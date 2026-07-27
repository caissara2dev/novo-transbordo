import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { categoryRules } from "@/lib/domain/constants";
import {
  collectPreviousContainerPassages,
  ContainerCycleHistoryEntry
} from "@/lib/domain/container-cycle-history";
import { filterAndSortOperationalHistory } from "@/lib/domain/event-order";
import { resolveTimelineDate } from "@/lib/domain/time";
import { collectChangedFields, validateEventInput } from "@/lib/domain/validation";
import {
  Category,
  EventDoc,
  GapJustification,
  GapSegment,
  EventInput,
  UserDoc
} from "@/types/domain";
import {
  eventContainerStatus,
  assertExpectedContainerStateVersion,
  getCurrentContainerState,
  latestEventState,
  persistEventWithContainerStateInTransaction,
  rebuildContainerState,
  resolveContainerTransition
} from "@/lib/server/container-states";
import {
  prepareDeletionGap,
  previewEventGap,
  timelineLockRef
} from "@/lib/server/gaps";

async function assertClientIfRequired(clientId: string | null): Promise<string | null> {
  if (!clientId) {
    return null;
  }

  const clientRef = adminDb.collection("clients").doc(clientId);
  const snap = await clientRef.get();

  if (!snap.exists) {
    throw new HttpError(400, "Cliente informado não existe.");
  }

  const client = snap.data() as { active: boolean; name: string };

  if (!client.active) {
    throw new HttpError(400, "Cliente informado está inativo.");
  }

  return client.name;
}

async function assertNoOverlap(params: {
  pump: EventDoc["pump"];
  startAt: Timestamp;
  endAt: Timestamp;
  ignoreEventId?: string;
  ignoreEventIds?: string[];
}): Promise<void> {
  const snap = await adminDb
    .collection("events")
    .where("pump", "==", params.pump)
    .where("deleted", "==", false)
    .where("startAt", "<", params.endAt)
    .get();

  const hasOverlap = snap.docs.some((doc) => {
    if (params.ignoreEventId && doc.id === params.ignoreEventId) {
      return false;
    }
    if (params.ignoreEventIds?.includes(doc.id)) return false;

    const data = doc.data() as EventDoc;
    if (params.ignoreEventId && data.generatedForEventId === params.ignoreEventId) {
      return false;
    }
    const existingStart = data.startAt as Timestamp;
    const existingEnd = data.endAt as Timestamp;

    return existingStart.toMillis() < params.endAt.toMillis() && existingEnd.toMillis() > params.startAt.toMillis();
  });

  if (hasOverlap) {
    throw new HttpError(409, "Existe sobreposição de horário em lançamentos desta bomba.");
  }
}

