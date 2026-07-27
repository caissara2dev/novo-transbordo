import { DateTime } from "luxon";
import { DocumentData, Query } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { TZ } from "@/lib/domain/constants";
import { HttpError } from "@/lib/domain/errors";
import {
  categoryLabelMap,
  containerStatusLabelMap
} from "@/lib/domain/options";
import { eventContainerStatus } from "@/lib/server/container-states";
import {
  MAX_REPORT_EVENTS_PROCESSED,
  MAX_REPORT_PERIOD_DAYS,
  ReportsFilters
} from "@/lib/server/reports-filters";
import {
  ReportDrilldownRow,
  ReportsDrilldownResponse,
  ReportsOverviewResponse
} from "@/types/api";
import { Category, ContainerStatus, Pump, ShiftType } from "@/types/domain";

type ReportEvent = {
  id: string;
  shiftDate: string;
  shiftType: ShiftType;
  pump: Pump;
  category: Category;
  productive: boolean;
  durationMinutes: number;
  startTime: string;
  endTime: string;
  clientId: string | null;
  clientNameSnapshot: string | null;
  plate: string | null;
  container: string | null;
  containerStatus: ContainerStatus | null;
  containerReason: string | null;
  notes: string | null;
  createdByEmail: string;
  updatedByEmail: string;
  createdAtMs: number;
  updatedAtMs: number;
  deleted: boolean;
  deletedAtMs: number | null;
  deletedReason: string | null;
};

const IDLE_CATEGORIES: Category[] = [
  "INTERVALO_OPERACIONAL",
  "EM_TRANSITO",
  "AGUARDANDO_LABORATORIO",
  "SEM_CAMINHAO",
  "SEM_CONTAINER",
  "MANUTENCAO",
  "OUTROS"
];

function toMillis(value: unknown): number {
  if (!value) return 0;

  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  if (value && typeof value === "object" && "_seconds" in (value as Record<string, unknown>)) {
    const sec = Number((value as { _seconds: unknown })._seconds);
    const ns = Number((value as { _nanoseconds?: unknown })._nanoseconds || 0);
    return sec * 1000 + Math.floor(ns / 1000000);
  }

  if (value && typeof value === "object" && "toMillis" in (value as Record<string, unknown>)) {
    try {
      return Number((value as { toMillis: () => number }).toMillis());
    } catch {
      return 0;
    }
  }

  return 0;
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!text.includes(";") && !text.includes('"') && !text.includes("\n")) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function formatDateDdMmYyyy(isoDate: string): string {
  const dt = DateTime.fromISO(isoDate, { zone: TZ });
  if (!dt.isValid) return isoDate;
  return dt.toFormat("dd-MM-yyyy");
}

function formatDateTimePtBr(ms: number): string {
  if (!ms) return "-";
  return DateTime.fromMillis(ms, { zone: TZ }).toFormat("dd/MM/yyyy HH:mm");
}

