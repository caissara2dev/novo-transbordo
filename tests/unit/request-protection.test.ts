import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type StoredBucket = {
  tokens: number;
  lastRefillAtMs: number;
  expiresAt: unknown;
  keyVersion?: string;
  policy?: string;
};

const firebaseBoundary = vi.hoisted(() => {
  const buckets = new Map<string, StoredBucket>();

  const verifyIdToken = vi.fn();
  const verifyAppCheckToken = vi.fn();
  const getAdminAppCheck = vi.fn(async () => ({
    verifyToken: verifyAppCheckToken
  }));

  const adminDb = {
    collection: vi.fn((collectionName: string) => ({
      doc: vi.fn((documentId: string) => ({
        id: documentId,
        path: `${collectionName}/${documentId}`
      }))
    })),
    runTransaction: vi.fn(
      async (
        operation: (transaction: {
          get: (reference: { path: string }) => Promise<{
            exists: boolean;
            data: () => StoredBucket | undefined;
          }>;
          set: (reference: { path: string }, value: StoredBucket) => void;
        }) => Promise<unknown>
      ) => {
        const transaction = {
          get: async (reference: { path: string }) => ({
            exists: buckets.has(reference.path),
            data: () => buckets.get(reference.path)
          }),
          set: (reference: { path: string }, value: StoredBucket) => {
            buckets.set(reference.path, value);
          }
        };

        return operation(transaction);
      }
    )
  };

  return {
    adminDb,
    buckets,
    getAdminAppCheck,
    verifyAppCheckToken,
    verifyIdToken
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: firebaseBoundary.verifyIdToken
  },
  getAdminAppCheck: firebaseBoundary.getAdminAppCheck,
  adminDb: firebaseBoundary.adminDb
}));

function makeRequest(
  path: string,
  {
    method = "GET",
    appCheckToken = "valid-app-check",
    ip = "203.0.113.10",
    headers: extraHeaders
  }: {
    method?: string;
    appCheckToken?: string | null;
    ip?: string;
    headers?: HeadersInit;
  } = {}
): NextRequest {
  const headers = new Headers({
    authorization: "Bearer valid-id-token",
    "x-forwarded-for": `attacker-spoofed, ${ip}, 35.191.0.1`,
    ...Object.fromEntries(new Headers(extraHeaders).entries())
  });

  if (appCheckToken) {
    headers.set("x-firebase-appcheck", appCheckToken);
  }

  return new NextRequest(`http://localhost${path}`, {
    method,
    headers
  });
}

