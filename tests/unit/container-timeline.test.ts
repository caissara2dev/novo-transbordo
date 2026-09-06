import { describe, expect, it } from "vitest";
import {
  assertTimelineTransactionWriteBudget,
  ContainerTimelineEvent,
  planContainerTimeline
} from "@/lib/domain/container-timeline";

const baseEvent = (
  overrides: Partial<ContainerTimelineEvent> &
    Pick<ContainerTimelineEvent, "id">
): ContainerTimelineEvent => {
  const { id, ...rest } = overrides;
  return {
    id,
    container: "ABCU 123456-0",
    status: "PARTIAL",
    clientId: "client-1",
    plate: "ABC-1234",
    pump: "BOMBA_1",
    operationalAtMs: 1_000,
    createdAtMs: 1_000,
    startsNewCycle: false,
    existingCycleId: null,
    ...rest
  };
};

describe("container timeline planner", () => {
  it("links a retroactive event to its operational predecessor instead of the future state", () => {
    const plan = planContainerTimeline({
      events: [
        baseEvent({
          id: "future",
          operationalAtMs: 3_000,
          status: "FULL",
          existingCycleId: "cycle-existing"
        }),
        baseEvent({
          id: "first",
          operationalAtMs: 1_000,
          existingCycleId: "cycle-existing"
        }),
        baseEvent({
          id: "retroactive",
          operationalAtMs: 2_000,
          status: "PARTIAL"
        })
      ],
      createCycleId: () => "cycle-new"
    });

    expect(plan.events).toMatchObject([
      {
        id: "first",
        containerCycleId: "cycle-existing",
        previousContainerEventId: null
      },
      {
        id: "retroactive",
        containerCycleId: "cycle-existing",
        previousContainerEventId: "first"
      },
      {
        id: "future",
        containerCycleId: "cycle-existing",
        previousContainerEventId: "retroactive"
      }
    ]);
    expect(plan.current?.id).toBe("future");
  });

  it("preserves the existing cycle when a retroactive event becomes its first passage", () => {
    const plan = planContainerTimeline({
      events: [
        baseEvent({
          id: "existing-first",
          operationalAtMs: 2_000,
          existingCycleId: "cycle-existing"
        }),
        baseEvent({
          id: "new-retroactive",
          operationalAtMs: 1_000,
          existingCycleId: null
        })
      ],
      createCycleId: () => "cycle-should-not-change"
    });

    expect(plan.events).toMatchObject([
      {
        id: "new-retroactive",
        containerCycleId: "cycle-existing",
        previousContainerEventId: null
      },
      {
        id: "existing-first",
        containerCycleId: "cycle-existing",
        previousContainerEventId: "new-retroactive"
      }
    ]);
  });

  it("rejects an edit that makes a downstream Blend belong to another client", () => {
    expect(() =>
      planContainerTimeline({
        events: [
          baseEvent({ id: "partial", clientId: "client-2" }),
          baseEvent({
            id: "blend",
            operationalAtMs: 2_000,
            status: "BLEND_FULL",
            clientId: "client-1"
          })
        ],
        createCycleId: () => "cycle-1"
      })
    ).toThrow("mesmo cliente");
  });

  it("rejects deleting the predecessor required by a downstream Blend", () => {
    expect(() =>
      planContainerTimeline({
        events: [
          baseEvent({
            id: "blend",
            status: "BLEND_FULL",
            operationalAtMs: 2_000
          })
        ],
        createCycleId: () => "cycle-1"
      })
    ).toThrow("Parcial ou Pulmão anterior");
  });

  it("relinks a restored historical event before validating the following Blend", () => {
    const plan = planContainerTimeline({
      events: [
        baseEvent({
          id: "partial-before",
          operationalAtMs: 1_000,
          existingCycleId: "cycle-1"
        }),
        baseEvent({
          id: "restored",
          operationalAtMs: 2_000
        }),
        baseEvent({
          id: "blend-after",
          status: "BLEND_FULL",
          operationalAtMs: 3_000
        })
      ],
      createCycleId: () => "cycle-new"
    });

    expect(plan.events[2]).toMatchObject({
      id: "blend-after",
      containerCycleId: "cycle-1",
      previousContainerEventId: "restored"
    });
  });

  it("uses creation order as the stable tie-breaker for equal operational times", () => {
    const plan = planContainerTimeline({
      events: [
        baseEvent({ id: "second", createdAtMs: 2_000 }),
        baseEvent({ id: "first", createdAtMs: 1_000 })
      ],
      createCycleId: () => "cycle-1"
    });

    expect(plan.events.map((event) => event.id)).toEqual(["first", "second"]);
    expect(plan.events[1].previousContainerEventId).toBe("first");
  });

  it("rejects reconciliation before it can exceed the conservative write budget", () => {
    expect(() =>
      assertTimelineTransactionWriteBudget({
        lifecycleWrites: 421,
        reservedWrites: 30
      })
    ).toThrow("450 escritas");
    expect(() =>
      assertTimelineTransactionWriteBudget({
        lifecycleWrites: 420,
        reservedWrites: 30
      })
    ).not.toThrow();
  });

  it("starts a new cycle automatically after a source container is emptied by transfer", () => {
    const plan = planContainerTimeline({
      events: [
        baseEvent({
          id: "buffer",
          status: "BUFFER",
          existingCycleId: "source-cycle"
        }),
        baseEvent({
          id: "emptied-transfer",
          status: "TRANSFER_EMPTIED",
          operationalAtMs: 2_000,
          existingCycleId: "source-cycle"
        }),
        baseEvent({
          id: "next-use",
          status: "PARTIAL",
          operationalAtMs: 3_000
        })
      ],
      createCycleId: () => "new-cycle"
    });

    expect(plan.events).toMatchObject([
      {
        id: "buffer",
        containerCycleId: "source-cycle",
        previousContainerEventId: null
      },
      {
        id: "emptied-transfer",
        containerCycleId: "source-cycle",
        previousContainerEventId: "buffer"
      },
      {
        id: "next-use",
        containerCycleId: "new-cycle",
        previousContainerEventId: null
      }
    ]);
  });

  it("treats each unlinked legacy closure as an independent cycle", () => {
    let cycleSequence = 0;
    const plan = planContainerTimeline({
      events: [
        baseEvent({
          id: "legacy-full-1",
          status: "FULL",
          legacyClosedCycleBoundary: true
        }),
        baseEvent({
          id: "legacy-full-2",
          status: "FULL",
          operationalAtMs: 2_000,
          legacyClosedCycleBoundary: true
        }),
        baseEvent({
          id: "modern-buffer",
          status: "BUFFER",
          operationalAtMs: 3_000,
          existingCycleId: "modern-cycle"
        })
      ],
      createCycleId: () => `legacy-cycle-${++cycleSequence}`
    });

    expect(plan.events).toMatchObject([
      {
        id: "legacy-full-1",
        containerCycleId: "legacy-cycle-1",
        previousContainerEventId: null
      },
      {
        id: "legacy-full-2",
        containerCycleId: "legacy-cycle-2",
        previousContainerEventId: null
      },
      {
        id: "modern-buffer",
        containerCycleId: "modern-cycle",
        previousContainerEventId: null
      }
    ]);
  });
});
