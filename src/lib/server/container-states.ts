import { randomUUID } from "node:crypto";
import {
  DocumentData,
  DocumentReference,
  FieldValue,
  Timestamp,
  Transaction
} from "firebase-admin/firestore";
import { normalizeContainer } from "@/lib/domain/identifiers";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import {
  ContainerStateDoc,
  ContainerStatus,
  containerStatuses,
  EventDoc
} from "@/types/domain";

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

export async function persistEventWithContainerState(params: {
  eventRef: DocumentReference;
  eventPayload: Omit<
    EventDoc,
    "containerCycleId" | "previousContainerEventId" | "containerStateVersion"
  > & {
    expectedContainerStateVersion: number | null;
  };
}): Promise<{
  cycleId: string | null;
  previousEventId: string | null;
  stateVersion: number | null;
}> {
  const { eventPayload, eventRef } = params;
  if (!eventPayload.container || !eventPayload.containerStatus || !eventPayload.clientId) {
    const {
      expectedContainerStateVersion: _expectedContainerStateVersion,
      ...storedEventPayload
    } = eventPayload;
    void _expectedContainerStateVersion;
    await eventRef.set({
      ...storedEventPayload,
      containerCycleId: null,
      previousContainerEventId: null,
      containerStateVersion: null
    });
    return { cycleId: null, previousEventId: null, stateVersion: null };
  }

  const container = eventPayload.container;
  const fallbackState = await latestEventState(container);

  return adminDb.runTransaction((transaction) =>
    persistEventWithContainerStateInTransaction({
      transaction,
      eventRef,
      eventPayload,
      fallbackState
    })
  );
}

export async function persistEventWithContainerStateInTransaction(params: {
  transaction: Transaction;
  eventRef: DocumentReference;
  eventPayload: Omit<
    EventDoc,
    "containerCycleId" | "previousContainerEventId" | "containerStateVersion"
  > & {
    expectedContainerStateVersion: number | null;
  };
  fallbackState: ContainerStateView | null;
}): Promise<{
  cycleId: string | null;
  previousEventId: string | null;
  stateVersion: number | null;
}> {
  const { transaction, eventPayload, eventRef, fallbackState } = params;
  const { expectedContainerStateVersion, ...storedEventPayload } = eventPayload;

  if (!eventPayload.container || !eventPayload.containerStatus || !eventPayload.clientId) {
    transaction.set(eventRef, {
      ...storedEventPayload,
      containerCycleId: null,
      previousContainerEventId: null,
      containerStateVersion: null
    });
    return { cycleId: null, previousEventId: null, stateVersion: null };
  }

  const container = eventPayload.container;
  const stateRef = adminDb
    .collection("containerStates")
    .doc(containerDocumentKey(container));
  const stateSnap = await transaction.get(stateRef);
  const current = stateSnap.exists
    ? (stateSnap.data() as ContainerStateView)
    : fallbackState;
  const observedVersion = current?.version ?? 0;
  const expectedVersion = expectedContainerStateVersion;

  assertExpectedContainerStateVersion(expectedVersion, observedVersion);

  const transition = resolveContainerTransition({
    current,
    status: eventPayload.containerStatus,
    clientId: eventPayload.clientId,
    startsNewCycle: eventPayload.startsNewContainerCycle
  });

  const candidateIsCurrent =
    !current ||
    compareOperationalOrder(
      eventPayload.endAt,
      eventPayload.createdAt,
      current
    ) >= 0;
  const nextVersion = candidateIsCurrent ? observedVersion + 1 : observedVersion;
  const persistedPayload = {
    ...storedEventPayload,
    containerCycleId: transition.cycleId,
    previousContainerEventId: transition.previousEventId,
    containerStateVersion: nextVersion
  };

  transaction.set(eventRef, persistedPayload);

  if (candidateIsCurrent) {
    const nextState = stateFromEvent(eventRef.id, persistedPayload, nextVersion);
    if (nextState) transaction.set(stateRef, nextState);
  } else if (!stateSnap.exists && current) {
    transaction.set(stateRef, {
      ...current,
      version: Math.max(1, current.version),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  return {
    cycleId: transition.cycleId,
    previousEventId: transition.previousEventId,
    stateVersion: nextVersion
  };
}

export async function rebuildContainerState(rawContainer: string | null): Promise<void> {
  const container = normalizeContainer(rawContainer);
  if (!container) return;

  const stateRef = adminDb
    .collection("containerStates")
    .doc(containerDocumentKey(container));
  const latest = await adminDb
    .collection("events")
    .where("container", "==", container)
    .where("deleted", "==", false)
    .orderBy("endAt", "desc")
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();
  const latestState = latest.docs
    .map((doc) => stateFromEvent(doc.id, doc.data(), 0))
    .find((state): state is ContainerStateDoc => Boolean(state));

  await adminDb.runTransaction(async (transaction: Transaction) => {
    const currentSnap = await transaction.get(stateRef);
    const nextVersion = Number(currentSnap.data()?.version || 0) + 1;

    if (!latestState) {
      transaction.delete(stateRef);
      return;
    }

    transaction.set(stateRef, {
      ...latestState,
      version: nextVersion,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

export async function listContainerStates(params: {
  query?: string;
  openOnly: boolean;
  status?: ContainerStatus;
}): Promise<ContainerStateView[]> {
  let firestoreQuery: FirebaseFirestore.Query = adminDb.collection("containerStates");

  if (params.status) {
    firestoreQuery = firestoreQuery.where("status", "==", params.status);
  } else if (params.openOnly) {
    firestoreQuery = firestoreQuery.where("status", "in", OPEN_CONTAINER_STATUSES);
  }

  const snap = await firestoreQuery
    .orderBy("operationalAt", "desc")
    .limit(200)
    .get();
  const needle = params.query?.replace(/[^A-Z0-9]/gi, "").toUpperCase();

  return snap.docs
    .map((doc) => doc.data() as ContainerStateView)
    .filter((state) => {
      if (!needle) return true;
      return containerDocumentKey(state.container).includes(needle);
    });
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
