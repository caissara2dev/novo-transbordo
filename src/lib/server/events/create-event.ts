import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/domain/errors";
import { validateEventInput } from "@/lib/domain/validation";
import { adminDb } from "@/lib/firebase/admin";
import { reconcileEventContainerEffectsInTransaction } from "@/lib/server/container-event-effects";
import { resolveCheckinRuntimeConfig } from "@/lib/server/checkins/config";
import { previewEventGap, timelineLockRef } from "@/lib/server/gaps";
import type { StoredCheckin } from "@/types/checkins";
import { EventDoc, UserRole } from "@/types/domain";
import {
  assertClientIfRequired,
  assertNoOverlap,
  buildAutomaticGapEvents
} from "./policies";

type EventActor = {
  uid: string;
  email: string;
  role: UserRole;
};

type CheckinLinkPlan = {
  checkInId: string | null;
  expectedVersion: number | null;
  manualPlateReason: string | null;
  rawForValidation: unknown;
};

const CHECKIN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rawLinkFields(raw: unknown): {
  category: unknown;
  loadSourceType: unknown;
  checkInId: unknown;
  manualPlateReason: unknown;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      category: undefined,
      loadSourceType: undefined,
      checkInId: undefined,
      manualPlateReason: undefined
    };
  }
  const value = raw as Record<string, unknown>;
  return {
    category: value.category,
    loadSourceType: value.loadSourceType,
    checkInId: value.checkInId,
    manualPlateReason: value.manualPlateReason
  };
}

function normalizedOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function planCheckinLink(
  raw: unknown,
  actor: EventActor
): Promise<CheckinLinkPlan> {
  const fields = rawLinkFields(raw);
  const requestedCheckInId = normalizedOptionalText(fields.checkInId);
  const manualPlateReason = normalizedOptionalText(fields.manualPlateReason);
  const isContainerTransfer =
    fields.category === "PRODUTIVO" &&
    fields.loadSourceType === "BUFFER_CONTAINER";
  const mode = resolveCheckinRuntimeConfig(process.env).mode;

  // `off` is a true rollback switch: the additive fields are ignored and the
  // existing manual-plate creation behavior remains byte-for-byte compatible.
  if (mode === "off") {
    return {
      checkInId: null,
      expectedVersion: null,
      manualPlateReason: null,
      rawForValidation: raw
    };
  }

  if (requestedCheckInId && !CHECKIN_ID_PATTERN.test(requestedCheckInId)) {
    throw new HttpError(400, "Identificador interno do check-in é inválido.");
  }
  if (requestedCheckInId && actor.role === "DISPLAY") {
    throw new HttpError(403, "Este perfil não pode iniciar uma descarga.");
  }

  if (requestedCheckInId && fields.category !== "PRODUTIVO") {
    throw new HttpError(
      400,
      "Um check-in só pode ser vinculado a um lançamento produtivo."
    );
  }

  if (requestedCheckInId && isContainerTransfer) {
    throw new HttpError(
      400,
      "Um check-in de carreta não pode ser vinculado a uma transferência entre containers."
    );
  }

  if (isContainerTransfer) {
    return {
      checkInId: null,
      expectedVersion: null,
      manualPlateReason: null,
      rawForValidation: raw
    };
  }

  if (requestedCheckInId) {
    const snapshot = await adminDb
      .collection("checkins")
      .doc(requestedCheckInId)
      .get();
    const checkin = snapshot.data() as StoredCheckin | undefined;
    if (!snapshot.exists || !checkin || checkin.status !== "CHAMADO") {
      throw new HttpError(
        409,
        "O check-in não está disponível para iniciar a descarga.",
        { code: "CHECKIN_NOT_CALLED" }
      );
    }
    if (!checkin.plate || !Number.isInteger(checkin.version)) {
      throw new HttpError(409, "O check-in está incompleto ou inconsistente.");
    }

    return {
      checkInId: requestedCheckInId,
      expectedVersion: checkin.version,
      manualPlateReason: null,
      rawForValidation:
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>), plate: checkin.plate }
          : raw
    };
  }

  if (mode === "enforce" && fields.category === "PRODUTIVO") {
    if (actor.role !== "ADMIN") {
      throw new HttpError(
        409,
        "Selecione um check-in chamado antes de iniciar a descarga.",
        { code: "CHECKIN_NOT_CALLED" }
      );
    }
    if (!manualPlateReason) {
      throw new HttpError(
        400,
        "O motivo da placa manual é obrigatório nesta contingência."
      );
    }
  }

  return {
    checkInId: null,
    expectedVersion: null,
    manualPlateReason:
      mode === "enforce" && fields.category === "PRODUTIVO"
        ? manualPlateReason
        : null,
    rawForValidation: raw
  };
}

