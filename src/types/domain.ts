export type UserRole = "OPERATOR" | "SUPERVISOR" | "ADMIN";

export type ShiftType = "MANHA" | "NOITE";

export type Pump = "BOMBA_1" | "BOMBA_2";

export const categories = [
  "PRODUTIVO",
  "EM_TRANSITO",
  "AGUARDANDO_LABORATORIO",
  "SEM_CAMINHAO",
  "SEM_CONTAINER",
  "MANUTENCAO",
  "OUTROS"
] as const;

export type Category = (typeof categories)[number];

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

export type EventDoc = EventInput & {
  productive: boolean;
  clientNameSnapshot: string | null;
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