export async function createEvent(raw: unknown, actor: { uid: string; email: string }) {
  const validated = validateEventInput(raw);
  if (validated.event.category === "INTERVALO_OPERACIONAL") {
    throw new HttpError(400, "Intervalo operacional só pode ser gerado automaticamente.");
  }
  const clientNameSnapshot = await assertClientIfRequired(validated.event.clientId);

  const startAt = Timestamp.fromDate(new Date(validated.startAtIso));
  const endAt = Timestamp.fromDate(new Date(validated.endAtIso));
  const lockRef = timelineLockRef(
    validated.event.shiftDate,
    validated.event.shiftType,
    validated.event.pump
  );
  const lockBefore = await lockRef.get();
  const expectedLockVersion = Number(lockBefore.data()?.version || 0);

  await assertNoOverlap({
    pump: validated.event.pump,
    startAt,
    endAt
  });

  const now = Timestamp.now();
  const rawGap = (raw || {}) as {
    gapVersion?: string;
    gapJustifications?: unknown[];
  };
  const gapPreview = validated.productive
    ? await previewEventGap({
        pump: validated.event.pump,
        shiftDate: validated.event.shiftDate,
        shiftType: validated.event.shiftType,
        startTime: validated.event.startTime,
        endTime: validated.event.endTime
      })
    : null;

  if (gapPreview && rawGap.gapVersion !== gapPreview.gapVersion) {
    throw new HttpError(
      409,
      "A linha do tempo desta bomba mudou. Revise o intervalo antes de salvar."
    );
  }

  const autoEvents = gapPreview
    ? await buildAutomaticGapEvents({
        preview: gapPreview,
        rawJustifications: rawGap.gapJustifications,
        productiveEvent: validated.event,
        actor,
        createdAt: now
      })
    : [];
  const payload: Omit<
    EventDoc,
    "containerCycleId" | "previousContainerEventId" | "containerStateVersion"
  > & {
    expectedContainerStateVersion: number | null;
  } = {
    ...validated.event,
    productive: validated.productive,
    origin: "MANUAL",
    generatedForEventId: null,
    gapSegmentId: null,
    justificationWaived: false,
    clientNameSnapshot,
    startAt,
    endAt,
    durationMinutes: validated.durationMinutes,
    createdByUid: actor.uid,
    createdByEmail: actor.email,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email,
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
    deletedByUid: null,
    deletedByEmail: null,
    deletedReason: null
  };

  const ref = adminDb.collection("events").doc();
  const fallbackState = validated.event.container
    ? await latestEventState(validated.event.container)
    : null;

  await adminDb.runTransaction(async (transaction) => {
    const lockSnap = await transaction.get(lockRef);
    const observedLockVersion = Number(lockSnap.data()?.version || 0);
    if (observedLockVersion !== expectedLockVersion) {
      throw new HttpError(
        409,
        "A linha do tempo desta bomba mudou. Atualize o intervalo e tente novamente."
      );
    }

    await persistEventWithContainerStateInTransaction({
      transaction,
      eventRef: ref,
      eventPayload: payload,
      fallbackState
    });

    for (const automatic of autoEvents) {
      transaction.set(adminDb.collection("events").doc(), {
        ...automatic,
        generatedForEventId: ref.id
      });
    }

    transaction.set(
      lockRef,
      {
        version: observedLockVersion + 1,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });
  const created = await ref.get();

  return {
    id: ref.id,
    ...created.data(),
    warnings: validated.warnings
  };
}

const justifiableCategories: Array<Exclude<
  Category,
  "PRODUTIVO" | "INTERVALO_OPERACIONAL"
>> = [
  "EM_TRANSITO",
  "AGUARDANDO_LABORATORIO",
  "SEM_CAMINHAO",
  "SEM_CONTAINER",
  "MANUTENCAO",
  "OUTROS"
];

function parseGapJustification(
  raw: unknown,
  expected: GapSegment
): GapJustification {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, `Justifique o trecho ${expected.startTime}–${expected.endTime}.`);
  }
  const input = raw as Partial<GapJustification>;
  if (
    input.id !== expected.id ||
    input.startTime !== expected.startTime ||
    input.endTime !== expected.endTime ||
    input.durationMinutes !== expected.durationMinutes ||
    !justifiableCategories.includes(input.category as never)
  ) {
    throw new HttpError(400, "Uma justificativa de intervalo está inválida ou desatualizada.");
  }
  const category = input.category as GapJustification["category"];
  const rules = categoryRules[category];
  const clientId = input.clientId?.trim() || null;
  const plate = input.plate?.trim().toUpperCase() || null;
  const notes = input.notes?.trim() || null;
  if (rules.requiresClient && !clientId) {
    throw new HttpError(400, `Cliente obrigatório no trecho ${expected.startTime}–${expected.endTime}.`);
  }
  if (rules.requiresPlate && !plate) {
    throw new HttpError(400, `Placa obrigatória no trecho ${expected.startTime}–${expected.endTime}.`);
  }
  if (rules.requiresNotes && !notes) {
    throw new HttpError(400, `Observação obrigatória no trecho ${expected.startTime}–${expected.endTime}.`);
  }
  return { ...expected, category, clientId, plate, notes };
}

