import { z } from "zod";
import {
  checkinStatuses,
  validateDriverCheckinInput
} from "@/lib/domain/checkins";
import type {
  CheckinStatus,
  DriverCheckinForm
} from "@/lib/domain/checkins";
import { HttpError } from "@/lib/domain/errors";
import type { InternalCheckinActor } from "@/lib/server/checkins/internal-service";
import type { RequestContext } from "@/lib/server/auth";

export const expectedVersionSchema = z.number().int().min(1);

export const reasonSchema = z.string().trim().min(1).max(500);

export const checkinIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !value.includes("/"));

const correctionPatchSchema = z
  .object({
    driverName: z.string().trim().min(1).max(120).optional(),
    driverLicense: z.string().trim().min(1).max(32).optional(),
    driverPhone: z.string().trim().min(1).max(32).optional(),
    plate: z.string().trim().min(1).max(12).optional(),
    carrierName: z.string().trim().min(1).max(120).optional(),
    vehicleType: z.enum(["Bitrem", "Rodotrem", "Vanderleia"]).optional(),
    product: z.string().trim().min(1).max(120).optional(),
    originPlant: z.string().trim().min(1).max(120).optional(),
    originInvoiceNumbers: z.string().trim().min(1).max(250).optional(),
    remittanceInvoiceNumber: z.string().trim().min(1).max(250).optional(),
    whatsappNoticeAccepted: z.literal(true).optional(),
    queueLocationAccepted: z.literal(true).optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Informe ao menos um campo para correção."
  });

export const checkinMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("ASSIGN_CLIENT"),
      clientId: checkinIdSchema,
      expectedVersion: expectedVersionSchema,
      reason: reasonSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("CORRECT"),
      patch: correctionPatchSchema,
      expectedVersion: expectedVersionSchema,
      reason: reasonSchema
    })
    .strict()
]);

export const transitionSchema = z
  .object({
    toStatus: z.enum(checkinStatuses),
    expectedVersion: expectedVersionSchema,
    reason: reasonSchema
  })
  .strict();

export const cancellationSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reason: reasonSchema
  })
  .strict();

export const locationOverrideSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    justification: reasonSchema
  })
  .strict();

const managerDetailSchema = z
  .object({
    publicCode: z.string().regex(/^LT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/),
    status: z.enum(checkinStatuses),
    version: expectedVersionSchema,
    driverName: z.string(),
    driverLicense: z.string(),
    driverPhone: z.string(),
    plate: z.string(),
    carrierName: z.string(),
    vehicleType: z.enum(["Bitrem", "Rodotrem", "Vanderleia"]),
    product: z.string(),
    originPlant: z.string(),
    originInvoiceNumbers: z.string(),
    remittanceInvoiceNumber: z.string(),
    whatsappNoticeAccepted: z.literal(true),
    queueLocationAccepted: z.literal(true)
  })
  .passthrough();

export type OfficialRecordDetail = z.infer<typeof managerDetailSchema>;

export function actorFromContext(context: RequestContext): InternalCheckinActor {
  return {
    uid: context.uid,
    role: context.profile.role
  };
}

export function parseCheckinId(rawId: string): string {
  return checkinIdSchema.parse(rawId);
}

export function parseStatuses(searchParams: URLSearchParams): CheckinStatus[] | undefined {
  const query: Record<string, string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    query[key] = [...(query[key] ?? []), value];
  }
  const parsed = z
    .object({
      status: z.array(z.enum(checkinStatuses)).max(checkinStatuses.length).optional()
    })
    .strict()
    .parse(query);
  return parsed.status;
}

export function parseOfficialRecordDetail(value: unknown): OfficialRecordDetail {
  return managerDetailSchema.parse(value);
}

export function assertExpectedDetailVersion(
  detail: OfficialRecordDetail,
  expectedVersion: number
): void {
  if (detail.version !== expectedVersion) {
    throw new HttpError(
      409,
      "O check-in foi alterado. Atualize os dados e tente novamente."
    );
  }
}

export function formFromOfficialDetail(
  detail: OfficialRecordDetail
): DriverCheckinForm {
  return validateDriverCheckinInput({
    driverName: detail.driverName,
    driverLicense: detail.driverLicense,
    driverPhone: detail.driverPhone,
    plate: detail.plate,
    carrierName: detail.carrierName,
    vehicleType: detail.vehicleType,
    product: detail.product,
    originPlant: detail.originPlant,
    originInvoiceNumbers: detail.originInvoiceNumbers,
    remittanceInvoiceNumber: detail.remittanceInvoiceNumber,
    whatsappNoticeAccepted: detail.whatsappNoticeAccepted,
    queueLocationAccepted: detail.queueLocationAccepted
  });
}

export function normalizedCorrectionPatch(
  detail: OfficialRecordDetail,
  patch: Partial<DriverCheckinForm>
): Partial<DriverCheckinForm> {
  const current = formFromOfficialDetail(detail);
  const normalized = validateDriverCheckinInput({
    ...current,
    ...patch
  });
  const entries = (Object.keys(patch) as Array<keyof DriverCheckinForm>)
    .filter((field) => normalized[field] !== current[field])
    .map((field) => [field, normalized[field]] as const);
  if (entries.length === 0) {
    throw new HttpError(400, "A correção não altera nenhum campo.");
  }
  return Object.fromEntries(entries) as Partial<DriverCheckinForm>;
}