function percentage(part: number, total: number): number {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

export function deltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

export function previousWindow(dateFrom: string, dateTo: string): {
  previousFrom: string;
  previousTo: string;
} {
  const from = DateTime.fromISO(dateFrom, { zone: TZ }).startOf("day");
  const to = DateTime.fromISO(dateTo, { zone: TZ }).startOf("day");
  const span = Math.floor(to.diff(from, "days").days) + 1;

  const previousTo = from.minus({ days: 1 });
  const previousFrom = previousTo.minus({ days: span - 1 });

  return {
    previousFrom: previousFrom.toISODate() ?? "",
    previousTo: previousTo.toISODate() ?? ""
  };
}

function reportEventFromDoc(id: string, data: DocumentData): ReportEvent {
  return {
    id,
    shiftDate: String(data.shiftDate || ""),
    shiftType: (data.shiftType || "MANHA") as ShiftType,
    pump: (data.pump || "BOMBA_1") as Pump,
    category: (data.category || "OUTROS") as Category,
    productive: Boolean(data.productive),
    durationMinutes: Number(data.durationMinutes || 0),
    startTime: String(data.startTime || ""),
    endTime: String(data.endTime || ""),
    clientId: (data.clientId as string | null) || null,
    clientNameSnapshot: (data.clientNameSnapshot as string | null) || null,
    plate: (data.plate as string | null) || null,
    container: (data.container as string | null) || null,
    containerStatus: eventContainerStatus(data),
    containerReason: (data.containerReason as string | null) || null,
    notes: (data.notes as string | null) || null,
    createdByEmail: String(data.createdByEmail || "-"),
    updatedByEmail: String(data.updatedByEmail || "-"),
    createdAtMs: toMillis(data.createdAt),
    updatedAtMs: toMillis(data.updatedAt),
    deleted: Boolean(data.deleted),
    deletedAtMs: data.deletedAt ? toMillis(data.deletedAt) : null,
    deletedReason: (data.deletedReason as string | null) || null
  };
}

function applyDimensionFilters(events: ReportEvent[], filters: ReportsFilters): ReportEvent[] {
  return events.filter((event) => {
    if (filters.pump && event.pump !== filters.pump) return false;
    if (filters.shiftType && event.shiftType !== filters.shiftType) return false;
    if (filters.category && event.category !== filters.category) return false;
    if (filters.clientId && event.clientId !== filters.clientId) return false;
    if (filters.containerStatus && event.containerStatus !== filters.containerStatus) return false;
    return true;
  });
}

async function fetchEventsByShiftDate(params: {
  dateFrom: string;
  dateTo: string;
  includeDeleted: boolean;
}): Promise<ReportEvent[]> {
  let query: Query = adminDb
    .collection("events")
    .where("shiftDate", ">=", params.dateFrom)
    .where("shiftDate", "<=", params.dateTo);

  if (!params.includeDeleted) {
    query = query.where("deleted", "==", false);
  }

  const snap = await query.get();
  return snap.docs.map((doc) => reportEventFromDoc(doc.id, doc.data()));
}

export function computeAggregate(events: ReportEvent[]): {
  totalMinutes: number;
  productiveMinutes: number;
  idleMinutes: number;
  productiveRateMinutes: number;
  totalEvents: number;
  productiveEvents: number;
  productiveRateEvents: number;
  avgProductiveTransbordoMinutes: number;
} {
  const totalMinutes = events.reduce((acc, event) => acc + event.durationMinutes, 0);
  const productiveMinutes = events
    .filter((event) => event.productive)
    .reduce((acc, event) => acc + event.durationMinutes, 0);
  const idleMinutes = totalMinutes - productiveMinutes;

  const totalEvents = events.length;
  const productiveEvents = events.filter((event) => event.productive).length;
  const productiveDurations = events
    .filter((event) => event.category === "PRODUTIVO")
    .map((event) => event.durationMinutes);

  const avgProductiveTransbordoMinutes = productiveDurations.length
    ? Number(
        (
          productiveDurations.reduce((acc, value) => acc + value, 0) /
          productiveDurations.length
        ).toFixed(2)
      )
    : 0;

  return {
    totalMinutes,
    productiveMinutes,
    idleMinutes,
    productiveRateMinutes: percentage(productiveMinutes, totalMinutes),
    totalEvents,
    productiveEvents,
    productiveRateEvents: percentage(productiveEvents, totalEvents),
    avgProductiveTransbordoMinutes
  };
}

export function buildTrendBucket(shiftDate: string, granularity: ReportsFilters["granularity"]): {
  bucket: string;
  label: string;
} {
  const dt = DateTime.fromISO(shiftDate, { zone: TZ });

  if (granularity === "month") {
    return {
      bucket: dt.toFormat("yyyy-MM"),
      label: dt.toFormat("MM/yyyy")
    };
  }

  if (granularity === "week") {
    const start = dt.startOf("week");
    const end = start.plus({ days: 6 });
    return {
      bucket: start.toISODate() ?? "",
      label: `${start.toFormat("dd/MM")} - ${end.toFormat("dd/MM")}`
    };
  }

  return {
    bucket: shiftDate,
    label: dt.toFormat("dd/MM")
  };
}

function sortDrilldown(events: ReportEvent[]): ReportEvent[] {
  return [...events].sort((a, b) => {
    if (a.shiftDate !== b.shiftDate) return a.shiftDate < b.shiftDate ? 1 : -1;
    if (a.startTime !== b.startTime) return a.startTime < b.startTime ? 1 : -1;
    return b.createdAtMs - a.createdAtMs;
  });
}

function toDrilldownRow(event: ReportEvent): ReportDrilldownRow {
  return {
    id: event.id,
    shiftDate: event.shiftDate,
    shiftType: event.shiftType,
    pump: event.pump,
    category: event.category,
    productive: event.productive,
    durationMinutes: event.durationMinutes,
    startTime: event.startTime,
    endTime: event.endTime,
    clientNameSnapshot: event.clientNameSnapshot,
    notes: event.notes,
    plate: event.plate,
    container: event.container,
    containerStatus: event.containerStatus,
    containerReason: event.containerReason,
    createdByEmail: event.createdByEmail,
    updatedByEmail: event.updatedByEmail,
    createdAt: event.createdAtMs ? new Date(event.createdAtMs).toISOString() : "",
    updatedAt: event.updatedAtMs ? new Date(event.updatedAtMs).toISOString() : "",
    deleted: event.deleted,
    deletedReason: event.deletedReason
  };
}

async function countEditedActions(params: {
  dateFrom: string;
  dateTo: string;
  allowedEventIds: Set<string>;
}): Promise<number> {
  if (!params.allowedEventIds.size) return 0;

  const start = DateTime.fromISO(params.dateFrom, { zone: TZ }).startOf("day").toJSDate();
  const end = DateTime.fromISO(params.dateTo, { zone: TZ }).endOf("day").toJSDate();

  const snap = await adminDb
    .collectionGroup("revisions")
    .where("editedAt", ">=", start)
    .where("editedAt", "<=", end)
    .get();

  let count = 0;
  for (const doc of snap.docs) {
    const eventId = doc.ref.parent.parent?.id;
    if (eventId && params.allowedEventIds.has(eventId)) {
      count += 1;
    }
  }

  return count;
}

async function countDeletedActions(params: {
  dateFrom: string;
  dateTo: string;
  filters: ReportsFilters;
}): Promise<number> {
  const start = DateTime.fromISO(params.dateFrom, { zone: TZ }).startOf("day").toJSDate();
  const end = DateTime.fromISO(params.dateTo, { zone: TZ }).endOf("day").toJSDate();

  const snap = await adminDb
    .collection("events")
    .where("deleted", "==", true)
    .where("deletedAt", ">=", start)
    .where("deletedAt", "<=", end)
    .get();

  const events = snap.docs.map((doc) => reportEventFromDoc(doc.id, doc.data()));
  return applyDimensionFilters(events, params.filters).length;
}

export async function getReportsOverview(filters: ReportsFilters): Promise<ReportsOverviewResponse> {
  const previous = previousWindow(filters.dateFrom, filters.dateTo);
  const comparisonWindowEvents = await fetchEventsByShiftDate({
    dateFrom: previous.previousFrom,
    dateTo: filters.dateTo,
    includeDeleted: filters.includeDeleted
  });

  if (comparisonWindowEvents.length > MAX_REPORT_EVENTS_PROCESSED) {
    throw new HttpError(
      400,
      `Consulta excede ${MAX_REPORT_EVENTS_PROCESSED} eventos. Refine os filtros.`
    );
  }

  const filtered = applyDimensionFilters(comparisonWindowEvents, filters);
  const currentEvents = filtered.filter(
    (event) => event.shiftDate >= filters.dateFrom && event.shiftDate <= filters.dateTo
  );
  const previousEvents = filtered.filter(
    (event) => event.shiftDate >= previous.previousFrom && event.shiftDate <= previous.previousTo
  );

  const current = computeAggregate(currentEvents);
  const prior = computeAggregate(previousEvents);

  const byPump = (["BOMBA_1", "BOMBA_2", "BOMBA_3"] as Pump[]).map((pump) => {
    const scoped = currentEvents.filter((event) => event.pump === pump);
    const scopedTotal = scoped.reduce((acc, event) => acc + event.durationMinutes, 0);
    const scopedProductive = scoped
      .filter((event) => event.productive)
      .reduce((acc, event) => acc + event.durationMinutes, 0);
    const scopedIdle = scopedTotal - scopedProductive;

    return {
      pump,
      productiveMinutes: scopedProductive,
      idleMinutes: scopedIdle,
      totalMinutes: scopedTotal,
      productiveRateMinutes: percentage(scopedProductive, scopedTotal)
    };
  });

  const idleByCategoryMinutes = IDLE_CATEGORIES.map((category) => ({
    category,
    minutes: currentEvents
      .filter((event) => event.category === category)
      .reduce((acc, event) => acc + event.durationMinutes, 0)
  })).sort((a, b) => b.minutes - a.minutes);

  const idleByCategoryCount = IDLE_CATEGORIES.map((category) => ({
    category,
    count: currentEvents.filter((event) => event.category === category).length
  })).sort((a, b) => b.count - a.count);

  const trendMap = new Map<string, { label: string; productiveMinutes: number; idleMinutes: number }>();
  for (const event of currentEvents) {
    const bucketInfo = buildTrendBucket(event.shiftDate, filters.granularity);
    const existing = trendMap.get(bucketInfo.bucket) || {
      label: bucketInfo.label,
      productiveMinutes: 0,
      idleMinutes: 0
    };

    if (event.productive) {
      existing.productiveMinutes += event.durationMinutes;
    } else {
      existing.idleMinutes += event.durationMinutes;
    }

    trendMap.set(bucketInfo.bucket, existing);
  }

  const trendSeries = [...trendMap.entries()]
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([bucket, values]) => ({
      bucket,
      label: values.label,
      productiveMinutes: values.productiveMinutes,
      idleMinutes: values.idleMinutes,
      totalMinutes: values.productiveMinutes + values.idleMinutes
    }));

  const shiftDistribution = (["MANHA", "NOITE"] as ShiftType[]).map((shiftType) => {
    const scoped = currentEvents.filter((event) => event.shiftType === shiftType);
    const totalMinutes = scoped.reduce((acc, event) => acc + event.durationMinutes, 0);
    const productiveMinutes = scoped
      .filter((event) => event.productive)
      .reduce((acc, event) => acc + event.durationMinutes, 0);
    const idleMinutes = totalMinutes - productiveMinutes;

    return {
      shiftType,
      productiveMinutes,
      idleMinutes,
      totalMinutes,
      productiveRateMinutes: percentage(productiveMinutes, totalMinutes)
    };
  });

  const allowedEventIds = new Set(currentEvents.map((event) => event.id));
  const [editedActions, deletedActions] = await Promise.all([
    countEditedActions({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      allowedEventIds
    }),
    countDeletedActions({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      filters
    })
  ]);

  return {
    filtersApplied: {
      ...filters
    },
    kpis: {
      totalMinutes: {
        current: current.totalMinutes,
        previous: prior.totalMinutes,
        deltaPercent: deltaPercent(current.totalMinutes, prior.totalMinutes)
      },
      productiveMinutes: {
        current: current.productiveMinutes,
        previous: prior.productiveMinutes,
        deltaPercent: deltaPercent(current.productiveMinutes, prior.productiveMinutes)
      },
      idleMinutes: {
        current: current.idleMinutes,
        previous: prior.idleMinutes,
        deltaPercent: deltaPercent(current.idleMinutes, prior.idleMinutes)
      },
      productiveRateMinutes: {
        current: current.productiveRateMinutes,
        previous: prior.productiveRateMinutes,
        deltaPercent: deltaPercent(current.productiveRateMinutes, prior.productiveRateMinutes)
      },
      totalEvents: {
        current: current.totalEvents,
        previous: prior.totalEvents,
        deltaPercent: deltaPercent(current.totalEvents, prior.totalEvents)
      },
      productiveEvents: {
        current: current.productiveEvents,
        previous: prior.productiveEvents,
        deltaPercent: deltaPercent(current.productiveEvents, prior.productiveEvents)
      },
      productiveRateEvents: {
        current: current.productiveRateEvents,
        previous: prior.productiveRateEvents,
        deltaPercent: deltaPercent(current.productiveRateEvents, prior.productiveRateEvents)
      },
      avgProductiveTransbordoMinutes: {
        current: current.avgProductiveTransbordoMinutes,
        previous: prior.avgProductiveTransbordoMinutes,
        deltaPercent: deltaPercent(
          current.avgProductiveTransbordoMinutes,
          prior.avgProductiveTransbordoMinutes
        )
      }
    },
    charts: {
      productiveVsIdleByPump: byPump,
      idleByCategoryMinutes,
      idleByCategoryCount,
      trendSeries,
      shiftDistribution
    },
    audit: {
      editedActions,
      deletedActions
    },
    totals: {
      processedCurrent: currentEvents.length,
      processedComparisonWindow: filtered.length
    },
    limits: {
      maxPeriodDays: MAX_REPORT_PERIOD_DAYS,
      maxEventsProcessed: MAX_REPORT_EVENTS_PROCESSED
    },
    warnings: []
  };
}

