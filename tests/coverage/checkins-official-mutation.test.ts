import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  commitOfficialCorrection,
  commitOfficialLocationOverride,
  markOfficialMutationFailure,
  reserveOfficialCorrection,
  reserveOfficialLocationOverride
} from "@/lib/server/checkins/official-mutation";
import { assignInternalCheckinClient } from "@/lib/server/checkins/internal-service";

const NOW = "2026-08-10T18:00:00.000Z";
const MANAGER = { uid: "supervisor-1", role: "SUPERVISOR" as const };

function seedCheckin(overrides: Record<string, unknown> = {}) {
  const stored = {
    id: "checkin-1",
    publicCode: "LT-23456789",
    source: "CARRIER",
    status: "AGUARDANDO_LIBERACAO",
    syncState: "CONFIRMADO",
    driverName: "Wallace Mendes",
    driverLicense: "05555930435",
    driverPhone: "44999197442",
    plate: "AYZ5E53",
    carrierName: "Transrio",
    vehicleType: "Vanderleia",
    product: "Glicerina bruta",
    originPlant: "Petrobrás",
    originInvoiceNumbers: "95796",
    remittanceInvoiceNumber: "26947",
    whatsappNoticeAccepted: true,
    queueLocationAccepted: true,
    driverLicenseIndex: "v1:cnh-index",
    driverPhoneIndex: "v1:phone-index",
    plateIndex: "v1:plate-index",
    geofence: null,
    clientId: null,
    clientNameSnapshot: null,
    cancellationReason: null,
    version: 3,
    createdAtIso: "2026-08-10T15:00:00.000Z",
    updatedAtIso: "2026-08-10T17:50:00.000Z",
    confirmedAtIso: "2026-08-10T17:50:01.000Z",
    ...overrides
  };
  inMemoryAdminDb.seed("checkins", "checkin-1", stored);
  return stored;
}

