import { FieldValue, Transaction } from "firebase-admin/firestore";
import { normalizeContainer } from "@/lib/domain/identifiers";
import {
  assertTimelineTransactionWriteBudget,
  ContainerTimelineEvent,
  planContainerTimeline
} from "@/lib/domain/container-timeline";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import {
  assertExpectedContainerStateVersion,
  containerDocumentKey,
  eventContainerStatus
} from "@/lib/server/container-state-core";
import {
  ContainerEventRole,
  ContainerLifecycleStatus,
  ContainerStateDoc,
  EventDoc
} from "@/types/domain";
import { randomUUID } from "node:crypto";

type EventEffect = ContainerTimelineEvent & {
  role: ContainerEventRole;
  reason: string | null;
  clientNameSnapshot: string | null;
  relatedContainer: string | null;
  data: EventDoc;
};

type ContainerEventRecord = { id: string; data: EventDoc };

export type EventContainerEffectsResult = {
  containerCycleId: string | null;
  previousContainerEventId: string | null;
  containerStateVersion: number | null;
  sourceContainerCycleId: string | null;
  previousSourceContainerEventId: string | null;
  sourceContainerStateVersion: number | null;
};

function toMillis(value: unknown): number {
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

function isActive(data: EventDoc | null): data is EventDoc {
  return Boolean(data && !data.deleted);
}

function containersAffectedBy(data: EventDoc | null): string[] {
  if (!isActive(data)) return [];
  const source =
    data.loadSourceType === "BUFFER_CONTAINER"
      ? normalizeContainer(data.sourceContainer ?? null)
      : null;
  return [normalizeContainer(data.container), source]
    .filter((value): value is string => Boolean(value));
}

function effectForContainer(
  id: string,
  data: EventDoc,
  container: string
): EventEffect | null {
  const destination = normalizeContainer(data.container);
  const source = normalizeContainer(data.sourceContainer ?? null);
  const role: ContainerEventRole | null =
    destination === container
      ? "DESTINATION"
      : data.loadSourceType === "BUFFER_CONTAINER" && source === container
        ? "SOURCE"
        : null;
  if (!role || !data.clientId) return null;

  const status: ContainerLifecycleStatus | null =
    role === "DESTINATION"
      ? eventContainerStatus(data)
      : data.sourceContainerEmptied
        ? "TRANSFER_EMPTIED"
        : "BUFFER";
  if (!status) return null;

  return {
    id,
    container,
    status,
    clientId: data.clientId,
    plate: data.plate || null,
    pump: data.pump,
    operationalAtMs: toMillis(data.endAt),
    createdAtMs: toMillis(data.createdAt),
    startsNewCycle:
      role === "DESTINATION" ? Boolean(data.startsNewContainerCycle) : false,
    existingCycleId:
      role === "DESTINATION"
        ? data.containerCycleId || null
        : data.sourceContainerCycleId || null,
    role,
    reason: role === "DESTINATION" ? data.containerReason || null : null,
    clientNameSnapshot: data.clientNameSnapshot || null,
    relatedContainer: role === "DESTINATION" ? source : destination,
    data,
    fromBufferTransfer:
      role === "DESTINATION" && data.loadSourceType === "BUFFER_CONTAINER",
    legacyClosedCycleBoundary:
      role === "DESTINATION" &&
      !data.loadSourceType &&
      !data.containerCycleId &&
      !data.previousContainerEventId &&
      !data.startsNewContainerCycle &&
      (status === "FULL" || status === "BLEND_FULL")
  };
}

function linkPatch(role: ContainerEventRole, cycleId: string, previousId: string | null) {
  return role === "DESTINATION"
    ? {
        containerCycleId: cycleId,
        previousContainerEventId: previousId
      }
    : {
        sourceContainerCycleId: cycleId,
        previousSourceContainerEventId: previousId
      };
}

function projectionFromPlan(params: {
  effects: EventEffect[];
  links: Array<{
    id: string;
    containerCycleId: string;
    previousContainerEventId: string | null;
  }>;
  current: EventEffect;
  version: number;
}): ContainerStateDoc {
  const linksById = new Map(params.links.map((link) => [link.id, link]));
  const currentLink = linksById.get(params.current.id);
  if (!currentLink) {
    throw new HttpError(500, "Não foi possível reconstruir o estado do container.");
  }
  const currentCycleEffects = params.effects
    .filter(
      (effect) =>
        linksById.get(effect.id)?.containerCycleId === currentLink.containerCycleId
    )
    .sort(
      (left, right) =>
        left.operationalAtMs - right.operationalAtMs ||
        left.createdAtMs - right.createdAtMs ||
        left.id.localeCompare(right.id)
    );
  const previousWithPlate = [...currentCycleEffects]
    .reverse()
    .find((effect) => effect.plate);
  const previousWithReason = [...currentCycleEffects]
    .reverse()
    .find((effect) => effect.reason);
  const preserveSourceMetadata = params.current.role === "SOURCE";

  return {
    container: params.current.container,
    status: params.current.status,
    reason: preserveSourceMetadata
      ? previousWithReason?.reason || null
      : params.current.reason,
    cycleId: currentLink.containerCycleId,
    latestEventId: params.current.id,
    previousEventId: currentLink.previousContainerEventId,
    clientId: params.current.clientId,
    clientNameSnapshot: params.current.clientNameSnapshot,
    plate: preserveSourceMetadata
      ? previousWithPlate?.plate || null
      : params.current.plate,
    pump: params.current.pump,
    latestEventRole: params.current.role,
    relatedContainer: params.current.relatedContainer,
    operationalAt: params.current.data.endAt,
    eventCreatedAt: params.current.data.createdAt,
    version: params.version,
    updatedAt: FieldValue.serverTimestamp()
  };
}

function planEffectsForContainer(
  container: string,
  records: ContainerEventRecord[]
) {
  const effects = records
    .map(({ id, data }) => effectForContainer(id, data, container))
    .filter((effect): effect is EventEffect => Boolean(effect));
  return {
    effects,
    plan: planContainerTimeline({ events: effects, createCycleId: randomUUID })
  };
}

export function projectContainerStateFromEventRecords(params: {
  container: string;
  records: ContainerEventRecord[];
  version: number;
}): ContainerStateDoc | null {
  const { effects, plan } = planEffectsForContainer(
    params.container,
    params.records
  );
  if (!plan.current) return null;
  const current = effects.find((effect) => effect.id === plan.current?.id);
  return current
    ? projectionFromPlan({
        effects,
        links: plan.events,
        current,
        version: params.version
      })
    : null;
}

export async function reconcileEventContainerEffectsInTransaction(params: {
  transaction: Transaction;
  eventId: string;
  before: EventDoc | null;
  after: EventDoc | null;
  expectedContainerStateVersion?: number | null;
  expectedSourceContainerStateVersion?: number | null;
  requireSourceCurrentlyOpen?: boolean;
  affectedContainers?: Array<string | null>;
  reservedWrites?: number;
}): Promise<EventContainerEffectsResult> {
  const affected = Array.from(
    new Set([
      ...containersAffectedBy(params.before),
      ...containersAffectedBy(params.after),
      ...(params.affectedContainers || [])
        .map((container) => normalizeContainer(container))
        .filter((container): container is string => Boolean(container))
    ])
  );
  const emptyResult: EventContainerEffectsResult = {
    containerCycleId: null,
    previousContainerEventId: null,
    containerStateVersion: null,
    sourceContainerCycleId: null,
    previousSourceContainerEventId: null,
    sourceContainerStateVersion: null
  };
  if (!affected.length) return emptyResult;

  const loaded = await Promise.all(
    affected.map(async (container) => {
      const stateRef = adminDb
        .collection("containerStates")
        .doc(containerDocumentKey(container));
      const destinationQuery = adminDb
        .collection("events")
        .where("container", "==", container)
        .where("deleted", "==", false);
      const sourceQuery = adminDb
        .collection("events")
        .where("sourceContainer", "==", container)
        .where("deleted", "==", false);
      const [stateSnap, destinationSnap, sourceSnap] = await Promise.all([
        params.transaction.get(stateRef),
        params.transaction.get(destinationQuery),
        params.transaction.get(sourceQuery)
      ]);
      return { container, stateRef, stateSnap, destinationSnap, sourceSnap };
    })
  );

  const expectedDestinationContainer = normalizeContainer(params.after?.container ?? null);
  const expectedSourceContainer = normalizeContainer(params.after?.sourceContainer ?? null);
  const previousSourceContainer =
    params.before?.loadSourceType === "BUFFER_CONTAINER"
      ? normalizeContainer(params.before.sourceContainer ?? null)
      : null;
  const prepared = loaded.map((entry) => {
    const observedVersion = Number(entry.stateSnap.data()?.version || 0);
    if (entry.container === expectedDestinationContainer) {
      assertExpectedContainerStateVersion(
        params.expectedContainerStateVersion ?? null,
        observedVersion
      );
    }
    if (entry.container === expectedSourceContainer) {
      assertExpectedContainerStateVersion(
        params.expectedSourceContainerStateVersion ?? null,
        observedVersion
      );
      if (
        params.requireSourceCurrentlyOpen &&
        entry.container !== previousSourceContainer &&
        entry.stateSnap.data()?.status !== "BUFFER"
      ) {
        throw new HttpError(
          409,
          "O container de origem não está mais aberto como Pulmão."
        );
      }
    }

    const persistedRecords = Array.from(
      new Map(
        [...entry.destinationSnap.docs, ...entry.sourceSnap.docs].map((doc) => [
          doc.id,
          { id: doc.id, data: doc.data() as EventDoc }
        ])
      ).values()
    ).filter((record) => record.id !== params.eventId);
    const records =
      isActive(params.after) &&
      containersAffectedBy(params.after).includes(entry.container)
        ? [...persistedRecords, { id: params.eventId, data: params.after }]
        : persistedRecords;
    const eventsById = new Map(
      records.map(({ id, data }) => [id, data] as const)
    );
    const { effects, plan } = planEffectsForContainer(
      entry.container,
      records
    );
    const nextVersion = observedVersion + 1;
    const effectsById = new Map(effects.map((effect) => [effect.id, effect]));

    const linkPatches = plan.events.flatMap((link) => {
      const effect = effectsById.get(link.id);
      const existing = eventsById.get(link.id);
      if (!effect || !existing || link.id === params.eventId) return [];
      const patch = linkPatch(
        effect.role,
        link.containerCycleId,
        link.previousContainerEventId
      );
      return Object.entries(patch).some(
        ([key, value]) => Reflect.get(existing, key) !== value
      )
        ? [{ id: link.id, patch }]
        : [];
    });

    return {
      ...entry,
      effects,
      plan,
      nextVersion,
      linkPatches,
      overrideEffect: effectsById.get(params.eventId) || null
    };
  });
  const eventPatches = prepared
    .flatMap((entry) => entry.linkPatches)
    .reduce<Record<string, Record<string, unknown>>>(
      (accumulator, item) => ({
        ...accumulator,
        [item.id]: {
          ...(accumulator[item.id] || {}),
          ...item.patch
        }
      }),
      {}
    );

  assertTimelineTransactionWriteBudget({
    lifecycleWrites:
      Object.keys(eventPatches).length + prepared.length,
    reservedWrites: params.reservedWrites || 0
  });

  for (const [eventId, patch] of Object.entries(eventPatches)) {
    params.transaction.update(adminDb.collection("events").doc(eventId), patch);
  }
  for (const entry of prepared) {
    if (!entry.plan.current) {
      params.transaction.delete(entry.stateRef);
      continue;
    }
    const currentEffect = entry.effects.find(
      (effect) => effect.id === entry.plan.current?.id
    );
    if (!currentEffect) {
      throw new HttpError(500, "Não foi possível reconstruir o estado do container.");
    }
    params.transaction.set(
      entry.stateRef,
      projectionFromPlan({
        effects: entry.effects,
        links: entry.plan.events,
        current: currentEffect,
        version: entry.nextVersion
      })
    );
  }

  return prepared.reduce<EventContainerEffectsResult>((result, entry) => {
    const effect = entry.overrideEffect;
    if (!effect) return result;
    const link = entry.plan.events.find((candidate) => candidate.id === params.eventId);
    if (!link) return result;
    return effect.role === "DESTINATION"
      ? {
          ...result,
          containerCycleId: link.containerCycleId,
          previousContainerEventId: link.previousContainerEventId,
          containerStateVersion: entry.nextVersion
        }
      : {
          ...result,
          sourceContainerCycleId: link.containerCycleId,
          previousSourceContainerEventId: link.previousContainerEventId,
          sourceContainerStateVersion: entry.nextVersion
        };
  }, emptyResult);
}
