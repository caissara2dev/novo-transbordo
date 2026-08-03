import { z } from "zod";
import { categories, containerStatuses, EventInput, ShiftType } from "@/types/domain";
import {
  calculateDurationMinutes,
  computeWindowCheck,
  isValidHHMM,
  resolveTimelineDate
} from "@/lib/domain/time";
import { categoryRules } from "@/lib/domain/constants";
import { HttpError } from "@/lib/domain/errors";
import { normalizeContainer, normalizePlate } from "@/lib/domain/identifiers";

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Data inválida.");

const baseSchema = z.object({
  pump: z.enum(["BOMBA_1", "BOMBA_2", "BOMBA_3"]),
  shiftDate: isoDateSchema,
  shiftType: z.enum(["MANHA", "NOITE"]),
  startTime: z.string(),
  endTime: z.string(),
  category: z.enum(categories),
  clientId: z.string().trim().min(1).nullable(),
  plate: z.string().trim().nullable(),
  container: z.string().trim().nullable(),
  containerStatus: z.enum(containerStatuses).nullable().optional(),
  containerReason: z.string().trim().nullable().optional(),
  startsNewContainerCycle: z.boolean().optional(),
  blendConfirmed: z.boolean().optional(),
  expectedContainerStateVersion: z.number().int().min(0).nullable().optional(),
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
    throw new HttpError(400, "Horário deve estar no formato HH:MM.");
  }

  const normalizedContainer = normalizeContainer(parsed.container);
  const isProductiveContainer = parsed.category === "PRODUTIVO" && Boolean(normalizedContainer);
  const containerStatus = isProductiveContainer ? parsed.containerStatus ?? "FULL" : null;
  const containerReason = isProductiveContainer
    ? parsed.containerReason?.trim() || null
    : null;

  const normalized: EventInput = {
    ...parsed,
    plate: normalizePlate(parsed.plate),
    container: normalizedContainer,
    containerStatus,
    containerReason,
    startsNewContainerCycle: isProductiveContainer
      ? Boolean(parsed.startsNewContainerCycle)
      : false,
    blendConfirmed: isProductiveContainer ? Boolean(parsed.blendConfirmed) : false,
    expectedContainerStateVersion:
      parsed.expectedContainerStateVersion === undefined
        ? null
        : parsed.expectedContainerStateVersion,
    notes: parsed.notes?.trim() || null
  };

  const rules = categoryRules[normalized.category];

  if (rules.requiresClient && !normalized.clientId) {
    throw new HttpError(400, "Cliente obrigatório para esta categoria.");
  }

  if (rules.requiresPlate && !normalized.plate) {
    throw new HttpError(400, "Placa obrigatória para esta categoria.");
  }

  if (rules.requiresContainer && !normalized.container) {
    throw new HttpError(400, "Container obrigatório para esta categoria.");
  }

  if (rules.requiresNotes && !normalized.notes) {
    throw new HttpError(400, "Observação obrigatória para esta categoria.");
  }

  if (
    normalized.containerStatus === "PARTIAL" ||
    normalized.containerStatus === "BUFFER" ||
    normalized.containerStatus === "BLEND_PARTIAL"
  ) {
    if (!normalized.containerReason) {
      throw new HttpError(400, "Motivo do estado do container é obrigatório.");
    }
  }

  if (
    (normalized.containerStatus === "BLEND_FULL" ||
      normalized.containerStatus === "BLEND_PARTIAL") &&
    !normalized.blendConfirmed
  ) {
    throw new HttpError(400, "Confirme a formação do Blend antes de salvar.");
  }

  if (
    normalized.startsNewContainerCycle &&
    (normalized.containerStatus === "BLEND_FULL" ||
      normalized.containerStatus === "BLEND_PARTIAL")
  ) {
    throw new HttpError(400, "Um novo ciclo não pode começar diretamente como Blend.");
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

  if (!startDt.isValid || !endDt.isValid) {
    throw new HttpError(400, "Data ou horário do lançamento é inválido.");
  }

  if (endDt <= startDt) {
    if (normalized.shiftType === "NOITE") {
      endDt = endDt.plus({ days: 1 });
    } else {
      throw new HttpError(400, "Horário de início deve ser menor que horário de fim.");
    }
  }

  const durationMinutes = calculateDurationMinutes(startDt.toISO() ?? "", endDt.toISO() ?? "");

  if (!Number.isFinite(durationMinutes) || durationMinutes < 1) {
    throw new HttpError(400, "Duração mínima de 1 minuto.");
  }

  if (durationMinutes > 540) {
    throw new HttpError(400, "Duração máxima de 9 horas.");
  }

  const warnings: string[] = [];

  if (!computeWindowCheck(normalized.shiftType, normalized.startTime)) {
    warnings.push("Horário de início fora da janela do turno selecionado.");
  }

  if (!computeWindowCheck(normalized.shiftType, normalized.endTime)) {
    warnings.push("Horário de fim fora da janela do turno selecionado.");
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

  throw new HttpError(400, "Turno inválido.");
}
