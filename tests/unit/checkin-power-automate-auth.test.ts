import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/domain/errors";
import { createPowerAutomateEntraTokenProvider } from "@/lib/server/checkins/power-automate-auth";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_SECRET = "staging-secret-with-sufficient-length";

function tokenResponse(accessToken = "valid-access-token-with-sufficient-length") {
  return new Response(
    JSON.stringify({
      token_type: "Bearer",
      expires_in: 3600,
      ext_expires_in: 3600,
      access_token: accessToken
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Power Automate Microsoft Entra token provider", () => {
  it("reports only the allowlisted OAuth error code from a Microsoft rejection", async () => {
    const diagnostics = vi.fn();
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      diagnostics,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description:
              "LEAK secret endpoint CNH 12345678900 and tenant details",
            error_codes: [7000215],
            trace_id: "LEAK-trace",
            correlation_id: "LEAK-correlation"
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
      )
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "A autenticação da sincronização oficial está temporariamente indisponível."
    );
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith({
      event: "power_automate_failure",
      component: "token",
      reason: "status",
      status: 400,
      oauthError: "invalid_client"
    });
    const serialized = JSON.stringify(diagnostics.mock.calls);
    for (const forbidden of [
      CLIENT_SECRET,
      TENANT_ID,
      CLIENT_ID,
      "LEAK",
      "12345678900",
      "7000215"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not report an unrecognized OAuth error value", async () => {
    const diagnostics = vi.fn();
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      diagnostics,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "LEAK_custom_error" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        })
      )
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "A autenticação da sincronização oficial está temporariamente indisponível."
    );
    expect(diagnostics).toHaveBeenCalledWith({
      event: "power_automate_failure",
      component: "token",
      reason: "status",
      status: 400
    });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("LEAK");
  });

  it("reports a sanitized Microsoft rejection without leaking upstream data", async () => {
    const diagnostics = vi.fn();
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      diagnostics,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response("LEAK secret endpoint CNH 12345678900", { status: 401 })
      )
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "A autenticação da sincronização oficial está temporariamente indisponível."
    );
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith({
      event: "power_automate_failure",
      component: "token",
      reason: "status",
      status: 401
    });
    const serialized = JSON.stringify(diagnostics.mock.calls);
    for (const forbidden of [
      CLIENT_SECRET,
      TENANT_ID,
      CLIENT_ID,
      "LEAK",
      "12345678900"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reports a sanitized token network failure", async () => {
    const diagnostics = vi.fn();
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      diagnostics,
      fetchImpl: vi.fn().mockRejectedValue(
        new Error("LEAK token URL and driver data")
      )
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "A autenticação da sincronização oficial está temporariamente indisponível."
    );
    expect(diagnostics).toHaveBeenCalledWith({
      event: "power_automate_failure",
      component: "token",
      reason: "network"
    });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("LEAK");
  });

  it("does not let a diagnostics failure replace the public error", async () => {
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      diagnostics: () => {
        throw new Error("diagnostics unavailable");
      },
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "A autenticação da sincronização oficial está temporariamente indisponível."
    );
  });

  it("obtains a client-credentials token for the Power Automate service", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse());
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl
    });

    await expect(provider.getAccessToken()).resolves.toBe(
      "valid-access-token-with-sufficient-length"
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      }
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(init.body)).toBe(
      "grant_type=client_credentials" +
        `&client_id=${CLIENT_ID}` +
        `&client_secret=${CLIENT_SECRET}` +
        "&scope=https%3A%2F%2Fservice.flow.microsoft.com%2F%2F.default"
    );
  });

  it("reuses a valid token and refreshes it after the safety margin", async () => {
    let nowMs = 1_000_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("first-access-token-with-enough-length"))
      .mockResolvedValueOnce(tokenResponse("second-access-token-with-enough-length"));
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
      now: () => nowMs
    });

    await expect(provider.getAccessToken()).resolves.toBe(
      "first-access-token-with-enough-length"
    );
    nowMs += 3_539_999;
    await expect(provider.getAccessToken()).resolves.toBe(
      "first-access-token-with-enough-length"
    );
    expect(fetchImpl).toHaveBeenCalledOnce();

    nowMs += 1;
    await expect(provider.getAccessToken()).resolves.toBe(
      "second-access-token-with-enough-length"
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one token acquisition between simultaneous callers", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl
    });

    const first = provider.getAccessToken();
    const second = provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledOnce();
    resolveResponse?.(tokenResponse());

    await expect(Promise.all([first, second])).resolves.toEqual([
      "valid-access-token-with-sufficient-length",
      "valid-access-token-with-sufficient-length"
    ]);
  });

  it("fetches a new token after the cached token is invalidated", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("first-access-token-with-enough-length"))
      .mockResolvedValueOnce(tokenResponse("second-access-token-with-enough-length"));
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl
    });

    await expect(provider.getAccessToken()).resolves.toBe(
      "first-access-token-with-enough-length"
    );
    provider.invalidateAccessToken();
    await expect(provider.getAccessToken()).resolves.toBe(
      "second-access-token-with-enough-length"
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      tenantId: "not-a-tenant",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    },
    {
      tenantId: TENANT_ID,
      clientId: "not-a-client",
      clientSecret: CLIENT_SECRET
    },
    {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: "s".repeat(31)
    },
    {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: ` ${CLIENT_SECRET}`
    }
  ])("rejects incomplete credentials without contacting Microsoft", (credentials) => {
    const fetchImpl = vi.fn();

    expect(() =>
      createPowerAutomateEntraTokenProvider({ ...credentials, fetchImpl })
    ).toThrow("Configuração da autenticação oficial inválida.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects timeout values above the fifteen-second ceiling", () => {
    expect(() =>
      createPowerAutomateEntraTokenProvider({
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        timeoutMs: 15_001
      })
    ).toThrow("Configuração da autenticação oficial inválida.");
  });

  it.each([
    new Response("secret and driver PII from Microsoft", { status: 401 }),
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    new Response(
      JSON.stringify({
        token_type: "Bearer",
        expires_in: 3600,
        access_token: "valid-access-token-with-sufficient-length",
        unexpected: "field"
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ),
    new Response("x".repeat(16 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  ])("returns a generic error for unsafe Microsoft responses", async (response) => {
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl: vi.fn().mockResolvedValue(response)
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "A autenticação da sincronização oficial está temporariamente indisponível."
    );
  });

  it("replaces detailed fetch failures with a generic error", async () => {
    const provider = createPowerAutomateEntraTokenProvider({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl: vi
        .fn()
        .mockRejectedValue(
          new HttpError(401, "secret, endpoint and driver PII from upstream")
        )
    });

    await expect(provider.getAccessToken()).rejects.toThrow(
      "A autenticação da sincronização oficial está temporariamente indisponível."
    );
  });

  it("times out even when the external fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (...request: [string | URL | Request, RequestInit?]) => {
          void request;
          return new Promise<Response>(() => undefined);
        }
      );
      const provider = createPowerAutomateEntraTokenProvider({
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        timeoutMs: 5,
        fetchImpl
      });

      const acquisition = provider.getAccessToken();
      const assertion = expect(acquisition).rejects.toThrow(
        "A autenticação da sincronização oficial está temporariamente indisponível."
      );
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
