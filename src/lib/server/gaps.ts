import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { analyzeGap, TimelineInterval } from "@/lib/domain/gaps";
import { isValidHHMM, resolveTimelineDate } from "@/lib/domain/time";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import { EventDoc, GapPreview, Pump, ShiftType } from "@/types/domain";
import { getOperationalSettings } from "@/lib/server/operational-settings";

const previewSchema = z.object({
  pump: z.enum(["BOMBA_1", "BOMBA_2", "BOMBA_3"]),
  shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shiftType: z.enum(["MANHA", "NOITE"]),
  startTime: z.string(),
  endTime: z.string().optional(),
  eventId: z.string().trim().min(1).optional(),
  operation: z.enum(["UPSERT", "DELETE"]).optional()
});

export type GapPreviewInput = z.infer<typeof previewSchema>;

function timestampMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value && typeof value === "object" && "toMillis" in value) {
    return Number((value as { toMillis: () => number }).toMillis());
  }
  if (value && typeof value === "object" && "_seconds" in value) {
    return Number((value as { _seconds: number })._seconds) * 1000;
  }
  return 0;
}

export function timelineLockId(
  shiftDate: string,
  shiftType: ShiftType,
  pump: Pump
): string {
  return `${shiftDate}_${shiftType}_${pump}`;
}

export function timelineLockRef(
  shiftDate: string,
  shiftType: ShiftType,
  pump: Pump
) {
  return adminDb.collection("timelineLocks").doc(timelineLockId(shiftDate, shiftType, pump));
}

export async function loadTimeline(params: {
  shiftDate: string;
  shiftType: ShiftType;
  pump: Pump;
}): Promise<TimelineInterval[]> {
  const snap = await adminDb
    .collection("events")
    .where("shiftDate", "==", params.shiftDate)
    .where("deleted", "==", false)
    .get();

  return snap.docs.flatMap((doc) => {
    const data = doc.data() as EventDoc;
    if (data.pump !== params.pump || data.shiftType !== params.shiftType) return [];
    return [{
      id: doc.id,
      startMs: timestampMillis(data.startAt),
      endMs: timestampMillis(data.endAt),
      productive: data.productive ?? data.category === "PRODUTIVO",
      deleted: Boolean(data.deleted),
      origin: data.origin || "MANUAL",
      generatedForEventId: data.generatedForEventId || null,
      updatedAtMs: timestampMillis(data.updatedAt)
    }];
  });
}

export function parseGapPreviewInput(raw: unknown): GapPreviewInput {
  const parsed = previewSchema.parse(raw);
  if (!isValidHHMM(parsed.startTime)) {
    throw new HttpError(400, "Horário de início inválido.");
  }
  return parsed;
}

