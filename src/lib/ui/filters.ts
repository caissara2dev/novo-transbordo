import { ReportGranularity } from "@/types/api";

export type EventListFilters = {
  dateFrom: string;
  dateTo: string;
  pump: string;
  shiftType: string;
  category: string;
  clientId: string;
  containerStatus: string;
  includeDeleted: boolean;
};

export type ReportFilters = EventListFilters & {
  granularity: ReportGranularity;
};

export function filtersAreEqual(
  left: EventListFilters | ReportFilters,
  right: EventListFilters | ReportFilters
): boolean {
  const eventFieldsAreEqual =
    left.dateFrom === right.dateFrom &&
    left.dateTo === right.dateTo &&
    left.pump === right.pump &&
    left.shiftType === right.shiftType &&
    left.category === right.category &&
    left.clientId === right.clientId &&
    left.containerStatus === right.containerStatus &&
    left.includeDeleted === right.includeDeleted;
  const leftGranularity = "granularity" in left ? left.granularity : null;
  const rightGranularity = "granularity" in right ? right.granularity : null;

  return eventFieldsAreEqual && leftGranularity === rightGranularity;
}

function appendOptional(query: URLSearchParams, key: string, value: string): void {
  if (value) {
    query.set(key, value);
  }
}

export function toEventListQuery(filters: EventListFilters): string {
  const query = new URLSearchParams();

  appendOptional(query, "dateFrom", filters.dateFrom);
  appendOptional(query, "dateTo", filters.dateTo);
  appendOptional(query, "pump", filters.pump);
  appendOptional(query, "shiftType", filters.shiftType);
  appendOptional(query, "category", filters.category);
  appendOptional(query, "clientId", filters.clientId);
  appendOptional(query, "containerStatus", filters.containerStatus);

  if (filters.includeDeleted) {
    query.set("includeDeleted", "true");
  }

  return query.toString();
}

export function toReportQuery(filters: ReportFilters): string {
  const query = new URLSearchParams();
  query.set("dateFrom", filters.dateFrom);
  query.set("dateTo", filters.dateTo);
  query.set("granularity", filters.granularity);
  appendOptional(query, "pump", filters.pump);
  appendOptional(query, "shiftType", filters.shiftType);
  appendOptional(query, "category", filters.category);
  appendOptional(query, "clientId", filters.clientId);
  appendOptional(query, "containerStatus", filters.containerStatus);

  if (filters.includeDeleted) {
    query.set("includeDeleted", "true");
  }

  return query.toString();
}
