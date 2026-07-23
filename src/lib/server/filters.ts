import { Category, ContainerStatus, Pump, ShiftType } from "@/types/domain";

export type EventFilters = {
  dateFrom?: string;
  dateTo?: string;
  pump?: Pump;
  shiftType?: ShiftType;
  category?: Category;
  clientId?: string;
  containerStatus?: ContainerStatus;
  includeDeleted?: boolean;
};

export function parseEventFilters(searchParams: URLSearchParams): EventFilters {
  const includeDeleted = searchParams.get("includeDeleted") === "true";

  return {
    dateFrom: searchParams.get("dateFrom") || undefined,
    dateTo: searchParams.get("dateTo") || undefined,
    pump: (searchParams.get("pump") as Pump | null) || undefined,
    shiftType: (searchParams.get("shiftType") as ShiftType | null) || undefined,
    category: (searchParams.get("category") as Category | null) || undefined,
    clientId: searchParams.get("clientId") || undefined,
    containerStatus:
      (searchParams.get("containerStatus") as ContainerStatus | null) || undefined,
    includeDeleted
  };
}
