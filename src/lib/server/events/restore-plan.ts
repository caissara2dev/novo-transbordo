import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import { getCurrentContainerState } from "@/lib/server/container-states";
import {
  previewGapAfterEventOverride,
  timelineLockRef
} from "@/lib/server/gaps";
import { EventDoc } from "@/types/domain";

type RestoreReconciliation = {
  target: { id: string } & EventDoc;
  preview: Awaited<ReturnType<typeof previewGapAfterEventOverride>>;
};

export type RestorePlan = {
  event: EventDoc;
  lockVersion: number;
  gapVersion: string;
  changedSinceDeletion: boolean;
  expectedContainerStateVersion: number | null;
  reconciliations: RestoreReconciliation[];
};

export async function prepareRestoreEvent(
  eventId: string
): Promise<RestorePlan> {
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
  if (!existing.deleted) {
    throw new HttpError(400, "O lançamento não está excluído.");
  }

  const lockRef = timelineLockRef(
    existing.shiftDate,
    existing.shiftType,
    existing.pump
  );
  const [lockSnap, daySnap, currentContainerState] = await Promise.all([
    lockRef.get(),
    adminDb
      .collection("events")
      .where("shiftDate", "==", existing.shiftDate)
      .where("deleted", "==", false)
      .get(),
    existing.container
      ? getCurrentContainerState(existing.container)
      : Promise.resolve(null)
  ]);
  const lockVersion = Number(lockSnap.data()?.version || 0);
  const eventStartMs = (existing.startAt as Timestamp).toMillis();
  const nextProductive =
    daySnap.docs
      .flatMap((doc) => {
        const data = doc.data() as EventDoc;
        if (
          data.pump !== existing.pump ||
          data.shiftType !== existing.shiftType ||
          !(data.productive ?? data.category === "PRODUTIVO")
        ) {
          return [];
        }
        return [
          {
            id: doc.id,
            ...data,
            startMs: (data.startAt as Timestamp).toMillis()
          }
        ];
      })
      .filter((event) => event.startMs > eventStartMs)
      .sort((left, right) => left.startMs - right.startMs)[0] || null;
  const restoredEvent: EventDoc = {
    ...existing,
    deleted: false,
    deletedAt: null,
    deletedByUid: null,
    deletedByEmail: null,
    deletedReason: null
  };
  const nextTarget = nextProductive
    ? (({ startMs: _startMs, ...target }) => {
        void _startMs;
        return target;
      })(nextProductive)
    : null;
  const targets: Array<{ id: string } & EventDoc> = [
    ...((restoredEvent.productive ??
    restoredEvent.category === "PRODUTIVO")
      ? [{ id: eventId, ...restoredEvent }]
      : []),
    ...(nextTarget ? [nextTarget] : [])
  ];
  const reconciliations = await Promise.all(
    targets.map(async (target) => ({
      target,
      preview: await previewGapAfterEventOverride({
        targetId: target.id,
        target,
        overrideId: eventId,
        override: restoredEvent
      })
    }))
  );
  const gapVersion = createHash("sha256")
    .update(
      JSON.stringify([
        eventId,
        lockVersion,
        reconciliations.map(({ target, preview }) => [
          target.id,
          preview.gapVersion
        ])
      ])
    )
    .digest("hex")
    .slice(0, 24);

  return {
    event: existing,
    lockVersion,
    gapVersion,
    changedSinceDeletion:
      existing.deletionTimelineVersion !== null &&
      existing.deletionTimelineVersion !== undefined &&
      existing.deletionTimelineVersion !== lockVersion,
    expectedContainerStateVersion: existing.container
      ? currentContainerState?.version ?? 0
      : null,
    reconciliations
  };
}