export async function previewEventGap(raw: unknown): Promise<GapPreview> {
  const parsed = parseGapPreviewInput(raw);
  if (parsed.operation === "DELETE") {
    if (!parsed.eventId) throw new HttpError(400, "Lançamento obrigatório para recalcular a exclusão.");
    return (await prepareDeletionGap(parsed.eventId)).preview;
  }
  const [settings, intervals, lockSnap] = await Promise.all([
    getOperationalSettings(),
    loadTimeline(parsed),
    timelineLockRef(parsed.shiftDate, parsed.shiftType, parsed.pump).get()
  ]);
  const targetStartMs = resolveTimelineDate(
    parsed.shiftDate,
    parsed.shiftType,
    parsed.startTime
  ).toMillis();

  const overlap = intervals.some(
    (item) =>
      item.id !== parsed.eventId &&
      item.origin !== "AUTO_GAP" &&
      item.startMs < targetStartMs &&
      item.endMs > targetStartMs
  );
  if (overlap) {
    throw new HttpError(409, "O início informado sobrepõe um lançamento existente.");
  }

  const preview = analyzeGap({
    shiftDate: parsed.shiftDate,
    shiftType: parsed.shiftType,
    targetStartMs,
    toleranceMinutes: settings.idleToleranceMinutes,
    lockVersion: Number(lockSnap.data()?.version || 0),
    eventId: parsed.eventId,
    intervals
  });
  if (!parsed.eventId) return preview;

  const existingSnap = await adminDb.collection("events").doc(parsed.eventId).get();
  if (!existingSnap.exists) {
    throw new HttpError(404, "Lançamento não encontrado.");
  }
  const existing = existingSnap.data() as EventDoc;
  const override: EventDoc = {
    ...existing,
    pump: parsed.pump,
    shiftDate: parsed.shiftDate,
    shiftType: parsed.shiftType,
    startTime: parsed.startTime,
    endTime: parsed.endTime || existing.endTime,
    startAt: Timestamp.fromDate(
      resolveTimelineDate(
        parsed.shiftDate,
        parsed.shiftType,
        parsed.startTime
      ).toJSDate()
    ),
    endAt: Timestamp.fromDate(
      resolveTimelineDate(
        parsed.shiftDate,
        parsed.shiftType,
        parsed.endTime || existing.endTime
      ).toJSDate()
    ),
    deleted: false
  };
  const following = await prepareFollowingGapsAfterOverride({
    eventId: parsed.eventId,
    existing,
    override
  });
  if (!following.length) return preview;

  return {
    ...preview,
    gapVersion: createHash("sha256")
      .update(
        JSON.stringify([
          preview.gapVersion,
          following.map(({ target, preview: nextPreview }) => [
            target.id,
            nextPreview.gapVersion
          ])
        ])
      )
      .digest("hex")
      .slice(0, 24),
    reconciliations: following.map(({ target, preview: nextPreview }) => ({
      eventId: target.id,
      preview: nextPreview
    }))
  };
}

export async function previewGapAfterEventOverride(params: {
  targetId: string;
  target: EventDoc;
  overrideId: string;
  override: EventDoc;
}): Promise<GapPreview> {
  const [settings, intervals, lockSnap] = await Promise.all([
    getOperationalSettings(),
    loadTimeline(params.target),
    timelineLockRef(
      params.target.shiftDate,
      params.target.shiftType,
      params.target.pump
    ).get()
  ]);
  const simulated = intervals
    .filter(
      (item) =>
        item.id !== params.overrideId &&
        item.generatedForEventId !== params.overrideId
    );
  if (
    params.override.shiftDate === params.target.shiftDate &&
    params.override.shiftType === params.target.shiftType &&
    params.override.pump === params.target.pump &&
    !params.override.deleted
  ) {
    simulated.push({
      id: params.overrideId,
      startMs: timestampMillis(params.override.startAt),
      endMs: timestampMillis(params.override.endAt),
      productive:
        params.override.productive ??
        params.override.category === "PRODUTIVO",
      deleted: false,
      origin: params.override.origin || "MANUAL",
      generatedForEventId: params.override.generatedForEventId || null,
      updatedAtMs: timestampMillis(params.override.updatedAt)
    });
  }

  return analyzeGap({
    shiftDate: params.target.shiftDate,
    shiftType: params.target.shiftType,
    targetStartMs: timestampMillis(params.target.startAt),
    toleranceMinutes: settings.idleToleranceMinutes,
    lockVersion: Number(lockSnap.data()?.version || 0),
    eventId: params.targetId,
    intervals: simulated
  });
}

