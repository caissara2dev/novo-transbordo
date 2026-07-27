type TimelineValue =
  | { toMillis: () => number }
  | Date
  | string
  | number
  | null
  | undefined;

type OperationalTimelineItem = {
  id: string;
  startAt: TimelineValue;
  endAt?: TimelineValue;
  createdAt?: TimelineValue;
};

type FilterableTimelineItem = OperationalTimelineItem & {
  shiftDate: string;
  pump: string;
  shiftType: string;
  category: string;
  clientId?: string | null;
  containerStatus?: string | null;
  createdByUid: string;
  deleted: boolean;
};

type OperationalHistoryFilters = {
  dateFrom?: string;
  dateTo?: string;
  pump?: string;
  shiftType?: string;
  category?: string;
  clientId?: string;
  containerStatus?: string;
  includeDeleted?: boolean;
};

function toMillis(value: TimelineValue): number {
  if (value && typeof value === "object" && "toMillis" in value) {
    return value.toMillis();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

export function sortByOperationalTimeline<T extends OperationalTimelineItem>(
  items: T[]
): T[] {
  return [...items].sort((left, right) => {
    const byStart = toMillis(right.startAt) - toMillis(left.startAt);
    if (byStart !== 0) return byStart;

    const byEnd = toMillis(right.endAt) - toMillis(left.endAt);
    if (byEnd !== 0) return byEnd;

    const byCreation = toMillis(right.createdAt) - toMillis(left.createdAt);
    if (byCreation !== 0) return byCreation;

    return right.id.localeCompare(left.id);
  });
}

export function filterAndSortOperationalHistory<T extends FilterableTimelineItem>(
  items: T[],
  params: {
    role: string;
    uid: string;
    filters: OperationalHistoryFilters;
    limit?: number;
  }
): T[] {
  const { role, uid, filters } = params;

  const filtered = items.filter((event) => {
    if (role === "OPERATOR" && event.createdByUid !== uid) return false;
    if (!filters.includeDeleted && event.deleted) return false;
    if (filters.dateFrom && event.shiftDate < filters.dateFrom) return false;
    if (filters.dateTo && event.shiftDate > filters.dateTo) return false;
    if (filters.pump && event.pump !== filters.pump) return false;
    if (filters.shiftType && event.shiftType !== filters.shiftType) return false;
    if (filters.category && event.category !== filters.category) return false;
    if (filters.clientId && event.clientId !== filters.clientId) return false;
    if (
      filters.containerStatus &&
      event.containerStatus !== filters.containerStatus
    ) {
      return false;
    }
    return true;
  });

  return sortByOperationalTimeline(filtered).slice(0, params.limit ?? 200);
}