async function buildAutomaticGapEvents(params: {
  preview: Awaited<ReturnType<typeof previewEventGap>>;
  rawJustifications: unknown[] | undefined;
  productiveEvent: Pick<EventInput, "pump" | "shiftDate" | "shiftType">;
  actor: { uid: string; email: string };
  createdAt: Timestamp;
  reconciledAfterEventId?: string | null;
}): Promise<Array<Omit<EventDoc, "containerCycleId" | "previousContainerEventId" | "containerStateVersion">>> {
  const supplied = Array.isArray(params.rawJustifications) ? params.rawJustifications : [];
  if (
    params.preview.requiresJustification &&
    supplied.length !== params.preview.uncoveredSegments.length
  ) {
    throw new HttpError(400, "Informe uma causa para cada trecho de ociosidade.");
  }

  return Promise.all(params.preview.uncoveredSegments.map(async (segment, index) => {
    const justification = params.preview.requiresJustification
      ? parseGapJustification(supplied[index], segment)
      : null;
    const category = justification?.category || "INTERVALO_OPERACIONAL";
    const clientNameSnapshot = await assertClientIfRequired(justification?.clientId || null);
    const startAt = Timestamp.fromDate(
      resolveTimelineDate(
        params.productiveEvent.shiftDate,
        params.productiveEvent.shiftType,
        segment.startTime
      ).toJSDate()
    );
    const endAt = Timestamp.fromDate(
      resolveTimelineDate(
        params.productiveEvent.shiftDate,
        params.productiveEvent.shiftType,
        segment.endTime
      ).toJSDate()
    );

    return {
      pump: params.productiveEvent.pump,
      shiftDate: params.productiveEvent.shiftDate,
      shiftType: params.productiveEvent.shiftType,
      startTime: segment.startTime,
      endTime: segment.endTime,
      category,
      clientId: justification?.clientId || null,
      plate: justification?.plate || null,
      container: null,
      containerStatus: null,
      containerReason: null,
      startsNewContainerCycle: false,
      blendConfirmed: false,
      notes: justification?.notes || null,
      productive: false,
      origin: "AUTO_GAP",
      generatedForEventId: null,
      gapSegmentId: segment.id,
      justificationWaived: !params.preview.requiresJustification,
      reconciledAfterEventId: params.reconciledAfterEventId || null,
      clientNameSnapshot,
      startAt,
      endAt,
      durationMinutes: segment.durationMinutes,
      createdByUid: params.actor.uid,
      createdByEmail: params.actor.email,
      updatedByUid: params.actor.uid,
      updatedByEmail: params.actor.email,
      createdAt: params.createdAt,
      updatedAt: params.createdAt,
      deleted: false,
      deletedAt: null,
      deletedByUid: null,
      deletedByEmail: null,
      deletedReason: null
    };
  }));
}

