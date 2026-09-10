import { z } from "zod";

const boundedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

export const checkinFormSchema = z
  .object({
    driverName: boundedText(120),
    driverLicense: boundedText(32),
    driverPhone: boundedText(32),
    plate: boundedText(16),
    carrierName: boundedText(120),
    vehicleType: z.enum(["Bitrem", "Rodotrem", "Vanderleia"]),
    product: boundedText(120),
    originPlant: boundedText(120),
    originInvoiceNumbers: boundedText(250),
    remittanceInvoiceNumber: boundedText(250),
    whatsappNoticeAccepted: z.literal(true),
    queueLocationAccepted: z.literal(true)
  })
  .strict();

export const checkinLocationSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracyMeters: z.number().finite().positive().max(100_000),
    capturedAtIso: z.string().datetime({ offset: true })
  })
  .strict();

export const checkinPreRegistrationSchema = z
  .object({
    source: z.enum(["DRIVER", "CARRIER"]),
    form: checkinFormSchema
  })
  .strict();

export const checkinConfirmationSchema = z
  .object({
    publicCode: boundedText(16),
    driverLicense: boundedText(32),
    driverPhone: boundedText(32),
    plate: boundedText(16),
    location: checkinLocationSchema
  })
  .strict();

export const checkinWalkInSchema = z
  .object({
    form: checkinFormSchema,
    location: checkinLocationSchema
  })
  .strict();

export const checkinRecoverySchema = z
  .object({
    driverLicense: boundedText(32),
    driverPhone: boundedText(32),
    plate: boundedText(16)
  })
  .strict();

export const checkinStatusQuerySchema = z
  .object({
    publicCode: boundedText(16),
    driverPhone: boundedText(32)
  })
  .strict();

export const checkinExpirationSchema = z
  .object({
    limit: z.number().int().positive().max(250).optional()
  })
  .strict();