function applyCurrentWindow(events: ReportEvent[], filters: ReportsFilters): ReportEvent[] {
  const filtered = applyDimensionFilters(events, filters).filter(
    (event) => event.shiftDate >= filters.dateFrom && event.shiftDate <= filters.dateTo
  );

  return sortDrilldown(filtered);
}

export async function getReportsDrilldown(params: {
  filters: ReportsFilters;
  source: "kpi" | "chart";
  cursor: number;
  limit: number;
}): Promise<ReportsDrilldownResponse> {
  const events = await fetchEventsByShiftDate({
    dateFrom: params.filters.dateFrom,
    dateTo: params.filters.dateTo,
    includeDeleted: params.filters.includeDeleted
  });

  if (events.length > MAX_REPORT_EVENTS_PROCESSED) {
    throw new HttpError(
      400,
      `Consulta excede ${MAX_REPORT_EVENTS_PROCESSED} eventos. Refine os filtros.`
    );
  }

  const sorted = applyCurrentWindow(events, params.filters);
  const rows = sorted.slice(params.cursor, params.cursor + params.limit).map(toDrilldownRow);
  const nextCursor =
    params.cursor + params.limit < sorted.length ? String(params.cursor + params.limit) : null;

  return {
    source: params.source,
    rows,
    nextCursor,
    summary: {
      totalRows: sorted.length,
      returnedRows: rows.length
    }
  };
}

