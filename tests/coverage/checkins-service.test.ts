import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  confirmCheckin,
  createOrRecoverPreRegistration,
  recoverPreRegistrationCode
} from "@/lib/server/checkins/service";
import { HttpError } from "@/lib/domain/errors";

const HMAC_SECRET = "test-only-checkin-hmac-secret-32-bytes-minimum";
const NOW = "2026-08-10T15:00:00.000Z";
const ALLOWED_AREA = {
  latitude: -23.9608,
  longitude: -46.3336,
  radiusMeters: 20_000
};

const VALID_FORM = {
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

async function createVisit(): Promise<void> {
  await createOrRecoverPreRegistration(
    { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
    {
      hmacSecret: HMAC_SECRET,
      generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
      generatePublicCode: () => "LT-23456789"
    }
  );
}

function validConfirmation(expectedVersion = 1) {
  return {
    publicCode: "LT-23456789",
    driverLicense: VALID_FORM.driverLicense,
    driverPhone: VALID_FORM.driverPhone,
    plate: VALID_FORM.plate,
    location: {
      latitude: -23.9675,
      longitude: -46.3289,
      accuracyMeters: 35,
      capturedAtIso: "2026-08-10T15:05:00.000Z"
    },
    nowIso: "2026-08-10T15:05:00.000Z",
    expectedVersion
  };
}

describe("public check-in lifecycle service", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    inMemoryAdminDb.reset();
  });

  it("creates a pre-registration with an opaque UUID and public LT code", async () => {
    const result = await createOrRecoverPreRegistration(
      {
        rawForm: VALID_FORM,
        source: "CARRIER",
        nowIso: NOW,
        requestId: "8f6df25b-fef0-4d04-93df-7038c95cf44a"
      },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );

    expect(result).toEqual({
      publicCode: "LT-23456789",
      status: "PRE_CADASTRO",
      syncState: null,
      version: 1,
      recovered: false
    });
    expect(JSON.stringify(result)).not.toContain("de305d54");
  });

  it("recovers the same active pre-registration instead of duplicating it", async () => {
    const dependencies = {
      hmacSecret: HMAC_SECRET,
      generateId: vi
        .fn()
        .mockReturnValueOnce("de305d54-75b4-431b-adb2-eb6b9e546014")
        .mockReturnValueOnce("123e4567-e89b-42d3-a456-426614174000"),
      generatePublicCode: vi
        .fn()
        .mockReturnValueOnce("LT-23456789")
        .mockReturnValueOnce("LT-ABCDEFGH")
    };

    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
      dependencies
    );
    const recovered = await createOrRecoverPreRegistration(
      {
        rawForm: VALID_FORM,
        source: "DRIVER",
        nowIso: "2026-08-10T16:00:00.000Z"
      },
      dependencies
    );

    expect(recovered).toEqual({
      publicCode: "LT-23456789",
      status: "PRE_CADASTRO",
      syncState: null,
      version: 1,
      recovered: true
    });
    expect(inMemoryAdminDb.entries("checkins")).toHaveLength(1);
  });

  it("recovers a code only when CNH, phone and plate identify the same visit", async () => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );

    await expect(
      recoverPreRegistrationCode(
        {
          driverLicense: "055.559.304-35",
          driverPhone: "(44) 99919-7442",
          plate: "ayz5e53",
          nowIso: "2026-08-10T16:00:00.000Z"
        },
        { hmacSecret: HMAC_SECRET }
      )
    ).resolves.toEqual({
      publicCode: "LT-23456789",
      status: "PRE_CADASTRO",
      syncState: null,
      version: 1
    });
  });

  it("expires an unused pre-registration after five days and releases both locks", async () => {
    const firstId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => firstId,
        generatePublicCode: () => "LT-23456789"
      }
    );

    await expect(
      recoverPreRegistrationCode(
        {
          driverLicense: VALID_FORM.driverLicense,
          driverPhone: VALID_FORM.driverPhone,
          plate: VALID_FORM.plate,
          nowIso: "2026-08-15T15:00:00.000Z"
        },
        { hmacSecret: HMAC_SECRET }
      )
    ).rejects.toMatchObject({ status: 404 });

    expect(inMemoryAdminDb.read("checkins", firstId)).toMatchObject({
      status: "CANCELADO",
      cancellationReason: "EXPIRADO",
      version: 2
    });
    await expect(
      createOrRecoverPreRegistration(
        {
          rawForm: VALID_FORM,
          source: "DRIVER",
          nowIso: "2026-08-15T15:00:01.000Z"
        },
        {
          hmacSecret: HMAC_SECRET,
          generateId: () => "123e4567-e89b-42d3-a456-426614174000",
          generatePublicCode: () => "LT-ABCDEFGH"
        }
      )
    ).resolves.toMatchObject({
      publicCode: "LT-ABCDEFGH",
      recovered: false
    });
  });

  it("confirms only after the idempotent Excel inclusion succeeds", async () => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );
    const excelAdapter = {
      includeIdempotently: vi.fn().mockResolvedValue({
        confirmedAtIso: "2026-08-10T15:05:01.000Z"
      })
    };

    const result = await confirmCheckin(
      {
        publicCode: "LT-23456789",
        driverLicense: VALID_FORM.driverLicense,
        driverPhone: VALID_FORM.driverPhone,
        plate: VALID_FORM.plate,
        location: {
          latitude: -23.9675,
          longitude: -46.3289,
          accuracyMeters: 35,
          capturedAtIso: "2026-08-10T15:05:00.000Z"
        },
        nowIso: "2026-08-10T15:05:00.000Z",
        expectedVersion: 1,
        requestId: "804eefb1-f466-4665-a21c-197dbbefbb30"
      },
      {
        hmacSecret: HMAC_SECRET,
        allowedArea: ALLOWED_AREA,
        excelAdapter
      }
    );

    expect(result).toEqual({
      publicCode: "LT-23456789",
      status: "AGUARDANDO_LIBERACAO",
      syncState: "CONFIRMADO",
      version: 2
    });
    expect(excelAdapter.includeIdempotently).toHaveBeenCalledOnce();
    expect(JSON.stringify(excelAdapter.includeIdempotently.mock.calls)).not.toMatch(
      /-23\.9675|-46\.3289/
    );
    expect(
      JSON.stringify(
        inMemoryAdminDb.read(
          "checkins",
          "de305d54-75b4-431b-adb2-eb6b9e546014"
        )
      )
    ).not.toMatch(/-23\.9675|-46\.3289/);
  });

  it("keeps PRE_CADASTRO after an Excel failure and retries the same inclusion", async () => {
    const checkinId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "DRIVER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => checkinId,
        generatePublicCode: () => "LT-23456789"
      }
    );
    const excelAdapter = {
      includeIdempotently: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary timeout"))
        .mockResolvedValueOnce({ confirmedAtIso: "2026-08-10T15:07:00.000Z" })
    };
    const confirmation = {
      publicCode: "LT-23456789",
      driverLicense: VALID_FORM.driverLicense,
      driverPhone: VALID_FORM.driverPhone,
      plate: VALID_FORM.plate,
      location: {
        latitude: -23.9675,
        longitude: -46.3289,
        accuracyMeters: 35,
        capturedAtIso: "2026-08-10T15:05:00.000Z"
      },
      nowIso: "2026-08-10T15:05:00.000Z",
      expectedVersion: 1
    };
    const dependencies = {
      hmacSecret: HMAC_SECRET,
      allowedArea: ALLOWED_AREA,
      excelAdapter
    };

    await expect(confirmCheckin(confirmation, dependencies)).rejects.toMatchObject({
      status: 503
    });
    expect(inMemoryAdminDb.read("checkins", checkinId)).toMatchObject({
      status: "PRE_CADASTRO",
      syncState: "FALHA_RETRY",
      version: 1
    });

    await expect(
      confirmCheckin(
        { ...confirmation, nowIso: "2026-08-10T15:06:00.000Z" },
        dependencies
      )
    ).resolves.toMatchObject({
      status: "AGUARDANDO_LIBERACAO",
      syncState: "CONFIRMADO",
      version: 2
    });
    expect(excelAdapter.includeIdempotently).toHaveBeenCalledTimes(2);
    expect(
      excelAdapter.includeIdempotently.mock.calls.map(([record]) => record.publicCode)
    ).toEqual(["LT-23456789", "LT-23456789"]);
  });

  it("marks an upstream HttpError 503 as retryable before returning it", async () => {
    const checkinId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    await createVisit();

    await expect(
      confirmCheckin(validConfirmation(), {
        hmacSecret: HMAC_SECRET,
        allowedArea: ALLOWED_AREA,
        excelAdapter: {
          includeIdempotently: vi.fn().mockRejectedValue(
            new HttpError(503, "O registro oficial está temporariamente indisponível.")
          )
        }
      })
    ).rejects.toMatchObject({ status: 503 });

    expect(inMemoryAdminDb.read("checkins", checkinId)).toMatchObject({
      status: "PRE_CADASTRO",
      syncState: "FALHA_RETRY",
      version: 1
    });
    expect(inMemoryAdminDb.entries(`checkins/${checkinId}/revisions`)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.any(String),
          expect.objectContaining({ action: "CHECKIN_SYNC_FAILED" })
        ])
      ])
    );
  });

  it("regenerates a colliding public code without leaking or duplicating visits", async () => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );
    const generatePublicCode = vi
      .fn()
      .mockReturnValueOnce("LT-23456789")
      .mockReturnValueOnce("LT-ABCDEFGH");

    await expect(
      createOrRecoverPreRegistration(
        {
          rawForm: {
            ...VALID_FORM,
            driverLicense: "10000000091",
            driverPhone: "11987654321",
            plate: "ABC1234"
          },
          source: "DRIVER",
          nowIso: "2026-08-10T15:10:00.000Z"
        },
        {
          hmacSecret: HMAC_SECRET,
          generateId: () => "123e4567-e89b-42d3-a456-426614174000",
          generatePublicCode
        }
      )
    ).resolves.toMatchObject({ publicCode: "LT-ABCDEFGH" });
    expect(generatePublicCode).toHaveBeenCalledTimes(2);
    expect(inMemoryAdminDb.entries("checkins")).toHaveLength(2);
  });

  it("treats an invalid Excel acknowledgement as retryable without confirming", async () => {
    const checkinId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "DRIVER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => checkinId,
        generatePublicCode: () => "LT-23456789"
      }
    );

    await expect(
      confirmCheckin(
        {
          publicCode: "LT-23456789",
          driverLicense: VALID_FORM.driverLicense,
          driverPhone: VALID_FORM.driverPhone,
          plate: VALID_FORM.plate,
          location: {
            latitude: -23.9675,
            longitude: -46.3289,
            accuracyMeters: 35,
            capturedAtIso: "2026-08-10T15:05:00.000Z"
          },
          nowIso: "2026-08-10T15:05:00.000Z",
          expectedVersion: 1
        },
        {
          hmacSecret: HMAC_SECRET,
          allowedArea: ALLOWED_AREA,
          excelAdapter: {
            includeIdempotently: vi.fn().mockResolvedValue({
              confirmedAtIso: "invalid"
            })
          }
        }
      )
    ).rejects.toMatchObject({ status: 503 });
    expect(inMemoryAdminDb.read("checkins", checkinId)).toMatchObject({
      status: "PRE_CADASTRO",
      syncState: "FALHA_RETRY",
      version: 1
    });
  });

  it("rejects an unknown pre-registration source at the service boundary", async () => {
    await expect(
      createOrRecoverPreRegistration(
        {
          rawForm: VALID_FORM,
          source: "SYSTEM" as never,
          nowIso: NOW
        },
        {
          hmacSecret: HMAC_SECRET,
          generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
          generatePublicCode: () => "LT-23456789"
        }
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(inMemoryAdminDb.entries("checkins")).toHaveLength(0);
  });

  it("refuses a non-UUID internal identifier before writing persistence", async () => {
    await expect(
      createOrRecoverPreRegistration(
        { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
        {
          hmacSecret: HMAC_SECRET,
          generateId: () => "visible-sequential-id",
          generatePublicCode: () => "LT-23456789"
        }
      )
    ).rejects.toMatchObject({ status: 500 });
    expect(inMemoryAdminDb.entries("checkins")).toHaveLength(0);
  });

  it.each([
    [
      "CNH",
      {
        ...VALID_FORM,
        driverPhone: "11987654321",
        plate: "ABC1234"
      }
    ],
    [
      "placa",
      {
        ...VALID_FORM,
        driverLicense: "10000000091",
        driverPhone: "11987654321"
      }
    ]
  ])("blocks a second active visit sharing the same %s", async (_label, rawForm) => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );

    await expect(
      createOrRecoverPreRegistration(
        {
          rawForm,
          source: "DRIVER",
          nowIso: "2026-08-10T15:10:00.000Z"
        },
        {
          hmacSecret: HMAC_SECRET,
          generateId: () => "123e4567-e89b-42d3-a456-426614174000",
          generatePublicCode: () => "LT-ABCDEFGH"
        }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(inMemoryAdminDb.entries("checkins")).toHaveLength(1);
  });

  it("does not recover a code when one of the three identity fields differs", async () => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );

    await expect(
      recoverPreRegistrationCode(
        {
          driverLicense: VALID_FORM.driverLicense,
          driverPhone: "11987654321",
          plate: VALID_FORM.plate,
          nowIso: "2026-08-10T15:10:00.000Z"
        },
        { hmacSecret: HMAC_SECRET }
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a GPS capture older than two minutes before calling Excel", async () => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "DRIVER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );
    const excelAdapter = { includeIdempotently: vi.fn() };

    await expect(
      confirmCheckin(
        {
          publicCode: "LT-23456789",
          driverLicense: VALID_FORM.driverLicense,
          driverPhone: VALID_FORM.driverPhone,
          plate: VALID_FORM.plate,
          location: {
            latitude: -23.9675,
            longitude: -46.3289,
            accuracyMeters: 35,
            capturedAtIso: "2026-08-10T15:02:59.999Z"
          },
          nowIso: "2026-08-10T15:05:00.000Z",
          expectedVersion: 1
        },
        {
          hmacSecret: HMAC_SECRET,
          allowedArea: ALLOWED_AREA,
          excelAdapter
        }
      )
    ).rejects.toMatchObject({ status: 422 });
    expect(excelAdapter.includeIdempotently).not.toHaveBeenCalled();
  });

  it("uses server configuration and cryptographic defaults without exposing the UUID", async () => {
    vi.stubEnv("CHECKIN_INDEX_HMAC_SECRET", HMAC_SECRET);

    const result = await createOrRecoverPreRegistration({
      rawForm: VALID_FORM,
      source: "CARRIER",
      nowIso: NOW
    });

    expect(result.publicCode).toMatch(
      /^LT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/
    );
    const [stored] = inMemoryAdminDb.entries("checkins");
    expect(stored?.[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(JSON.stringify(result)).not.toContain(stored?.[0]);
  });

  it.each([
    ["an invalid operation time", { nowIso: "invalid" }, HMAC_SECRET],
    ["a short HMAC secret", {}, "too-short"]
  ])("rejects %s before persistence", async (_label, inputPatch, hmacSecret) => {
    await expect(
      createOrRecoverPreRegistration(
        {
          rawForm: VALID_FORM,
          source: "CARRIER",
          nowIso: NOW,
          ...inputPatch
        },
        {
          hmacSecret,
          generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
          generatePublicCode: () => "LT-23456789"
        }
      )
    ).rejects.toBeDefined();
    expect(inMemoryAdminDb.entries("checkins")).toHaveLength(0);
  });

  it("stops after five public-code collisions without partial writes", async () => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "CARRIER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );
    const generatePublicCode = vi.fn(() => "LT-23456789");

    await expect(
      createOrRecoverPreRegistration(
        {
          rawForm: {
            ...VALID_FORM,
            driverLicense: "10000000091",
            driverPhone: "11987654321",
            plate: "ABC1234"
          },
          source: "DRIVER",
          nowIso: "2026-08-10T15:10:00.000Z"
        },
        {
          hmacSecret: HMAC_SECRET,
          generateId: () => "123e4567-e89b-42d3-a456-426614174000",
          generatePublicCode
        }
      )
    ).rejects.toMatchObject({ status: 500 });
    expect(generatePublicCode).toHaveBeenCalledTimes(5);
    expect(inMemoryAdminDb.entries("checkins")).toHaveLength(1);
  });

  it.each([
    ["CNH", { driverLicense: "12345678901" }],
    ["telefone", { driverPhone: "123" }],
    ["placa", { plate: "" }]
  ])("rejects malformed %s during recovery", async (_label, patch) => {
    await expect(
      recoverPreRegistrationCode(
        {
          driverLicense: VALID_FORM.driverLicense,
          driverPhone: VALID_FORM.driverPhone,
          plate: VALID_FORM.plate,
          nowIso: NOW,
          ...patch
        },
        { hmacSecret: HMAC_SECRET }
      )
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a GPS capture more than thirty seconds in the future", async () => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "DRIVER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );
    const excelAdapter = { includeIdempotently: vi.fn() };

    await expect(
      confirmCheckin(
        {
          publicCode: "LT-23456789",
          driverLicense: VALID_FORM.driverLicense,
          driverPhone: VALID_FORM.driverPhone,
          plate: VALID_FORM.plate,
          location: {
            latitude: -23.9675,
            longitude: -46.3289,
            accuracyMeters: 35,
            capturedAtIso: "2026-08-10T15:05:30.001Z"
          },
          nowIso: "2026-08-10T15:05:00.000Z",
          expectedVersion: 1
        },
        { hmacSecret: HMAC_SECRET, allowedArea: ALLOWED_AREA, excelAdapter }
      )
    ).rejects.toMatchObject({ status: 422 });
    expect(excelAdapter.includeIdempotently).not.toHaveBeenCalled();
  });

  it.each([
    [
      "outside the allowed radius",
      { latitude: -23.5505, longitude: -46.6333, accuracyMeters: 50 }
    ],
    [
      "with insufficient accuracy",
      { latitude: -23.9675, longitude: -46.3289, accuracyMeters: 1_001 }
    ]
  ])("rejects a current GPS capture %s", async (_label, coordinates) => {
    await createOrRecoverPreRegistration(
      { rawForm: VALID_FORM, source: "DRIVER", nowIso: NOW },
      {
        hmacSecret: HMAC_SECRET,
        generateId: () => "de305d54-75b4-431b-adb2-eb6b9e546014",
        generatePublicCode: () => "LT-23456789"
      }
    );
    const excelAdapter = { includeIdempotently: vi.fn() };

    await expect(
      confirmCheckin(
        {
          publicCode: "LT-23456789",
          driverLicense: VALID_FORM.driverLicense,
          driverPhone: VALID_FORM.driverPhone,
          plate: VALID_FORM.plate,
          location: {
            ...coordinates,
            capturedAtIso: "2026-08-10T15:05:00.000Z"
          },
          nowIso: "2026-08-10T15:05:00.000Z",
          expectedVersion: 1
        },
        { hmacSecret: HMAC_SECRET, allowedArea: ALLOWED_AREA, excelAdapter }
      )
    ).rejects.toMatchObject({ status: 422 });
    expect(excelAdapter.includeIdempotently).not.toHaveBeenCalled();
  });

});
