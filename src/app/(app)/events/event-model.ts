import { currentShiftFromNow } from "@/lib/domain/time";
import { pumpShortLabelMap } from "@/lib/domain/options";
import {
  Category,
  ContainerStatus,
  GapJustification,
  GapPreview,
  Pump,
  ShiftType
} from "@/types/domain";
import {
  EventApiItem,
  RestoreEventPreviewResponse
} from "@/types/api";
import {
  EventListFilters,
  toEventListQuery
} from "@/lib/ui/filters";

export type EventFormState = {
  pump: Pump;
  shiftDate: string;
  shiftType: ShiftType;
  startTime: string;
  endTime: string;
  category: Category;
  clientId: string;
  plate: string;
  container: string;
  containerStatus: ContainerStatus | null;
  containerReason: string;
  startsNewContainerCycle: boolean;
  blendConfirmed: boolean;
  expectedContainerStateVersion: number | null;
  notes: string;
  revisionReason?: string;
  gapPreview: GapPreview | null;
  gapJustifications: GapJustification[];
  gapJustificationsByEvent: Record<string, GapJustification[]>;
};

export type DeletePlan = {
  eventId: string;
  reason: string;
  preview: GapPreview;
  gapJustifications: GapJustification[];
};

export type RestorePlan = {
  eventId: string;
  preview: RestoreEventPreviewResponse;
  gapJustificationsByEvent: Record<string, GapJustification[]>;
};

export const categoryDescriptions: Record<Category, string> = {
  PRODUTIVO: "Transbordo em execução.",
  INTERVALO_OPERACIONAL: "Intervalo gerado automaticamente.",
  EM_TRANSITO: "Movimentação entre pontos.",
  AGUARDANDO_LABORATORIO: "Parado aguardando liberação.",
  SEM_CAMINHAO: "Sem veículo disponível.",
  SEM_CONTAINER: "Sem container para operação.",
  MANUTENCAO: "Parada para manutenção.",
  OUTROS: "Ocorrências fora dos cenários acima."
};

export const categoryNotesPlaceholders: Partial<Record<Category, string>> = {
  AGUARDANDO_LABORATORIO:
    "Informe quantas carretas estão aguardando o laboratório."
};

export function makeInitialForm(): EventFormState {
  const currentShift = currentShiftFromNow();

  return {
    pump: "BOMBA_1",
    shiftDate: currentShift.shiftDate,
    shiftType: currentShift.shiftType,
    startTime: "",
    endTime: "",
    category: "PRODUTIVO",
    clientId: "",
    plate: "",
    container: "",
    containerStatus: "FULL",
    containerReason: "",
    startsNewContainerCycle: false,
    blendConfirmed: false,
    expectedContainerStateVersion: null,
    notes: "",
    gapPreview: null,
    gapJustifications: [],
    gapJustificationsByEvent: {}
  };
}

export function makeInitialEventFilters(): EventListFilters {
  const currentShift = currentShiftFromNow();

  return {
    dateFrom: currentShift.shiftDate,
    dateTo: currentShift.shiftDate,
    pump: "",
    shiftType: "",
    category: "",
    clientId: "",
    containerStatus: "",
    includeDeleted: false
  };
}

export function toPayload(form: EventFormState) {
  return {
    pump: form.pump,
    shiftDate: form.shiftDate,
    shiftType: form.shiftType,
    startTime: form.startTime,
    endTime: form.endTime,
    category: form.category,
    clientId: form.clientId || null,
    plate: form.plate || null,
    container: form.container || null,
    containerStatus:
      form.category === "PRODUTIVO"
        ? form.containerStatus || "FULL"
        : null,
    containerReason: form.containerReason || null,
    startsNewContainerCycle: form.startsNewContainerCycle,
    blendConfirmed: form.blendConfirmed,
    expectedContainerStateVersion: form.expectedContainerStateVersion,
    notes: form.notes || null,
    revisionReason: form.revisionReason || null,
    gapVersion: form.gapPreview?.gapVersion || null,
    gapJustifications: form.gapJustifications,
    gapJustificationsByEvent: form.gapJustificationsByEvent
  };
}

export function toEventPageQuery(
  filters: EventListFilters,
  cursor?: string | null
): string {
  const query = new URLSearchParams(toEventListQuery(filters));

  if (cursor) {
    query.set("cursor", cursor);
  }

  return query.toString();
}

export function mergeEventPageItems<T extends { id: string }>(
  current: T[],
  incoming: T[]
): T[] {
  const incomingById = new Map(
    incoming.map((item) => [item.id, item])
  );
  const currentIds = new Set(current.map((item) => item.id));

  return [
    ...current.map((item) => incomingById.get(item.id) || item),
    ...incoming.filter((item) => !currentIds.has(item.id))
  ];
}

export function toViewDate(iso: string): string {
  if (!iso) {
    return "-";
  }

  return new Date(iso).toLocaleString("pt-BR");
}

export function formatDuration(durationMinutes: number): string {
  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;

  if (hours && minutes) {
    return `${hours}h ${minutes}m`;
  }

  if (hours) {
    return `${hours}h`;
  }

  return `${minutes}m`;
}

export function pumpShortLabel(pump: Pump): string {
  return pumpShortLabelMap[pump];
}

export function toClockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const date = new Date(2000, 0, 1, h, m);
  return date.toLocaleTimeString("pt-BR", {
    hour: "numeric",
    minute: "2-digit"
  });
}

export function wasEdited(item: EventApiItem): boolean {
  const createdMs = Date.parse(item.createdAt);
  const updatedMs = Date.parse(item.updatedAt);

  if (Number.isFinite(createdMs) && Number.isFinite(updatedMs)) {
    return updatedMs > createdMs;
  }

  return item.updatedAt !== item.createdAt;
}
