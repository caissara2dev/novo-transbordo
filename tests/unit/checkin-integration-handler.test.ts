import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/domain/errors";
import { createCheckinIntegrationSignature } from "@/lib/server/checkins/integration-auth";
import {
  handleCheckinConfirmation,
  handleCheckinExpiration,
  handleCheckinPreRegistration,
  handleCheckinRecovery,
  handleCheckinStatus,
  handleCheckinWalkIn,
  type CheckinIntegrationHandlerDependencies
} from "@/lib/server/checkins/integration-handler";
import type { CheckinReplayStore } from "@/lib/server/checkins/replay-protection";

const timestamp = "2026-08-10T12:00:00.000Z";
const integrationSecret = "0123456789abcdef0123456789abcdef";
const indexSecret = "abcdef0123456789abcdef0123456789";
const requestId = "550e8400-e29b-41d4-a716-446655440000";
const environment = {
  CHECKIN_INTEGRATION_MODE: "observe",
  CHECKIN_INTEGRATION_KEY_ID: "public-app-v1",
  CHECKIN_INTEGRATION_HMAC_SECRET: integrationSecret,
  CHECKIN_INDEX_HMAC_SECRET: indexSecret,
  CHECKIN_GEOFENCE_CENTER_LAT: "-23.95",
  CHECKIN_GEOFENCE_CENTER_LNG: "-46.33",
  CHECKIN_GEOFENCE_RADIUS_METERS: "20000"
};

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

const location = {
  latitude: -23.95,
  longitude: -46.33,
  accuracyMeters: 50,
  capturedAtIso: timestamp
};

function createReplayStore(): CheckinReplayStore {
  const documents = new Map<string, Record<string, unknown>>();
  return {
    collection: () => ({ doc: (id) => ({ id }) }),
    runTransaction: async (callback) =>
      callback({
        get: async (reference) => {
          const value = documents.get(reference.id);
          return { exists: Boolean(value), data: () => value && { ...value } };
        },
        set: (reference, data) => void documents.set(reference.id, { ...data })
      })
  };
}

function signedRequest(pathname: string, body: unknown, id = requestId): Request {
  const rawBody = JSON.stringify(body);
  const signature = createCheckinIntegrationSignature({
    method: "POST",
    pathname,
    timestamp,
    requestId: id,
    rawBody,
    secret: integrationSecret
  });
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-checkin-key-id": "public-app-v1",
      "x-checkin-timestamp": timestamp,
      "x-checkin-request-id": id,
      "x-checkin-signature": signature
    },
    body: rawBody
  });
}

function dependencies(
  overrides: Partial<CheckinIntegrationHandlerDependencies> = {}
): CheckinIntegrationHandlerDependencies {
  return {
    environment,
    now: () => new Date(timestamp),
    replayStore: createReplayStore(),
    excelAdapter: { includeIdempotently: vi.fn() },
    ...overrides
  };
}