function detailedCsvRows(events: ReportEvent[]): string {
  const header = [
    "Data",
    "Turno",
    "Bomba",
    "Categoria",
    "Cliente",
    "Horário Início",
    "Horário Fim",
    "Duração (minutos)",
    "Produtivo",
    "Placa",
    "Container",
    "Estado do Container",
    "Motivo do Estado",
    "Observações",
    "Criado por",
    "Criado em",
    "Atualizado por",
    "Atualizado em",
    "Excluído",
    "Motivo exclusão"
  ];

  const lines = [header.join(";")];

  for (const event of events) {
    lines.push(
      [
        csvEscape(formatDateDdMmYyyy(event.shiftDate)),
        csvEscape(event.shiftType),
        csvEscape(event.pump),
        csvEscape(categoryLabelMap[event.category]),
        csvEscape(event.clientNameSnapshot || ""),
        csvEscape(event.startTime),
        csvEscape(event.endTime),
        csvEscape(event.durationMinutes),
        csvEscape(event.productive ? "SIM" : "NÃO"),
        csvEscape(event.plate || ""),
        csvEscape(event.container || ""),
        csvEscape(
          event.containerStatus ? containerStatusLabelMap[event.containerStatus] : ""
        ),
        csvEscape(event.containerReason || ""),
        csvEscape(event.notes || ""),
        csvEscape(event.createdByEmail),
        csvEscape(formatDateTimePtBr(event.createdAtMs)),
        csvEscape(event.updatedByEmail),
        csvEscape(formatDateTimePtBr(event.updatedAtMs)),
        csvEscape(event.deleted ? "SIM" : "NÃO"),
        csvEscape(event.deletedReason || "")
      ].join(";")
    );
  }

  return lines.join("\n");
}

