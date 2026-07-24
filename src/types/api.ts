import {
  ContainerStateDoc,
  ContainerStatus,
  EventDoc,
  UserDoc
} from "@/types/domain";

export type EventApiItem = Omit<EventDoc, "createdAt" | "updatedAt" | "startAt" | "endAt"> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  startAt: string;
  endAt: string;
  warnings?: string[];
};

export type ContainerStateApiItem = Omit<
  ContainerStateDoc,
  "operationalAt" | "eventCreatedAt" | "updatedAt"
> & {
  operationalAt: string;
  eventCreatedAt: string;
  updatedAt: string;
};

export type ContainerLookupResponse = {
  container: string;
  current: ContainerStateApiItem | null;
  availableStatuses: ContainerStatus[];
  requiresNewCycleConfirmation: boolean;
};

export type ContainerHistoryItem = EventApiItem & {
  status: ContainerStatus;
};

export type ClientApiItem = {
  id: string;
  name: string;
  nameUpper: string;
  active: boolean;
};

export type UserApiItem = UserDoc & { id: string };

export type DisplayClientCount = {
  clientId: string;
  clientName: string;
  finalizedToday: number;
  openNow: number;
};

export type DisplayOverviewResponse = {
  operationalDate: string;
  generatedAt: string;
  finalizedTotal: number;
  averageProductiveMinutes: number | null;
  openContainers: {
    total: number;
    partial: number;
    buffer: number;
    blendPartial: number;
  };
  clients: DisplayClientCount[];
};

export type ReportGranularity = "day" | "week" | "month";

export type ReportKpi = {
  current: number;
  previous: number;
  deltaPercent: number | null;
};

export type ReportSeriesPoint = {
  bucket: string;
  label: string;
  productiveMinutes: number;
  idleMinutes: number;
  totalMinutes: number;
};

export type ReportAuditSummary = {
  editedActions: number;
  deletedActions: number;
};

export type ReportsOverviewResponse = {
  filtersApplied: {
    dateFrom: string;
    dateTo: string;
    granularity: ReportGranularity;
    pump?: string;
    shiftType?: string;
    category?: string;
    clientId?: string;
      includeDeleted: boolean;
      containerStatus?: ContainerStatus;
  };
  kpis: {
    totalMinutes: ReportKpi;
    productiveMinutes: ReportKpi;
    idleMinutes: ReportKpi;
    productiveRateMinutes: ReportKpi;
    totalEvents: ReportKpi;
    productiveEvents: ReportKpi;
    productiveRateEvents: ReportKpi;
    avgProductiveTransbordoMinutes: ReportKpi;
  };
  charts: {
    productiveVsIdleByPump: Array<{
      pump: string;
      productiveMinutes: number;
      idleMinutes: number;
      totalMinutes: number;
      productiveRateMinutes: number;
    }>;
    idleByCategoryMinutes: Array<{
      category: string;
      minutes: number;
    }>;
    idleByCategoryCount: Array<{
      category: string;
      count: number;
    }>;
    trendSeries: ReportSeriesPoint[];
    shiftDistribution: Array<{
      shiftType: string;
      productiveMinutes: number;
      idleMinutes: number;
      totalMinutes: number;
      productiveRateMinutes: number;
    }>;
  };
  audit: ReportAuditSummary;
  totals: {
    processedCurrent: number;
    processedComparisonWindow: number;
  };
  limits: {
    maxPeriodDays: number;
    maxEventsProcessed: number;
  };
  warnings: string[];
};

export type ReportDrilldownRow = {
  id: string;
  shiftDate: string;
  shiftType: string;
  pump: string;
  category: string;
  productive: boolean;
  durationMinutes: number;
  startTime: string;
  endTime: string;
  clientNameSnapshot: string | null;
  notes: string | null;
  plate: string | null;
  container: string | null;
  containerStatus: ContainerStatus | null;
  containerReason: string | null;
  createdByEmail: string;
  updatedByEmail: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  deletedReason: string | null;
};

export type ReportsDrilldownResponse = {
  source: "kpi" | "chart";
  rows: ReportDrilldownRow[];
  nextCursor: string | null;
  summary: {
    totalRows: number;
    returnedRows: number;
  };
};