describe("versioned check-in integration handler", () => {
  it("creates a pre-registration and replays the exact same public envelope", async () => {
    const createPreRegistration = vi.fn().mockResolvedValue({
      publicCode: "LT-23456789",
      status: "PRE_CADASTRO",
      syncState: null,
      version: 1,
      recovered: false
    });
    const deps = dependencies({ createPreRegistration });
    const path = "/api/integrations/checkins/v1/pre-registrations";

    const first = await handleCheckinPreRegistration(
      signedRequest(path, { source: "CARRIER", form }),
      deps
    );
    const replay = await handleCheckinPreRegistration(
      signedRequest(path, { source: "CARRIER", form }),
      deps
    );

    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      ok: true,
      data: {
        publicCode: "LT-23456789",
        recovered: false,
        version: 1,
        publicStatus: "processing"
      }
    });
    expect(await replay.json()).toEqual({
      ok: true,
      data: {
        publicCode: "LT-23456789",
        recovered: false,
        version: 1,
        publicStatus: "processing"
      }
    });
    expect(createPreRegistration).toHaveBeenCalledOnce();
    expect(createPreRegistration).toHaveBeenCalledWith(
      { rawForm: form, source: "CARRIER", nowIso: timestamp, requestId },
      { hmacSecret: indexSecret }
    );
  });

  it("resolves the current version server-side before confirming with Excel", async () => {
    const resolveVersion = vi.fn().mockResolvedValue(7);
    const confirm = vi.fn().mockResolvedValue({
      publicCode: "LT-23456789",
      status: "AGUARDANDO_LIBERACAO",
      syncState: "CONFIRMADO",
      version: 8
    });
    const deps = dependencies({ resolveVersion, confirm });
    const path = "/api/integrations/checkins/v1/confirmations";
    const body = {
      publicCode: "LT-23456789",
      driverLicense: form.driverLicense,
      driverPhone: form.driverPhone,
      plate: form.plate,
      location
    };

    const response = await handleCheckinConfirmation(signedRequest(path, body), deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { publicCode: "LT-23456789", version: 8, publicStatus: "confirmed" }
    });
    expect(resolveVersion).toHaveBeenCalledWith(
      {
        publicCode: body.publicCode,
        driverLicense: body.driverLicense,
        driverPhone: body.driverPhone,
        plate: body.plate
      },
      { hmacSecret: indexSecret }
    );
    expect(confirm).toHaveBeenCalledWith(
      { ...body, expectedVersion: 7, nowIso: timestamp, requestId },
      expect.objectContaining({ hmacSecret: indexSecret })
    );
  });

  it("creates and confirms a driver walk-in in one request", async () => {
    const createPreRegistration = vi.fn().mockResolvedValue({
      publicCode: "LT-23456789",
      status: "PRE_CADASTRO",
      syncState: null,
      version: 3,
      recovered: true
    });
    const confirm = vi.fn().mockResolvedValue({
      publicCode: "LT-23456789",
      status: "AGUARDANDO_LIBERACAO",
      syncState: "CONFIRMADO",
      version: 4
    });
    const deps = dependencies({ createPreRegistration, confirm });
    const path = "/api/integrations/checkins/v1/walk-ins";

    const response = await handleCheckinWalkIn(
      signedRequest(path, { form, location }),
      deps
    );

    expect(await response.json()).toEqual({
      ok: true,
      data: { publicCode: "LT-23456789", version: 4, publicStatus: "confirmed" }
    });
    expect(createPreRegistration).toHaveBeenCalledWith(
      { rawForm: form, source: "DRIVER", nowIso: timestamp, requestId },
      { hmacSecret: indexSecret }
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 3, requestId }),
      expect.any(Object)
    );
  });

  it("recovers a code with three identity fields and exposes no internal state", async () => {
    const recover = vi.fn().mockResolvedValue({
      publicCode: "LT-23456789",
      status: "CHAMADO",
      syncState: "CONFIRMADO",
      version: 5
    });
    const deps = dependencies({ recover });
    const path = "/api/integrations/checkins/v1/recoveries";

    const response = await handleCheckinRecovery(
      signedRequest(path, {
        driverLicense: form.driverLicense,
        driverPhone: form.driverPhone,
        plate: form.plate
      }),
      deps
    );

    expect(await response.json()).toEqual({
      ok: true,
      data: { publicCode: "LT-23456789", version: 5, publicStatus: "confirmed" }
    });
  });

  it("returns only the coarse public status", async () => {
    const getStatus = vi.fn().mockResolvedValue({ status: "cancelled" });
    const deps = dependencies({ getStatus });
    const path = "/api/integrations/checkins/v1/status";

    const response = await handleCheckinStatus(
      signedRequest(path, {
        publicCode: "LT-23456789",
        driverPhone: form.driverPhone
      }),
      deps
    );

    expect(await response.json()).toEqual({
      ok: true,
      data: { publicStatus: "cancelled" }
    });
  });

  it("runs a bounded expiration sweep and replays its counts", async () => {
    const expire = vi.fn().mockResolvedValue({ examined: 20, expired: 7, hasMore: true });
    const deps = dependencies({ expire });
    const path = "/api/integrations/checkins/v1/maintenance/expire";
    const first = await handleCheckinExpiration(signedRequest(path, { limit: 20 }), deps);
    const replay = await handleCheckinExpiration(signedRequest(path, { limit: 20 }), deps);

    expect(await first.json()).toEqual({
      ok: true,
      data: { examined: 20, expired: 7, hasMore: true }
    });
    expect(await replay.json()).toEqual({
      ok: true,
      data: { examined: 20, expired: 7, hasMore: true }
    });
    expect(expire).toHaveBeenCalledOnce();
  });

  it("marks a transient failure retryable instead of replaying a false success", async () => {
    const resolveVersion = vi.fn().mockResolvedValue(1);
    const confirm = vi.fn().mockRejectedValue(
      new HttpError(503, "O registro oficial está temporariamente indisponível.")
    );
    const deps = dependencies({ resolveVersion, confirm });
    const path = "/api/integrations/checkins/v1/confirmations";
    const body = {
      publicCode: "LT-23456789",
      driverLicense: form.driverLicense,
      driverPhone: form.driverPhone,
      plate: form.plate,
      location
    };

    const first = await handleCheckinConfirmation(signedRequest(path, body), deps);
    const retry = await handleCheckinConfirmation(signedRequest(path, body), deps);

    expect(first.status).toBe(503);
    expect(retry.status).toBe(503);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("returns a generic 503 when the server-only Excel adapter is not configured", async () => {
    const confirm = vi.fn();
    const deps = dependencies({
      excelAdapter: undefined,
      resolveVersion: vi.fn().mockResolvedValue(1),
      confirm
    });
    const path = "/api/integrations/checkins/v1/confirmations";
    const response = await handleCheckinConfirmation(
      signedRequest(path, {
        publicCode: "LT-23456789",
        driverLicense: form.driverLicense,
        driverPhone: form.driverPhone,
        plate: form.plate,
        location
      }),
      deps
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Erro inesperado." }
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects unknown fields using the strict route schema", async () => {
    const createPreRegistration = vi.fn();
    const deps = dependencies({ createPreRegistration });
    const path = "/api/integrations/checkins/v1/pre-registrations";
    const response = await handleCheckinPreRegistration(
      signedRequest(path, { source: "CARRIER", form, unexpected: true }),
      deps
    );

    expect(response.status).toBe(400);
    expect(createPreRegistration).not.toHaveBeenCalled();
  });
});
