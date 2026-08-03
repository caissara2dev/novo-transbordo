import type { DecodedIdToken } from "firebase-admin/auth";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/domain/errors";
import { adminAuth, getAdminAppCheck } from "@/lib/firebase/admin";
import {
  consumeRateLimit
} from "@/lib/server/rate-limit-store";
import type { RateLimitPolicy } from "@/lib/server/rate-limit-store";

type ProtectionMode = "off" | "observe" | "enforce";
type TrustedProxyMode = "google-lb" | "vercel" | "local";

const POLICIES = {
  AUTH: { name: "AUTH", requestsPerMinute: 10 },
  READ: { name: "READ", requestsPerMinute: 120 },
  WRITE: { name: "WRITE", requestsPerMinute: 30 },
  ADMIN: { name: "ADMIN", requestsPerMinute: 10 }
} as const satisfies Record<string, RateLimitPolicy>;

const PROTECTION_UNAVAILABLE = "Proteção da API temporariamente indisponível.";

class RequestProtectionError extends HttpError {
  retryAfterSeconds?: number;

  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(status, message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isEmulatorEnvironment(): boolean {
  return Boolean(
    process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true"
  );
}

function protectionMode(variable: "APP_CHECK_MODE" | "RATE_LIMIT_MODE"): ProtectionMode {
  const configured = process.env[variable]?.trim().toLowerCase();

  if (configured === "off" || configured === "observe" || configured === "enforce") {
    return configured;
  }

  if (configured) {
    throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
  }

  return process.env.NODE_ENV === "production" ? "observe" : "off";
}

function allowedAppIds(): ReadonlySet<string> {
  return new Set(
    (process.env.APP_CHECK_ALLOWED_APP_IDS ?? "")
      .split(",")
      .map((appId) => appId.trim())
      .filter(Boolean)
  );
}

function isAdminPath(pathname: string): boolean {
  return (
    pathname === "/api/users" ||
    pathname.startsWith("/api/users/") ||
    pathname === "/api/settings" ||
    pathname.startsWith("/api/settings/") ||
    /^\/api\/events\/[^/]+\/restore$/.test(pathname)
  );
}

function selectPolicy(req: NextRequest): RateLimitPolicy {
  const pathname = req.nextUrl.pathname;

  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
    return POLICIES.AUTH;
  }

  if (isAdminPath(pathname)) {
    return POLICIES.ADMIN;
  }

  return req.method === "GET" || req.method === "HEAD"
    ? POLICIES.READ
    : POLICIES.WRITE;
}

function trustedProxyMode(): TrustedProxyMode {
  const configured = process.env.TRUSTED_PROXY_MODE?.trim().toLowerCase();

  if (configured === "google-lb" || configured === "vercel" || configured === "local") {
    if (
      configured === "local" &&
      process.env.NODE_ENV === "production" &&
      !isEmulatorEnvironment()
    ) {
      throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
    }

    return configured;
  }

  if (!configured && process.env.NODE_ENV !== "production") {
    return "local";
  }

  throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
}

function validIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : undefined;
}

