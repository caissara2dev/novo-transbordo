import { randomUUID } from "node:crypto";
import {
  DocumentData,
  FieldPath,
  FieldValue,
  Timestamp,
  Transaction
} from "firebase-admin/firestore";
import { normalizeContainer } from "@/lib/domain/identifiers";
import { HttpError } from "@/lib/domain/errors";
import {
  assertTimelineTransactionWriteBudget,
  ContainerTimelineEvent,
  planContainerTimeline
} from "@/lib/domain/container-timeline";
import { adminDb } from "@/lib/firebase/admin";
import {
  ContainerStateDoc,
  ContainerStatus,
  containerStatuses,
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

function toTimelineEvent(
  id: string,
  data: EventDoc
): ContainerTimelineEvent | null {
  const status = eventContainerStatus(data);
  const container = normalizeContainer(data.container);

  if (!status || !container || !data.clientId || !data.plate) {
    return null;
  }

  return {
    id,
    container,
    status,
    clientId: data.clientId,
    plate: data.plate,
    pump: data.pump,
    operationalAtMs: toMillis(data.endAt),
    createdAtMs: toMillis(data.createdAt),
    startsNewCycle: Boolean(data.startsNewContainerCycle),
    existingCycleId: data.containerCycleId || null
  };
}

export function containerDocumentKey(container: string): string {
  return container.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export function eventContainerStatus(data: DocumentData): ContainerStatus | null {
  const raw = data.containerStatus;
  if (containerStatuses.includes(raw as ContainerStatus)) {
    return raw as ContainerStatus;
  }

  if (data.category === "PRODUTIVO" && data.container) {
    return "FULL";
  }

  return null;
}

function stateFromEvent(
  eventId: string,
  data: DocumentData,
  version: number
): ContainerStateDoc | null {
  const status = eventContainerStatus(data);
  const container = normalizeContainer(data.container ? String(data.container) : null);

  if (!status || !container || !data.clientId || !data.plate) {
    return null;
  }

  return {
    container,
    status,
    reason: data.containerReason ? String(data.containerReason) : null,
    cycleId: String(data.containerCycleId || `legacy-${containerDocumentKey(container)}`),
    latestEventId: eventId,
    previousEventId: data.previousContainerEventId
      ? String(data.previousContainerEventId)
      : null,
    clientId: String(data.clientId),
    clientNameSnapshot: data.clientNameSnapshot
      ? String(data.clientNameSnapshot)
      : null,
    plate: String(data.plate),
    pump: data.pump as ContainerStateDoc["pump"],
    operationalAt: data.endAt,
    eventCreatedAt: data.createdAt,
    version,
    updatedAt: FieldValue.serverTimestamp()
  };
}

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

export function assertExpectedContainerStateVersion(
  expectedVersion: number | null,
  observedVersion: number
): void {
  if (expectedVersion !== null && expectedVersion !== observedVersion) {
    throw new HttpError(
      409,
      "O estado deste container foi alterado por outro usuário. Atualize e tente novamente."
    );
  }
}

export async function latestEventState(container: string): Promise<ContainerStateView | null> {
  const snap = await adminDb
    .collection("events")
    .where("container", "==", container)
    .where("deleted", "==", false)
    .orderBy("endAt", "desc")
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();

  for (const candidate of snap.docs) {
    const state = stateFromEvent(candidate.id, candidate.data(), 0);
    if (state) return state;
  }
  return null;
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

type ContainerTimelineReconciliation = {
  cycleId: string | null;
  previousEventId: string | null;
  stateVersion: number | null;
};

type ContainerTimelineChange = {
  rawContainer: string | null;
  override?: { id: string; data: EventDoc | null };
  expectedVersion?: number | null;
};

export async function reconcileContainerTimelinesInTransaction(params: {
  transaction: Transaction;
  changes: ContainerTimelineChange[];
  reservedWrites?: number;
}): Promise<ContainerTimelineReconciliation[]> {
  const normalizedChanges = params.changes.map((change) => ({
    ...change,
    container: normalizeContainer(change.rawContainer)
  }));
  const loaded = await Promise.all(
    normalizedChanges.map(async (change) => {
      if (!change.container) return null;
      const stateRef = adminDb
        .collection("containerStates")
        .doc(containerDocumentKey(change.container));
      const eventsQuery = adminDb
        .collection("events")
        .where("container", "==", change.container)
        .where("deleted", "==", false);
      const [stateSnap, eventsSnap] = await Promise.all([
        params.transaction.get(stateRef),
        params.transaction.get(eventsQuery)
      ]);
      return { change, stateRef, stateSnap, eventsSnap };
    })
  );

  const prepared = loaded.map((entry) => {
    if (!entry) {
      return null;
    }

    const { change, stateRef, stateSnap, eventsSnap } = entry;
    const observedVersion = Number(stateSnap.data()?.version || 0);
    if (change.expectedVersion !== undefined) {
      assertExpectedContainerStateVersion(
        change.expectedVersion,
        observedVersion
      );
    }

    const eventsById = new Map(
      eventsSnap.docs.map((doc) => [doc.id, doc.data() as EventDoc])
    );
    if (change.override) {
      if (
        change.override.data &&
        !change.override.data.deleted &&
        normalizeContainer(change.override.data.container) === change.container
      ) {
        eventsById.set(change.override.id, change.override.data);
      } else {
        eventsById.delete(change.override.id);
      }
    }

    const plan = planContainerTimeline({
      events: Array.from(eventsById, ([id, data]) =>
        toTimelineEvent(id, data)
      ).filter((event): event is ContainerTimelineEvent => Boolean(event)),
      createCycleId: randomUUID
    });
    const nextVersion = observedVersion + 1;
    const linksById = new Map(plan.events.map((event) => [event.id, event]));
    const linkUpdates = Array.from(eventsById, ([id, data]) => {
      if (change.override?.id === id) return null;
      const link = linksById.get(id);
      if (
        !link ||
        (
          data.containerCycleId === link.containerCycleId &&
          data.previousContainerEventId === link.previousContainerEventId
        )
      ) {
        return null;
      }
      return link;
    }).filter((link): link is NonNullable<typeof link> => Boolean(link));
    const overrideLink = change.override
      ? linksById.get(change.override.id)
      : null;

    return {
      change,
      stateRef,
      eventsById,
      plan,
      nextVersion,
      linksById,
      linkUpdates,
      result: {
        cycleId: overrideLink?.containerCycleId || null,
        previousEventId: overrideLink?.previousContainerEventId || null,
        stateVersion: nextVersion
      } satisfies ContainerTimelineReconciliation
    };
  });

  assertTimelineTransactionWriteBudget({
    lifecycleWrites: prepared.reduce(
      (total, entry) => total + (entry ? entry.linkUpdates.length + 1 : 0),
      0
    ),
    reservedWrites: params.reservedWrites || 0
  });

  for (const entry of prepared) {
    if (!entry) continue;
    for (const link of entry.linkUpdates) {
      params.transaction.update(adminDb.collection("events").doc(link.id), {
        containerCycleId: link.containerCycleId,
        previousContainerEventId: link.previousContainerEventId
      });
    }

    if (!entry.plan.current) {
      params.transaction.delete(entry.stateRef);
      continue;
    }
    const currentData = entry.eventsById.get(entry.plan.current.id);
    const currentLink = entry.linksById.get(entry.plan.current.id);
    if (!currentData || !currentLink) {
      throw new HttpError(500, "Não foi possível reconstruir o estado do container.");
    }
    const nextState = stateFromEvent(
      entry.plan.current.id,
      {
        ...currentData,
        containerCycleId: currentLink.containerCycleId,
        previousContainerEventId: currentLink.previousContainerEventId
      },
      entry.nextVersion
    );
    if (!nextState) {
      throw new HttpError(500, "Não foi possível reconstruir o estado do container.");
    }
    params.transaction.set(entry.stateRef, nextState);
  }

  return prepared.map(
    (entry): ContainerTimelineReconciliation =>
      entry?.result || {
        cycleId: null,
        previousEventId: null,
        stateVersion: null
      }
  );
}

export async function reconcileContainerTimelineInTransaction(
  params: {
    transaction: Transaction;
    reservedWrites?: number;
  } & ContainerTimelineChange
): Promise<ContainerTimelineReconciliation> {
  const [result] = await reconcileContainerTimelinesInTransaction({
    transaction: params.transaction,
    changes: [params],
    reservedWrites: params.reservedWrites
  });
  return result;
}

export async function rebuildContainerState(rawContainer: string | null): Promise<void> {
  const container = normalizeContainer(rawContainer);
  if (!container) return;

  await adminDb.runTransaction((transaction: Transaction) =>
    reconcileContainerTimelineInTransaction({
      transaction,
      rawContainer: container
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
  status: ContainerStatus;
  [key: string]: unknown;
}>> {
  const container = normalizeContainer(rawContainer);
  if (!container) {
    throw new HttpError(400, "Container inválido.");
  }

  const snap = await adminDb
    .collection("events")
    .where("container", "==", container)
    .where("deleted", "==", false)
    .orderBy("endAt", "desc")
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();

  return snap.docs.flatMap((doc) => {
    const status = eventContainerStatus(doc.data());
    if (!status) return [];
    return [{
      id: doc.id,
      ...doc.data(),
      status
    }];
  });
}
