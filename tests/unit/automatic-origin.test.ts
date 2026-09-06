import { describe, expect, it } from "vitest";
import {
  identifyLoadSource,
  isTransferSourceStatus
} from "@/lib/domain/container-transfer";
import {
  planContainerTimeline,
  ContainerTimelineEvent
} from "@/lib/domain/container-timeline";

describe("automatic origin and remaining source state", () => {
  it.each([
    ["", null],
    ["a", null],
    ["abc", null],
    ["1234", null],
    ["ABC?", null],
    ["ABCD", "BUFFER_CONTAINER"],
    ["msc-u6639870", "BUFFER_CONTAINER"],
    ["m s c u", "BUFFER_CONTAINER"],
    ["abc-1234", "TRUCK"],
    ["abc1d23", "TRUCK"]
  ])(
    "recognizes %s without completing or validating an identifier",
    (input, expected) => {
      expect(identifyLoadSource(input!)).toBe(expected);
    }
  );
  it.each(["FULL", "BLEND_FULL", "BLEND_PARTIAL", "TRANSFER_EMPTIED", null])(
    "excludes %s from origins",
    (status) => {
      expect(isTransferSourceStatus(status)).toBe(false);
    }
  );
  const entry = (
    id: string,
    time: number,
    status: ContainerTimelineEvent["status"],
    role?: "SOURCE"
  ): ContainerTimelineEvent => ({
    id,
    container: "ABCU 123456-0",
    clientId: "client",
    pump: "BOMBA_1",
    plate: null,
    operationalAtMs: time,
    createdAtMs: time,
    status,
    role,
    startsNewCycle: false,
    existingCycleId: "cycle"
  });
  it.each(["PARTIAL", "BUFFER"] as const)(
    "replays multiple remaining transfers from a %s predecessor",
    (status) => {
      const inputs = [
        entry("source", 1, status),
        entry("transfer-1", 2, "BUFFER", "SOURCE"),
        entry("transfer-2", 3, "BUFFER", "SOURCE")
      ];
      const plan = planContainerTimeline({
        events: inputs,
        createCycleId: () => "unused"
      });
      expect(plan.events.map((event) => event.status)).toEqual([
        status,
        status,
        status
      ]);
      expect(plan.events[2].previousContainerEventId).toBe("transfer-1");
      expect(inputs[1].status).toBe("BUFFER");
      expect(plan.current?.status).toBe(status);
    }
  );
  it("rejects a retroactive change that makes a later source ineligible", () => {
    expect(() =>
      planContainerTimeline({
        events: [
          entry("source", 1, "FULL"),
          entry("transfer", 2, "BUFFER", "SOURCE")
        ],
        createCycleId: () => "unused"
      })
    ).toThrow("Pulmão ou Parcial");
  });
});
