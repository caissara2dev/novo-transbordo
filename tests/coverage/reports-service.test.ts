import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  exportReportsCsv,
  getReportsDrilldown,
  getReportsOverview
} from "@/lib/server/reports";
import { ReportsFilters } from "@/lib/server/reports-filters";

const baseFilters: ReportsFilters = {
  dateFrom: "2026-07-27",
  dateTo: "2026-07-27",
  granularity: "day",
  includeDeleted: false
};

function reportEvent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    shiftDate: "2026-07-27",
    shiftType: "MANHA",
    pump: "BOMBA_1",
    category: "PRODUTIVO",
    productive: true,
    durationMinutes: 20,
    startTime: "06:00",
    endTime: "06:20",
    clientId: "client-1",
    clientNameSnapshot: "Cliente 1",
    plate: "ABC-1234",
    container: "ABCU 123456-0",
    containerStatus: "FULL",
    containerReason: null,
    notes: null,
    createdByEmail: "operator@example.com",
    updatedByEmail: "operator@example.com",
    startAt: Timestamp.fromDate(new Date("2026-07-27T09:00:00.000Z")),
    createdAt: Timestamp.fromDate(new Date("2026-07-27T09:21:00.000Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-07-27T09:22:00.000Z")),
    deleted: false,
    deletedAt: null,
    deletedReason: null,
    ...overrides
  };
}

