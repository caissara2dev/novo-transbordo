import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";

const firestoreState = vi.hoisted(() => ({
  docs: [] as Array<{ id: string; data: () => Record<string, unknown> }>
}));

vi.mock("@/lib/firebase/admin", () => {
  const query = {
    where: vi.fn(() => query),
    limit: vi.fn(() => query),
    get: vi.fn(async () => ({ docs: firestoreState.docs }))
  };

  return {
    adminDb: {
      collection: vi.fn(() => query)
    }
  };
});

import { exportReportsCsv, getReportsDrilldown } from "@/lib/server/reports";
import { ReportsFilters } from "@/lib/server/reports-filters";

const filters: ReportsFilters = {
  dateFrom: "2026-02-09",
  dateTo: "2026-02-09",
  granularity: "day",
  includeDeleted: false
};

function eventDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    data: () => ({
      shiftDate: "2026-02-09",
      shiftType: "NOITE",
      pump: "BOMBA_1",
      category: "PRODUTIVO",
      durationMinutes: 10,
      startTime: "23:00",
      endTime: "23:10",
      startAt: Timestamp.fromDate(new Date("2026-02-10T02:00:00.000Z")),
      deleted: false,
      createdAt: Timestamp.fromMillis(1),
      updatedAt: Timestamp.fromMillis(1),
      createdByEmail: "operator@example.com",
      updatedByEmail: "operator@example.com",
      ...overrides
    })
  };
}

describe("reports data integrity", () => {
  beforeEach(() => {
    firestoreState.docs = [];
  });

  it("treats a legacy PRODUTIVO event without the productive field as productive", async () => {
    firestoreState.docs = [eventDoc("legacy")];

    const result = await getReportsDrilldown({
      filters,
      source: "kpi",
      cursor: 0,
      limit: 20
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].productive).toBe(true);
  });

  it("orders night-shift events by their operational instant across midnight", async () => {
    firestoreState.docs = [
      eventDoc("before-midnight", {
        startTime: "23:55",
        endTime: "23:59",
        startAt: Timestamp.fromDate(new Date("2026-02-10T02:55:00.000Z"))
      }),
      eventDoc("after-midnight", {
        startTime: "00:05",
        endTime: "00:10",
        startAt: Timestamp.fromDate(new Date("2026-02-10T03:05:00.000Z"))
      })
    ];

    const result = await getReportsDrilldown({
      filters,
      source: "kpi",
      cursor: 0,
      limit: 20
    });

    expect(result.rows.map((row) => row.id)).toEqual([
      "after-midnight",
      "before-midnight"
    ]);
  });

  it.each(["=2+2", "+2+2", "-2+2", "@SUM(A1)", "\tformula", "\rformula"])(
    "neutralizes CSV formulas beginning with %j while preserving valid CSV quoting",
    async (notes) => {
      firestoreState.docs = [
        eventDoc("formula", {
          notes: `${notes};com separador`,
          productive: true
        })
      ];

      const csv = await exportReportsCsv({
        filters,
        mode: "detailed"
      });

      const dataLine = csv.split("\n")[1];
      expect(dataLine).toContain(`"'${notes};com separador"`);
      expect(dataLine).not.toContain(`;"${notes};com separador"`);
    }
  );

  it("fails explicitly instead of returning metrics from a partial event set", async () => {
    const repeated = eventDoc("overflow");
    firestoreState.docs = Array.from(
      { length: 10_001 },
      (_, index) => ({ ...repeated, id: `overflow-${index}` })
    );

    await expect(
      getReportsDrilldown({
        filters,
        source: "kpi",
        cursor: 0,
        limit: 20
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("10000")
    });
  });
});
