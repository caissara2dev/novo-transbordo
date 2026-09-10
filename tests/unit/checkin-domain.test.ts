import { describe, expect, it } from "vitest";
import {
  buildCheckinStoragePayload,
  canTransitionCheckinStatus,
  evaluateCheckinGeofence,
  isPreRegistrationExpired,
  validateDriverCheckinInput
} from "@/lib/domain/checkins";
import type {
  CheckinActorRole,
  CheckinStatus,
  CheckinTransitionTrigger
} from "@/lib/domain/checkins";

const LINE_SANTOS_GATE = {
  latitude: -23.9608,
  longitude: -46.3336,
  radiusMeters: 20_000
};

const VALID_DRIVER_FORM = {
  driverName: "Wallace Mendes",
  driverLicense: "05555930435",
  driverPhone: "44999197442",
  plate: "Ayz5e53",
  carrierName: "Transrio",
  vehicleType: "Vanderleia",
  product: "Glicerina bruta",
  originPlant: "Petrobrás",
  originInvoiceNumbers: "95796",
  remittanceInvoiceNumber: "26947",
  whatsappNoticeAccepted: true,
  queueLocationAccepted: true
};

describe("check-in geofence domain", () => {
  it("allows GPS inside a 20 km radius when accuracy is at most 1 km", () => {
    const result = evaluateCheckinGeofence({
      allowedArea: LINE_SANTOS_GATE,
      driverLocation: {
        latitude: -23.9675,
        longitude: -46.3289,
        accuracyMeters: 35
      },
      validatedAtIso: "2026-08-10T12:00:00.000-03:00"
    });

    expect(result).toEqual({
      allowed: true,
      distanceMeters: expect.any(Number),
      radiusMeters: 20_000,
      accuracyMeters: 35,
      validatedAtIso: "2026-08-10T12:00:00.000-03:00"
    });
    expect(result.distanceMeters).toBeLessThan(20_000);
  });

  it("blocks GPS outside the 20 km radius", () => {
    const result = evaluateCheckinGeofence({
      allowedArea: LINE_SANTOS_GATE,
      driverLocation: {
        latitude: -23.5505,
        longitude: -46.6333,
        accuracyMeters: 50
      },
      validatedAtIso: "2026-08-10T12:00:00.000-03:00"
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "OUTSIDE_ALLOWED_RADIUS",
      radiusMeters: 20_000,
      accuracyMeters: 50
    });
    expect(result.distanceMeters).toBeGreaterThan(20_000);
  });

  it("blocks coordinates with GPS accuracy worse than 1 km", () => {
    const result = evaluateCheckinGeofence({
      allowedArea: LINE_SANTOS_GATE,
      driverLocation: {
        latitude: -23.9675,
        longitude: -46.3289,
        accuracyMeters: 1_001
      },
      validatedAtIso: "2026-08-10T12:00:00.000-03:00"
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "GPS_ACCURACY_TOO_LOW",
      accuracyMeters: 1_001
    });
  });

  it.each([
    { latitude: -91, longitude: -46.3336, accuracyMeters: 35 },
    { latitude: -23.9608, longitude: -181, accuracyMeters: 35 },
    { latitude: Number.NaN, longitude: -46.3336, accuracyMeters: 35 },
    { latitude: -23.9608, longitude: -46.3336, accuracyMeters: 0 }
  ])("rejects invalid GPS payload %#", (driverLocation) => {
    expect(() =>
      evaluateCheckinGeofence({
        allowedArea: LINE_SANTOS_GATE,
        driverLocation,
        validatedAtIso: "2026-08-10T12:00:00.000-03:00"
      })
    ).toThrow(/GPS|localização|coordenada|precisão/i);
  });

  it("builds the stored payload without persisting exact latitude or longitude", () => {
    const geofence = evaluateCheckinGeofence({
      allowedArea: LINE_SANTOS_GATE,
      driverLocation: {
        latitude: -23.9675,
        longitude: -46.3289,
        accuracyMeters: 35
      },
      validatedAtIso: "2026-08-10T12:00:00.000-03:00"
    });
    const form = validateDriverCheckinInput(VALID_DRIVER_FORM);

    const stored = buildCheckinStoragePayload({
      id: "checkin-20260810-0001",
      form,
      geofence,
      createdAtIso: "2026-08-10T12:01:00.000-03:00"
    });

    expect(stored).toMatchObject({
      id: "checkin-20260810-0001",
      status: "PRE_CADASTRO",
      geofence: {
        allowed: true,
        distanceMeters: expect.any(Number),
        radiusMeters: 20_000,
        accuracyMeters: 35,
        validatedAtIso: "2026-08-10T12:00:00.000-03:00"
      }
    });
    expect(JSON.stringify(stored)).not.toContain("-23.9675");
    expect(JSON.stringify(stored)).not.toContain("-46.3289");
    expect(stored).not.toHaveProperty("latitude");
    expect(stored).not.toHaveProperty("longitude");
  });
});