function forwardedIps(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function callerIp(req: NextRequest, mode: TrustedProxyMode): string {
  if (mode === "google-lb") {
    const hops = forwardedIps(req.headers.get("x-forwarded-for"));
    const clientHop = validIp(hops.at(-2));
    if (clientHop) {
      return clientHop;
    }
  }

  if (mode === "vercel") {
    const hops = forwardedIps(req.headers.get("x-vercel-forwarded-for"));
    const clientHop = validIp(hops.at(-1));
    if (clientHop) {
      return clientHop;
    }
  }

  if (mode === "local") {
    const hops = forwardedIps(req.headers.get("x-forwarded-for"));
    return (
      validIp(hops.at(-1)) ||
      validIp(req.headers.get("x-real-ip") ?? undefined) ||
      "127.0.0.1"
    );
  }

  throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
}

async function verifyAppCheck(req: NextRequest): Promise<void> {
  const mode = protectionMode("APP_CHECK_MODE");
  const pathname = req.nextUrl.pathname;

  if (mode === "off") {
    if (process.env.NODE_ENV === "production" && !isEmulatorEnvironment()) {
      throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
    }
    return;
  }

  const token = req.headers.get("x-firebase-appcheck")?.trim();

  if (!token) {
    if (mode === "enforce") {
      throw new RequestProtectionError(401, "Verificação da aplicação necessária.");
    }
    console.warn("App Check ausente em modo de observação.", { pathname });
    return;
  }

  let appId: string | undefined;
  try {
    const adminAppCheck = await getAdminAppCheck();
    appId = (await adminAppCheck.verifyToken(token)).appId;
  } catch {
    if (mode === "enforce") {
      throw new RequestProtectionError(401, "Verificação da aplicação inválida.");
    }
    console.warn("App Check inválido em modo de observação.", { pathname });
    return;
  }

  const appIds = allowedAppIds();
  if (!appIds.size) {
    if (mode === "enforce") {
      throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
    }
    console.warn("Allowlist de App Check não configurada em modo de observação.", {
      pathname
    });
    return;
  }

  if (!appId || !appIds.has(appId)) {
    if (mode === "enforce") {
      throw new RequestProtectionError(401, "Verificação da aplicação inválida.");
    }
    console.warn("App Check de aplicação não permitida em modo de observação.", {
      pathname
    });
  }
}

async function verifyAuthentication(req: NextRequest): Promise<DecodedIdToken> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    throw new RequestProtectionError(401, "Token de autenticação ausente.");
  }

  try {
    return await adminAuth.verifyIdToken(token);
  } catch {
    throw new RequestProtectionError(401, "Token de autenticação inválido.");
  }
}

function rateLimitConfiguration(
  mode: ProtectionMode,
  policy: RateLimitPolicy
): { keyVersion: string; secret: string } | undefined {
  const secret = process.env.RATE_LIMIT_HMAC_SECRET?.trim();
  const keyVersion = process.env.RATE_LIMIT_KEY_VERSION?.trim() || "v1";
  const validKeyVersion = /^[a-zA-Z0-9._-]{1,32}$/.test(keyVersion);

  if (!secret || secret.length < 32 || !validKeyVersion) {
    if (mode === "observe") {
      console.warn("Rate limiting não configurado em modo de observação.", {
        policy: policy.name
      });
      return undefined;
    }
    throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
  }

  return { keyVersion, secret };
}

async function enforceRateLimit(
  policy: RateLimitPolicy,
  identity: string
): Promise<void> {
  const mode = protectionMode("RATE_LIMIT_MODE");

  if (mode === "off") {
    if (process.env.NODE_ENV === "production" && !isEmulatorEnvironment()) {
      throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
    }
    return;
  }

  const configuration = rateLimitConfiguration(mode, policy);
  if (!configuration) {
    return;
  }

  let result;
  try {
    result = await consumeRateLimit({
      identity,
      keyVersion: configuration.keyVersion,
      policy,
      secret: configuration.secret
    });
  } catch {
    if (mode === "observe") {
      console.warn("Rate limiting indisponível em modo de observação.", {
        policy: policy.name
      });
      return;
    }

    throw new RequestProtectionError(503, PROTECTION_UNAVAILABLE);
  }

  if (result.allowed) {
    return;
  }

  if (mode === "observe") {
    console.warn("Rate limit excedido em modo de observação.", {
      policy: policy.name,
      retryAfterSeconds: result.retryAfterSeconds
    });
    return;
  }

  throw new RequestProtectionError(
    429,
    "Muitas requisições. Tente novamente em instantes.",
    result.retryAfterSeconds
  );
}

async function enforceIpRateLimit(
  req: NextRequest,
  policy: RateLimitPolicy
): Promise<void> {
  const mode = protectionMode("RATE_LIMIT_MODE");

  if (mode === "off") {
    await enforceRateLimit(policy, "");
    return;
  }

  let identity: string;
  try {
    identity = callerIp(req, trustedProxyMode());
  } catch (error) {
    if (mode !== "observe") {
      throw error;
    }

    console.warn("Proxy confiável não configurado em modo de observação.", {
      policy: policy.name
    });
    return;
  }

  await enforceRateLimit(policy, identity);
}

export async function protectApiRequest(req: NextRequest): Promise<DecodedIdToken> {
  await verifyAppCheck(req);
  const policy = selectPolicy(req);

  await enforceIpRateLimit(req, policy);

  const decoded = await verifyAuthentication(req);

  if (policy.name !== "AUTH") {
    await enforceRateLimit(policy, decoded.uid);
  }

  return decoded;
}
