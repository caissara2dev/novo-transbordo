import { z } from "zod";
import { categories, EventInput, ShiftType } from "@/types/domain";
import {
  calculateDurationMinutes,
  computeWindowCheck,
  isValidHHMM,
  resolveTimelineDate
} from "@/lib/domain/time";
import { categoryRules } from "@/lib/domain/constants";
import { normalizeContainer, normalizePlate } from "@/lib/domain/identifiers";

const baseSchema = z.object({
  pump: z.enum(["BOMBA_1", "BOMBA_2"]),
  shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shiftType: z.enum(["MANHA", "NOITE"]),
  startTime: z.string(),
  endTime: z.string(),
  category: z.enum(categories),
  clientId: z.string().trim().min(1).nullable(),
  plate: z.string().trim().nullable(),
  container: z.string().trim().nullable(),
  notes: z.string().trim().nullable()
});

export type EventValidationResult = {
  event: EventInput;
  warnings: string[];
  startAtIso: string;
  endAtIso: string;
  durationMinutes: number;
  productive: boolean;
};

export function canEdit(role: string, createdAtMs: number, nowMs: number): boolean {
  if (role === "ADMIN") {
    return true;
  }

  if (role !== "SUPERVISOR") {
    return false;
  }

  return nowMs - createdAtMs <= 24 * 60 * 60 * 1000;
}

export function validateEventInput(raw: unknown): EventValidationResult {
  const parsed = baseSchema.parse(raw);

  if (!isValidHHMM(parsed.startTime) || !isValidHHMM(parsed.endTime)) {
    throw new Error("Horario deve estar no formato HH:MM.");
  }

  const normalized: EventInput = {
    ...parsed,
    plate: normalizePlate(parsed.plate),
    container: normalizeContainer(parsed.container),
    notes: parsed.notes?.trim() || null
  };

  const rules = categoryRules[normalized.category];

  if (rules.requiresClient && !normalized.clientId) {
    throw new Error("Cliente obrigatorio para esta categoria.");
  }

  if (rules.requiresPlate && !normalized.plate) {
    throw new Error("Placa obrigatoria para esta categoria.");
  }

  if (rules.requiresContainer && !normalized.container) {
    throw new Error("Container obrigatorio para esta categoria.");
  }

  if (rules.requiresNotes && !normalized.notes) {
    throw new Error("Observacao obrigatoria para esta categoria.");
  }

  const startDt = resolveTimelineDate(
    normalized.shiftDate,
    normalized.shiftType,
    normalized.startTime
  );
  let endDt = resolveTimelineDate(
    normalized.shiftDate,
    normalized.shiftType,
    normalized.endTime
  );

  if (endDt <= startDt) {
    if (normalized.shiftType === "NOITE") {
      endDt = endDt.plus({ days: 1 });
    } else {
      throw new Error("Horario de inicio deve ser menor que horario de fim.");
    }
  }

  const durationMinutes = calculateDurationMinutes(startDt.toISO() ?? "", endDt.toISO() ?? "");

  if (durationMinutes < 1) {
    throw new Error("Duracao minima de 1 minuto.");
  }

  if (durationMinutes > 540) {
    throw new Error("Duracao maxima de 9 horas.");
  }

  const warnings: string[] = [];

  if (!computeWindowCheck(normalized.shiftType, normalized.startTime)) {
    warnings.push("Horario de inicio fora da janela do turno selecionado.");
  }

  if (!computeWindowCheck(normalized.shiftType, normalized.endTime)) {
    warnings.push("Horario de fim fora da janela do turno selecionado.");
  }

  return {
    event: normalized,
    warnings,
    startAtIso: startDt.toISO() ?? "",
    endAtIso: endDt.toISO() ?? "",
    durationMinutes,
    productive: normalized.category === "PRODUTIVO"
  };
}

export function collectChangedFields(
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): {
  changedFields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
} {
  const changedFields: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const key of Object.keys(next)) {
    const oldValue = previous[key] ?? null;
    const newValue = next[key] ?? null;

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changedFields.push(key);
      before[key] = oldValue;
      after[key] = newValue;
    }
  }

  return { changedFields, before, after };
}

export function roleCanAccessUsers(role: string): boolean {
  return role === "ADMIN";
}

export function roleCanAccessClients(role: string): boolean {
  return role === "ADMIN";
}

export function ensureShiftType(input: string): ShiftType {
  if (input === "MANHA" || input === "NOITE") {
    return input;
  }

  throw new Error("Turno invalido.");
}
