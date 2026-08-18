import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({ adminDb: inMemoryAdminDb }));

import { expireUnusedPreRegistrations } from "@/lib/server/checkins/expiration";

function seedPreRegistration(id: string, createdAtIso: string, status = "PRE_CADASTRO") {
  inMemoryAdminDb.seed("checkins", id, {
    id,
    publicCode: "LT-23456789",
    status,
    syncState: null,
    driverLicenseIndex: "v1:cnh-index",
    plateIndex: "v1:plate-index",
    version: 1,
    createdAtIso,
    updatedAtIso: createdAtIso
  });
  inMemoryAdminDb.seed("_checkinUniqueLocks", "cnh_v1_cnh-index", {
    checkinId: id
  });
  inMemoryAdminDb.seed("_checkinUniqueLocks", "plate_v1_plate-index", {
    checkinId: id
  });
}

describe("check-in expiration sweep", () => {
  beforeEach(() => inMemoryAdminDb.reset());

  it("cancels unused pre-registrations at five days and releases identity locks", async () => {
    seedPreRegistration("checkin-expired", "2026-08-05T12:00:00.000Z");

    await expect(
      expireUnusedPreRegistrations({ nowIso: "2026-08-10T12:00:00.000Z" })
    ).resolves.toEqual({ examined: 1, expired: 1, hasMore: false });

    expect(inMemoryAdminDb.read("checkins", "checkin-expired")).toMatchObject({
      status: "CANCELADO",
      cancellationReason: "EXPIRADO",
      version: 2
    });
    expect(
      inMemoryAdminDb.read("_checkinUniqueLocks", "cnh_v1_cnh-index")
    ).toBeUndefined();
    expect(
      inMemoryAdminDb.entries("checkins/checkin-expired/revisions")[0]?.[1]
    ).toMatchObject({
      action: "PRE_REGISTRATION_EXPIRED",
      source: "SYSTEM",
      reason: "EXPIRADO"
    });
  });

  it("does not cancel recent or already-confirmed visits", async () => {
    seedPreRegistration("checkin-recent", "2026-08-09T12:00:00.000Z");
    seedPreRegistration(
      "checkin-confirmed",
      "2026-08-01T12:00:00.000Z",
      "AGUARDANDO_LIBERACAO"
    );

    await expect(
      expireUnusedPreRegistrations({ nowIso: "2026-08-10T12:00:00.000Z" })
    ).resolves.toEqual({ examined: 0, expired: 0, hasMore: false });
    expect(inMemoryAdminDb.read("checkins", "checkin-recent")).toMatchObject({
      status: "PRE_CADASTRO"
    });
    expect(inMemoryAdminDb.read("checkins", "checkin-confirmed")).toMatchObject({
      status: "AGUARDANDO_LIBERACAO"
    });
  });

  it("uses a bounded page and reports remaining work", async () => {
    seedPreRegistration("checkin-1", "2026-08-01T12:00:00.000Z");
    seedPreRegistration("checkin-2", "2026-08-02T12:00:00.000Z");

    await expect(
      expireUnusedPreRegistrations({
        nowIso: "2026-08-10T12:00:00.000Z",
        limit: 1
      })
    ).resolves.toEqual({ examined: 1, expired: 1, hasMore: true });
  });

  it("does not cancel a pre-registration while an official GPS bypass is reserved", async () => {
    seedPreRegistration("checkin-pending", "2026-08-01T12:00:00.000Z");
    inMemoryAdminDb.seed("checkins", "checkin-pending", {
      ...inMemoryAdminDb.read("checkins", "checkin-pending"),
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
        startedAtIso: "2026-08-05T11:59:59.000Z",
        lastAttemptAtIso: "2026-08-05T11:59:59.000Z"
      },
      version: 2
    });

    await expect(
      expireUnusedPreRegistrations({ nowIso: "2026-08-10T12:00:00.000Z" })
    ).resolves.toEqual({ examined: 1, expired: 0, hasMore: false });
    expect(inMemoryAdminDb.read("checkins", "checkin-pending")).toMatchObject({
      status: "PRE_CADASTRO",
      version: 2,
      pendingOfficialMutation: { token: "test-token" }
    });
  });

  it.each(["EM_PROCESSAMENTO", "FALHA_RETRY"] as const)(
    "does not expire a public Excel command in %s",
    async (syncState) => {
      seedPreRegistration("checkin-public-sync", "2026-08-01T12:00:00.000Z");
      inMemoryAdminDb.seed("checkins", "checkin-public-sync", {
        ...inMemoryAdminDb.read("checkins", "checkin-public-sync"),
        syncState
      });

      await expect(
        expireUnusedPreRegistrations({ nowIso: "2026-08-10T12:00:00.000Z" })
      ).resolves.toEqual({ examined: 1, expired: 0, hasMore: false });
      expect(inMemoryAdminDb.read("checkins", "checkin-public-sync")).toMatchObject({
        status: "PRE_CADASTRO",
        syncState
      });
    }
  );
});
