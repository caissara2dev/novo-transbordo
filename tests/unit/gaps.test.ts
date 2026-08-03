import { describe, expect, it } from "vitest";
import { analyzeGap, subtractCoverage, TimelineInterval } from "@/lib/domain/gaps";
import { resolveTimelineDate } from "@/lib/domain/time";

const morning = (time: string) =>
  resolveTimelineDate("2026-07-27", "MANHA", time).toMillis();
const night = (time: string) =>
  resolveTimelineDate("2026-07-27", "NOITE", time).toMillis();

function preview(startTime: string, intervals: TimelineInterval[] = []) {
  return analyzeGap({
    shiftDate: "2026-07-27",
    shiftType: "MANHA",
    targetStartMs: morning(startTime),
    toleranceMinutes: 10,
    lockVersion: 0,
    intervals
  });
}

describe("automatic operational gaps", () => {
  it.each([
    ["06:00", 0, false],
    ["06:01", 1, false],
    ["06:10", 10, false],
    ["06:11", 11, true]
  ])("handles a first productive at %s", (startTime, minutes, required) => {
    const result = preview(startTime);
    expect(result.uncoveredMinutes).toBe(minutes);
    expect(result.requiresJustification).toBe(required);
    expect(result.uncoveredSegments).toHaveLength(minutes ? 1 : 0);
  });

  it("starts after the latest productive event", () => {
    const result = preview("08:10", [{
      id: "productive-1",
      startMs: morning("07:00"),
      endMs: morning("08:00"),
      productive: true
    }]);
    expect(result.uncoveredSegments).toEqual([{
      id: `${morning("08:00")}-${morning("08:10")}`,
      startTime: "08:00",
      endTime: "08:10",
      durationMinutes: 10
    }]);
  });

  it("subtracts total and partial manual coverage into separate segments", () => {
    const result = preview("08:30", [
      {
        id: "productive-1",
        startMs: morning("07:00"),
        endMs: morning("08:00"),
        productive: true
      },
      {
        id: "manual-1",
        startMs: morning("08:05"),
        endMs: morning("08:15"),
        productive: false,
        origin: "MANUAL"
      },
      {
        id: "deleted",
        startMs: morning("08:20"),
        endMs: morning("08:25"),
        productive: false,
        origin: "MANUAL",
        deleted: true
      }
    ]);
    expect(result.uncoveredMinutes).toBe(20);
    expect(result.requiresJustification).toBe(true);
    expect(result.uncoveredSegments.map((item) => [item.startTime, item.endTime])).toEqual([
      ["08:00", "08:05"],
      ["08:15", "08:30"]
    ]);
  });

  it("uses the night shift start and resolves segments after midnight", () => {
    const result = analyzeGap({
      shiftDate: "2026-07-27",
      shiftType: "NOITE",
      targetStartMs: night("00:10"),
      toleranceMinutes: 10,
      lockVersion: 2,
      intervals: [{
        id: "night-productive",
        startMs: night("23:40"),
        endMs: night("23:55"),
        productive: true
      }]
    });
    expect(result.uncoveredMinutes).toBe(15);
    expect(result.uncoveredSegments[0]).toMatchObject({
      startTime: "23:55",
      endTime: "00:10"
    });
  });

  it("merges overlapping coverage before calculating gaps", () => {
    expect(subtractCoverage(0, 100, [
      { startMs: 10, endMs: 40 },
      { startMs: 30, endMs: 70 }
    ])).toEqual([
      { startMs: 0, endMs: 10 },
      { startMs: 70, endMs: 100 }
    ]);
  });

  it("changes the version when timeline state changes", () => {
    const first = preview("06:10");
    const second = analyzeGap({
      shiftDate: "2026-07-27",
      shiftType: "MANHA",
      targetStartMs: morning("06:10"),
      toleranceMinutes: 10,
      lockVersion: 1,
      intervals: []
    });
    expect(second.gapVersion).not.toBe(first.gapVersion);
  });
});
