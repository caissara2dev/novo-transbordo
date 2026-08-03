import { DateTime } from "luxon";
import { ReportFilters } from "@/lib/ui/filters";
import { ReportsOverviewResponse } from "@/types/api";

export const REPORT_ZONE = "America/Sao_Paulo";

export type PresetKey = "today" | "week" | "month" | "last7" | "custom";

export type ReportKpiView = {
  key: string;
  label: string;
  value: string;
  delta: string;
};

export const numberFmt = new Intl.NumberFormat("pt-BR");

export function last7DaysFilter(): ReportFilters {
  const now = DateTime.now().setZone(REPORT_ZONE);
  return {
    dateFrom: now.minus({ days: 6 }).toISODate() || "",
    dateTo: now.toISODate() || "",
    granularity: "day",
    pump: "",
    shiftType: "",
    category: "",
    clientId: "",
    containerStatus: "",
    includeDeleted: false
  };
}

export function filtersForPreset(
  current: ReportFilters,
  preset: Exclude<PresetKey, "custom">
): ReportFilters {
  const now = DateTime.now().setZone(REPORT_ZONE);

  if (preset === "today") {
    return {
      ...current,
      dateFrom: now.toISODate() || "",
      dateTo: now.toISODate() || ""
    };
  }

  if (preset === "week") {
    return {
      ...current,
      dateFrom: now.startOf("week").toISODate() || "",
      dateTo: now.toISODate() || ""
    };
  }

  if (preset === "month") {
    return {
      ...current,
      dateFrom: now.startOf("month").toISODate() || "",
      dateTo: now.toISODate() || ""
    };
  }

  return {
    ...current,
    ...last7DaysFilter()
  };
}

export function formatMinutes(value: number): string {
  return `${numberFmt.format(Math.round(value))} min`;
}

export function formatDateTime(iso: string): string {
  if (!iso) return "-";
  const dateTime = DateTime.fromISO(iso, { zone: REPORT_ZONE });
  if (!dateTime.isValid) return "-";
  return dateTime.setLocale("pt-BR").toFormat("dd/MM/yyyy HH:mm");
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function toDeltaBadge(deltaPercent: number | null): string {
  if (deltaPercent === null) return "Sem base";
  if (deltaPercent > 0) return `+${deltaPercent.toFixed(2)}%`;
  return `${deltaPercent.toFixed(2)}%`;
}

export function buildReportKpis(
  overview: ReportsOverviewResponse | null
): ReportKpiView[] {
  if (!overview) return [];

  return [
    {
      key: "totalMinutes",
      label: "Minutos totais",
      value: formatMinutes(overview.kpis.totalMinutes.current),
      delta: toDeltaBadge(overview.kpis.totalMinutes.deltaPercent)
    },
    {
      key: "productiveMinutes",
      label: "Minutos produtivos",
      value: formatMinutes(overview.kpis.productiveMinutes.current),
      delta: toDeltaBadge(overview.kpis.productiveMinutes.deltaPercent)
    },
    {
      key: "idleMinutes",
      label: "Minutos ociosos",
      value: formatMinutes(overview.kpis.idleMinutes.current),
      delta: toDeltaBadge(overview.kpis.idleMinutes.deltaPercent)
    },
    {
      key: "productiveRateMinutes",
      label: "Produtividade (% minutos)",
      value: formatPercent(overview.kpis.productiveRateMinutes.current),
      delta: toDeltaBadge(overview.kpis.productiveRateMinutes.deltaPercent)
    },
    {
      key: "totalEvents",
      label: "Eventos totais",
      value: numberFmt.format(overview.kpis.totalEvents.current),
      delta: toDeltaBadge(overview.kpis.totalEvents.deltaPercent)
    },
    {
      key: "productiveRateEvents",
      label: "Produtividade (% eventos)",
      value: formatPercent(overview.kpis.productiveRateEvents.current),
      delta: toDeltaBadge(overview.kpis.productiveRateEvents.deltaPercent)
    },
    {
      key: "avgProductiveTransbordoMinutes",
      label: "Tempo médio transbordo",
      value: formatMinutes(overview.kpis.avgProductiveTransbordoMinutes.current),
      delta: toDeltaBadge(
        overview.kpis.avgProductiveTransbordoMinutes.deltaPercent
      )
    }
  ];
}
