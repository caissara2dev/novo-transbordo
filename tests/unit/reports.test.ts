import { describe, expect, it } from "vitest";
import { buildTrendBucket, computeAggregate, deltaPercent, previousWindow } from "@/lib/server/reports";

function makeEvent(overrides: Record<string, unknown>) {
  return {
    id: "e1",
    shiftDate: "2026-02-09",
    shiftType: "MANHA",
    pump: "BOMBA_1",
    category: "PRODUTIVO",
    productive: true,
    durationMinutes: 30,
    startTime: "09:00",
    endTime: "09:30",
    clientId: null,
    clientNameSnapshot: null,
    plate: null,
    container: null,
    notes: null,
    createdByEmail: "u@test.com",
    updatedByEmail: "u@test.com",
    createdAtMs: 1,
    updatedAtMs: 1,
    deleted: false,
    deletedAtMs: null,
    deletedReason: null,
    ...overrides
  } as any;
}

describe("reports math", () => {
  it("computes KPI aggregates by minutes and event counts", () => {
    const result = computeAggregate([
      makeEvent({ productive: true, category: "PRODUTIVO", durationMinutes: 30 }),
      makeEvent({ productive: false, category: "SEM_CAMINHAO", durationMinutes: 20 }),
      makeEvent({ productive: false, category: "OUTROS", durationMinutes: 10 })
    ]);

    expect(result.totalMinutes).toBe(60);
    expect(result.productiveMinutes).toBe(30);
    expect(result.idleMinutes).toBe(30);
    expect(result.totalEvents).toBe(3);
    expect(result.productiveEvents).toBe(1);
    expect(result.productiveRateMinutes).toBe(50);
    expect(result.productiveRateEvents).toBeCloseTo(33.33, 2);
  });

  it("computes average productive transbordo using only PRODUTIVO", () => {
    const result = computeAggregate([
      makeEvent({ productive: true, category: "PRODUTIVO", durationMinutes: 20 }),
      makeEvent({ productive: true, category: "PRODUTIVO", durationMinutes: 40 }),
      makeEvent({ productive: false, category: "EM_TRANSITO", durationMinutes: 120 })
    ]);

    expect(result.avgProductiveTransbordoMinutes).toBe(30);
  });

  it("calculates delta percent and handles previous zero", () => {
    expect(deltaPercent(120, 100)).toBe(20);
    expect(deltaPercent(80, 100)).toBe(-20);
    expect(deltaPercent(0, 0)).toBeNull();
  });

  it("builds trend buckets for day week and month", () => {
    const day = buildTrendBucket("2026-02-11", "day");
    const week = buildTrendBucket("2026-02-11", "week");
    const month = buildTrendBucket("2026-02-11", "month");

    expect(day.bucket).toBe("2026-02-11");
    expect(week.bucket).toBe("2026-02-09");
    expect(week.label).toContain("09/02");
    expect(month.bucket).toBe("2026-02");
    expect(month.label).toBe("02/2026");
  });

  it("builds previous equivalent period", () => {
    const window = previousWindow("2026-02-10", "2026-02-16");
    expect(window.previousFrom).toBe("2026-02-03");
    expect(window.previousTo).toBe("2026-02-09");
  });
});
