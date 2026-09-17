import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getPublicCheckinStatus,
  resolvePublicCheckinVersion,
  type CheckinPublicQueryStore
} from "@/lib/server/checkins/public-query";
import type { StoredCheckin } from "@/types/checkins";

const indexKeyMaterial = "public-query-index-secret-at-least-32-bytes";
const phone = "13999990000";

function phoneIndex(value: string): string {
  return identityIndex("phone", value);
}

function identityIndex(namespace: string, value: string): string {
  return `v1:${createHmac("sha256", indexKeyMaterial)
    .update(`${namespace}:${value}`)
    .digest("hex")}`;
}

function stored(status: StoredCheckin["status"]): StoredCheckin {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    publicCode: "LT-23456789",
    source: "DRIVER",
    status,
    syncState: status === "PRE_CADASTRO" ? null : "CONFIRMADO",
    driverName: "Motorista",
    driverLicense: "02650306461",
    driverPhone: phone,
    plate: "ABC-1D23",
    carrierName: "Transportadora",
    vehicleType: "Bitrem",
    product: "Produto",
    originPlant: "Usina",
    originInvoiceNumbers: "1",
    remittanceInvoiceNumber: "2",
    whatsappNoticeAccepted: true,
    queueLocationAccepted: true,
    driverLicenseIndex: identityIndex("cnh", "02650306461"),
    driverPhoneIndex: phoneIndex(phone),
    plateIndex: identityIndex("plate", "ABC-1D23"),
    geofence: null,
    cancellationReason: status === "CANCELADO" ? "EXPIRADO" : null,
    version: 2,
    createdAtIso: "2026-08-10T12:00:00.000Z",
    updatedAtIso: "2026-08-10T12:01:00.000Z",
    confirmedAtIso: status === "PRE_CADASTRO" ? null : "2026-08-10T12:01:00.000Z"
  };
}

function store(value: StoredCheckin | null): CheckinPublicQueryStore {
  return { findByPublicCode: async () => value };
}

describe("public check-in status query", () => {
  it.each([
    ["PRE_CADASTRO", "processing"],
    ["AGUARDANDO_LIBERACAO", "confirmed"],
    ["AGUARDANDO_CHAMADA", "confirmed"],
    ["CHAMADO", "confirmed"],
    ["EM_DESCARGA", "confirmed"],
    ["CONCLUIDO", "confirmed"],
    ["CANCELADO", "cancelled"]
  ] as const)("maps %s without exposing the internal queue state", async (internal, expected) => {
    await expect(
      getPublicCheckinStatus(
        { publicCode: "lt-23456789", driverPhone: "(13) 99999-0000" },
      { hmacSecret: indexKeyMaterial, store: store(stored(internal)) }
      )
    ).resolves.toEqual({ status: expected });
  });

  it("uses the same not-found response for an unknown code and a phone mismatch", async () => {
    const unknown = getPublicCheckinStatus(
      { publicCode: "LT-23456789", driverPhone: phone },
      { hmacSecret: indexKeyMaterial, store: store(null) }
    );
    const mismatch = getPublicCheckinStatus(
      { publicCode: "LT-23456789", driverPhone: "13988880000" },
      { hmacSecret: indexKeyMaterial, store: store(stored("AGUARDANDO_LIBERACAO")) }
    );

    await expect(unknown).rejects.toMatchObject({ status: 404 });
    await expect(mismatch).rejects.toMatchObject({ status: 404 });
    await expect(unknown).rejects.toThrow("Não foi possível localizar o check-in.");
    await expect(mismatch).rejects.toThrow("Não foi possível localizar o check-in.");
  });

  it("resolves the current optimistic version only after all three identity fields match", async () => {
    await expect(
      resolvePublicCheckinVersion(
        {
          publicCode: "LT-23456789",
          driverLicense: "02650306461",
          driverPhone: "(13) 99999-0000",
          plate: "abc1d23"
        },
        { hmacSecret: indexKeyMaterial, store: store(stored("PRE_CADASTRO")) }
      )
    ).resolves.toBe(2);

    await expect(
      resolvePublicCheckinVersion(
        {
          publicCode: "LT-23456789",
          driverLicense: "02650306461",
          driverPhone: "(13) 99999-0000",
          plate: "ZZZ9Z99"
        },
        { hmacSecret: indexKeyMaterial, store: store(stored("PRE_CADASTRO")) }
      )
    ).rejects.toThrow("Não foi possível localizar o check-in.");
  });

  it("blocks confirmation while an official GPS bypass owns the pre-registration", async () => {
    const pending = {
      ...stored("PRE_CADASTRO"),
      pendingOfficialMutation: {
        token: "test-token",
        kind: "LOCATION_OVERRIDE" as const,
        state: "EM_PROCESSAMENTO" as const,
        payloadHash: "hash",
        baseVersion: 2,
        reservedVersion: 3,
        requestedByUid: "supervisor-1",
        requestedByRole: "SUPERVISOR" as const,
        reason: "Presença confirmada",
        startedAtIso: "2026-08-10T12:02:00.000Z",
        lastAttemptAtIso: "2026-08-10T12:02:00.000Z"
      },
      version: 3
    };

    await expect(
      resolvePublicCheckinVersion(
        {
          publicCode: "LT-23456789",
          driverLicense: "02650306461",
          driverPhone: "(13) 99999-0000",
          plate: "abc1d23"
        },
        { hmacSecret: indexKeyMaterial, store: store(pending) }
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it("blocks a second confirmation while the public Excel command is running", async () => {
    const syncing = {
      ...stored("PRE_CADASTRO"),
      syncState: "EM_PROCESSAMENTO" as const
    };

    await expect(
      resolvePublicCheckinVersion(
        {
          publicCode: "LT-23456789",
          driverLicense: "02650306461",
          driverPhone: "(13) 99999-0000",
          plate: "abc1d23"
        },
        { hmacSecret: indexKeyMaterial, store: store(syncing) }
      )
    ).rejects.toMatchObject({ status: 409 });
  });
});
