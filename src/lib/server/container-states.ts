import {
  FieldPath,
  Timestamp,
  Transaction
} from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { normalizeContainer } from "@/lib/domain/identifiers";
import { HttpError } from "@/lib/domain/errors";
import {
  projectContainerStateFromEventRecords,
  reconcileEventContainerEffectsInTransaction
} from "@/lib/server/container-event-effects";
import { adminDb } from "@/lib/firebase/admin";
import {
  containerDocumentKey,
  eventContainerStatus
} from "@/lib/server/container-state-core";
import {
  ContainerStateDoc,
  ContainerStatus,
  EventDoc
} from "@/types/domain";
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

function toMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && "toMillis" in value) {
    return Number((value as { toMillis: () => number }).toMillis());
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export {
  assertExpectedContainerStateVersion,
  containerDocumentKey,
  eventContainerStatus
} from "@/lib/server/container-state-core";

export function compareOperationalOrder(
  candidateOperationalAt: unknown,
  candidateCreatedAt: unknown,
  current: ContainerStateView
): number {
  const operationalDelta =
    toMillis(candidateOperationalAt) - toMillis(current.operationalAt);
  if (operationalDelta !== 0) return operationalDelta;
  return toMillis(candidateCreatedAt) - toMillis(current.eventCreatedAt);
}

export async function latestEventState(container: string): Promise<ContainerStateView | null> {
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

export function availableStatusesFor(
  current: ContainerStateView | null,
  startsNewCycle = false
): ContainerStatus[] {
  if (!current || startsNewCycle) {
    return ["FULL", "PARTIAL", "BUFFER"];
  }

  if (current.status === "BLEND_FULL" || current.status === "BLEND_PARTIAL") {
    return ["BLEND_FULL", "BLEND_PARTIAL"];
  }

  if (current.status === "PARTIAL" || current.status === "BUFFER") {
    return ["FULL", "PARTIAL", "BUFFER", "BLEND_FULL", "BLEND_PARTIAL"];
  }

  return ["FULL", "PARTIAL", "BUFFER"];
}

export async function lookupContainer(rawContainer: string): Promise<ContainerLookupResult> {
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

export function resolveContainerTransition(params: {
  current: ContainerStateView | null;
  status: ContainerStatus;
  clientId: string;
  startsNewCycle: boolean;
}): { cycleId: string; previousEventId: string | null } {
  const { current, status, clientId, startsNewCycle } = params;
  const isBlend = status === "BLEND_FULL" || status === "BLEND_PARTIAL";

  if (!current) {
    if (isBlend) {
      throw new HttpError(400, "Blend exige um container Parcial ou Pulmão anterior.");
    }
    return { cycleId: randomUUID(), previousEventId: null };
  }

  if (startsNewCycle) {
    if (isBlend) {
      throw new HttpError(400, "Um novo ciclo não pode começar diretamente como Blend.");
    }
    return { cycleId: randomUUID(), previousEventId: null };
  }

  if (current.status === "FULL" || current.status === "BLEND_FULL") {
    throw new HttpError(
      409,
      "Este container estava cheio. Confirme que foi esvaziado para iniciar um novo ciclo."
    );
  }

  const currentIsBlend = current.status === "BLEND_PARTIAL";
  if (currentIsBlend && !isBlend) {
    throw new HttpError(400, "Um Blend não pode voltar a ser carga simples no mesmo ciclo.");
  }

  if (isBlend && current.clientId !== clientId) {
    throw new HttpError(400, "Blend só pode ser formado com cargas do mesmo cliente.");
  }

  return {
    cycleId: current.cycleId,
    previousEventId: current.latestEventId
  };
}

export async function rebuildContainerState(rawContainer: string | null): Promise<void> {
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
  pagination: PaginationInput;
}): Promise<{
  items: ContainerStateView[];
  nextCursor: string | null;
  incomplete: boolean;
}> {
  let firestoreQuery: FirebaseFirestore.Query = adminDb.collection("containerStates");

  if (params.status) {
    firestoreQuery = firestoreQuery.where("status", "==", params.status);
  } else if (params.openOnly) {
    firestoreQuery = firestoreQuery.where("status", "in", OPEN_CONTAINER_STATUSES);
  }

  const needle = params.query?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const scope = paginationScope("containers", [
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
        ? firestoreQuery.startAfter(
            after.operationalAt,
            after.documentId
          )
        : firestoreQuery;
      const snap = await pageQuery.limit(limit).get();
      return snap.docs;
    },
    positionForDocument: containerListPosition,
    matchDocument: (doc) => {
      const state = doc.data() as ContainerStateView;
      if (
        needle &&
        !containerDocumentKey(state.container).includes(needle)
      ) {
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
    nextCursor:
      nextPosition
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

export async function getContainerHistory(rawContainer: string): Promise<Array<{
  id: string;
  status: ContainerStateDoc["status"];
  containerRole: "DESTINATION" | "SOURCE";
  relatedContainer: string | null;
  [key: string]: unknown;
}>> {
  const container = normalizeContainer(rawContainer);
  if (!container) {
    throw new HttpError(400, "Container inválido.");
  }

  const [destinationSnap, sourceSnap] = await Promise.all([
    adminDb
      .collection("events")
      .where("container", "==", container)
      .where("deleted", "==", false)
      .orderBy("endAt", "desc")
      .orderBy("createdAt", "desc")
      .limit(200)
      .get(),
    adminDb
      .collection("events")
      .where("sourceContainer", "==", container)
      .where("deleted", "==", false)
      .orderBy("endAt", "desc")
      .orderBy("createdAt", "desc")
      .limit(200)
      .get()
  ]);
  const byId = new Map(
    [...destinationSnap.docs, ...sourceSnap.docs].map((doc) => [doc.id, doc])
  );

  return Array.from(byId.values())
    .sort((left, right) => {
      const endDelta = toMillis(right.data().endAt) - toMillis(left.data().endAt);
      return endDelta || toMillis(right.data().createdAt) - toMillis(left.data().createdAt);
    })
    .flatMap((doc) => {
      const data = doc.data() as EventDoc;
      const isSource = normalizeContainer(data.sourceContainer ?? null) === container;
      const status: ContainerStateDoc["status"] | null = isSource
        ? data.sourceContainerEmptied
          ? "TRANSFER_EMPTIED"
          : "BUFFER"
        : eventContainerStatus(data);
      if (!status) return [];
      return [{
        id: doc.id,
        ...data,
        status,
        containerRole: isSource ? "SOURCE" as const : "DESTINATION" as const,
        relatedContainer: isSource
          ? normalizeContainer(data.container)
          : normalizeContainer(data.sourceContainer ?? null)
      }];
    });
}
