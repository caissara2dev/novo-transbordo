import { describe, expect, it, vi } from "vitest";
import type { DriverCheckinForm } from "@/lib/domain/checkins";
import {
  createPowerAutomateCheckinAdapter,
  createPowerAutomateCheckinAdapterFromEnv
} from "@/lib/server/checkins/power-automate-adapter";

const FORM: DriverCheckinForm = {
  driverName: "=HYPERLINK(\"https://example.test\")",
  driverLicense: "12345678900",
  driverPhone: "13999999999",
  plate: "ABC1D23",
  carrierName: "+Transportadora",
  vehicleType: "Bitrem",
  product: "  @produto",
  originPlant: "Usina\u0000 segura",
  originInvoiceNumbers: "-10+20",
  remittanceInvoiceNumber: "NF 123",
  whatsappNoticeAccepted: true,
  queueLocationAccepted: true
};

const INCLUDE_URL = "https://example.logic.azure.com/workflows/include?sig=secret";
const UPDATE_URL = "https://example.logic.azure.com/workflows/update?sig=secret";

function successResponse(
  identifier = "LT-23456789",
  result: "CREATED" | "ALREADY_EXISTS" | "UPDATED" | "UNCHANGED" = "CREATED"
) {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        identifier,
        confirmedAtIso: "2026-08-10T15:00:00.000Z",
        result
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Power Automate check-in adapter", () => {
  it("posts a versioned, idempotent and Excel-safe inclusion payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(successResponse());
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      bearerToken: "server-secret-token",
      fetchImpl
    });

    await expect(
      adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      })
    ).resolves.toEqual({ confirmedAtIso: "2026-08-10T15:00:00.000Z" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(INCLUDE_URL);
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "manual"
    });
    expect(init.headers).toMatchObject({
      authorization: "Bearer server-secret-token",
      "content-type": "application/json"
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      schemaVersion: "checkin-excel.v1",
      operation: "INCLUDE",
      idempotencyKey: "LT-23456789",
      record: {
        identifier: "LT-23456789",
        startedAtIso: "2026-08-10T14:59:00.000Z",
        language: "pt-BR",
        email: "",
        name: "",
        driverName: "'=HYPERLINK(\"https://example.test\")",
        driverLicense: "12345678900",
        driverPhone: "13999999999",
        plate: "ABC1D23",
        carrierName: "'+Transportadora",
        vehicleType: "Bitrem",
        product: "'  @produto",
        originPlant: "Usina segura",
        originInvoiceNumbers: "'-10+20",
        remittanceInvoiceNumber: "NF 123",
        whatsappNoticeAccepted: "Ciente",
        queueLocationAccepted: "Ciente"
      }
    });
  });

  it("updates the same identifier using only the update endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(successResponse("LT-23456789", "UPDATED"));
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      fetchImpl
    });

    await expect(
      adapter.updateIdempotently({
        publicCode: "LT-23456789",
        idempotencyKey: "LT-23456789:v3",
        requestedAtIso: "2026-08-10T15:01:00.000Z",
        patch: {
          carrierName: "=Transportadora corrigida",
          originInvoiceNumbers: "NF 456"
        }
      })
    ).resolves.toEqual({ confirmedAtIso: "2026-08-10T15:00:00.000Z" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(UPDATE_URL);
    expect(init.headers).toMatchObject({
      "x-idempotency-key": "LT-23456789:v3"
    });
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: "checkin-excel.v1",
      operation: "UPDATE",
      idempotencyKey: "LT-23456789:v3",
      identifier: "LT-23456789",
      requestedAtIso: "2026-08-10T15:01:00.000Z",
      patch: {
        carrierName: "'=Transportadora corrigida",
        originInvoiceNumbers: "NF 456"
      }
    });
  });

  it.each([
    ["http://example.test/include", UPDATE_URL],
    [INCLUDE_URL, "file:///tmp/update"]
  ])("rejects non-HTTPS endpoints", (includeUrl, updateUrl) => {
    expect(() =>
      createPowerAutomateCheckinAdapter({ includeUrl, updateUrl })
    ).toThrow("Configuração da sincronização oficial inválida.");
  });

  it("rejects timeout values above the fifteen-second ceiling", () => {
    expect(() =>
      createPowerAutomateCheckinAdapter({
        includeUrl: INCLUDE_URL,
        updateUrl: UPDATE_URL,
        timeoutMs: 15_001
      })
    ).toThrow("Configuração da sincronização oficial inválida.");
  });

  it("loads URLs and credentials only from server environment values", () => {
    const adapter = createPowerAutomateCheckinAdapterFromEnv({
      CHECKIN_POWER_AUTOMATE_ADD_URL: INCLUDE_URL,
      CHECKIN_POWER_AUTOMATE_UPDATE_URL: UPDATE_URL,
      CHECKIN_POWER_AUTOMATE_BEARER_TOKEN: "token"
    });

    expect(adapter).toBeDefined();
  });

  it.each([
    new Response("upstream PII: motorista", { status: 500 }),
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    new Response(
      JSON.stringify({
        ok: true,
        data: {
          identifier: "LT-ABCDEFGH",
          confirmedAtIso: "2026-08-10T15:00:00.000Z",
          result: "CREATED"
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  ])("returns a generic error for unsafe upstream responses", async (response) => {
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      fetchImpl: vi.fn().mockResolvedValue(response)
    });

    await expect(
      adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      })
    ).rejects.toThrow("O registro oficial está temporariamente indisponível.");
  });

  it("stops reading a response larger than the configured limit", async () => {
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      maxResponseBytes: 64,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response("x".repeat(65), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    });

    await expect(
      adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      })
    ).rejects.toThrow("O registro oficial está temporariamente indisponível.");
  });

  it("aborts a request when the configured timeout elapses", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      })
    );
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      timeoutMs: 5,
      fetchImpl
    });

    await expect(
      adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      })
    ).rejects.toThrow("O registro oficial está temporariamente indisponível.");
  });
});