function aggregatedCsvRows(events: ReportEvent[]): string {
  type Row = {
    groupType: string;
    groupValue: string;
    events: number;
    totalMinutes: number;
    productiveMinutes: number;
    idleMinutes: number;
    productiveRateMinutes: number;
  };

  const rows: Row[] = [];

  const buildRows = <T extends string>(groupType: string, keys: T[], pick: (event: ReportEvent) => T) => {
    for (const key of keys) {
      const scoped = events.filter((event) => pick(event) === key);
      const totalMinutes = scoped.reduce((acc, event) => acc + event.durationMinutes, 0);
      const productiveMinutes = scoped
        .filter((event) => event.productive)
        .reduce((acc, event) => acc + event.durationMinutes, 0);
      const idleMinutes = totalMinutes - productiveMinutes;

      rows.push({
        groupType,
        groupValue: key,
        events: scoped.length,
        totalMinutes,
        productiveMinutes,
        idleMinutes,
        productiveRateMinutes: percentage(productiveMinutes, totalMinutes)
      });
    }
  };

  buildRows("CATEGORY", ["PRODUTIVO", ...IDLE_CATEGORIES], (event) => event.category);
  buildRows("PUMP", ["BOMBA_1", "BOMBA_2", "BOMBA_3"], (event) => event.pump);
  buildRows("SHIFT", ["MANHA", "NOITE"], (event) => event.shiftType);

  const header = [
    "Grupo",
    "Chave",
    "Eventos",
    "Minutos Totais",
    "Minutos Produtivos",
    "Minutos Ociosos",
    "Produtividade (% minutos)"
  ];

  const lines = [header.join(";")];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.groupType),
        csvEscape(row.groupValue),
        csvEscape(row.events),
        csvEscape(row.totalMinutes),
        csvEscape(row.productiveMinutes),
        csvEscape(row.idleMinutes),
        csvEscape(row.productiveRateMinutes)
      ].join(";")
    );
  }

  return lines.join("\n");
}

export async function exportReportsCsv(params: {
  filters: ReportsFilters;
  mode: "detailed" | "aggregated";
}): Promise<string> {
  const events = await fetchEventsByShiftDate({
    dateFrom: params.filters.dateFrom,
    dateTo: params.filters.dateTo,
    includeDeleted: params.filters.includeDeleted
  });

  if (events.length > MAX_REPORT_EVENTS_PROCESSED) {
    throw new HttpError(
      400,
      `Consulta excede ${MAX_REPORT_EVENTS_PROCESSED} eventos. Refine os filtros.`
    );
  }

  const scoped = applyCurrentWindow(events, params.filters).reverse();

  if (params.mode === "aggregated") {
    return aggregatedCsvRows(scoped);
  }

  return detailedCsvRows(scoped);
}
