import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/domain/errors";
import {
  collectChangedFields,
  validateEventInput
} from "@/lib/domain/validation";
import { adminDb } from "@/lib/firebase/admin";
import { reconcileContainerTimelinesInTransaction } from "@/lib/server/container-states";
import { previewEventGap, timelineLockRef } from "@/lib/server/gaps";
import { EventDoc, UserDoc } from "@/types/domain";
import {
  assertClientIfRequired,
  assertNoOverlap,
  buildAutomaticGapEvents
} from "./policies";

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
  if (
    existing.checkInId &&
    (validated.event.category !== "PRODUTIVO" ||
      validated.event.plate !== existing.plate)
  ) {
    // The canonical plate belongs to the check-in. Detaching it through the
    // generic editor would leave EM_DESCARGA without an owning event; managers
    // must delete the mistaken event so the audited rollback can run.
    throw new HttpError(
      409,
      "Este lançamento está vinculado a um check-in. Exclua-o com motivo para devolver a carreta a chamado antes de corrigir a seleção."
    );
  }
  const existingOrigin = existing.origin || "MANUAL";
  if (existingOrigin === "AUTO_GAP") {
    const changedDerivedField =
      existing.pump !== validated.event.pump ||
      existing.shiftDate !== validated.event.shiftDate ||
      existing.shiftType !== validated.event.shiftType ||
      existing.startTime !== validated.event.startTime ||
      existing.endTime !== validated.event.endTime;
    if (changedDerivedField) {
      throw new HttpError(
        400,
        "Horários de uma ociosidade automática são derivados e não podem ser editados."
      );
    }
    if (validated.productive) {
      throw new HttpError(
        400,
        "Uma ociosidade automática não pode ser convertida em produtivo."
      );
    }
  } else if (validated.event.category === "INTERVALO_OPERACIONAL") {
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
  const newLockRef = timelineLockRef(
    validated.event.shiftDate,
    validated.event.shiftType,
    validated.event.pump
  );
  const oldLockRef = timelineLockRef(
    existing.shiftDate,
    existing.shiftType,
    existing.pump
  );
  const [lockBefore, oldLockBefore] = await Promise.all([
    newLockRef.get(),
    oldLockRef.path === newLockRef.path
      ? Promise.resolve(null)
      : oldLockRef.get()
  ]);
  const expectedLockVersion = Number(lockBefore.data()?.version || 0);
  const expectedOldLockVersion =
    oldLockBefore === null
      ? expectedLockVersion
      : Number(oldLockBefore.data()?.version || 0);

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
        endTime: validated.event.endTime,
        eventId
      })
    : null;
  if (gapPreview && rawGap.gapVersion !== gapPreview.gapVersion) {
    throw new HttpError(
      409,
      "A linha do tempo desta bomba mudou. Revise o intervalo antes de salvar."
    );
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
  const followingGapPlans = await Promise.all(
    (gapPreview?.reconciliations || []).map(async (reconciliation) => {
      const [targetSnap, linkedSnap] = await Promise.all([
        adminDb.collection("events").doc(reconciliation.eventId).get(),
        adminDb
          .collection("events")
          .where("generatedForEventId", "==", reconciliation.eventId)
          .get()
      ]);
      if (!targetSnap.exists || targetSnap.data()?.deleted) {
        throw new HttpError(
          409,
          "O próximo produtivo mudou durante a prévia. Atualize e tente novamente."
        );
      }
      const target = {
        id: targetSnap.id,
        ...(targetSnap.data() as EventDoc)
      };
      const supplied =
        rawGap.gapJustificationsByEvent?.[reconciliation.eventId] ||
        reconciliation.preview.uncoveredSegments.map((segment) => {
          const previous = linkedSnap.docs.find(
            (doc) =>
              !doc.data().deleted && doc.data().gapSegmentId === segment.id
          );
          return previous
            ? {
                ...segment,
                category: previous.data().category,
                clientId: previous.data().clientId || null,
                plate: previous.data().plate || null,
                notes: previous.data().notes || null
              }
            : null;
        });
      const events = await buildAutomaticGapEvents({
        preview: reconciliation.preview,
        rawJustifications: supplied,
        productiveEvent: target,
        actor,
        createdAt: Timestamp.now(),
        reconciledAfterEventId: eventId
      });
      return { target, linkedSnap, events };
    })
  );
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

  const {
    expectedContainerStateVersion: _expectedContainerStateVersion,
    ...validatedEventForStorage
  } = validated.event;
  void _expectedContainerStateVersion;
  const sameContainer = existing.container === validated.event.container;
  const canPreserveCycle =
    sameContainer &&
    Boolean(existing.containerCycleId) &&
    Boolean(existing.startsNewContainerCycle) ===
      validated.event.startsNewContainerCycle;
  const provisionalEvent: EventDoc = {
    ...existing,
    ...validatedEventForStorage,
    productive: validated.productive,
    origin: existingOrigin,
    clientNameSnapshot,
    containerCycleId: canPreserveCycle ? existing.containerCycleId : null,
    previousContainerEventId: null,
    containerStateVersion: existing.containerStateVersion ?? null,
    startAt,
    endAt,
    durationMinutes: validated.durationMinutes,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email,
    updatedAt: existing.updatedAt
  };

  const preliminaryDiff = collectChangedFields(
    existing as Record<string, unknown>,
    provisionalEvent as unknown as Record<string, unknown>
  );
  const revisionReason =
    (raw as { revisionReason?: string | null })?.revisionReason
      ?.toString()
      .trim() || null;
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

  if (
    preliminaryDiff.changedFields.some((field) =>
      lifecycleFields.has(field)
    ) &&
    !revisionReason
  ) {
    throw new HttpError(
      400,
      "Justificativa da edição é obrigatória ao alterar o ciclo do container."
    );
  }

  await adminDb.runTransaction(async (transaction) => {
    const [newLockSnap, transactionalEventSnap] = await Promise.all([
      transaction.get(newLockRef),
      transaction.get(ref)
    ]);
    const observedNewVersion = Number(newLockSnap.data()?.version || 0);
    if (observedNewVersion !== expectedLockVersion) {
      throw new HttpError(
        409,
        "A linha do tempo desta bomba mudou. Atualize e tente novamente."
      );
    }
    if (
      !transactionalEventSnap.exists ||
      transactionalEventSnap.data()?.deleted
    ) {
      throw new HttpError(
        409,
        "O lançamento mudou durante a edição. Atualize e tente novamente."
      );
    }
    const oldLockSnap =
      oldLockRef.path === newLockRef.path
        ? newLockSnap
        : await transaction.get(oldLockRef);
    if (
      oldLockRef.path !== newLockRef.path &&
      Number(oldLockSnap.data()?.version || 0) !== expectedOldLockVersion
    ) {
      throw new HttpError(
        409,
        "A linha do tempo original mudou. Atualize e tente novamente."
      );
    }

    const removalChanges: Parameters<
      typeof reconcileContainerTimelinesInTransaction
    >[0]["changes"] =
      existing.container && !sameContainer
        ? [
            {
              rawContainer: existing.container,
              override: { id: eventId, data: null }
            }
          ]
        : [];
    const targetPlanIndex = validated.event.container
      ? removalChanges.length
      : -1;
    const changes: Parameters<
      typeof reconcileContainerTimelinesInTransaction
    >[0]["changes"] = validated.event.container
      ? [
          ...removalChanges,
          {
            rawContainer: validated.event.container,
            override: { id: eventId, data: provisionalEvent },
            expectedVersion: validated.event.expectedContainerStateVersion
          }
        ]
      : removalChanges;
    const containerPlans = await reconcileContainerTimelinesInTransaction({
      transaction,
      changes,
      reservedWrites:
        1 +
        linkedAutomaticSnap.docs.filter((doc) => !doc.data().deleted).length +
        automaticEvents.length +
        followingGapPlans.reduce(
          (total, following) =>
            total +
            following.linkedSnap.docs.filter((doc) => !doc.data().deleted)
              .length +
            following.events.length,
          0
        ) +
        (oldLockRef.path === newLockRef.path ? 1 : 2) +
        1
    });
    const targetPlan =
      targetPlanIndex >= 0 ? containerPlans[targetPlanIndex] : null;
    const nextEvent: EventDoc = {
      ...provisionalEvent,
      containerCycleId: targetPlan?.cycleId || null,
      previousContainerEventId: targetPlan?.previousEventId || null,
      containerStateVersion: targetPlan?.stateVersion || null
    };
    const diff = collectChangedFields(
      transactionalEventSnap.data() as Record<string, unknown>,
      nextEvent as unknown as Record<string, unknown>
    );

    transaction.update(ref, {
      ...validatedEventForStorage,
      productive: validated.productive,
      origin: existingOrigin,
      clientNameSnapshot,
      containerCycleId: nextEvent.containerCycleId,
      previousContainerEventId: nextEvent.previousContainerEventId,
      containerStateVersion: nextEvent.containerStateVersion,
      startAt,
      endAt,
      durationMinutes: validated.durationMinutes,
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
    for (const following of followingGapPlans) {
      for (const linked of following.linkedSnap.docs) {
        if (linked.data().deleted) continue;
        transaction.update(linked.ref, {
          deleted: true,
          deletedAt: FieldValue.serverTimestamp(),
          deletedByUid: actor.uid,
          deletedByEmail: actor.email,
          deletedReason: `Recalculado após edição do produtivo ${eventId}.`,
          updatedAt: FieldValue.serverTimestamp(),
          updatedByUid: actor.uid,
          updatedByEmail: actor.email
        });
      }
      for (const automatic of following.events) {
        transaction.set(adminDb.collection("events").doc(), {
          ...automatic,
          generatedForEventId: following.target.id
        });
      }
    }
    transaction.set(
      newLockRef,
      {
        version: observedNewVersion + 1,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    if (oldLockRef.path !== newLockRef.path) {
      transaction.set(
        oldLockRef,
        {
          version: Number(oldLockSnap.data()?.version || 0) + 1,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
    if (diff.changedFields.length) {
      transaction.set(ref.collection("revisions").doc(), {
        editedAt: FieldValue.serverTimestamp(),
        editedByUid: actor.uid,
        editedByEmail: actor.email,
        reason: revisionReason,
        changedFields: diff.changedFields,
        before: diff.before,
        after: diff.after
      });
    }
  });

  const updated = await ref.get();

  return {
    id: updated.id,
    ...updated.data(),
    warnings: validated.warnings
  };
}