describe("protectApiRequest", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    firebaseBoundary.buckets.clear();
    firebaseBoundary.verifyIdToken.mockResolvedValue({
      uid: "operator-1",
      email: "operator@example.com",
      email_verified: true
    });
    firebaseBoundary.verifyAppCheckToken.mockResolvedValue({
      appId: "1:123:web:abc",
      token: {}
    });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_CHECK_MODE", "enforce");
    vi.stubEnv("APP_CHECK_ALLOWED_APP_IDS", "1:123:web:abc");
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "a".repeat(32));
    vi.stubEnv("RATE_LIMIT_KEY_VERSION", "v1");
    vi.stubEnv("TRUSTED_PROXY_MODE", "google-lb");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("rejects a missing App Check token without exposing verification details", async () => {
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(
      protectApiRequest(makeRequest("/api/events", { appCheckToken: null }))
    ).rejects.toMatchObject({
      status: 401,
      message: "Verificação da aplicação necessária."
    });
    expect(firebaseBoundary.getAdminAppCheck).not.toHaveBeenCalled();
    expect(firebaseBoundary.verifyIdToken).not.toHaveBeenCalled();
  });

  it("loads the App Check verifier only when a token is present", async () => {
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).resolves.toMatchObject({
      uid: "operator-1"
    });
    expect(firebaseBoundary.getAdminAppCheck).toHaveBeenCalledOnce();
    expect(firebaseBoundary.verifyAppCheckToken).toHaveBeenCalledWith(
      "valid-app-check"
    );
  });

  it("does not allow a path allowlist to bypass App Check enforcement", async () => {
    vi.stubEnv("APP_CHECK_ALLOWLIST", "/api/auth/sync");
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(
      protectApiRequest(makeRequest("/api/auth/sync", { appCheckToken: null, method: "POST" }))
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a valid App Check token issued for an unapproved Firebase app", async () => {
    firebaseBoundary.verifyAppCheckToken.mockResolvedValue({
      appId: "1:123:web:unapproved",
      token: {}
    });
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).rejects.toMatchObject({
      status: 401,
      message: "Verificação da aplicação inválida."
    });
  });

  it("fails closed when App Check enforcement has no approved app IDs", async () => {
    vi.stubEnv("APP_CHECK_ALLOWED_APP_IDS", "");
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).rejects.toMatchObject({
      status: 503,
      message: "Proteção da API temporariamente indisponível."
    });
  });

  it("observes an invalid App Check token without blocking outside enforcement mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_CHECK_MODE", "observe");
    firebaseBoundary.verifyAppCheckToken.mockRejectedValue(new Error("invalid app check"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).resolves.toMatchObject({
      uid: "operator-1"
    });
    expect(warn).toHaveBeenCalledWith("App Check inválido em modo de observação.", {
      pathname: "/api/events"
    });
    warn.mockRestore();
  });

  it("defaults both protections to observe in production", async () => {
    vi.stubEnv("APP_CHECK_MODE", "");
    vi.stubEnv("RATE_LIMIT_MODE", "");
    vi.stubEnv("APP_CHECK_ALLOWED_APP_IDS", "");
    vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(
      protectApiRequest(makeRequest("/api/events", { appCheckToken: null }))
    ).resolves.toMatchObject({ uid: "operator-1" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("allows production observe mode while reporting missing proxy configuration", async () => {
    vi.stubEnv("APP_CHECK_MODE", "observe");
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "");
    vi.stubEnv("TRUSTED_PROXY_MODE", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).resolves.toMatchObject({
      uid: "operator-1"
    });
    expect(warn).toHaveBeenCalledWith(
      "Proxy confiável não configurado em modo de observação.",
      { policy: "READ" }
    );
    warn.mockRestore();
  });

  it("skips only the AUTH bucket when observe mode has no trusted proxy", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    vi.stubEnv("TRUSTED_PROXY_MODE", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(
      protectApiRequest(makeRequest("/api/auth/sync", { method: "POST" }))
    ).resolves.toMatchObject({ uid: "operator-1" });
    expect(warn).toHaveBeenCalledWith(
      "Proxy confiável não configurado em modo de observação.",
      { policy: "AUTH" }
    );
    expect(firebaseBoundary.adminDb.runTransaction).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sanitizes invalid Firebase authentication failures", async () => {
    firebaseBoundary.verifyIdToken.mockRejectedValue(new Error("auth/internal-error: secret"));
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).rejects.toMatchObject({
      status: 401,
      message: "Token de autenticação inválido."
    });
  });

  it("rate limits invalid authentication attempts by IP before token verification", async () => {
    firebaseBoundary.verifyIdToken.mockRejectedValue(new Error("invalid token"));
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/auth/sync", {
      method: "POST",
      ip: "198.51.100.30"
    });

    for (let index = 0; index < 10; index += 1) {
      await expect(protectApiRequest(request)).rejects.toMatchObject({ status: 401 });
    }

    await expect(protectApiRequest(request)).rejects.toMatchObject({ status: 429 });
    expect(firebaseBoundary.verifyIdToken).toHaveBeenCalledTimes(10);
  });

  it("rate limits invalid tokens on operational APIs before repeated verification", async () => {
    firebaseBoundary.verifyIdToken.mockRejectedValue(new Error("invalid token"));
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/events", {
      method: "POST",
      ip: "198.51.100.31"
    });

    for (let index = 0; index < 30; index += 1) {
      await expect(protectApiRequest(request)).rejects.toMatchObject({ status: 401 });
    }

    await expect(protectApiRequest(request)).rejects.toMatchObject({ status: 429 });
    expect(firebaseBoundary.verifyIdToken).toHaveBeenCalledTimes(30);
  });

  it("enforces the write policy per UID with a transactional token bucket", async () => {
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/events", { method: "POST" });

    for (let index = 0; index < 30; index += 1) {
      await expect(protectApiRequest(request)).resolves.toMatchObject({ uid: "operator-1" });
    }

    await expect(protectApiRequest(request)).rejects.toMatchObject({
      status: 429,
      message: "Muitas requisições. Tente novamente em instantes.",
      retryAfterSeconds: 2
    });
  });

  it("uses the stricter admin policy for administrative paths", async () => {
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/users/operator-2/approve", { method: "POST" });

    for (let index = 0; index < 10; index += 1) {
      await protectApiRequest(request);
    }

    await expect(protectApiRequest(request)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 6
    });
  });

  it("refills an auth bucket keyed by HMAC of the caller IP", async () => {
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/auth/sync", { method: "POST", ip: "198.51.100.25" });

    for (let index = 0; index < 10; index += 1) {
      await protectApiRequest(request);
    }

    await expect(protectApiRequest(request)).rejects.toMatchObject({ status: 429 });
    expect([...firebaseBoundary.buckets.keys()].join(" ")).not.toContain("198.51.100.25");
    const storedBucket = [...firebaseBoundary.buckets.values()][0];
    expect(storedBucket).toMatchObject({
      keyVersion: "v1",
      policy: "AUTH"
    });
    expect(
      (storedBucket.expiresAt as { toMillis: () => number }).toMillis()
    ).toBe(Date.parse("2026-07-29T12:00:00.000Z"));

    vi.advanceTimersByTime(6_000);
    await expect(protectApiRequest(request)).resolves.toMatchObject({ uid: "operator-1" });
  });

  it("fails closed with a sanitized 503 when production rate limiting is misconfigured", async () => {
    vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "");
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).rejects.toMatchObject({
      status: 503,
      message: "Proteção da API temporariamente indisponível."
    });
  });

  it("observes a depleted bucket without blocking the request", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/events", { method: "POST" });

    for (let index = 0; index < 31; index += 1) {
      await expect(protectApiRequest(request)).resolves.toMatchObject({ uid: "operator-1" });
    }
    expect(warn).toHaveBeenCalledWith("Rate limit excedido em modo de observação.", {
      policy: "WRITE",
      retryAfterSeconds: 2
    });
    warn.mockRestore();
  });

  it("allows production observe mode without an HMAC secret", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).resolves.toMatchObject({
      uid: "operator-1"
    });
    expect(warn).toHaveBeenCalledWith(
      "Rate limiting não configurado em modo de observação.",
      { policy: "READ" }
    );
    warn.mockRestore();
  });

  it("rejects rate limiting off in production outside emulators", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "off");
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).rejects.toMatchObject({
      status: 503,
      message: "Proteção da API temporariamente indisponível."
    });
  });

  it("does not allow App Check off in production outside emulators", async () => {
    vi.stubEnv("APP_CHECK_MODE", "off");
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(protectApiRequest(makeRequest("/api/events"))).rejects.toMatchObject({
      status: 503,
      message: "Proteção da API temporariamente indisponível."
    });
  });

  it("uses the trusted Google LB hop instead of an attacker-controlled first XFF value", async () => {
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/auth/sync", {
      method: "POST",
      ip: "198.51.100.44"
    });

    await protectApiRequest(request);

    const bucketPaths = [...firebaseBoundary.buckets.keys()].join(" ");
    expect(bucketPaths).not.toContain("attacker-spoofed");
    expect(bucketPaths).not.toContain("198.51.100.44");
  });

  it("ignores spoofable alternative IP headers in Google LB mode", async () => {
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await protectApiRequest(
      makeRequest("/api/auth/sync", {
        method: "POST",
        ip: "198.51.100.45",
        headers: { "x-appengine-user-ip": "203.0.113.250" }
      })
    );
    await protectApiRequest(
      makeRequest("/api/auth/sync", {
        method: "POST",
        ip: "198.51.100.45"
      })
    );

    expect(firebaseBoundary.buckets.size).toBe(1);
  });

  it("uses Vercel's protected forwarding header when configured", async () => {
    vi.stubEnv("TRUSTED_PROXY_MODE", "vercel");
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/auth/sync", {
      method: "POST",
      headers: {
        "x-vercel-forwarded-for": "198.51.100.55"
      }
    });

    await expect(protectApiRequest(request)).resolves.toMatchObject({ uid: "operator-1" });
  });

  it("accepts only a valid local proxy mode outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TRUSTED_PROXY_MODE", "local");
    const { protectApiRequest } = await import("@/lib/server/request-protection");
    const request = makeRequest("/api/auth/sync", {
      method: "POST",
      headers: {
        "x-forwarded-for": "198.51.100.60"
      }
    });

    await expect(protectApiRequest(request)).resolves.toMatchObject({ uid: "operator-1" });
  });

  it("fails closed in production when the trusted proxy mode is absent", async () => {
    vi.stubEnv("TRUSTED_PROXY_MODE", "");
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(
      protectApiRequest(makeRequest("/api/auth/sync", { method: "POST" }))
    ).rejects.toMatchObject({
      status: 503,
      message: "Proteção da API temporariamente indisponível."
    });
  });

  it("fails closed for an invalid trusted proxy mode or malformed trusted header", async () => {
    vi.stubEnv("TRUSTED_PROXY_MODE", "anything");
    const { protectApiRequest } = await import("@/lib/server/request-protection");

    await expect(
      protectApiRequest(makeRequest("/api/auth/sync", { method: "POST" }))
    ).rejects.toMatchObject({ status: 503 });

    vi.stubEnv("TRUSTED_PROXY_MODE", "google-lb");
    await expect(
      protectApiRequest(
        makeRequest("/api/auth/sync", {
          method: "POST",
          headers: { "x-forwarded-for": "attacker-controlled" }
        })
      )
    ).rejects.toMatchObject({ status: 503 });
  });
});
