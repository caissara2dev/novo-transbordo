import { DateTime } from "luxon";
import { HttpError } from "@/lib/domain/errors";
import { TZ } from "@/lib/domain/constants";
import {
  Category,
  containerStatuses,
  ContainerStatus,
  Pump,
  ShiftType
} from "@/types/domain";
import { ReportGranularity } from "@/types/api";

export const MAX_REPORT_PERIOD_DAYS = 90;
export const MAX_REPORT_EVENTS_PROCESSED = 10000;

export type ReportsFilters = {
  dateFrom: string;
  dateTo: string;
  granularity: ReportGranularity;
  pump?: Pump;
  shiftType?: ShiftType;
  category?: Category;
  clientId?: string;
  containerStatus?: ContainerStatus;
  includeDeleted: boolean;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ensureIsoDate(value: string, fieldName: string): string {
  if (!ISO_DATE_RE.test(value)) {
    throw new HttpError(400, `${fieldName} inválido. Use YYYY-MM-DD.`);
  }

  const dt = DateTime.fromISO(value, { zone: TZ });
  if (!dt.isValid) {
    throw new HttpError(400, `${fieldName} inválido.`);
  }

  return value;
}

function parsePump(value: string | null): Pump | undefined {
  if (!value) return undefined;
  if (value === "BOMBA_1" || value === "BOMBA_2" || value === "BOMBA_3") return value;
  throw new HttpError(400, "Bomba inválida.");
}

function parseContainerStatus(value: string | null): ContainerStatus | undefined {
  if (!value) return undefined;
  if (containerStatuses.includes(value as ContainerStatus)) return value as ContainerStatus;
  throw new HttpError(400, "Estado do container inválido.");
}

function parseShiftType(value: string | null): ShiftType | undefined {
  if (!value) return undefined;
  if (value === "MANHA" || value === "NOITE") return value;
  throw new HttpError(400, "Turno inválido.");
}

function parseCategory(value: string | null): Category | undefined {
  if (!value) return undefined;
  if (
    value === "PRODUTIVO" ||
    value === "EM_TRANSITO" ||
    value === "AGUARDANDO_LABORATORIO" ||
    value === "SEM_CAMINHAO" ||
    value === "SEM_CONTAINER" ||
    value === "MANUTENCAO" ||
    value === "OUTROS"
  ) {
    return value;
  }

  throw new HttpError(400, "Categoria inválida.");
}

function parseGranularity(value: string | null): ReportGranularity {
  if (!value) return "day";
  if (value === "day" || value === "week" || value === "month") return value;
  throw new HttpError(400, "Granularidade inválida.");
}

export function defaultLast7DaysRange(now = DateTime.now().setZone(TZ)): {
  dateFrom: string;
  dateTo: string;
} {
  const dateTo = now.toISODate() ?? "";
  const dateFrom = now.minus({ days: 6 }).toISODate() ?? "";
  return { dateFrom, dateTo };
}

export function inclusiveDaysBetween(dateFrom: string, dateTo: string): number {
  const from = DateTime.fromISO(dateFrom, { zone: TZ }).startOf("day");
  const to = DateTime.fromISO(dateTo, { zone: TZ }).startOf("day");
  return Math.floor(to.diff(from, "days").days) + 1;
}

export function parseReportsFilters(
  searchParams: URLSearchParams,
  options: { allowIncludeDeleted: boolean }
): ReportsFilters {
  const defaults = defaultLast7DaysRange();

  const dateFrom = ensureIsoDate(searchParams.get("dateFrom") || defaults.dateFrom, "dateFrom");
  const dateTo = ensureIsoDate(searchParams.get("dateTo") || defaults.dateTo, "dateTo");

  if (dateFrom > dateTo) {
    throw new HttpError(400, "dateFrom não pode ser maior que dateTo.");
  }

  const periodDays = inclusiveDaysBetween(dateFrom, dateTo);
  if (periodDays > MAX_REPORT_PERIOD_DAYS) {
    throw new HttpError(400, `Período máximo permitido: ${MAX_REPORT_PERIOD_DAYS} dias.`);
  }

  const includeDeletedRaw = searchParams.get("includeDeleted") === "true";
  const includeDeleted = options.allowIncludeDeleted ? includeDeletedRaw : false;

  return {
    dateFrom,
    dateTo,
    granularity: parseGranularity(searchParams.get("granularity")),
    pump: parsePump(searchParams.get("pump")),
    shiftType: parseShiftType(searchParams.get("shiftType")),
    category: parseCategory(searchParams.get("category")),
    clientId: searchParams.get("clientId") || undefined,
    containerStatus: parseContainerStatus(searchParams.get("containerStatus")),
    includeDeleted
  };
}

export function parseDrilldownParams(searchParams: URLSearchParams): {
  source: "kpi" | "chart";
  cursor: number;
  limit: number;
} {
  const sourceParam = searchParams.get("source");
  const source = sourceParam === "chart" ? "chart" : "kpi";

  const cursorRaw = Number(searchParams.get("cursor") || "0");
  const limitRaw = Number(searchParams.get("limit") || "20");

  const cursor = Number.isFinite(cursorRaw) && cursorRaw >= 0 ? Math.floor(cursorRaw) : 0;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(100, Math.max(1, Math.floor(limitRaw)))
    : 20;

  return { source, cursor, limit };
}

export function parseExportMode(searchParams: URLSearchParams): "detailed" | "aggregated" {
  const mode = searchParams.get("mode");
  if (mode === "aggregated") return "aggregated";
  if (!mode || mode === "detailed") return "detailed";
  throw new HttpError(400, "Modo de exportação inválido.");
}
