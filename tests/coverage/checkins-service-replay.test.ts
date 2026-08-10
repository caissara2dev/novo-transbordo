import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  confirmCheckin,
  createOrRecoverPreRegistration
} from "@/lib/server/checkins/service";

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

describe("public check-in confirmation concurrency", () => {
  beforeEach(() => {
    inMemoryAdminDb.reset();
  });

  it("rejects a stale optimistic version before the Excel side effect", async () => {
    await createVisit();
    const excelAdapter = { includeIdempotently: vi.fn() };

    await expect(
      confirmCheckin(validConfirmation(0), {
        hmacSecret: HMAC_SECRET,
        allowedArea: ALLOWED_AREA,
        excelAdapter
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(excelAdapter.includeIdempotently).not.toHaveBeenCalled();
    expect(
      inMemoryAdminDb.read(
        "checkins",
        "de305d54-75b4-431b-adb2-eb6b9e546014"
      )
    ).toMatchObject({ status: "PRE_CADASTRO", version: 1 });
  });

  it("returns an already confirmed visit without repeating the Excel inclusion", async () => {
    await createVisit();
    const excelAdapter = {
      includeIdempotently: vi.fn().mockResolvedValue({
        confirmedAtIso: "2026-08-10T15:06:00.000Z"
      })
    };
    const dependencies = {
      hmacSecret: HMAC_SECRET,
      allowedArea: ALLOWED_AREA,
      excelAdapter
    };

    const first = await confirmCheckin(validConfirmation(), dependencies);
    const replay = await confirmCheckin(validConfirmation(), dependencies);

    expect(replay).toEqual(first);
    expect(excelAdapter.includeIdempotently).toHaveBeenCalledOnce();
    expect(
      inMemoryAdminDb
        .entries(
          "checkins/de305d54-75b4-431b-adb2-eb6b9e546014/revisions"
        )
        .map(([, revision]) => revision.action)
    ).toEqual([
      "PRE_REGISTRATION_CREATED",
      "CHECKIN_SYNC_STARTED",
      "CHECKIN_CONFIRMED"
    ]);
  });

  it("does not confirm when the three identity fields do not match the code", async () => {
    await createVisit();
    const excelAdapter = { includeIdempotently: vi.fn() };

    await expect(
      confirmCheckin(
        { ...validConfirmation(), driverPhone: "11987654321" },
        { hmacSecret: HMAC_SECRET, allowedArea: ALLOWED_AREA, excelAdapter }
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(excelAdapter.includeIdempotently).not.toHaveBeenCalled();
  });

  it("does not call Excel while an official GPS bypass is pending", async () => {
    await createVisit();
    const checkinId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    const current = inMemoryAdminDb.read("checkins", checkinId);
    inMemoryAdminDb.seed("checkins", checkinId, {
      ...current,
      version: 2,
      pendingOfficialMutation: {
        token: "test-token",
        kind: "LOCATION_OVERRIDE",
        state: "EM_PROCESSAMENTO",
        payloadHash: "hash",
        baseVersion: 1,
        reservedVersion: 2,
        requestedByUid: "supervisor-1",
        requestedByRole: "SUPERVISOR",
        reason: "Presença confirmada",
        startedAtIso: "2026-08-10T15:04:00.000Z",
        lastAttemptAtIso: "2026-08-10T15:04:00.000Z"
      }
    });
    const excelAdapter = { includeIdempotently: vi.fn() };

    await expect(
      confirmCheckin(validConfirmation(2), {
        hmacSecret: HMAC_SECRET,
        allowedArea: ALLOWED_AREA,
        excelAdapter
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(excelAdapter.includeIdempotently).not.toHaveBeenCalled();
  });

  it("serializes two public confirmations before the Excel side effect", async () => {
    await createVisit();
    let releaseExcel!: (value: { confirmedAtIso: string }) => void;
    const excelAdapter = {
      includeIdempotently: vi.fn().mockImplementation(
        () => new Promise<{ confirmedAtIso: string }>((resolve) => {
          releaseExcel = resolve;
        })
      )
    };
    const dependencies = {
      hmacSecret: HMAC_SECRET,
      allowedArea: ALLOWED_AREA,
      excelAdapter
    };

    const first = confirmCheckin(validConfirmation(), dependencies);
    await vi.waitFor(() => expect(excelAdapter.includeIdempotently).toHaveBeenCalledOnce());
    await expect(
      confirmCheckin(validConfirmation(), dependencies)
    ).rejects.toMatchObject({ status: 409 });

    releaseExcel({ confirmedAtIso: "2026-08-10T15:06:00.000Z" });
    await expect(first).resolves.toMatchObject({ status: "AGUARDANDO_LIBERACAO" });
    expect(excelAdapter.includeIdempotently).toHaveBeenCalledOnce();
  });
});
