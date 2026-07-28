export type UserRole = "OPERATOR" | "SUPERVISOR" | "DISPLAY" | "ADMIN";

export type ShiftType = "MANHA" | "NOITE";

export type Pump = "BOMBA_1" | "BOMBA_2" | "BOMBA_3";

export const containerStatuses = [
  "FULL",
  "PARTIAL",
  "BUFFER",
  "BLEND_FULL",
  "BLEND_PARTIAL"
] as const;

export type ContainerStatus = (typeof containerStatuses)[number];

export const categories = [
  "PRODUTIVO",
  "INTERVALO_OPERACIONAL",
  "EM_TRANSITO",
  "AGUARDANDO_LABORATORIO",
  "SEM_CAMINHAO",
  "SEM_CONTAINER",
  "MANUTENCAO",
  "OUTROS"
] as const;

export type Category = (typeof categories)[number];

export type EventOrigin = "MANUAL" | "AUTO_GAP";

export type GapSegment = {
  id: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
};

export type GapJustification = GapSegment & {
  category: Exclude<Category, "PRODUTIVO" | "INTERVALO_OPERACIONAL">;
  clientId: string | null;
  plate: string | null;
  notes: string | null;
};

export type GapPreview = {
  toleranceMinutes: number;
  gapVersion: string;
  uncoveredSegments: GapSegment[];
  uncoveredMinutes: number;
  requiresJustification: boolean;
  reconciliationEventId?: string | null;
  reconciliations?: Array<{
    eventId: string;
    preview: Omit<GapPreview, "reconciliations">;
  }>;
};

export type EventInput = {
  pump: Pump;
  shiftDate: string;
  shiftType: ShiftType;
  startTime: string;
  endTime: string;
  category: Category;
  clientId: string | null;
  plate: string | null;
  container: string | null;
  containerStatus: ContainerStatus | null;
  containerReason: string | null;
  startsNewContainerCycle: boolean;
  blendConfirmed: boolean;
  expectedContainerStateVersion: number | null;
  notes: string | null;
};

export type UserDoc = {
  email: string;
  name: string | null;
  role: UserRole;
  approved: boolean;
  active: boolean;
  createdAt: unknown;
  updatedAt: unknown;
  approvedAt: unknown;
  approvedByUid: string | null;
  approvedByEmail: string | null;
};

export type ClientDoc = {
  name: string;
  nameUpper: string;
  active: boolean;
  createdAt: unknown;
  createdByUid: string;
  updatedAt: unknown;
  updatedByUid: string;
};

export type EventDoc = Omit<EventInput, "expectedContainerStateVersion"> & {
  productive: boolean;
  origin: EventOrigin;
  generatedForEventId: string | null;
  gapSegmentId: string | null;
  justificationWaived: boolean;
  reconciledAfterEventId?: string | null;
  deletionReconciliationEventId?: string | null;
  deletionTimelineVersion?: number | null;
  clientNameSnapshot: string | null;
  containerCycleId: string | null;
  previousContainerEventId: string | null;
  containerStateVersion: number | null;
  startAt: unknown;
  endAt: unknown;
  durationMinutes: number;
  createdByUid: string;
  createdByEmail: string;
  updatedByUid: string;
  updatedByEmail: string;
  createdAt: unknown;
  updatedAt: unknown;
  deleted: boolean;
  deletedAt: unknown;
  deletedByUid: string | null;
  deletedByEmail: string | null;
  deletedReason: string | null;
};

export type ContainerCyclePassage = {
  id: string;
  startTime: string;
  endTime: string;
  pump: Pump;
  plate: string | null;
  status: ContainerStatus;
};

export type ContainerStateDoc = {
  container: string;
  status: ContainerStatus;
  reason: string | null;
  cycleId: string;
  latestEventId: string;
  previousEventId: string | null;
  clientId: string;
  clientNameSnapshot: string | null;
  plate: string;
  pump: Pump;
  operationalAt: unknown;
  eventCreatedAt: unknown;
  version: number;
  updatedAt: unknown;
};