describe("public reports service", () => {
  beforeEach(() => {
    inMemoryAdminDb.reset();

    inMemoryAdminDb.seed(
      "events",
      "prior",
      reportEvent({
        shiftDate: "2026-07-26",
        durationMinutes: 10,
        startAt: Timestamp.fromDate(new Date("2026-07-26T09:00:00.000Z"))
      })
    );
    inMemoryAdminDb.seed("events", "productive", reportEvent());
    inMemoryAdminDb.seed(
      "events",
      "idle",
      reportEvent({
        category: "SEM_CAMINHAO",
        productive: false,
        durationMinutes: 10,
        startTime: "06:20",
        endTime: "06:30",
        startAt: Timestamp.fromDate(new Date("2026-07-27T09:20:00.000Z")),
        clientId: null,
        clientNameSnapshot: null,
        plate: null,
        container: null,
        containerStatus: null,
        notes: "Aguardando caminhão"
      })
    );
    inMemoryAdminDb.seed(
      "events",
      "deleted",
      reportEvent({
        deleted: true,
        deletedAt: Timestamp.fromDate(new Date("2026-07-27T12:00:00.000Z")),
        deletedReason: "Duplicado"
      })
    );
    inMemoryAdminDb.seed("events/productive/revisions", "revision-1", {
      editedAt: Timestamp.fromDate(new Date("2026-07-27T12:30:00.000Z"))
    });
  });

  it("builds KPI, chart and audit data over current and comparison windows", async () => {
    const overview = await getReportsOverview(baseFilters);

    expect(overview.kpis.totalMinutes).toEqual({
      current: 30,
      previous: 10,
      deltaPercent: 200
    });
    expect(overview.kpis.productiveRateMinutes.current).toBe(66.67);
    expect(overview.charts.productiveVsIdleByPump[0]).toMatchObject({
      pump: "BOMBA_1",
      productiveMinutes: 20,
      idleMinutes: 10,
      totalMinutes: 30
    });
    expect(overview.charts.idleByCategoryMinutes[0]).toEqual({
      category: "SEM_CAMINHAO",
      minutes: 10
    });
    expect(overview.charts.trendSeries).toEqual([
      expect.objectContaining({
        bucket: "2026-07-27",
        productiveMinutes: 20,
        idleMinutes: 10
      })
    ]);
    expect(overview.audit).toEqual({
      editedActions: 1,
      deletedActions: 1
    });
    expect(overview.totals).toEqual({
      processedCurrent: 2,
      processedComparisonWindow: 3
    });
  });

  it("applies dimension filters before computing totals and audit", async () => {
    const overview = await getReportsOverview({
      ...baseFilters,
      category: "SEM_CAMINHAO",
      clientId: undefined,
      pump: "BOMBA_1",
      shiftType: "MANHA"
    });

    expect(overview.kpis.totalMinutes.current).toBe(10);
    expect(overview.kpis.productiveMinutes.current).toBe(0);
    expect(overview.audit.editedActions).toBe(0);
    expect(overview.audit.deletedActions).toBe(0);
  });

  it("paginates drilldown by operational timestamp and maps audit fields", async () => {
    const firstPage = await getReportsDrilldown({
      filters: baseFilters,
      source: "chart",
      cursor: 0,
      limit: 1
    });

    expect(firstPage).toMatchObject({
      source: "chart",
      nextCursor: "1",
      summary: { totalRows: 2, returnedRows: 1 }
    });
    expect(firstPage.rows[0]).toMatchObject({
      id: "idle",
      category: "SEM_CAMINHAO",
      notes: "Aguardando caminhão",
      deleted: false
    });

    const secondPage = await getReportsDrilldown({
      filters: baseFilters,
      source: "kpi",
      cursor: 1,
      limit: 1
    });
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.rows[0].id).toBe("productive");
  });

  it("exports detailed data with neutralized formulas and quoted delimiters", async () => {
    inMemoryAdminDb.seed(
      "events",
      "formula",
      reportEvent({
        startTime: "07:00",
        endTime: "07:05",
        startAt: Timestamp.fromDate(new Date("2026-07-27T10:00:00.000Z")),
        notes: "=SUM(A1);conteúdo",
        clientNameSnapshot: "Cliente \"Especial\""
      })
    );

    const csv = await exportReportsCsv({
      filters: baseFilters,
      mode: "detailed"
    });

    expect(csv).toContain("Data;Turno;Bomba;Categoria");
    expect(csv).toContain("\"'=SUM(A1);conteúdo\"");
    expect(csv).toContain("\"Cliente \"\"Especial\"\"\"");
    expect(csv).toContain("27-07-2026");
  });

  it("exports a complete aggregate matrix including empty groups", async () => {
    const csv = await exportReportsCsv({
      filters: baseFilters,
      mode: "aggregated"
    });
    const lines = csv.split("\n");

    expect(lines[0]).toBe(
      "Grupo;Chave;Eventos;Minutos Totais;Minutos Produtivos;Minutos Ociosos;Produtividade (% minutos)"
    );
    expect(csv).toContain("CATEGORY;PRODUTIVO;1;20;20;0;100");
    expect(csv).toContain("CATEGORY;SEM_CAMINHAO;1;10;0;10;0");
    expect(csv).toContain("PUMP;BOMBA_3;0;0;0;0;0");
    expect(csv).toContain("SHIFT;NOITE;0;0;0;0;0");
  });

  it("reports one transfer event while exposing its container source for audit", async () => {
    inMemoryAdminDb.reset();
    inMemoryAdminDb.seed(
      "events",
      "transfer",
      reportEvent({
        plate: null,
        loadSourceType: "BUFFER_CONTAINER",
        sourceContainer: "MSCU 663987-0",
        sourceContainerEmptied: true
      })
    );

    const overview = await getReportsOverview(baseFilters);
    expect(overview.kpis.productiveEvents.current).toBe(1);
    expect(overview.kpis.productiveMinutes.current).toBe(20);
    const drilldown = await getReportsDrilldown({
      filters: baseFilters,
      source: "kpi",
      cursor: 0,
      limit: 20
    });
    expect(drilldown.rows).toEqual([
      expect.objectContaining({
        loadSourceType: "BUFFER_CONTAINER",
        sourceContainer: "MSCU 663987-0",
        sourceContainerEmptied: true
      })
    ]);
    const csv = await exportReportsCsv({ filters: baseFilters, mode: "detailed" });
    expect(csv).toContain("Origem da carga;Container de origem;Origem esvaziada");
    expect(csv).toContain("CONTAINER PULMÃO;MSCU 663987-0;SIM");
  });

  it("includes deleted records only when explicitly requested", async () => {
    const result = await getReportsDrilldown({
      filters: { ...baseFilters, includeDeleted: true },
      source: "kpi",
      cursor: 0,
      limit: 20
    });

    expect(result.rows.map((row) => row.id)).toContain("deleted");
    expect(result.rows.find((row) => row.id === "deleted")).toMatchObject({
      deleted: true,
      deletedReason: "Duplicado"
    });
  });
});
