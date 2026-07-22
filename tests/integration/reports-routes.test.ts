import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HttpError } from "@/lib/domain/errors";

let authCtx = {
  uid: "u1",
  email: "supervisor@x.com",
  profile: {
    role: "SUPERVISOR",
    approved: true,
    active: true,
    email: "supervisor@x.com",
    name: null,
    createdAt: null,
    updatedAt: null,
    approvedAt: null,
    approvedByUid: null,
    approvedByEmail: null
  }
};

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return {
    ...actual,
    requireAuth: vi.fn(async () => authCtx)
  };
});

const getReportsOverviewMock = vi.fn(async () => ({
  filtersApplied: {
    dateFrom: "2026-02-01",
    dateTo: "2026-02-07",
    granularity: "day",
    includeDeleted: false
  },
  kpis: {
    totalMinutes: { current: 1, previous: 1, deltaPercent: 0 },
    productiveMinutes: { current: 1, previous: 1, deltaPercent: 0 },
    idleMinutes: { current: 0, previous: 0, deltaPercent: null },
    productiveRateMinutes: { current: 100, previous: 100, deltaPercent: 0 },
    totalEvents: { current: 1, previous: 1, deltaPercent: 0 },
    productiveEvents: { current: 1, previous: 1, deltaPercent: 0 },
    productiveRateEvents: { current: 100, previous: 100, deltaPercent: 0 },
    avgProductiveTransbordoMinutes: { current: 60, previous: 60, deltaPercent: 0 }
  },
  charts: {
    productiveVsIdleByPump: [],
    idleByCategoryMinutes: [],
    idleByCategoryCount: [],
    trendSeries: [],
    shiftDistribution: []
  },
  audit: { editedActions: 0, deletedActions: 0 },
  totals: { processedCurrent: 1, processedComparisonWindow: 1 },
  limits: { maxPeriodDays: 90, maxEventsProcessed: 10000 },
  warnings: []
}));

const getReportsDrilldownMock = vi.fn(async () => ({
  source: "kpi",
  rows: [],
  nextCursor: "20",
  summary: {
    totalRows: 30,
    returnedRows: 20
  }
}));

const exportReportsCsvMock = vi.fn(async () => "Data;Turno\n01-02-2026;MANHA");

vi.mock("@/lib/server/reports", () => ({
  getReportsOverview: getReportsOverviewMock,
  getReportsDrilldown: getReportsDrilldownMock,
  exportReportsCsv: exportReportsCsvMock
}));

describe("reports API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authCtx = {
      uid: "u1",
      email: "supervisor@x.com",
      profile: {
        role: "SUPERVISOR",
        approved: true,
        active: true,
        email: "supervisor@x.com",
        name: null,
        createdAt: null,
        updatedAt: null,
        approvedAt: null,
        approvedByUid: null,
        approvedByEmail: null
      }
    };
  });

  it("GET /api/reports/overview returns payload", async () => {
    const mod = await import("@/app/api/reports/overview/route");
    const req = new NextRequest("http://localhost/api/reports/overview?dateFrom=2026-02-01&dateTo=2026-02-07");

    const res = await mod.GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.kpis.totalMinutes.current).toBe(1);
    expect(getReportsOverviewMock).toHaveBeenCalled();
  });

  it("blocks OPERATOR access to reports", async () => {
    authCtx.profile.role = "OPERATOR";
    const mod = await import("@/app/api/reports/overview/route");
    const req = new NextRequest("http://localhost/api/reports/overview");

    const res = await mod.GET(req);
    expect(res.status).toBe(403);
  });

  it("forces includeDeleted false for SUPERVISOR", async () => {
    const mod = await import("@/app/api/reports/overview/route");
    const req = new NextRequest(
      "http://localhost/api/reports/overview?dateFrom=2026-02-01&dateTo=2026-02-07&includeDeleted=true"
    );

    await mod.GET(req);

    expect(getReportsOverviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeDeleted: false })
    );
  });

  it("rejects periods greater than 90 days", async () => {
    const mod = await import("@/app/api/reports/overview/route");
    const req = new NextRequest(
      "http://localhost/api/reports/overview?dateFrom=2026-01-01&dateTo=2026-04-20"
    );

    const res = await mod.GET(req);
    expect(res.status).toBe(400);
  });

  it("returns limit error when service throws max events", async () => {
    getReportsOverviewMock.mockRejectedValueOnce(
      new HttpError(400, "Consulta excede 10000 eventos. Refine os filtros.")
    );

    const mod = await import("@/app/api/reports/overview/route");
    const req = new NextRequest("http://localhost/api/reports/overview?dateFrom=2026-02-01&dateTo=2026-02-07");

    const res = await mod.GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("10000");
  });

  it("GET /api/reports/drilldown returns cursor payload", async () => {
    const mod = await import("@/app/api/reports/drilldown/route");
    const req = new NextRequest(
      "http://localhost/api/reports/drilldown?dateFrom=2026-02-01&dateTo=2026-02-07&source=chart&cursor=0&limit=20"
    );

    const res = await mod.GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.nextCursor).toBe("20");
  });

  it("GET /api/reports/export returns csv", async () => {
    const mod = await import("@/app/api/reports/export/route");
    const req = new NextRequest(
      "http://localhost/api/reports/export?dateFrom=2026-02-01&dateTo=2026-02-07&mode=aggregated"
    );

    const res = await mod.GET(req);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(text).toContain("Data;Turno");
  });
});