describe("driver check-in form domain", () => {
  it("accepts and normalizes the form fields used by the scheduling spreadsheet", () => {
    const validated = validateDriverCheckinInput(VALID_DRIVER_FORM);

    expect(validated).toEqual({
      driverName: "Wallace Mendes",
      driverLicense: "05555930435",
      driverPhone: "44999197442",
      plate: "AYZ-5E53",
      carrierName: "Transrio",
      vehicleType: "Vanderleia",
      product: "Glicerina bruta",
      originPlant: "Petrobrás",
      originInvoiceNumbers: "95796",
      remittanceInvoiceNumber: "26947",
      whatsappNoticeAccepted: true,
      queueLocationAccepted: true
    });
  });

  it.each(["0555593043", "0555593043A", "12345678901"])(
    "rejects CNH without 11 valid verifier digits: %s",
    (driverLicense) => {
      expect(() =>
        validateDriverCheckinInput({
          ...VALID_DRIVER_FORM,
          driverLicense
        })
      ).toThrow(/CNH|dígito/i);
    }
  );

  it.each(["1198765432", "abcdefghijk", "00000000000"])(
    "rejects structurally invalid phone: %s",
    (driverPhone) => {
      expect(() =>
        validateDriverCheckinInput({
          ...VALID_DRIVER_FORM,
          driverPhone
        })
      ).toThrow(/telefone/i);
    }
  );

  it.each([
    ["old Brazilian plate", "BDS6G06", "BDS-6G06"],
    ["legacy Brazilian plate", "EGK 0637", "EGK-0637"],
    ["Mercosul plate", "AYZ5E53", "AYZ-5E53"]
  ])("accepts %s", (_label, plate, expected) => {
    expect(
      validateDriverCheckinInput({
        ...VALID_DRIVER_FORM,
        plate
      }).plate
    ).toBe(expected);
  });

  it("rejects missing mandatory queue and WhatsApp acknowledgements", () => {
    expect(() =>
      validateDriverCheckinInput({
        ...VALID_DRIVER_FORM,
        whatsappNoticeAccepted: false
      })
    ).toThrow(/WhatsApp|ciente/i);

    expect(() =>
      validateDriverCheckinInput({
        ...VALID_DRIVER_FORM,
        queueLocationAccepted: false
      })
    ).toThrow(/localização|fila|ciente/i);
  });

  it("rejects fields that exceed the public contract limits", () => {
    expect(() =>
      validateDriverCheckinInput({
        ...VALID_DRIVER_FORM,
        driverName: "A".repeat(121)
      })
    ).toThrow(/nome|120|limite/i);

    expect(() =>
      validateDriverCheckinInput({
        ...VALID_DRIVER_FORM,
        originInvoiceNumbers: "9".repeat(251)
      })
    ).toThrow(/nota fiscal|250|limite/i);
  });
});

describe("check-in lifecycle domain", () => {
  it("expires PRE_CADASTRO after 5 days", () => {
    expect(
      isPreRegistrationExpired({
        status: "PRE_CADASTRO",
        createdAtIso: "2026-08-10T08:00:00.000-03:00",
        nowIso: "2026-08-15T07:59:59.999-03:00"
      })
    ).toBe(false);

    expect(
      isPreRegistrationExpired({
        status: "PRE_CADASTRO",
        createdAtIso: "2026-08-10T08:00:00.000-03:00",
        nowIso: "2026-08-15T08:00:00.000-03:00"
      })
    ).toBe(true);

    expect(
      isPreRegistrationExpired({
        status: "AGUARDANDO_LIBERACAO",
        createdAtIso: "2026-08-10T08:00:00.000-03:00",
        nowIso: "2026-08-20T08:00:00.000-03:00"
      })
    ).toBe(false);
  });

  it.each([
    ["SYSTEM", "PRE_CADASTRO", "AGUARDANDO_LIBERACAO", "CHECKIN_CONFIRMED", true],
    ["OPERATOR", "PRE_CADASTRO", "AGUARDANDO_LIBERACAO", "MANUAL", false],
    ["SUPERVISOR", "AGUARDANDO_LIBERACAO", "AGUARDANDO_CHAMADA", "MANUAL", true],
    ["ADMIN", "AGUARDANDO_LIBERACAO", "AGUARDANDO_CHAMADA", "MANUAL", true],
    ["OPERATOR", "AGUARDANDO_LIBERACAO", "AGUARDANDO_CHAMADA", "MANUAL", false],
    ["SUPERVISOR", "AGUARDANDO_CHAMADA", "CHAMADO", "MANUAL", true],
    ["OPERATOR", "CHAMADO", "EM_DESCARGA", "MANUAL", false],
    ["OPERATOR", "CHAMADO", "EM_DESCARGA", "PRODUCTIVE_EVENT", true],
    ["SUPERVISOR", "CHAMADO", "EM_DESCARGA", "PRODUCTIVE_EVENT", true],
    ["ADMIN", "CHAMADO", "EM_DESCARGA", "PRODUCTIVE_EVENT", true],
    ["SUPERVISOR", "EM_DESCARGA", "CONCLUIDO", "MANUAL", true],
    ["ADMIN", "EM_DESCARGA", "CONCLUIDO", "MANUAL", true],
    ["OPERATOR", "EM_DESCARGA", "CONCLUIDO", "MANUAL", false],
    ["SYSTEM", "PRE_CADASTRO", "CANCELADO", "EXPIRATION", true],
    ["SUPERVISOR", "CHAMADO", "CANCELADO", "MANUAL", true],
    ["ADMIN", "CHAMADO", "CANCELADO", "MANUAL", true],
    ["DISPLAY", "CHAMADO", "CANCELADO", "MANUAL", false]
  ] satisfies Array<[
    CheckinActorRole,
    CheckinStatus,
    CheckinStatus,
    CheckinTransitionTrigger,
    boolean
  ]>)(
    "%s transition %s -> %s through %s allowed=%s",
    (role, from, to, trigger, expectedAllowed) => {
      expect(
        canTransitionCheckinStatus({
          role,
          from,
          to,
          trigger
        })
      ).toBe(expectedAllowed);
    }
  );
});
