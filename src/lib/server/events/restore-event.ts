import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import { reconcileContainerTimelineInTransaction } from "@/lib/server/container-states";
import { timelineLockRef } from "@/lib/server/gaps";
import { EventDoc } from "@/types/domain";
import type { StoredCheckin } from "@/types/checkins";
import type { UserRole } from "@/types/domain";
import {
  assertNoOverlap,
  buildAutomaticGapEvents
} from "./policies";
import { prepareRestoreEvent } from "./restore-plan";

export async function previewEventRestore(eventId: string) {
  const plan = await prepareRestoreEvent(eventId);
  return {
    gapVersion: plan.gapVersion,
    changedSinceDeletion: plan.changedSinceDeletion,
    expectedContainerStateVersion: plan.expectedContainerStateVersion,
    reconciliations: plan.reconciliations.map(({ target, preview }) => ({
      eventId: target.id,
      preview
    }))
  };
}

export async function restoreEvent(
  eventId: string,
  actor: { uid: string; email: string; role: UserRole },
  reconciliation?: {
    gapVersion?: string;
    gapJustificationsByEvent?: Record<string, unknown[]>;
    expectedContainerStateVersion?: number | null;
  }
) {
  if (actor.role !== "ADMIN") {
    throw new HttpError(403, "Somente administradores podem restaurar lançamentos.");
  }
  const plan = await prepareRestoreEvent(eventId);
  const existing = plan.event;
  const ref = adminDb.collection("events").doc(eventId);
  const lockRef = timelineLockRef(
    existing.shiftDate,
    existing.shiftType,
    existing.pump
  );
  const explicitlyReconciled = Boolean(reconciliation?.gapVersion);

  if (
    existing.container &&
    reconciliation?.expectedContainerStateVersion !==
      plan.expectedContainerStateVersion
  ) {
    throw new HttpError(
      409,
      "O estado do container mudou desde a prévia. Atualize a restauração e tente novamente."
    );
  }
  if (
    plan.changedSinceDeletion &&
    reconciliation?.gapVersion !== plan.gapVersion
  ) {
    throw new HttpError(
      409,
      "A linha do tempo mudou desde a exclusão. Faça a prévia e confirme a reconciliação atual."
    );
  }
  if (
    explicitlyReconciled &&
    reconciliation?.gapVersion !== plan.gapVersion
  ) {
    throw new HttpError(
      409,
      "A linha do tempo mudou depois da prévia de restauração. Revise e tente novamente."
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
        .where(
          "generatedForEventId",
          "==",
          existing.deletionReconciliationEventId
        )
        .get()
    : null;
  const regeneratedEvents = explicitlyReconciled
    ? (
        await Promise.all(
          plan.reconciliations.map(({ target, preview }) =>
            buildAutomaticGapEvents({
              preview,
              rawJustifications:
                reconciliation?.gapJustificationsByEvent?.[target.id],
              productiveEvent: target,
              actor,
              createdAt: Timestamp.now(),
              reconciledAfterEventId:
                target.id === eventId ? null : eventId
            }).then((events) =>
              events.map((event) => ({
                event,
                generatedForEventId: target.id
              }))
            )
          )
        )
      ).flat()
    : [];
  const reconciledTargetSnaps = explicitlyReconciled
    ? await Promise.all(
        plan.reconciliations.map(({ target }) =>
          adminDb
            .collection("events")
            .where("generatedForEventId", "==", target.id)
            .get()
        )
      )
    : [];
  const automaticToRetire = new Map(
    [
      ...replacementSnap.docs,
      ...reconciledTargetSnaps.flatMap((targetSnap) => targetSnap.docs)
    ]
      .filter((doc) => !doc.data().deleted)
      .map((doc) => [doc.id, doc])
  );
  const ignoredEventIds = explicitlyReconciled
    ? Array.from(automaticToRetire.keys())
    : replacementSnap.docs
        .filter((doc) => !doc.data().deleted)
        .map((doc) => doc.id);
  const startAt = existing.startAt as Timestamp;
  const endAt = existing.endAt as Timestamp;
  const checkinRef = existing.checkInId
    ? adminDb.collection("checkins").doc(existing.checkInId)
    : null;
  const changedAtIso = new Date().toISOString();
  await assertNoOverlap({
    pump: existing.pump,
    startAt,
    endAt,
    ignoreEventId: eventId,
    ignoreEventIds: ignoredEventIds
  });
  await adminDb.runTransaction(async (transaction) => {
    const [lockSnap, checkinSnap] = await Promise.all([
      transaction.get(lockRef),
      checkinRef ? transaction.get(checkinRef) : Promise.resolve(null)
    ]);
    const observedLockVersion = Number(lockSnap.data()?.version || 0);
    if (observedLockVersion !== plan.lockVersion) {
      throw new HttpError(
        409,
        "A linha do tempo mudou durante a restauração. Atualize e tente novamente."
      );
    }
    const restoredEvent: EventDoc = {
      ...existing,
      deleted: false,
      deletedAt: null,
      deletedByUid: null,
      deletedByEmail: null,
      deletedReason: null
    };
    const transactionalCheckin = checkinSnap?.data() as
      | StoredCheckin
      | undefined;
    if (
      checkinRef &&
      (!checkinSnap?.exists ||
        !transactionalCheckin ||
        Boolean(transactionalCheckin.pendingOfficialMutation) ||
        transactionalCheckin.status !== "CHAMADO" ||
        transactionalCheckin.activeProductiveEventId !== null ||
        !Number.isInteger(transactionalCheckin.version))
    ) {
      throw new HttpError(
        409,
        "Este check-in já mudou de estado e o lançamento não pode ser restaurado.",
        { code: "CHECKIN_EVENT_MISMATCH" }
      );
    }
    const containerPlan = await reconcileContainerTimelineInTransaction({
      transaction,
      rawContainer: existing.container,
      override: { id: eventId, data: restoredEvent },
      expectedVersion: plan.expectedContainerStateVersion,
      reservedWrites:
        2 +
        (checkinRef ? 2 : 0) +
        (explicitlyReconciled
          ? automaticToRetire.size + regeneratedEvents.length
          : linkedAutomaticSnap.docs.filter(
              (doc) =>
                doc.data().deletedReason === "Produtivo vinculado excluído."
            ).length +
            replacementSnap.docs.filter((doc) => !doc.data().deleted).length +
            (targetAutomaticSnap?.docs.filter(
              (doc) =>
                doc.data().deletedReason ===
                `Recalculado após exclusão do produtivo ${eventId}.`
            ).length || 0))
    });
    transaction.update(ref, {
      deleted: false,
      deletedAt: null,
      deletedByUid: null,
      deletedByEmail: null,
      deletedReason: null,
      deletionReconciliationEventId: null,
      deletionTimelineVersion: null,
      containerCycleId: containerPlan.cycleId,
      previousContainerEventId: containerPlan.previousEventId,
      containerStateVersion: containerPlan.stateVersion,
      updatedByUid: actor.uid,
      updatedByEmail: actor.email,
      updatedAt: FieldValue.serverTimestamp()
    });
    if (checkinRef && transactionalCheckin) {
      const nextVersion = transactionalCheckin.version + 1;

      transaction.update(checkinRef, {
        status: "EM_DESCARGA",
        activeProductiveEventId: eventId,
        version: nextVersion,
        updatedAtIso: changedAtIso
      });
      transaction.create(checkinRef.collection("revisions").doc(), {
        action: "PRODUCTIVE_EVENT_RESTORED",
        source: "PRODUCTIVE_EVENT",
        eventId,
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: actor.role,
        reason: "Lançamento produtivo restaurado pelo administrador.",
        changedFields: ["status", "activeProductiveEventId"],
        fromStatus: "CHAMADO",
        toStatus: "EM_DESCARGA",
        previousStatus: "CHAMADO",
        newStatus: "EM_DESCARGA",
        previousVersion: transactionalCheckin.version,
        newVersion: nextVersion,
        createdAtIso: changedAtIso
      });
    }
    if (explicitlyReconciled) {
      for (const automatic of automaticToRetire.values()) {
        transaction.update(automatic.ref, {
          deleted: true,
          deletedAt: FieldValue.serverTimestamp(),
          deletedByUid: actor.uid,
          deletedByEmail: actor.email,
          deletedReason: "Recalculado após restauração.",
          updatedByUid: actor.uid,
          updatedByEmail: actor.email,
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      for (const regenerated of regeneratedEvents) {
        transaction.set(adminDb.collection("events").doc(), {
          ...regenerated.event,
          generatedForEventId: regenerated.generatedForEventId
        });
      }
    } else {
      for (const linked of linkedAutomaticSnap.docs) {
        if (
          linked.data().deletedReason !== "Produtivo vinculado excluído."
        ) {
          continue;
        }
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
        ) {
          continue;
        }
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

  return { ok: true };
}
