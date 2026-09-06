import {
  Category,
  ContainerLifecycleStatus,
  ContainerStatus,
  Pump,
  ShiftType
} from "@/types/domain";

export const pumpOptions: Array<{ value: Pump; label: string }> = [
  { value: "BOMBA_1", label: "Bomba 1" },
  { value: "BOMBA_2", label: "Bomba 2" },
  { value: "BOMBA_3", label: "Bomba 3" }
];

export const pumpLabelMap = Object.fromEntries(
  pumpOptions.map((option) => [option.value, option.label])
) as Record<Pump, string>;

export const pumpShortLabelMap: Record<Pump, string> = {
  BOMBA_1: "B1",
  BOMBA_2: "B2",
  BOMBA_3: "B3"
};

export const containerStatusOptions: Array<{ value: ContainerStatus; label: string }> = [
  { value: "FULL", label: "Cheio / Normal" },
  { value: "PARTIAL", label: "Parcial" },
  { value: "BUFFER", label: "Pulmão" },
  { value: "BLEND_FULL", label: "Blend cheio" },
  { value: "BLEND_PARTIAL", label: "Blend parcial" }
];

export const containerStatusLabelMap: Record<ContainerLifecycleStatus, string> = {
  ...Object.fromEntries(
    containerStatusOptions.map((option) => [option.value, option.label])
  ) as Record<ContainerStatus, string>,
  TRANSFER_EMPTIED: "Esvaziado por transferência"
};

export const shiftOptions: Array<{ value: ShiftType; label: string }> = [
  { value: "MANHA", label: "MANHÃ" },
  { value: "NOITE", label: "NOITE" }
];

export const shiftLabelMap = Object.fromEntries(
  shiftOptions.map((option) => [option.value, option.label])
) as Record<ShiftType, string>;

export const categoryOptions: Array<{ value: Category; label: string }> = [
  { value: "PRODUTIVO", label: "Produtivo" },
  { value: "EM_TRANSITO", label: "Em Trânsito" },
  { value: "AGUARDANDO_LABORATORIO", label: "Aguardando Laboratório" },
  { value: "SEM_CAMINHAO", label: "Sem Caminhão" },
  { value: "SEM_CONTAINER", label: "Sem Container" },
  { value: "MANUTENCAO", label: "Manutenção" },
  { value: "OUTROS", label: "Outros" }
];

export const idleCategoryOptions = categoryOptions.filter(
  (option): option is { value: Exclude<Category, "PRODUTIVO" | "INTERVALO_OPERACIONAL">; label: string } =>
    option.value !== "PRODUTIVO" && option.value !== "INTERVALO_OPERACIONAL"
);

export const reportCategoryOptions: Array<{ value: Category; label: string }> = [
  ...categoryOptions,
  { value: "INTERVALO_OPERACIONAL", label: "Intervalo operacional" }
];

export const categoryLabelMap: Record<Category, string> = {
  PRODUTIVO: "Produtivo",
  INTERVALO_OPERACIONAL: "Intervalo operacional",
  EM_TRANSITO: "Em Trânsito",
  AGUARDANDO_LABORATORIO: "Aguardando Laboratório",
  SEM_CAMINHAO: "Sem Caminhão",
  SEM_CONTAINER: "Sem Container",
  MANUTENCAO: "Manutenção",
  OUTROS: "Outros"
};
