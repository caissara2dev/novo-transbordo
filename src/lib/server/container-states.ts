export { getContainerHistory } from "./container-history";
import { TRANSFER_SOURCE_STATUSES } from "@/lib/domain/container-transfer";
import { FieldPath, Timestamp, Transaction } from "firebase-admin/firestore";
import { availableStatusesFor } from "@/lib/domain/container-timeline";
import { normalizeContainer } from "@/lib/domain/identifiers";
import { HttpError } from "@/lib/domain/errors";
import {
  projectContainerStateFromEventRecords,
  reconcileEventContainerEffectsInTransaction
} from "@/lib/server/container-event-effects";
import { adminDb } from "@/lib/firebase/admin";
import { containerDocumentKey } from "@/lib/server/container-state-core";
import { ContainerStateDoc, ContainerStatus, EventDoc } from "@/types/domain";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  paginationScope,
  PaginationInput,
  scanFilteredPage
} from "@/lib/server/pagination";

export const OPEN_CONTAINER_STATUSES: ContainerStatus[] = [
  "PARTIAL",
  "BUFFER",
  "BLEND_PARTIAL"
];

export type ContainerStateView = Omit<
  ContainerStateDoc,
  "operationalAt" | "eventCreatedAt" | "updatedAt"
> & {
  operationalAt: unknown;
  eventCreatedAt: unknown;
  updatedAt: unknown;
};

export type ContainerLookupResult = {
  container: string;
  current: ContainerStateView | null;
  availableStatuses: ContainerStatus[];
  requiresNewCycleConfirmation: boolean;
};

export {
  assertExpectedContainerStateVersion,
  containerDocumentKey,
  eventContainerStatus
} from "@/lib/server/container-state-core";

export async function latestEventState(
  container: string
): Promise<ContainerStateView | null> {
  const [destinationSnap, sourceSnap] = await Promise.all([
    adminDb
      .collection("events")
      .where("container", "==", container)
      .where("deleted", "==", false)
      .get(),
    adminDb
      .collection("events")
      .where("sourceContainer", "==", container)
      .where("deleted", "==", false)
      .get()
  ]);
  const records = Array.from(
    new Map(
      [...destinationSnap.docs, ...sourceSnap.docs].map((doc) => [
        doc.id,
        { id: doc.id, data: doc.data() as EventDoc }
      ])
    ).values()
  );
  return projectContainerStateFromEventRecords({
    container,
    records,
    version: 0
  }) as ContainerStateView | null;
}

export async function getCurrentContainerState(
  rawContainer: string
): Promise<ContainerStateView | null> {
  const container = normalizeContainer(rawContainer);
  if (!container) {
    throw new HttpError(400, "Container inválido.");
  }

  const stateSnap = await adminDb
    .collection("containerStates")
    .doc(containerDocumentKey(container))
    .get();

  if (stateSnap.exists) {
    return stateSnap.data() as ContainerStateView;
  }

  return latestEventState(container);
}

export async function lookupContainer(
  rawContainer: string
): Promise<ContainerLookupResult> {
  const container = normalizeContainer(rawContainer);
  if (!container) {
    throw new HttpError(400, "Container inválido.");
  }

  const current = await getCurrentContainerState(container);
  return {
    container,
    current,
    availableStatuses: availableStatusesFor(current),
    requiresNewCycleConfirmation:
      current?.status === "FULL" || current?.status === "BLEND_FULL"
  };
}

export async function rebuildContainerState(
  rawContainer: string | null
): Promise<void> {
  const container = normalizeContainer(rawContainer);
  if (!container) return;

  await adminDb.runTransaction((transaction: Transaction) =>
    reconcileEventContainerEffectsInTransaction({
      transaction,
      eventId: "__container-state-rebuild__",
      before: null,
      after: null,
      affectedContainers: [container]
    })
  );
}

type ContainerListPosition = {
  operationalAt: Timestamp;
  documentId: string;
};

function containerListPosition(
  doc: FirebaseFirestore.QueryDocumentSnapshot
): ContainerListPosition {
  const data = doc.data() as ContainerStateView;
  return {
    operationalAt: data.operationalAt as Timestamp,
    documentId: doc.id
  };
}

export async function listContainerStates(params: {
  query?: string;
  openOnly: boolean;
  status?: ContainerStatus;
  transferSourceOnly?: boolean;
  excludeContainer?: string;
  pagination: PaginationInput;
}): Promise<{
  items: ContainerStateView[];
  nextCursor: string | null;
  incomplete: boolean;
}> {
  let firestoreQuery: FirebaseFirestore.Query =
    adminDb.collection("containerStates");

  if (params.transferSourceOnly) {
    firestoreQuery = firestoreQuery.where(
      "status",
      "in",
      TRANSFER_SOURCE_STATUSES
    );
  } else if (params.status) {
    firestoreQuery = firestoreQuery.where("status", "==", params.status);
  } else if (params.openOnly) {
    firestoreQuery = firestoreQuery.where(
      "status",
      "in",
      OPEN_CONTAINER_STATUSES
    );
  }

  const needle = params.query?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const excluded = containerDocumentKey(params.excludeContainer || "");
  const scope = paginationScope("containers", [
    Boolean(params.transferSourceOnly),
    excluded,
    params.status || null,
    params.openOnly,
    needle || null
  ]);
  firestoreQuery = firestoreQuery
    .orderBy("operationalAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");

  const decodedCursor = params.pagination.cursor
    ? decodePaginationCursor({
        cursor: params.pagination.cursor,
        kind: "containers",
        scope,
        valueTypes: ["timestamp-millis"]
      })
    : null;
  const initialPosition: ContainerListPosition | null = decodedCursor
    ? {
        operationalAt: Timestamp.fromMillis(Number(decodedCursor.values[0])),
        documentId: decodedCursor.documentId
      }
    : null;
  const scanBatchSize = Math.min(
    Math.max(params.pagination.limit * 2, 50),
    200
  );
  const scan = await scanFilteredPage({
    limit: params.pagination.limit,
    batchSize: scanBatchSize,
    initialPosition,
    fetchPage: async (after, limit) => {
      const pageQuery = after
        ? firestoreQuery.startAfter(after.operationalAt, after.documentId)
        : firestoreQuery;
      const snap = await pageQuery.limit(limit).get();
      return snap.docs;
    },
    positionForDocument: containerListPosition,
    matchDocument: (doc) => {
      const state = doc.data() as ContainerStateView;
      if (excluded && containerDocumentKey(state.container) === excluded)
        return undefined;
      if (needle && !containerDocumentKey(state.container).includes(needle)) {
        return undefined;
      }
      return {
        position: containerListPosition(doc),
        state
      };
    }
  });
  const pageEntries = scan.matches.slice(0, params.pagination.limit);
  const lastReturned = pageEntries.at(-1);
  const nextPosition = scan.incomplete
    ? scan.lastScannedPosition
    : scan.matches.length > params.pagination.limit
      ? lastReturned?.position || null
      : null;

  return {
    items: pageEntries.map((entry) => entry.state),
    nextCursor: nextPosition
      ? encodePaginationCursor({
          kind: "containers",
          scope,
          values: [nextPosition.operationalAt.toMillis()],
          documentId: nextPosition.documentId
        })
      : null,
    incomplete: scan.incomplete
  };
}
