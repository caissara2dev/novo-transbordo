import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import { reconcileEventContainerEffectsInTransaction } from "@/lib/server/container-event-effects";
import { prepareDeletionGap, timelineLockRef } from "@/lib/server/gaps";
import type { StoredCheckin } from "@/types/checkins";
import { EventDoc, UserRole } from "@/types/domain";
import { buildAutomaticGapEvents } from "./policies";

export async function softDeleteEvent(
  eventId: string,
  reason: string,
  actor: { uid: string; email: string; role: UserRole },
  reconciliation?: { gapVersion?: string; gapJustifications?: unknown[] }
) {
  if (actor.role !== "SUPERVISOR" && actor.role !== "ADMIN") {
    throw new HttpError(403, "Este perfil não pode excluir lançamentos.");
  }
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
  const lockRef = timelineLockRef(
    existing.shiftDate,
    existing.shiftType,
    existing.pump
  );
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
  const checkinRef = existing.checkInId
    ? adminDb.collection("checkins").doc(existing.checkInId)
    : null;
  const changedAtIso = new Date().toISOString();

  await adminDb.runTransaction(async (transaction) => {
    const [lockSnap, checkinSnap] = await Promise.all([
      transaction.get(lockRef),
      checkinRef ? transaction.get(checkinRef) : Promise.resolve(null)
    ]);
    const observedLockVersion = Number(lockSnap.data()?.version || 0);
    if (observedLockVersion !== expectedLockVersion) {
      throw new HttpError(
        409,
        "A linha do tempo mudou durante a exclusão. Atualize e tente novamente."
      );
    }
    await reconcileEventContainerEffectsInTransaction({
      transaction,
      eventId,
      before: existing,
      after: null,
      reservedWrites:
        2 +
        linkedAutomaticSnap.docs.filter((doc) => !doc.data().deleted).length +
        (targetAutomaticSnap?.docs.filter((doc) => !doc.data().deleted)
          .length || 0) +
        replacementEvents.length +
        (checkinRef ? 2 : 0)
    });
    const transactionalCheckin = checkinSnap?.data() as
      | StoredCheckin
      | undefined;
    if (
      checkinRef &&
      (!checkinSnap?.exists ||
        !transactionalCheckin ||
        Boolean(transactionalCheckin.pendingOfficialMutation) ||
        transactionalCheckin.status !== "EM_DESCARGA" ||
        transactionalCheckin.activeProductiveEventId !== eventId ||
        !Number.isInteger(transactionalCheckin.version))
    ) {
      throw new HttpError(
        409,
        "O vínculo deste check-in mudou. Atualize a fila antes de excluir o lançamento.",
        { code: "CHECKIN_EVENT_MISMATCH" }
      );
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
    if (checkinRef && transactionalCheckin) {
      const nextVersion = transactionalCheckin.version + 1;

      // Releasing the queue entry is atomic with the soft deletion. This
      // prevents a deleted event from leaving the truck stuck in EM_DESCARGA.
      transaction.update(checkinRef, {
        status: "CHAMADO",
        activeProductiveEventId: null,
        version: nextVersion,
        updatedAtIso: changedAtIso
      });
      transaction.create(checkinRef.collection("revisions").doc(), {
        action: "PRODUCTIVE_EVENT_UNLINKED",
        source: "PRODUCTIVE_EVENT",
        eventId,
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: actor.role,
        reason: trimmedReason,
        changedFields: ["status", "activeProductiveEventId"],
        fromStatus: "EM_DESCARGA",
        toStatus: "CHAMADO",
        previousStatus: "EM_DESCARGA",
        newStatus: "CHAMADO",
        previousVersion: transactionalCheckin.version,
        newVersion: nextVersion,
        createdAtIso: changedAtIso
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

  return { ok: true };
}
