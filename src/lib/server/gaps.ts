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

  return analyzeGap({
    shiftDate: parsed.shiftDate,
    shiftType: parsed.shiftType,
    targetStartMs,
    toleranceMinutes: settings.idleToleranceMinutes,
    lockVersion: Number(lockSnap.data()?.version || 0),
    eventId: parsed.eventId,
    intervals
  });
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
