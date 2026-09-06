import { FieldValue, Transaction } from "firebase-admin/firestore";
import { normalizeContainer } from "@/lib/domain/identifiers";
import { assertTimelineTransactionWriteBudget } from "@/lib/domain/container-timeline";
import {
  containersAffectedBy,
  planEffectsForContainer,
  projectionFromPlan,
  type ContainerEventRecord
} from "@/lib/domain/container-effects";
import { isTransferSourceStatus } from "@/lib/domain/container-transfer";
import { assertContainerTransfersEnabled } from "@/lib/server/container-transfer-capability";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import {
  assertExpectedContainerStateVersion,
  containerDocumentKey
} from "@/lib/server/container-state-core";
import {
  ContainerEventRole,
  ContainerStateDoc,
  EventDoc
} from "@/types/domain";
import { randomUUID } from "node:crypto";

export type EventContainerEffectsResult = {
  containerCycleId: string | null;
  previousContainerEventId: string | null;
  containerStateVersion: number | null;
  sourceContainerCycleId: string | null;
  previousSourceContainerEventId: string | null;
  sourceContainerStateVersion: number | null;
};

function isActive(data: EventDoc | null): data is EventDoc {
  return Boolean(data && !data.deleted);
}

function linkPatch(
  role: ContainerEventRole,
  cycleId: string,
  previousId: string | null
) {
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

export function projectContainerStateFromEventRecords(params: {
  container: string;
  records: ContainerEventRecord[];
  version: number;
}): ContainerStateDoc | null {
  const { effects, plan } = planEffectsForContainer(
    params.container,
    params.records,
    randomUUID
  );
  if (!plan.current) return null;
  const current = effects.find((effect) => effect.id === plan.current?.id);
  return current
    ? {
        ...projectionFromPlan({
          effects,
          links: plan.events,
          current,
          version: params.version
        }),
        updatedAt: FieldValue.serverTimestamp()
      }
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

  if (params.before || params.after) {
    const records = [
      params.before,
      params.after,
      ...loaded.flatMap((entry) =>
        [...entry.destinationSnap.docs, ...entry.sourceSnap.docs].map((doc) =>
          doc.data()
        )
      )
    ];
    if (
      records.some((record) => record?.loadSourceType === "BUFFER_CONTAINER")
    ) {
      assertContainerTransfersEnabled();
    }
  }

  const expectedDestinationContainer = normalizeContainer(
    params.after?.container ?? null
  );
  const expectedSourceContainer = normalizeContainer(
    params.after?.sourceContainer ?? null
  );
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
        !isTransferSourceStatus(entry.stateSnap.data()?.status)
      ) {
        throw new HttpError(
          409,
          "O container de origem não está mais aberto como Pulmão ou Parcial."
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
      records,
      randomUUID
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
    lifecycleWrites: Object.keys(eventPatches).length + prepared.length,
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
      throw new HttpError(
        500,
        "Não foi possível reconstruir o estado do container."
      );
    }
    params.transaction.set(entry.stateRef, {
      ...projectionFromPlan({
        effects: entry.effects,
        links: entry.plan.events,
        current: currentEffect,
        version: entry.nextVersion
      }),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  return prepared.reduce<EventContainerEffectsResult>((result, entry) => {
    const effect = entry.overrideEffect;
    if (!effect) return result;
    const link = entry.plan.events.find(
      (candidate) => candidate.id === params.eventId
    );
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
