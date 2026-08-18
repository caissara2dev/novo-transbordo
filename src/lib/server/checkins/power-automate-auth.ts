import "server-only";

import { z } from "zod";
import { HttpError } from "@/lib/domain/errors";
import {
  isPowerAutomateUuid,
  POWER_AUTOMATE_CLIENT_SECRET_MIN_LENGTH
} from "@/lib/server/checkins/power-automate-security";
import {
  reportPowerAutomateDiagnostic,
  type PowerAutomateDiagnosticReporter,
  type PowerAutomateOAuthError
} from "@/lib/server/checkins/power-automate-diagnostics";

const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com";
const POWER_AUTOMATE_SCOPE =
  "https://service.flow.microsoft.com//.default";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const GENERIC_CONFIGURATION_ERROR =
  "Configuração da autenticação oficial inválida.";
const GENERIC_UPSTREAM_ERROR =
  "A autenticação da sincronização oficial está temporariamente indisponível.";

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type PowerAutomateAccessTokenProvider = {
  getAccessToken(): Promise<string>;
  invalidateAccessToken(): void;
};

export type PowerAutomateEntraTokenProviderConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchImplementation;
  now?: () => number;
  timeoutMs?: number;
  diagnostics?: PowerAutomateDiagnosticReporter;
};

const tokenResponseSchema = z
  .object({
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().positive().max(86_400),
    ext_expires_in: z.number().int().positive().max(86_400).optional(),
    access_token: z.string().min(20).max(16 * 1024)
  })
  .strict();

const oauthErrorResponseSchema = z
  .object({
    error: z.enum([
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
      "temporarily_unavailable",
      "server_error"
    ])
  })
  .passthrough();

function configurationError(): HttpError {
  return new HttpError(500, GENERIC_CONFIGURATION_ERROR);
}

function upstreamError(): HttpError {
  // Keep credentials, Microsoft responses and endpoint details server-side.
  return new HttpError(503, GENERIC_UPSTREAM_ERROR);
}

function requireUuid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isPowerAutomateUuid(normalized)) throw configurationError();
  return normalized;
}

function requireSecret(value: string): string {
  if (
    value !== value.trim() ||
    value.length < POWER_AUTOMATE_CLIENT_SECRET_MIN_LENGTH
  ) {
    throw configurationError();
  }
  return value;
}

function requireTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw configurationError();
  }
  return value;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw upstreamError();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) throw upstreamError();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
    }
  }
}

async function readOAuthError(
  response: Response
): Promise<PowerAutomateOAuthError | undefined> {
  try {
    const rawBody = await readBoundedBody(response);
    const parsedBody: unknown = JSON.parse(rawBody);
    const parsed = oauthErrorResponseSchema.safeParse(parsedBody);
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

export function createPowerAutomateEntraTokenProvider(
  config: PowerAutomateEntraTokenProviderConfig
): PowerAutomateAccessTokenProvider {
  const tenantId = requireUuid(config.tenantId);
  const clientId = requireUuid(config.clientId);
  const clientSecret = requireSecret(config.clientSecret);
  const timeoutMs = requireTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const tokenEndpoint =
    `${MICROSOFT_LOGIN_ORIGIN}/${tenantId}/oauth2/v2.0/token`;
  let cachedToken: { accessToken: string; usableUntilMs: number } | undefined;
  let cacheGeneration = 0;
  let inFlightAcquisition:
    | { generation: number; promise: Promise<string> }
    | undefined;

  async function requestToken(generation: number): Promise<string> {
    let failureReason:
      | "network"
      | "timeout"
      | "status"
      | "content_type"
      | "body"
      | "schema" = "network";
    let failureStatus: number | undefined;
    let failureOAuthError: PowerAutomateOAuthError | undefined;
    const body = new URLSearchParams([
      ["grant_type", "client_credentials"],
      ["client_id", clientId],
      ["client_secret", clientSecret],
      ["scope", POWER_AUTOMATE_SCOPE]
    ]);

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        failureReason = "timeout";
        controller.abort();
        reject(upstreamError());
      }, timeoutMs);
    });
    const acquisition = (async () => {
      const response = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: body.toString(),
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal
      });
      if (response.status !== 200) {
        failureReason = "status";
        failureStatus = response.status;
        failureOAuthError = await readOAuthError(response);
        throw upstreamError();
      }
      failureReason = "content_type";
      const contentType = response.headers.get("content-type") ?? "";
      if (
        contentType.split(";", 1)[0].trim().toLowerCase() !==
        "application/json"
      ) {
        throw upstreamError();
      }

      failureReason = "body";
      const rawBody = await readBoundedBody(response);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        throw upstreamError();
      }
      failureReason = "schema";
      const parsed = tokenResponseSchema.safeParse(parsedBody);
      if (!parsed.success) throw upstreamError();
      return parsed.data;
    })();

    try {
      const token = await Promise.race([acquisition, timeoutFailure]);

      const lifetimeMs = token.expires_in * 1000;
      const safetyMarginMs = Math.min(60_000, Math.floor(lifetimeMs / 2));
      if (generation === cacheGeneration) {
        cachedToken = {
          accessToken: token.access_token,
          usableUntilMs: now() + lifetimeMs - safetyMarginMs
        };
      }
      return token.access_token;
    } catch {
      reportPowerAutomateDiagnostic(config.diagnostics, {
        event: "power_automate_failure",
        component: "token",
        reason: failureReason,
        ...(failureStatus === undefined ? {} : { status: failureStatus }),
        ...(failureOAuthError === undefined
          ? {}
          : { oauthError: failureOAuthError })
      });
      throw upstreamError();
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  return {
    getAccessToken() {
      if (cachedToken && now() < cachedToken.usableUntilMs) {
        return Promise.resolve(cachedToken.accessToken);
      }
      if (inFlightAcquisition?.generation === cacheGeneration) {
        return inFlightAcquisition.promise;
      }

      const generation = cacheGeneration;
      const acquisition = requestToken(generation);
      const trackedAcquisition = acquisition.finally(() => {
        if (inFlightAcquisition?.generation === generation) {
          inFlightAcquisition = undefined;
        }
      });
      inFlightAcquisition = { generation, promise: trackedAcquisition };
      return trackedAcquisition;
    },
    invalidateAccessToken() {
      cacheGeneration += 1;
      cachedToken = undefined;
    }
  };
}
