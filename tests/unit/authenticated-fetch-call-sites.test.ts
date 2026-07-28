import { readFile } from "node:fs/promises";
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
      uid: "user-1",
      getIdToken: clientBoundary.getIdToken
    }
  },
  appCheck: clientBoundary.appCheck
}));

vi.mock("firebase/app-check", () => ({
  getToken: clientBoundary.getAppCheckToken
}));

describe("authenticated client call sites", () => {
  beforeEach(() => {
    clientBoundary.fetch.mockReset();
    clientBoundary.getIdToken.mockReset();
    clientBoundary.getAppCheckToken.mockReset();
    vi.stubGlobal("fetch", clientBoundary.fetch);
    clientBoundary.getIdToken.mockResolvedValue("firebase-id-token");
    clientBoundary.getAppCheckToken.mockResolvedValue({ token: appCheckFixture });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads and synchronizes the session profile through authenticated requests", async () => {
    clientBoundary.fetch
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "Perfil de usuário não encontrado."
            }
          },
          { status: 404 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: { synced: true }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: {
            profile: { uid: "user-1", role: "OPERATOR" },
            approvalContactPhone: null
          }
        })
      );
    const { fetchSessionProfile } = await import("@/lib/auth/use-auth-session");
    const upstream = new AbortController();

    await expect(fetchSessionProfile(upstream.signal)).resolves.toMatchObject({
      profile: { uid: "user-1", role: "OPERATOR" }
    });

    expect(clientBoundary.fetch.mock.calls.map(([input]) => input)).toEqual([
      "/api/me",
      "/api/auth/sync",
      "/api/me"
    ]);

    for (const [, init] of clientBoundary.fetch.mock.calls as [
      string,
      RequestInit
    ][]) {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer firebase-id-token");
      expect(headers.get("x-firebase-appcheck")).toBe(appCheckFixture);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("keeps the session timeout while using the authenticated transport", async () => {
    vi.useFakeTimers();
    clientBoundary.fetch.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const rejectWithAbort = () =>
            reject(new DOMException("The operation was aborted.", "AbortError"));

          if (init?.signal?.aborted) {
            rejectWithAbort();
            return;
          }

          init?.signal?.addEventListener("abort", rejectWithAbort, { once: true });
        })
    );
    const { fetchSessionProfile } = await import("@/lib/auth/use-auth-session");
    const request = fetchSessionProfile(new AbortController().signal);
    const expectation = expect(request).rejects.toThrow(
      "A solicitação demorou demais. Tente novamente."
    );

    await vi.advanceTimersByTimeAsync(8000);
    await expectation;
  });

  it("validates the sync success envelope before retrying the profile", async () => {
    clientBoundary.fetch
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "Perfil de usuário não encontrado."
            }
          },
          { status: 404 }
        )
      )
      .mockResolvedValueOnce(Response.json({ synced: true }));
    const { fetchSessionProfile } = await import("@/lib/auth/use-auth-session");

    await expect(
      fetchSessionProfile(new AbortController().signal)
    ).rejects.toThrow("Resposta inválida do servidor.");
    expect(clientBoundary.fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves AbortSignal, response status and CSV blobs", async () => {
    const csv = new Blob(["header,value\nitem,1"], { type: "text/csv" });
    const response = new Response(csv, {
      status: 206,
      headers: { "content-type": "text/csv" }
    });
    clientBoundary.fetch.mockResolvedValue(response);
    const { authenticatedFetch } = await import("@/lib/auth/api-fetch");
    const controller = new AbortController();

    const result = await authenticatedFetch(
      "/api/reports/export?mode=detailed",
      { signal: controller.signal }
    );

    expect(result).toBe(response);
    expect(result.status).toBe(206);
    expect(await result.blob().then((blob) => blob.text())).toBe(
      "header,value\nitem,1"
    );
    const [, init] = clientBoundary.fetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer firebase-id-token"
    );
  });

  it("keeps authenticated API calls behind the shared transport", async () => {
    const [sessionSource, loginSource, registerSource, reportsSource] =
      await Promise.all([
        readFile(
          new URL("../../src/lib/auth/use-auth-session.tsx", import.meta.url),
          "utf8"
        ),
        readFile(
          new URL("../../src/app/(auth)/login/page.tsx", import.meta.url),
          "utf8"
        ),
        readFile(
          new URL("../../src/app/(auth)/register/page.tsx", import.meta.url),
          "utf8"
        ),
        readFile(
          new URL("../../src/app/(app)/reports/page.tsx", import.meta.url),
          "utf8"
        )
      ]);

    for (const source of [sessionSource, loginSource, reportsSource]) {
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/getIdToken\s*\(/);
      expect(source).toContain("authenticatedFetch");
    }

    expect(registerSource).not.toContain("/api/");
    expect(registerSource).not.toMatch(/\bfetch\s*\(/);
  });
});
