import { describe, expect, it } from "vitest";
import {
  collectPreviousContainerPassages,
  ContainerCycleHistoryEntry
} from "@/lib/domain/container-cycle-history";

function entry(
  id: string,
  previousContainerEventId: string | null,
  overrides: Partial<ContainerCycleHistoryEntry> = {}
): ContainerCycleHistoryEntry {
  return {
    id,
    containerCycleId: "cycle-1",
    previousContainerEventId,
    startTime: "17:00",
    endTime: "17:15",
    pump: "BOMBA_1",
    plate: "AAA-1A23",
    status: "PARTIAL",
    deleted: false,
    ...overrides
  };
}

describe("collectPreviousContainerPassages", () => {
  it("shows nothing on the first passage", () => {
    const first = entry("first", null);
    const events = new Map([[first.id, first]]);

    expect(collectPreviousContainerPassages(first, events)).toEqual([]);
  });

  it("lists only earlier passages of the same cycle in chronological order", () => {
    const first = entry("first", null);
    const second = entry("second", "first", {
      startTime: "17:18",
      endTime: "17:30",
      plate: "AAA-1B23",
      status: "BUFFER"
    });
    const current = entry("current", "second", {
      startTime: "17:35",
      endTime: "17:45",
      status: "FULL"
    });
    const events = new Map(
      [first, second, current].map((event) => [event.id, event])
    );

    expect(collectPreviousContainerPassages(current, events)).toEqual([
      {
        id: "first",
        startTime: "17:00",
        endTime: "17:15",
        pump: "BOMBA_1",
        plate: "AAA-1A23",
        status: "PARTIAL"
      },
      {
        id: "second",
        startTime: "17:18",
        endTime: "17:30",
        pump: "BOMBA_1",
        plate: "AAA-1B23",
        status: "BUFFER"
      }
    ]);
  });

  it("can follow a previous passage loaded outside the current filters", () => {
    const previous = entry("outside-filter", null, {
      startTime: "23:50",
      endTime: "00:05"
    });
    const current = entry("visible", "outside-filter", {
      startTime: "00:10",
      endTime: "00:20",
      status: "BLEND_FULL"
    });
    const events = new Map(
      [previous, current].map((event) => [event.id, event])
    );

    expect(collectPreviousContainerPassages(current, events)[0]?.id).toBe(
      "outside-filter"
    );
  });

  it("skips deleted passages while preserving the earlier chain", () => {
    const first = entry("first", null);
    const deleted = entry("deleted", "first", { deleted: true });
    const current = entry("current", "deleted", { status: "FULL" });
    const events = new Map(
      [first, deleted, current].map((event) => [event.id, event])
    );

    expect(collectPreviousContainerPassages(current, events).map((item) => item.id)).toEqual([
      "first"
    ]);
  });
});