describe("durable official-record mutations", () => {
  beforeEach(() => {
    inMemoryAdminDb.reset();
    vi.stubEnv(
      "CHECKIN_INDEX_HMAC_SECRET",
      "0123456789abcdef0123456789abcdef"
    );
  });

  it("reserves one correction before Excel and rejects a competing patch", async () => {
    seedCheckin();

    const reservation = await reserveOfficialCorrection({
      actor: MANAGER,
      checkinId: "checkin-1",
      patch: { carrierName: "Transportadora Corrigida" },
      expectedVersion: 3,
      reason: "Nome confirmado pela transportadora",
      nowIso: NOW
    });

    expect(reservation).toMatchObject({
      publicCode: "LT-23456789",
      reservedVersion: 4,
      patch: { carrierName: "Transportadora Corrigida" },
      idempotencyKey: "LT-23456789:v4"
    });
    expect(inMemoryAdminDb.read("checkins", "checkin-1")).toMatchObject({
      version: 4,
      syncState: "EM_PROCESSAMENTO",
      pendingOfficialMutation: {
        kind: "CORRECTION",
        state: "EM_PROCESSAMENTO"
      }
    });

    await expect(
      reserveOfficialCorrection({
        actor: MANAGER,
        checkinId: "checkin-1",
        patch: { carrierName: "Outro nome" },
        expectedVersion: 4,
        reason: "Outro ajuste",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("commits only the reserved correction and clears the durable command", async () => {
    seedCheckin();
    const reservation = await reserveOfficialCorrection({
      actor: MANAGER,
      checkinId: "checkin-1",
      patch: { carrierName: "Transportadora Corrigida" },
      expectedVersion: 3,
      reason: "Nome confirmado pela transportadora",
      nowIso: NOW
    });

    await commitOfficialCorrection({
      checkinId: "checkin-1",
      token: reservation.token,
      confirmedAtIso: "2026-08-10T18:00:01.000Z"
    });

    expect(inMemoryAdminDb.read("checkins", "checkin-1")).toMatchObject({
      carrierName: "Transportadora Corrigida",
      version: 5,
      syncState: "CONFIRMADO",
      pendingOfficialMutation: null
    });
    expect(
      inMemoryAdminDb.entries("checkins/checkin-1/revisions").map(([, row]) => row.action)
    ).toEqual(["CHECKIN_CORRECTION_SYNC_STARTED", "CHECKIN_CORRECTED"]);
  });

  it("reuses a failed correction reservation without changing its idempotency key", async () => {
    seedCheckin();
    const first = await reserveOfficialCorrection({
      actor: MANAGER,
      checkinId: "checkin-1",
      patch: { product: "Glicerina refinada" },
      expectedVersion: 3,
      reason: "Produto confirmado na nota",
      nowIso: NOW
    });
    await markOfficialMutationFailure({
      checkinId: "checkin-1",
      token: first.token,
      failedAtIso: "2026-08-10T18:00:02.000Z"
    });

    const retry = await reserveOfficialCorrection({
      actor: MANAGER,
      checkinId: "checkin-1",
      patch: { product: "Glicerina refinada" },
      expectedVersion: 4,
      reason: "Produto confirmado na nota",
      nowIso: "2026-08-10T18:01:00.000Z"
    });

    expect(retry.token).toBe(first.token);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(inMemoryAdminDb.read("checkins", "checkin-1")).toMatchObject({
      version: 4,
      syncState: "EM_PROCESSAMENTO"
    });
  });

  it("blocks unrelated manager mutations while the official command is pending", async () => {
    seedCheckin();
    inMemoryAdminDb.seed("clients", "client-1", {
      name: "Cliente Alfa",
      active: true
    });
    await reserveOfficialCorrection({
      actor: MANAGER,
      checkinId: "checkin-1",
      patch: { product: "Glicerina refinada" },
      expectedVersion: 3,
      reason: "Produto confirmado na nota",
      nowIso: NOW
    });

    await expect(
      assignInternalCheckinClient({
        actor: MANAGER,
        checkinId: "checkin-1",
        clientId: "client-1",
        expectedVersion: 4,
        reason: "Cliente identificado",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("does not recreate uniqueness locks when correcting a closed visit", async () => {
    seedCheckin({ status: "CONCLUIDO" });

    await reserveOfficialCorrection({
      actor: MANAGER,
      checkinId: "checkin-1",
      patch: { plate: "BRA2E19" },
      expectedVersion: 3,
      reason: "Correção histórica confirmada",
      nowIso: NOW
    });

    expect(inMemoryAdminDb.entries("_checkinUniqueLocks")).toEqual([]);
  });

  it("reserves and commits the GPS bypass before exposing a confirmed check-in", async () => {
    seedCheckin({ status: "PRE_CADASTRO", syncState: null });

    const reservation = await reserveOfficialLocationOverride({
      actor: MANAGER,
      checkinId: "checkin-1",
      expectedVersion: 3,
      justification: "Presença confirmada pela supervisão",
      nowIso: NOW
    });
    await commitOfficialLocationOverride({
      checkinId: "checkin-1",
      token: reservation.token,
      confirmedAtIso: "2026-08-10T18:00:03.000Z"
    });

    expect(inMemoryAdminDb.read("checkins", "checkin-1")).toMatchObject({
      status: "AGUARDANDO_LIBERACAO",
      syncState: "CONFIRMADO",
      version: 5,
      pendingOfficialMutation: null,
      locationOverride: {
        applied: true,
        justification: "Presença confirmada pela supervisão"
      }
    });
  });

  it("rejects a new GPS bypass after the five-day pre-registration TTL", async () => {
    seedCheckin({
      status: "PRE_CADASTRO",
      syncState: null,
      createdAtIso: "2026-08-05T17:59:59.999Z"
    });

    await expect(
      reserveOfficialLocationOverride({
        actor: MANAGER,
        checkinId: "checkin-1",
        expectedVersion: 3,
        justification: "Presença confirmada pela supervisão",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 410 });

    expect(inMemoryAdminDb.read("checkins", "checkin-1")).toMatchObject({
      status: "PRE_CADASTRO",
      version: 3
    });
    expect(
      inMemoryAdminDb.read("checkins", "checkin-1")?.pendingOfficialMutation
    ).toBeUndefined();
  });

  it("does not reserve a GPS bypass while public Excel confirmation is active", async () => {
    seedCheckin({ status: "PRE_CADASTRO", syncState: "EM_PROCESSAMENTO" });

    await expect(
      reserveOfficialLocationOverride({
        actor: MANAGER,
        checkinId: "checkin-1",
        expectedVersion: 3,
        justification: "Presença confirmada pela supervisão",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(
      inMemoryAdminDb.read("checkins", "checkin-1")?.pendingOfficialMutation
    ).toBeUndefined();
  });
});