export async function createEvent(
  raw: unknown,
  actor: EventActor
) {
  const checkinLink = await planCheckinLink(raw, actor);
  const validated = validateEventInput(checkinLink.rawForValidation);
  if (validated.event.category === "INTERVALO_OPERACIONAL") {
    throw new HttpError(
      400,
      "Intervalo operacional só pode ser gerado automaticamente."
    );
  }
  const clientNameSnapshot = await assertClientIfRequired(
    validated.event.clientId
  );

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
    gapJustificationsByEvent?: Record<string, unknown[]>;
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
  const {
    expectedContainerStateVersion,
    expectedSourceContainerStateVersion,
    ...validatedEventForStorage
  } = validated.event;
  const payload: Omit<
    EventDoc,
    | "containerCycleId"
    | "previousContainerEventId"
    | "containerStateVersion"
    | "sourceContainerCycleId"
    | "previousSourceContainerEventId"
    | "sourceContainerStateVersion"
  > = {
    ...validatedEventForStorage,
    ...(checkinLink.checkInId
      ? { checkInId: checkinLink.checkInId, manualPlateReason: null }
      : checkinLink.manualPlateReason
        ? { checkInId: null, manualPlateReason: checkinLink.manualPlateReason }
        : {}),
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
  await adminDb.runTransaction(async (transaction) => {
    const checkinRef = checkinLink.checkInId
      ? adminDb.collection("checkins").doc(checkinLink.checkInId)
      : null;
    const [lockSnap, checkinSnapshot] = await Promise.all([
      transaction.get(lockRef),
      checkinRef ? transaction.get(checkinRef) : Promise.resolve(null)
    ]);
    const observedLockVersion = Number(lockSnap.data()?.version || 0);
    if (observedLockVersion !== expectedLockVersion) {
      throw new HttpError(
        409,
        "A linha do tempo desta bomba mudou. Atualize o intervalo e tente novamente."
      );
    }

    const transactionalCheckin = checkinSnapshot?.data() as
      | StoredCheckin
      | undefined;
    if (
      checkinRef &&
      (!checkinSnapshot?.exists ||
        !transactionalCheckin ||
        Boolean(transactionalCheckin.pendingOfficialMutation) ||
        transactionalCheckin.status !== "CHAMADO" ||
        transactionalCheckin.version !== checkinLink.expectedVersion)
    ) {
      throw new HttpError(
        409,
        "O check-in foi selecionado por outro lançamento. Atualize e tente novamente.",
        { code: "CHECKIN_NOT_CALLED" }
      );
    }

    const provisionalEvent = {
      ...payload,
      containerCycleId: null,
      previousContainerEventId: null,
      containerStateVersion: null,
      sourceContainerCycleId: null,
      previousSourceContainerEventId: null,
      sourceContainerStateVersion: null
    } satisfies EventDoc;
    const containerEffects = await reconcileEventContainerEffectsInTransaction({
      transaction,
      eventId: ref.id,
      before: null,
      after: provisionalEvent,
      expectedContainerStateVersion,
      expectedSourceContainerStateVersion,
      requireSourceCurrentlyOpen: true,
      reservedWrites: autoEvents.length + 2 + (checkinRef ? 2 : 0)
    });
    transaction.set(ref, {
      ...payload,
      ...containerEffects
    });

    for (const automatic of autoEvents) {
      transaction.set(adminDb.collection("events").doc(), {
        ...automatic,
        generatedForEventId: ref.id
      });
    }

    if (checkinRef && transactionalCheckin) {
      const nextVersion = transactionalCheckin.version + 1;
      const updatedAtIso = now.toDate().toISOString();

      // The event, the queue transition and its revision intentionally share
      // this transaction. A failure rolls all three back; Firestore retries make
      // two simultaneous selections converge on a single CHAMADO -> EM_DESCARGA.
      transaction.update(checkinRef, {
        status: "EM_DESCARGA",
        activeProductiveEventId: ref.id,
        version: nextVersion,
        updatedAtIso
      });
      transaction.create(checkinRef.collection("revisions").doc(), {
        action: "PRODUCTIVE_EVENT_LINKED",
        source: "PRODUCTIVE_EVENT",
        eventId: ref.id,
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: actor.role,
        reason: "Check-in selecionado no lançamento produtivo.",
        changedFields: ["status", "activeProductiveEventId"],
        fromStatus: "CHAMADO",
        toStatus: "EM_DESCARGA",
        previousStatus: "CHAMADO",
        newStatus: "EM_DESCARGA",
        previousVersion: transactionalCheckin.version,
        newVersion: nextVersion,
        createdAtIso: updatedAtIso
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
