import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { SHIFT_WINDOWS, TZ } from "@/lib/domain/constants";
import { resolveTimelineDate } from "@/lib/domain/time";
import { GapPreview, GapSegment, ShiftType } from "@/types/domain";

export type TimelineInterval = {
  id: string;
  startMs: number;
  endMs: number;
  productive: boolean;
  deleted?: boolean;
  origin?: "MANUAL" | "AUTO_GAP";
  generatedForEventId?: string | null;
  updatedAtMs?: number;
};

export function segmentId(startMs: number, endMs: number): string {
  return `${startMs}-${endMs}`;
}

function toTime(ms: number): string {
  return DateTime.fromMillis(ms, { zone: TZ }).toFormat("HH:mm");
}

export function subtractCoverage(
  rangeStartMs: number,
  rangeEndMs: number,
  coverage: Array<{ startMs: number; endMs: number }>
): Array<{ startMs: number; endMs: number }> {
  if (rangeEndMs <= rangeStartMs) return [];

  const merged = coverage
    .map((item) => ({
      startMs: Math.max(rangeStartMs, item.startMs),
      endMs: Math.min(rangeEndMs, item.endMs)
    }))
    .filter((item) => item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs)
    .reduce<Array<{ startMs: number; endMs: number }>>((acc, item) => {
      const previous = acc.at(-1);
      if (!previous || item.startMs > previous.endMs) {
        acc.push({ ...item });
      } else {
        previous.endMs = Math.max(previous.endMs, item.endMs);
      }
      return acc;
    }, []);

  const gaps: Array<{ startMs: number; endMs: number }> = [];
  let cursor = rangeStartMs;
  for (const item of merged) {
    if (item.startMs > cursor) gaps.push({ startMs: cursor, endMs: item.startMs });
    cursor = Math.max(cursor, item.endMs);
  }
  if (cursor < rangeEndMs) gaps.push({ startMs: cursor, endMs: rangeEndMs });
  return gaps;
}

export function timelineVersion(params: {
  lockVersion: number;
  toleranceMinutes: number;
  targetStartMs: number;
  eventId?: string;
  intervals: TimelineInterval[];
}): string {
  const stable = params.intervals
    .filter((item) => !item.deleted)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => [
      item.id,
      item.startMs,
      item.endMs,
      item.productive,
      item.origin || "MANUAL",
      item.generatedForEventId || "",
      item.updatedAtMs || 0
    ]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.lockVersion,
        params.toleranceMinutes,
        params.targetStartMs,
        params.eventId || "",
        stable
      ])
    )
    .digest("hex")
    .slice(0, 24);
}

export function analyzeGap(params: {
  shiftDate: string;
  shiftType: ShiftType;
  targetStartMs: number;
  toleranceMinutes: number;
  lockVersion: number;
  eventId?: string;
  intervals: TimelineInterval[];
}): GapPreview {
  const active = params.intervals.filter(
    (item) =>
      !item.deleted &&
      item.id !== params.eventId &&
      (!params.eventId || item.generatedForEventId !== params.eventId)
  );
  const previousProductive = active
    .filter((item) => item.productive && item.endMs <= params.targetStartMs)
    .sort((a, b) => b.endMs - a.endMs)[0];
  const shiftStartMs = resolveTimelineDate(
    params.shiftDate,
    params.shiftType,
    SHIFT_WINDOWS[params.shiftType].start
  ).toMillis();
  const gapStartMs = Math.max(shiftStartMs, previousProductive?.endMs ?? shiftStartMs);

  const coverage = active
    .filter(
      (item) =>
        !item.productive &&
        item.origin !== "AUTO_GAP" &&
        item.startMs < params.targetStartMs &&
        item.endMs > gapStartMs
    )
    .map((item) => ({ startMs: item.startMs, endMs: item.endMs }));

  const uncovered = subtractCoverage(gapStartMs, params.targetStartMs, coverage);
  const segments: GapSegment[] = uncovered.map((item) => ({
    id: segmentId(item.startMs, item.endMs),
    startTime: toTime(item.startMs),
    endTime: toTime(item.endMs),
    durationMinutes: Math.floor((item.endMs - item.startMs) / 60_000)
  })).filter((item) => item.durationMinutes > 0);
  const uncoveredMinutes = segments.reduce((total, item) => total + item.durationMinutes, 0);

  return {
    toleranceMinutes: params.toleranceMinutes,
    gapVersion: timelineVersion({
      lockVersion: params.lockVersion,
      toleranceMinutes: params.toleranceMinutes,
      targetStartMs: params.targetStartMs,
      eventId: params.eventId,
      intervals: active
    }),
    uncoveredSegments: segments,
    uncoveredMinutes,
    requiresJustification: uncoveredMinutes > params.toleranceMinutes
  };
}
