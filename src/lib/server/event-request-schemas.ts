import { z } from "zod";
import { categories, containerStatuses } from "@/types/domain";

const idleCategories = [
  "EM_TRANSITO",
  "AGUARDANDO_LABORATORIO",
  "SEM_CAMINHAO",
  "SEM_CONTAINER",
  "MANUTENCAO",
  "OUTROS"
] as const;

const gapJustificationSchema = z
  .object({
    id: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    durationMinutes: z.number(),
    category: z.enum(idleCategories),
    clientId: z.string().nullable(),
    plate: z.string().nullable(),
    notes: z.string().nullable()
  })
  .strict();

const gapJustificationsByEventSchema = z.record(
  z.array(gapJustificationSchema)
);

export const eventMutationBodySchema = z
  .object({
    pump: z.enum(["BOMBA_1", "BOMBA_2", "BOMBA_3"]),
    shiftDate: z.string(),
    shiftType: z.enum(["MANHA", "NOITE"]),
    startTime: z.string(),
    endTime: z.string(),
    category: z.enum(categories),
    clientId: z.string().nullable(),
    plate: z.string().nullable(),
    container: z.string().nullable(),
    containerStatus: z.enum(containerStatuses).nullable().optional(),
    containerReason: z.string().nullable().optional(),
    startsNewContainerCycle: z.boolean().optional(),
    blendConfirmed: z.boolean().optional(),
    expectedContainerStateVersion: z.number().int().min(0).nullable().optional(),
    loadSourceType: z.enum(["TRUCK", "BUFFER_CONTAINER"]).nullable().optional(),
    sourceContainer: z.string().trim().max(32).nullable().optional(),
    sourceContainerEmptied: z.boolean().nullable().optional(),
    expectedSourceContainerStateVersion: z.number().int().min(0).nullable().optional(),
    notes: z.string().nullable(),
    revisionReason: z.string().nullable().optional(),
    gapVersion: z.string().nullable().optional(),
    gapJustifications: z.array(gapJustificationSchema).optional(),
    gapJustificationsByEvent: gapJustificationsByEventSchema.optional()
  })
  .strict();

export const eventCreateBodySchema = eventMutationBodySchema
  .extend({
    checkInId: z.string().trim().uuid().nullable().optional(),
    manualPlateReason: z.string().trim().min(1).max(500).nullable().optional()
  })
  .strict();

export const deleteEventBodySchema = z
  .object({
    reason: z.string(),
    gapVersion: z.string().optional(),
    gapJustifications: z.array(gapJustificationSchema).optional()
  })
  .strict();

export const gapPreviewBodySchema = z
  .object({
    pump: z.enum(["BOMBA_1", "BOMBA_2", "BOMBA_3"]),
    shiftDate: z.string(),
    shiftType: z.enum(["MANHA", "NOITE"]),
    startTime: z.string(),
    endTime: z.string().optional(),
    eventId: z.string().trim().min(1).optional(),
    operation: z.enum(["UPSERT", "DELETE"]).optional()
  })
  .strict();

export const restoreEventBodySchema = z
  .object({
    gapVersion: z.string().trim().min(1),
    gapJustificationsByEvent: gapJustificationsByEventSchema.optional(),
    expectedContainerStateVersion: z.number().int().min(0).nullable(),
    expectedSourceContainerStateVersion: z.number().int().min(0).nullable().optional()
  })
  .strict();