export async function updateEvent(
  eventId: string,
  raw: unknown,
  actor: { uid: string; email: string; role: UserDoc["role"] }
) {
  const ref = adminDb.collection("events").doc(eventId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Lançamento não encontrado.");
  }

  const existing = snap.data() as EventDoc;

  if (existing.deleted) {
    throw new HttpError(400, "Não é permitido editar lançamento excluído.");
  }

  const validated = validateEventInput(raw);
  const existingOrigin = existing.origin || "MANUAL";
  if (existingOrigin === "AUTO_GAP") {
    const changedDerivedField =
      existing.pump !== validated.event.pump ||
      existing.shiftDate !== validated.event.shiftDate ||
      existing.shiftType !== validated.event.shiftType ||
      existing.startTime !== validated.event.startTime ||
      existing.endTime !== validated.event.endTime;
    if (changedDerivedField) {
      throw new HttpError(400, "Horários de uma ociosidade automática são derivados e não podem ser editados.");
    }
    if (validated.productive) {
      throw new HttpError(400, "Uma ociosidade automática não pode ser convertida em produtivo.");
    }
  } else if (validated.event.category === "INTERVALO_OPERACIONAL") {
    throw new HttpError(400, "Intervalo operacional só pode ser gerado automaticamente.");
  }
  const clientNameSnapshot = await assertClientIfRequired(validated.event.clientId);

  const startAt = Timestamp.fromDate(new Date(validated.startAtIso));
  const endAt = Timestamp.fromDate(new Date(validated.endAtIso));
  const newLockRef = timelineLockRef(
    validated.event.shiftDate,
    validated.event.shiftType,
    validated.event.pump
  );
  const oldLockRef = timelineLockRef(existing.shiftDate, existing.shiftType, existing.pump);
  const lockBefore = await newLockRef.get();
  const expectedLockVersion = Number(lockBefore.data()?.version || 0);

  const rawGap = (raw || {}) as {
    gapVersion?: string;
    gapJustifications?: unknown[];
  };
  const gapPreview = validated.productive
    ? await previewEventGap({
        pump: validated.event.pump,
        shiftDate: validated.event.shiftDate,
        shiftType: validated.event.shiftType,
        startTime: validated.event.startTime,
        endTime: validated.event.endTime,
        eventId
      })
    : null;
  if (gapPreview && rawGap.gapVersion !== gapPreview.gapVersion) {
    throw new HttpError(409, "A linha do tempo desta bomba mudou. Revise o intervalo antes de salvar.");
  }
  const automaticEvents = gapPreview
    ? await buildAutomaticGapEvents({
        preview: gapPreview,
        rawJustifications: rawGap.gapJustifications,
        productiveEvent: validated.event,
        actor,
        createdAt: Timestamp.now()
      })
    : [];
  const linkedAutomaticSnap = await adminDb
    .collection("events")
    .where("generatedForEventId", "==", eventId)
    .get();

  await assertNoOverlap({
    pump: validated.event.pump,
    startAt,
    endAt,
    ignoreEventId: eventId
  });

  const sameContainer = existing.container === validated.event.container;
  const currentState = validated.event.container
    ? await getCurrentContainerState(validated.event.container)
    : null;
  const expectedVersion = validated.event.expectedContainerStateVersion;

  assertExpectedContainerStateVersion(
    expectedVersion,
    currentState?.version ?? 0
  );

  let containerCycleId = existing.containerCycleId || currentState?.cycleId || null;
  let previousContainerEventId = existing.previousContainerEventId || null;
  if (validated.event.containerStatus && validated.event.clientId) {
    if (!sameContainer || validated.event.startsNewContainerCycle) {
      const transition = resolveContainerTransition({
        current: sameContainer && currentState?.latestEventId === eventId ? null : currentState,
        status: validated.event.containerStatus,
        clientId: validated.event.clientId,
        startsNewCycle: validated.event.startsNewContainerCycle
      });
      containerCycleId = transition.cycleId;
      previousContainerEventId = transition.previousEventId;
    } else if (
      validated.event.containerStatus === "BLEND_FULL" ||
      validated.event.containerStatus === "BLEND_PARTIAL"
    ) {
      if (previousContainerEventId) {
        const previous = await adminDb.collection("events").doc(previousContainerEventId).get();
        const previousClientId = previous.data()?.clientId;
        if (previousClientId && previousClientId !== validated.event.clientId) {
          throw new HttpError(400, "Blend só pode ser formado com cargas do mesmo cliente.");
        }
      }
    }
  } else {
    containerCycleId = null;
    previousContainerEventId = null;
  }

  const {
    expectedContainerStateVersion: _expectedContainerStateVersion,
    ...validatedEventForStorage
  } = validated.event;
  void _expectedContainerStateVersion;
  const updatedPayload: Partial<EventDoc> & {
    updatedAt: FieldValue;
  } = {
    ...validatedEventForStorage,
    productive: validated.productive,
    origin: existingOrigin,
    clientNameSnapshot,
    containerCycleId,
    previousContainerEventId,
    containerStateVersion: currentState?.version ?? existing.containerStateVersion ?? null,
    startAt,
    endAt,
    durationMinutes: validated.durationMinutes,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email,
    updatedAt: FieldValue.serverTimestamp()
  };

  const comparableNext = {
    ...(existing as Record<string, unknown>),
    ...validatedEventForStorage,
    productive: validated.productive,
    clientNameSnapshot,
    startAt,
    endAt,
    durationMinutes: validated.durationMinutes,
    containerCycleId,
    previousContainerEventId,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email
  };

  const diff = collectChangedFields(existing as Record<string, unknown>, comparableNext);
  const revisionReason =
    (raw as { revisionReason?: string | null })?.revisionReason?.toString().trim() || null;
  const lifecycleFields = new Set([
    "container",
    "containerStatus",
    "containerReason",
    "containerCycleId",
    "previousContainerEventId",
    "clientId",
    "shiftDate",
    "shiftType",
    "startTime",
    "endTime"
  ]);

  if (diff.changedFields.some((field) => lifecycleFields.has(field)) && !revisionReason) {
    throw new HttpError(
      400,
      "Justificativa da edição é obrigatória ao alterar o ciclo do container."
    );
  }

  await adminDb.runTransaction(async (transaction) => {
    const newLockSnap = await transaction.get(newLockRef);
    const observedNewVersion = Number(newLockSnap.data()?.version || 0);
    if (observedNewVersion !== expectedLockVersion) {
      throw new HttpError(409, "A linha do tempo desta bomba mudou. Atualize e tente novamente.");
    }
    const oldLockSnap = oldLockRef.path === newLockRef.path
      ? newLockSnap
      : await transaction.get(oldLockRef);

    transaction.update(ref, updatedPayload);
    for (const linked of linkedAutomaticSnap.docs) {
      if (linked.data().deleted) continue;
      transaction.update(linked.ref, {
        deleted: true,
        deletedAt: FieldValue.serverTimestamp(),
        deletedByUid: actor.uid,
        deletedByEmail: actor.email,
        deletedReason: "Recalculado após edição do produtivo.",
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: actor.uid,
        updatedByEmail: actor.email
      });
    }
    for (const automatic of automaticEvents) {
      transaction.set(adminDb.collection("events").doc(), {
        ...automatic,
        generatedForEventId: eventId
      });
    }
    transaction.set(newLockRef, {
      version: observedNewVersion + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (oldLockRef.path !== newLockRef.path) {
      transaction.set(oldLockRef, {
        version: Number(oldLockSnap.data()?.version || 0) + 1,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });
  await Promise.all([
    rebuildContainerState(existing.container),
    existing.container === validated.event.container
      ? Promise.resolve()
      : rebuildContainerState(validated.event.container)
  ]);

  if (diff.changedFields.length) {
    await ref.collection("revisions").add({
      editedAt: FieldValue.serverTimestamp(),
      editedByUid: actor.uid,
      editedByEmail: actor.email,
      reason: revisionReason,
      changedFields: diff.changedFields,
      before: diff.before,
      after: diff.after
    });
  }

  const updated = await ref.get();

  return {
    id: updated.id,
    ...updated.data(),
    warnings: validated.warnings
  };
}

export async function softDeleteEvent(
  eventId: string,
  reason: string,
  actor: { uid: string; email: string },
  reconciliation?: { gapVersion?: string; gapJustifications?: unknown[] }
) {
  const ref = adminDb.collection("events").doc(eventId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Lançamento não encontrado.");
  }

  const trimmedReason = reason.trim();

  if (!trimmedReason) {
    throw new HttpError(400, "Motivo da exclusão é obrigatório.");
  }

  const existing = snap.data() as EventDoc;
  if ((existing.origin || "MANUAL") === "AUTO_GAP") {
    throw new HttpError(
      400,
      "Ociosidades automáticas são reconciliadas pelo produtivo vinculado e não podem ser excluídas diretamente."
    );
  }
  const linkedAutomaticSnap = await adminDb
    .collection("events")
    .where("generatedForEventId", "==", eventId)
    .get();
  const lockRef = timelineLockRef(existing.shiftDate, existing.shiftType, existing.pump);
  const lockBefore = await lockRef.get();
  const expectedLockVersion = Number(lockBefore.data()?.version || 0);
  const deletion = await prepareDeletionGap(eventId);
  if (reconciliation?.gapVersion !== deletion.preview.gapVersion) {
    throw new HttpError(
      409,
      "A linha do tempo mudou. Revise os intervalos que serão recalculados antes de excluir."
    );
  }
  const targetAutomaticSnap = deletion.target
    ? await adminDb
        .collection("events")
        .where("generatedForEventId", "==", deletion.target.id)
        .get()
    : null;
  const replacementEvents = deletion.target
    ? await buildAutomaticGapEvents({
        preview: deletion.preview,
        rawJustifications: reconciliation?.gapJustifications,
        productiveEvent: deletion.target,
        actor,
        createdAt: Timestamp.now(),
        reconciledAfterEventId: eventId
      })
    : [];

  await adminDb.runTransaction(async (transaction) => {
    const lockSnap = await transaction.get(lockRef);
    const observedLockVersion = Number(lockSnap.data()?.version || 0);
    if (observedLockVersion !== expectedLockVersion) {
      throw new HttpError(409, "A linha do tempo mudou durante a exclusão. Atualize e tente novamente.");
    }
    transaction.update(ref, {
      deleted: true,
      deletedAt: FieldValue.serverTimestamp(),
      deletedByUid: actor.uid,
      deletedByEmail: actor.email,
      deletedReason: trimmedReason,
      deletionReconciliationEventId: deletion.target?.id || null,
      deletionTimelineVersion: observedLockVersion + 1,
      updatedByUid: actor.uid,
      updatedByEmail: actor.email,
      updatedAt: FieldValue.serverTimestamp()
    });
    for (const linked of linkedAutomaticSnap.docs) {
      if (linked.data().deleted) continue;
      transaction.update(linked.ref, {
        deleted: true,
        deletedAt: FieldValue.serverTimestamp(),
        deletedByUid: actor.uid,
        deletedByEmail: actor.email,
        deletedReason: "Produtivo vinculado excluído.",
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    for (const linked of targetAutomaticSnap?.docs || []) {
      if (linked.data().deleted) continue;
      transaction.update(linked.ref, {
        deleted: true,
        deletedAt: FieldValue.serverTimestamp(),
        deletedByUid: actor.uid,
        deletedByEmail: actor.email,
        deletedReason: `Recalculado após exclusão do produtivo ${eventId}.`,
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    for (const replacement of replacementEvents) {
      transaction.set(adminDb.collection("events").doc(), {
        ...replacement,
        generatedForEventId: deletion.target?.id || null
      });
    }
    transaction.set(lockRef, {
      version: observedLockVersion + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await rebuildContainerState(existing.container);

  return { ok: true };
}

export async function restoreEvent(eventId: string, actor: { uid: string; email: string }) {
  const ref = adminDb.collection("events").doc(eventId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Lançamento não encontrado.");
  }

  const existing = snap.data() as EventDoc;
  if ((existing.origin || "MANUAL") === "AUTO_GAP") {
    throw new HttpError(
      400,
      "Restaure o produtivo vinculado para recuperar suas ociosidades automáticas."
    );
  }
  const lockRef = timelineLockRef(existing.shiftDate, existing.shiftType, existing.pump);
  const lockBefore = await lockRef.get();
  const expectedLockVersion = Number(lockBefore.data()?.version || 0);
  if (
    existing.deletionTimelineVersion !== null &&
    existing.deletionTimelineVersion !== undefined &&
    existing.deletionTimelineVersion !== expectedLockVersion
  ) {
    throw new HttpError(
      409,
      "A linha do tempo mudou desde a exclusão. Revise os intervalos antes de restaurar."
    );
  }
  const linkedAutomaticSnap = await adminDb
    .collection("events")
    .where("generatedForEventId", "==", eventId)
    .get();
  const replacementSnap = await adminDb
    .collection("events")
    .where("reconciledAfterEventId", "==", eventId)
    .get();
  const targetAutomaticSnap = existing.deletionReconciliationEventId
    ? await adminDb
        .collection("events")
        .where("generatedForEventId", "==", existing.deletionReconciliationEventId)
        .get()
    : null;
  const replacementIds = replacementSnap.docs
    .filter((doc) => !doc.data().deleted)
    .map((doc) => doc.id);
  const startAt = existing.startAt as Timestamp;
  const endAt = existing.endAt as Timestamp;
  await assertNoOverlap({
    pump: existing.pump,
    startAt,
    endAt,
    ignoreEventId: eventId,
    ignoreEventIds: replacementIds
  });
  await adminDb.runTransaction(async (transaction) => {
    const lockSnap = await transaction.get(lockRef);
    const observedLockVersion = Number(lockSnap.data()?.version || 0);
    if (observedLockVersion !== expectedLockVersion) {
      throw new HttpError(409, "A linha do tempo mudou durante a restauração. Atualize e tente novamente.");
    }
    transaction.update(ref, {
      deleted: false,
      deletedAt: null,
      deletedByUid: null,
      deletedByEmail: null,
      deletedReason: null,
      deletionReconciliationEventId: null,
      deletionTimelineVersion: null,
      updatedByUid: actor.uid,
      updatedByEmail: actor.email,
      updatedAt: FieldValue.serverTimestamp()
    });
    for (const linked of linkedAutomaticSnap.docs) {
      if (linked.data().deletedReason !== "Produtivo vinculado excluído.") continue;
      transaction.update(linked.ref, {
        deleted: false,
        deletedAt: null,
        deletedByUid: null,
        deletedByEmail: null,
        deletedReason: null,
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    for (const replacement of replacementSnap.docs) {
      if (replacement.data().deleted) continue;
      transaction.update(replacement.ref, {
        deleted: true,
        deletedAt: FieldValue.serverTimestamp(),
        deletedByUid: actor.uid,
        deletedByEmail: actor.email,
        deletedReason: "Removido após restauração do produtivo anterior.",
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    for (const linked of targetAutomaticSnap?.docs || []) {
      if (
        linked.data().deletedReason !==
        `Recalculado após exclusão do produtivo ${eventId}.`
      ) continue;
      transaction.update(linked.ref, {
        deleted: false,
        deletedAt: null,
        deletedByUid: null,
        deletedByEmail: null,
        deletedReason: null,
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    transaction.set(lockRef, {
      version: observedLockVersion + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await rebuildContainerState(existing.container);

  return { ok: true };
}

export async function listEvents(params: {
  role: UserDoc["role"];
  uid: string;
  filters: {
    dateFrom?: string;
    dateTo?: string;
    pump?: string;
    shiftType?: string;
    category?: string;
    clientId?: string;
    containerStatus?: string;
    includeDeleted?: boolean;
  };
}) {
  const { role, uid, filters } = params;

  let query = adminDb.collection("events") as FirebaseFirestore.Query;

  if (filters.dateFrom) {
    query = query.where("shiftDate", ">=", filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.where("shiftDate", "<=", filters.dateTo);
  }

  query =
    filters.dateFrom || filters.dateTo
      ? query.orderBy("shiftDate", "desc")
      : query.orderBy("createdAt", "desc");

  const snap = await query.limit(1000).get();

  const events = snap.docs
    .map((doc) => {
      const data = doc.data() as EventDoc;
      return {
        id: doc.id,
        ...data,
        startAt: data.startAt as Timestamp,
        endAt: data.endAt as Timestamp,
        createdAt: data.createdAt as Timestamp,
        containerStatus: eventContainerStatus(data),
        containerReason: data.containerReason || null,
        containerCycleId: data.containerCycleId || null,
        previousContainerEventId: data.previousContainerEventId || null,
        containerStateVersion: data.containerStateVersion ?? null,
        origin: data.origin || "MANUAL",
        generatedForEventId: data.generatedForEventId || null,
        gapSegmentId: data.gapSegmentId || null,
        justificationWaived: Boolean(data.justificationWaived),
        startsNewContainerCycle: Boolean(data.startsNewContainerCycle),
        blendConfirmed: Boolean(data.blendConfirmed)
      };
    });

  const visibleEvents = filterAndSortOperationalHistory(events, {
    role,
    uid,
    filters
  });

  const cycleIds = Array.from(
    new Set(
      visibleEvents
        .map((event) => event.containerCycleId)
        .filter((cycleId): cycleId is string => Boolean(cycleId))
    )
  );

  if (!cycleIds.length) {
    return visibleEvents.map((event) => ({
      ...event,
      previousContainerPassages: []
    }));
  }

  const cycleIdChunks = Array.from(
    { length: Math.ceil(cycleIds.length / 30) },
    (_, index) => cycleIds.slice(index * 30, index * 30 + 30)
  );
  const cycleSnaps = await Promise.all(
    cycleIdChunks.map((ids) =>
      adminDb
        .collection("events")
        .where("containerCycleId", "in", ids)
        .get()
    )
  );
  const cycleEvents = cycleSnaps.flatMap((cycleSnap) =>
    cycleSnap.docs.flatMap((doc): ContainerCycleHistoryEntry[] => {
      const data = doc.data() as EventDoc;
      const status = eventContainerStatus(data);
      if (!data.containerCycleId || !status) return [];

      return [{
        id: doc.id,
        containerCycleId: data.containerCycleId,
        previousContainerEventId: data.previousContainerEventId,
        startTime: data.startTime,
        endTime: data.endTime,
        pump: data.pump,
        plate: data.plate,
        status,
        deleted: data.deleted
      }];
    })
  );
  const cycleEventsById = new Map(
    cycleEvents.map((event) => [event.id, event])
  );

  return visibleEvents.map((event) => {
    const cycleEvent = cycleEventsById.get(event.id);
    return {
      ...event,
      previousContainerPassages: cycleEvent
        ? collectPreviousContainerPassages(cycleEvent, cycleEventsById)
        : []
    };
  });
}
