import { Category, Pump, ShiftType } from "@/types/domain";

export const pumpOptions: Array<{ value: Pump; label: string }> = [
  { value: "BOMBA_1", label: "Bomba 1" },
  { value: "BOMBA_2", label: "Bomba 2" }
];

export const shiftOptions: Array<{ value: ShiftType; label: string }> = [
  { value: "MANHA", label: "MANHÃ" },
  { value: "NOITE", label: "NOITE" }
];

export const categoryOptions: Array<{ value: Category; label: string }> = [
  { value: "PRODUTIVO", label: "Produtivo" },
  { value: "EM_TRANSITO", label: "Em Trânsito" },
  { value: "AGUARDANDO_LABORATORIO", label: "Aguardando Laboratório" },
  { value: "SEM_CAMINHAO", label: "Sem Caminhão" },
  { value: "SEM_CONTAINER", label: "Sem Container" },
  { value: "MANUTENCAO", label: "Manutenção" },
  { value: "OUTROS", label: "Outros" }
];

export const categoryLabelMap = Object.fromEntries(
  categoryOptions.map((option) => [option.value, option.label])
) as Record<Category, string>;
