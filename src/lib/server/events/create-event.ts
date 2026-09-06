import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/domain/errors";
import { validateEventInput } from "@/lib/domain/validation";
import { adminDb } from "@/lib/firebase/admin";
import { reconcileEventContainerEffectsInTransaction } from "@/lib/server/container-event-effects";
import { previewEventGap, timelineLockRef } from "@/lib/server/gaps";
import { EventDoc } from "@/types/domain";
import {
  assertClientIfRequired,
  assertNoOverlap,
  buildAutomaticGapEvents
} from "./policies";

export async function createEvent(
  raw: unknown,
  actor: { uid: string; email: string }
) {
  const validated = validateEventInput(raw);
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
    expectedSourceContainerCycleId,
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
    const lockSnap = await transaction.get(lockRef);
    const observedLockVersion = Number(lockSnap.data()?.version || 0);
    if (observedLockVersion !== expectedLockVersion) {
      throw new HttpError(
        409,
        "A linha do tempo desta bomba mudou. Atualize o intervalo e tente novamente."
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
      expectedSourceContainerCycleId,
      requireSourceCurrentlyOpen: true,
      reservedWrites: autoEvents.length + 2
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
