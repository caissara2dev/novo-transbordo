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
  plate: "ABC-1D23",
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

function testTokenProvider() {
  return {
    getAccessToken: vi.fn().mockResolvedValue("test-entra-access-token"),
    invalidateAccessToken: vi.fn()
  };
}

describe("Power Automate check-in adapter", () => {
  it("posts a versioned, idempotent and Excel-safe inclusion payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(successResponse());
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      accessTokenProvider: testTokenProvider(),
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
      authorization: "Bearer test-entra-access-token",
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

  it("obtains a fresh Entra token through the configured provider before sending", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(successResponse());
    const getAccessToken = vi.fn().mockResolvedValue("entra-access-token");
    const invalidateAccessToken = vi.fn();
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      accessTokenProvider: { getAccessToken, invalidateAccessToken },
      fetchImpl
    });

    await adapter.includeIdempotently({
      publicCode: "LT-23456789",
      form: FORM,
      startedAtIso: "2026-08-10T14:59:00.000Z"
    });

    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: "Bearer entra-access-token"
    });
  });

  it("confirms only after the asynchronous Power Automate run reaches its final response", async () => {
    vi.useFakeTimers();
    try {
      const statusUrl =
        "https://example.logic.azure.com/workflows/include/runs/status?sig=poll-secret";
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 202,
            headers: { location: statusUrl, "retry-after": "0" }
          })
        )
        .mockResolvedValueOnce(successResponse());
      const adapter = createPowerAutomateCheckinAdapter({
        includeUrl: INCLUDE_URL,
        updateUrl: UPDATE_URL,
        accessTokenProvider: testTokenProvider(),
        fetchImpl
      });

      const confirmation = adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      });
      await vi.advanceTimersByTimeAsync(250);

      await expect(confirmation).resolves.toEqual({
        confirmedAtIso: "2026-08-10T15:00:00.000Z"
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [pollUrl, pollInit] = fetchImpl.mock.calls[1] as [
        string,
        RequestInit
      ];
      expect(pollUrl).toBe(statusUrl);
      expect(pollInit).toMatchObject({
        method: "GET",
        cache: "no-store",
        redirect: "manual"
      });
      expect(pollInit.headers).not.toHaveProperty("authorization");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling the same safe status URL until Power Automate finishes", async () => {
    vi.useFakeTimers();
    try {
      const statusUrl =
        "https://example.logic.azure.com/workflows/include/runs/status?sig=poll-secret";
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 202,
            headers: { location: statusUrl, "retry-after": "invalid" }
          })
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 202, headers: { "retry-after": "99" } })
        )
        .mockResolvedValueOnce(successResponse());
      const adapter = createPowerAutomateCheckinAdapter({
        includeUrl: INCLUDE_URL,
        updateUrl: UPDATE_URL,
        accessTokenProvider: testTokenProvider(),
        fetchImpl
      });

      const confirmation = adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      });
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(confirmation).resolves.toEqual({
        confirmedAtIso: "2026-08-10T15:00:00.000Z"
      });
      expect(fetchImpl.mock.calls.slice(1).map(([url]) => url)).toEqual([
        statusUrl,
        statusUrl
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed if the request budget expires before polling starts", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(null, {
                    status: 202,
                    headers: {
                      location:
                        "https://example.logic.azure.com/workflows/include/runs/status?sig=safe"
                    }
                  })
                ),
              10
            );
          })
      );
      const adapter = createPowerAutomateCheckinAdapter({
        includeUrl: INCLUDE_URL,
        updateUrl: UPDATE_URL,
        accessTokenProvider: testTokenProvider(),
        timeoutMs: 5,
        fetchImpl
      });
      const confirmation = expect(
        adapter.includeIdempotently({
          publicCode: "LT-23456789",
          form: FORM,
          startedAtIso: "2026-08-10T14:59:00.000Z"
        })
      ).rejects.toThrow(
        "O registro oficial está temporariamente indisponível."
      );

      await vi.advanceTimersByTimeAsync(10);
      await confirmation;
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["without a status location", undefined],
    ["with an unsafe status location", "https://attacker.example/status"]
  ])("rejects an asynchronous response %s", async (_case, location) => {
    const headers = location === undefined ? undefined : { location };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202, headers }));
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      accessTokenProvider: testTokenProvider(),
      fetchImpl
    });

    await expect(
      adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      })
    ).rejects.toThrow("O registro oficial está temporariamente indisponível.");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps the visit unconfirmed when asynchronous polling exceeds the total timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 202,
          headers: {
            location:
              "https://example.logic.azure.com/workflows/include/runs/pending?sig=safe",
            "retry-after": "10"
          }
        })
      );
      const adapter = createPowerAutomateCheckinAdapter({
        includeUrl: INCLUDE_URL,
        updateUrl: UPDATE_URL,
        accessTokenProvider: testTokenProvider(),
        timeoutMs: 5,
        fetchImpl
      });
      const confirmation = expect(
        adapter.includeIdempotently({
          publicCode: "LT-23456789",
          form: FORM,
          startedAtIso: "2026-08-10T14:59:00.000Z"
        })
      ).rejects.toThrow(
        "O registro oficial está temporariamente indisponível."
      );

      await vi.advanceTimersByTimeAsync(5);
      await confirmation;
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails before calling Power Automate when Entra cannot issue a token", async () => {
    const fetchImpl = vi.fn();
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      accessTokenProvider: {
        getAccessToken: vi.fn().mockRejectedValue(new Error("secret leaked")),
        invalidateAccessToken: vi.fn()
      },
      fetchImpl
    });

    await expect(
      adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      })
    ).rejects.toThrow("O registro oficial está temporariamente indisponível.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an adapter without an Entra access-token provider", () => {
    expect(() =>
      createPowerAutomateCheckinAdapter({
        includeUrl: INCLUDE_URL,
        updateUrl: UPDATE_URL
      })
    ).toThrow("Configuração da sincronização oficial inválida.");
  });

  it("invalidates a rejected Entra token without automatically repeating the command", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(successResponse());
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce("rejected-entra-access-token")
      .mockResolvedValueOnce("refreshed-entra-access-token");
    const invalidateAccessToken = vi.fn();
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      accessTokenProvider: { getAccessToken, invalidateAccessToken },
      fetchImpl
    });
    const record = {
      publicCode: "LT-23456789",
      form: FORM,
      startedAtIso: "2026-08-10T14:59:00.000Z"
    };

    await expect(adapter.includeIdempotently(record)).rejects.toThrow(
      "O registro oficial está temporariamente indisponível."
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(invalidateAccessToken).toHaveBeenCalledOnce();

    await expect(adapter.includeIdempotently(record)).resolves.toEqual({
      confirmedAtIso: "2026-08-10T15:00:00.000Z"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(retryInit.headers).toMatchObject({
      authorization: "Bearer refreshed-entra-access-token"
    });
  });

  it("updates the same identifier using only the update endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(successResponse("LT-23456789", "UPDATED"))
      );
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      accessTokenProvider: testTokenProvider(),
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
      payloadHash:
        "cfa1376c6dfe27b993de47e4d3e5483f733f2174a24317461574c493f0ce9e91",
      patch: {
        carrierName: "'=Transportadora corrigida",
        originInvoiceNumbers: "NF 456"
      }
    });
  });

  it("keeps the update hash stable across retries with a new timestamp", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(successResponse("LT-23456789", "UPDATED"))
      );
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      accessTokenProvider: testTokenProvider(),
      fetchImpl
    });
    const command = {
      publicCode: "LT-23456789",
      idempotencyKey: "LT-23456789:v3",
      patch: { plate: "BRA-2E19" }
    };

    await adapter.updateIdempotently({
      ...command,
      requestedAtIso: "2026-08-10T15:01:00.000Z"
    });
    await adapter.updateIdempotently({
      ...command,
      requestedAtIso: "2026-08-10T15:02:00.000Z"
    });

    const requests = fetchImpl.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body))
    );
    expect(requests[0].payloadHash).toBe(requests[1].payloadHash);
    expect(requests[0].patch.plate).toBe("BRA2E19");
    expect(requests[1].patch.plate).toBe("BRA2E19");
  });

  it.each([
    ["http://example.test/include", UPDATE_URL],
    [INCLUDE_URL, "file:///tmp/update"],
    ["https://example.test/include", UPDATE_URL]
  ])("rejects unsafe or non-Power-Automate endpoints", (includeUrl, updateUrl) => {
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

  it.each([undefined, "none", "static-bearer"])(
    "fails closed when the Entra authentication mode is %s",
    (authMode) => {
      expect(() =>
        createPowerAutomateCheckinAdapterFromEnv({
          CHECKIN_POWER_AUTOMATE_ADD_URL: INCLUDE_URL,
          CHECKIN_POWER_AUTOMATE_UPDATE_URL: UPDATE_URL,
          CHECKIN_POWER_AUTOMATE_AUTH_MODE: authMode,
          CHECKIN_POWER_AUTOMATE_BEARER_TOKEN: "legacy-token"
        })
      ).toThrow("Configuração da sincronização oficial inválida.");
    }
  );

  it("normalizes whitespace around the explicit Entra mode", () => {
    expect(() =>
      createPowerAutomateCheckinAdapterFromEnv({
        CHECKIN_POWER_AUTOMATE_ADD_URL: INCLUDE_URL,
        CHECKIN_POWER_AUTOMATE_UPDATE_URL: UPDATE_URL,
        CHECKIN_POWER_AUTOMATE_AUTH_MODE: " entra-client-credentials ",
        CHECKIN_POWER_AUTOMATE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        CHECKIN_POWER_AUTOMATE_CLIENT_ID:
          "22222222-2222-4222-8222-222222222222",
        CHECKIN_POWER_AUTOMATE_CLIENT_SECRET: "s".repeat(32)
      })
    ).not.toThrow();
  });

  it("loads Entra client credentials only when the authentication mode is explicit", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token_type: "Bearer",
            expires_in: 3600,
            access_token: "entra-access-token-with-enough-length"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(successResponse());
    const adapter = createPowerAutomateCheckinAdapterFromEnv(
      {
        CHECKIN_POWER_AUTOMATE_ADD_URL: INCLUDE_URL,
        CHECKIN_POWER_AUTOMATE_UPDATE_URL: UPDATE_URL,
        CHECKIN_POWER_AUTOMATE_AUTH_MODE: "entra-client-credentials",
        CHECKIN_POWER_AUTOMATE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        CHECKIN_POWER_AUTOMATE_CLIENT_ID:
          "22222222-2222-4222-8222-222222222222",
        CHECKIN_POWER_AUTOMATE_CLIENT_SECRET: "s".repeat(32)
      },
      { fetchImpl }
    );

    await adapter.includeIdempotently({
      publicCode: "LT-23456789",
      form: FORM,
      startedAtIso: "2026-08-10T14:59:00.000Z"
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(tokenUrl).toBe(
      "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/oauth2/v2.0/token"
    );
    expect(String(tokenInit.body)).toContain(
      "scope=https%3A%2F%2Fservice.flow.microsoft.com%2F%2F.default"
    );
    const [, flowInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(flowInit.headers).toMatchObject({
      authorization: "Bearer entra-access-token-with-enough-length"
    });
  });

  it("reuses the cached Entra token for adapters built from the same environment", async () => {
    const environment = {
      CHECKIN_POWER_AUTOMATE_ADD_URL: INCLUDE_URL,
      CHECKIN_POWER_AUTOMATE_UPDATE_URL: UPDATE_URL,
      CHECKIN_POWER_AUTOMATE_AUTH_MODE: "entra-client-credentials",
      CHECKIN_POWER_AUTOMATE_TENANT_ID:
        "11111111-1111-4111-8111-111111111111",
      CHECKIN_POWER_AUTOMATE_CLIENT_ID:
        "22222222-2222-4222-8222-222222222222",
      CHECKIN_POWER_AUTOMATE_CLIENT_SECRET: "s".repeat(32)
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token_type: "Bearer",
            expires_in: 3600,
            access_token: "cached-access-token-with-enough-length"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(successResponse());

    const first = createPowerAutomateCheckinAdapterFromEnv(environment, {
      fetchImpl
    });
    const second = createPowerAutomateCheckinAdapterFromEnv(environment, {
      fetchImpl
    });
    const record = {
      publicCode: "LT-23456789",
      form: FORM,
      startedAtIso: "2026-08-10T14:59:00.000Z"
    };

    await first.includeIdempotently(record);
    await second.includeIdempotently(record);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "login.microsoftonline.com"
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(INCLUDE_URL);
    expect(String(fetchImpl.mock.calls[2]?.[0])).toBe(INCLUDE_URL);
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
      accessTokenProvider: testTokenProvider(),
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
      accessTokenProvider: testTokenProvider(),
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

  it("rejects a malformed declared response length before reading the body", async () => {
    const response = successResponse();
    response.headers.set("content-length", "unknown");
    const adapter = createPowerAutomateCheckinAdapter({
      includeUrl: INCLUDE_URL,
      updateUrl: UPDATE_URL,
      accessTokenProvider: testTokenProvider(),
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
      accessTokenProvider: testTokenProvider(),
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

  it("starts the flow timeout only after token acquisition completes", async () => {
    vi.useFakeTimers();
    try {
      let resolveToken: ((token: string) => void) | undefined;
      const accessTokenProvider = {
        getAccessToken: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              resolveToken = resolve;
            })
        ),
        invalidateAccessToken: vi.fn()
      };
      const fetchImpl = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) => {
          expect(init?.signal?.aborted).toBe(false);
          return Promise.resolve(successResponse());
        }
      );
      const adapter = createPowerAutomateCheckinAdapter({
        includeUrl: INCLUDE_URL,
        updateUrl: UPDATE_URL,
        accessTokenProvider,
        timeoutMs: 5,
        fetchImpl
      });

      const command = adapter.includeIdempotently({
        publicCode: "LT-23456789",
        form: FORM,
        startedAtIso: "2026-08-10T14:59:00.000Z"
      });
      await vi.advanceTimersByTimeAsync(10);
      resolveToken?.("delayed-entra-token");

      await expect(command).resolves.toEqual({
        confirmedAtIso: "2026-08-10T15:00:00.000Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
