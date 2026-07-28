import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientBoundary = vi.hoisted(() => ({
  getAppCheckToken: vi.fn(),
  getIdToken: vi.fn(),
  appCheck: { name: "app-check" },
  fetch: vi.fn()
}));
const appCheckFixture = "app-check-fixture";

vi.mock("@/lib/firebase/client", () => ({
  auth: {
    currentUser: {
      getIdToken: clientBoundary.getIdToken
    }
  },
  appCheck: clientBoundary.appCheck
}));

vi.mock("firebase/app-check", () => ({
  getToken: clientBoundary.getAppCheckToken
}));

describe("authenticatedFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", clientBoundary.fetch);
    clientBoundary.getIdToken.mockResolvedValue("firebase-id-token");
    clientBoundary.getAppCheckToken.mockResolvedValue({ token: appCheckFixture });
    clientBoundary.fetch.mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("preserves AbortSignal and binary bodies while adding Auth and App Check", async () => {
    const controller = new AbortController();
    const binary = new Blob(["binary"], { type: "application/octet-stream" });
    const { authenticatedFetch } = await import("@/lib/auth/api-fetch");

    await authenticatedFetch("/api/upload", {
      method: "POST",
      body: binary,
      signal: controller.signal,
      headers: {
        "x-correlation-id": "request-1"
      }
    });

    const [, init] = clientBoundary.fetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);

    expect(init.body).toBe(binary);
    expect(init.signal).toBe(controller.signal);
    expect(headers.get("authorization")).toBe("Bearer firebase-id-token");
    expect(headers.get("x-firebase-appcheck")).toBe(appCheckFixture);
    expect(headers.get("x-correlation-id")).toBe("request-1");
    expect(headers.has("content-type")).toBe(false);
  });

  it("keeps apiFetch JSON-compatible without changing the transport primitive", async () => {
    clientBoundary.fetch.mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { item: { id: "event-1" } }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const { apiFetch } = await import("@/lib/auth/api-fetch");

    await expect(
      apiFetch<{ item: { id: string } }>("/api/events", {
        method: "POST",
        body: JSON.stringify({ pump: "BOMBA_1" })
      })
    ).resolves.toEqual({ item: { id: "event-1" } });

    const [, init] = clientBoundary.fetch.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("throws the stable API error while keeping status and details", async () => {
    clientBoundary.fetch.mockResolvedValue(
      Response.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Dados da requisição inválidos.",
            details: {
              fieldErrors: {
                approved: ["Expected boolean"]
              }
            }
          }
        },
        { status: 400 }
      )
    );
    const { apiFetch } = await import("@/lib/auth/api-fetch");

    await expect(apiFetch("/api/users/u1/approve")).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Dados da requisição inválidos.",
      details: {
        fieldErrors: {
          approved: ["Expected boolean"]
        }
      }
    });
  });

  it("rejects a successful response that does not follow the envelope", async () => {
    clientBoundary.fetch.mockResolvedValue(
      Response.json({ item: { id: "event-1" } })
    );
    const { apiFetch } = await import("@/lib/auth/api-fetch");

    await expect(apiFetch("/api/events")).rejects.toMatchObject({
      name: "ApiRequestError",
      code: "INTERNAL_ERROR",
      message: "Resposta inválida do servidor."
    });
  });

  it.each(["Firebase ID token", "App Check token"])(
    "honors AbortSignal while acquiring the %s",
    async (pendingToken) => {
      let resolvePending: ((value: unknown) => void) | undefined;
      const delayedToken = new Promise((resolve) => {
        resolvePending = resolve;
      });

      if (pendingToken === "Firebase ID token") {
        clientBoundary.getIdToken.mockReturnValue(delayedToken);
      } else {
        clientBoundary.getAppCheckToken.mockReturnValue(delayedToken);
      }

      const controller = new AbortController();
      const { authenticatedFetch } = await import("@/lib/auth/api-fetch");
      const request = authenticatedFetch("/api/me", {
        signal: controller.signal
      });

      controller.abort();
      resolvePending?.(
        pendingToken === "Firebase ID token"
          ? "late-id-token"
          : { token: appCheckFixture }
      );

      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(clientBoundary.fetch).not.toHaveBeenCalled();
    }
  );

  it("lets the server decide App Check policy when client token acquisition fails", async () => {
    clientBoundary.getAppCheckToken.mockRejectedValue(
      new Error("App Check temporarily unavailable")
    );
    const { authenticatedFetch } = await import("@/lib/auth/api-fetch");

    await authenticatedFetch("/api/me");

    expect(clientBoundary.fetch).toHaveBeenCalledOnce();
    const [, init] = clientBoundary.fetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer firebase-id-token");
    expect(headers.has("x-firebase-appcheck")).toBe(false);
  });

  it("supports an explicit client-side fail-closed App Check policy", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_CHECK_FAIL_CLOSED", "true");
    clientBoundary.getAppCheckToken.mockRejectedValue(
      new Error("App Check temporarily unavailable")
    );
    const { authenticatedFetch } = await import("@/lib/auth/api-fetch");

    await expect(authenticatedFetch("/api/me")).rejects.toThrow(
      "App Check temporarily unavailable"
    );
    expect(clientBoundary.fetch).not.toHaveBeenCalled();
  });
});
