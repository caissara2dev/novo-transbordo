import { describe, expect, it } from "vitest";
import {
  checkinConfirmationSchema,
  checkinExpirationSchema,
  checkinPreRegistrationSchema,
  checkinRecoverySchema,
  checkinStatusQuerySchema,
  checkinWalkInSchema
} from "@/lib/server/checkins/integration-schemas";

const form = {
  driverName: "Motorista Exemplo",
  driverLicense: "02650306461",
  driverPhone: "(13) 99999-0000",
  plate: "ABC1D23",
  carrierName: "Transportadora Exemplo",
  vehicleType: "Bitrem" as const,
  product: "Óleo vegetal",
  originPlant: "Usina Exemplo",
  originInvoiceNumbers: "12345",
  remittanceInvoiceNumber: "67890",
  whatsappNoticeAccepted: true as const,
  queueLocationAccepted: true as const
};

describe("check-in integration schemas", () => {
  it("accepts the bounded pre-registration contract", () => {
    expect(
      checkinPreRegistrationSchema.parse({ source: "CARRIER", form })
    ).toEqual({ source: "CARRIER", form });
  });

  it("rejects unknown and oversized pre-registration fields", () => {
    expect(() =>
      checkinPreRegistrationSchema.parse({
        source: "DRIVER",
        form: { ...form, product: "x".repeat(121), unexpected: "value" }
      })
    ).toThrow();
  });

  it("requires a fresh-location timestamp in confirmation and walk-in shapes", () => {
    const location = {
      latitude: -23.95,
      longitude: -46.33,
      accuracyMeters: 50,
      capturedAtIso: "2026-08-10T12:00:00.000Z"
    };

    expect(
      checkinConfirmationSchema.parse({
        publicCode: "LT-ABCDEFGH",
        driverLicense: form.driverLicense,
        driverPhone: form.driverPhone,
        plate: form.plate,
        location
      })
    ).toMatchObject({ location });
    expect(checkinWalkInSchema.parse({ form, location })).toEqual({ form, location });
    expect(() =>
      checkinConfirmationSchema.parse({
        publicCode: "LT-ABCDEFGH",
        driverLicense: form.driverLicense,
        driverPhone: form.driverPhone,
        plate: form.plate,
        expectedVersion: 1,
        location
      })
    ).toThrow();
  });

  it("bounds recovery and status lookup credentials", () => {
    expect(
      checkinRecoverySchema.parse({
        driverLicense: form.driverLicense,
        driverPhone: form.driverPhone,
        plate: form.plate
      })
    ).toBeTruthy();
    expect(
      checkinStatusQuerySchema.parse({
        publicCode: "LT-ABCDEFGH",
        driverPhone: form.driverPhone
      })
    ).toBeTruthy();
    expect(() =>
      checkinStatusQuerySchema.parse({
        publicCode: "LT-ABCDEFGH",
        driverPhone: "1".repeat(65)
      })
    ).toThrow();
  });

  it("bounds the server-scheduled expiration sweep", () => {
    expect(checkinExpirationSchema.parse({})).toEqual({});
    expect(checkinExpirationSchema.parse({ limit: 250 })).toEqual({ limit: 250 });
    expect(() => checkinExpirationSchema.parse({ limit: 251 })).toThrow();
    expect(() => checkinExpirationSchema.parse({ limit: 10, force: true })).toThrow();
  });
});