export async function prepareFollowingGapsAfterOverride(params: {
  eventId: string;
  existing: EventDoc;
  override: EventDoc;
}): Promise<Array<{
  target: { id: string } & EventDoc;
  preview: GapPreview;
}>> {
  const timelines = [
    {
      shiftDate: params.existing.shiftDate,
      shiftType: params.existing.shiftType,
      pump: params.existing.pump,
      anchorMs: timestampMillis(params.existing.startAt)
    },
    {
      shiftDate: params.override.shiftDate,
      shiftType: params.override.shiftType,
      pump: params.override.pump,
      anchorMs: timestampMillis(params.override.startAt)
    }
  ].filter(
    (timeline, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.shiftDate === timeline.shiftDate &&
          candidate.shiftType === timeline.shiftType &&
          candidate.pump === timeline.pump
      ) === index
  );
  const targetById = new Map<string, { id: string } & EventDoc>();

  for (const timeline of timelines) {
    const daySnap = await adminDb
      .collection("events")
      .where("shiftDate", "==", timeline.shiftDate)
      .where("deleted", "==", false)
      .get();
    const next =
      daySnap.docs
        .flatMap((doc) => {
          const data = doc.data() as EventDoc;
          if (
            doc.id === params.eventId ||
            data.pump !== timeline.pump ||
            data.shiftType !== timeline.shiftType ||
            !(data.productive ?? data.category === "PRODUTIVO")
          ) {
            return [];
          }
          return [{
            id: doc.id,
            ...data,
            startMs: timestampMillis(data.startAt)
          }];
        })
        .filter((event) => event.startMs > timeline.anchorMs)
        .sort((left, right) => left.startMs - right.startMs)[0] || null;
    if (next) {
      const { startMs: _startMs, ...target } = next;
      void _startMs;
      targetById.set(target.id, target);
    }
  }

  return Promise.all(
    Array.from(targetById.values()).map(async (target) => ({
      target,
      preview: await previewGapAfterEventOverride({
        targetId: target.id,
        target,
        overrideId: params.eventId,
        override: params.override
      })
    }))
  );
}

export async function prepareDeletionGap(eventId: string): Promise<{
  preview: GapPreview;
  target: ({ id: string } & EventDoc) | null;
}> {
  const eventSnap = await adminDb.collection("events").doc(eventId).get();
  if (!eventSnap.exists) throw new HttpError(404, "Lançamento não encontrado.");
  const existing = eventSnap.data() as EventDoc;
  const [settings, intervals, lockSnap, daySnap] = await Promise.all([
    getOperationalSettings(),
    loadTimeline(existing),
    timelineLockRef(existing.shiftDate, existing.shiftType, existing.pump).get(),
    adminDb
      .collection("events")
      .where("shiftDate", "==", existing.shiftDate)
      .where("deleted", "==", false)
      .get()
  ]);
  const existingStartMs = timestampMillis(existing.startAt);
  const next = daySnap.docs
    .flatMap((doc) => {
      const data = doc.data() as EventDoc;
      if (
        doc.id === eventId ||
        data.pump !== existing.pump ||
        data.shiftType !== existing.shiftType ||
        !(data.productive ?? data.category === "PRODUTIVO")
      ) return [];
      return [{ id: doc.id, ...data, startMs: timestampMillis(data.startAt) }];
    })
    .filter((item) => item.startMs > existingStartMs)
    .sort((a, b) => a.startMs - b.startMs)[0] || null;

  if (!next) {
    const empty = analyzeGap({
      shiftDate: existing.shiftDate,
      shiftType: existing.shiftType,
      targetStartMs: existingStartMs,
      toleranceMinutes: settings.idleToleranceMinutes,
      lockVersion: Number(lockSnap.data()?.version || 0),
      eventId,
      intervals: intervals.filter(
        (item) => item.id !== eventId && item.generatedForEventId !== eventId
      )
    });
    return {
      preview: {
        ...empty,
        uncoveredSegments: [],
        uncoveredMinutes: 0,
        requiresJustification: false,
        reconciliationEventId: null
      },
      target: null
    };
  }

  const simulated = intervals.filter(
    (item) => item.id !== eventId && item.generatedForEventId !== eventId
  );
  const preview = analyzeGap({
    shiftDate: existing.shiftDate,
    shiftType: existing.shiftType,
    targetStartMs: next.startMs,
    toleranceMinutes: settings.idleToleranceMinutes,
    lockVersion: Number(lockSnap.data()?.version || 0),
    eventId: next.id,
    intervals: simulated
  });
  const { startMs: _startMs, ...target } = next;
  void _startMs;
  return {
    preview: { ...preview, reconciliationEventId: next.id },
    target
  };
}
