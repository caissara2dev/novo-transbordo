import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { toSafeExcelText } from "@/lib/domain/checkin-excel";
import type { DriverCheckinForm } from "@/lib/domain/checkins";
import { HttpError } from "@/lib/domain/errors";
import {
  createPowerAutomateEntraTokenProvider,
  type PowerAutomateAccessTokenProvider
} from "@/lib/server/checkins/power-automate-auth";
import { isAllowedPowerAutomateEndpoint } from "@/lib/server/checkins/power-automate-security";
import type {
  CheckinExcelAdapter,
  ExcelCheckinRecord
} from "@/types/checkins";

const CONTRACT_VERSION = "checkin-excel.v1";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CONFIGURABLE_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 60;
const PUBLIC_CODE_PATTERN = /^LT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
const GENERIC_CONFIGURATION_ERROR =
  "Configuração da sincronização oficial inválida.";
const GENERIC_UPSTREAM_ERROR =
  "O registro oficial está temporariamente indisponível.";

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type ExcelCheckinUpdateRecord = {
  publicCode: string;
  idempotencyKey: string;
  requestedAtIso: string;
  patch: Partial<DriverCheckinForm>;
};

export type PowerAutomateCheckinAdapter = CheckinExcelAdapter & {
  updateIdempotently(
    record: ExcelCheckinUpdateRecord
  ): Promise<{ confirmedAtIso: string }>;
};

export type PowerAutomateCheckinAdapterConfig = {
  includeUrl: string;
  updateUrl: string;
  accessTokenProvider?: PowerAutomateAccessTokenProvider;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: FetchImplementation;
};

type PowerAutomateEnvironment = Record<string, string | undefined>;

type CachedTokenProvider = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: FetchImplementation | undefined;
  provider: PowerAutomateAccessTokenProvider;
};

const tokenProvidersByEnvironment = new WeakMap<
  PowerAutomateEnvironment,
  CachedTokenProvider
>();

const confirmationResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        identifier: z.string().regex(PUBLIC_CODE_PATTERN),
        confirmedAtIso: z.string().datetime({ offset: true }),
        result: z.enum([
          "CREATED",
          "ALREADY_EXISTS",
          "UPDATED",
          "UNCHANGED"
        ])
      })
      .strict()
  })
  .strict();

type AdapterOperation = "INCLUDE" | "UPDATE";

function configurationError(): HttpError {
  return new HttpError(500, GENERIC_CONFIGURATION_ERROR);
}

function upstreamError(): HttpError {
  // Never include the endpoint, response body, identifier or driver data here.
  return new HttpError(503, GENERIC_UPSTREAM_ERROR);
}

function requireHttpsUrl(rawValue: string): string {
  try {
    const parsed = new URL(rawValue);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      (parsed.port !== "" && parsed.port !== "443") ||
      !isAllowedPowerAutomateEndpoint(parsed.toString())
    ) {
      throw configurationError();
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw configurationError();
  }
}

function requireBoundedInteger(
  value: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw configurationError();
  }
  return value;
}

function requirePublicCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!PUBLIC_CODE_PATTERN.test(normalized)) throw upstreamError();
  return normalized;
}

function requireUpdateIdempotencyKey(value: string, publicCode: string): string {
  const normalized = value.trim();
  if (!new RegExp(`^${publicCode}:v[1-9]\\d*$`).test(normalized)) {
    throw upstreamError();
  }
  return normalized;
}

function requireIsoTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw upstreamError();
  return value;
}

function safeText(value: string): string {
  return toSafeExcelText(value);
}

function excelPlate(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}-?(?:\d{4}|\d[A-Z]\d{2})$/.test(normalized)) {
    throw upstreamError();
  }
  return normalized.replace("-", "");
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pollIntervalMs(response: Response): number {
  const raw = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(
    MAX_POLL_INTERVAL_MS,
    Math.max(DEFAULT_POLL_INTERVAL_MS, seconds * 1_000)
  );
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function awaitFinalResponse(params: {
  initialResponse: Response;
  fetchImpl: FetchImplementation;
  signal: AbortSignal;
}): Promise<Response> {
  let response = params.initialResponse;
  let pollUrl: string | undefined;
  for (let attempt = 0; response.status === 202; attempt += 1) {
    if (attempt >= MAX_POLL_ATTEMPTS) throw upstreamError();
    const location = response.headers.get("location") ?? pollUrl;
    if (!location) throw upstreamError();
    pollUrl = requireHttpsUrl(location);
    await response.body?.cancel().catch(() => undefined);
    await waitForPoll(pollIntervalMs(response), params.signal);
    response = await params.fetchImpl(pollUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: params.signal
    });
  }
  return response;
}

function inclusionPayload(record: ExcelCheckinRecord) {
  const identifier = requirePublicCode(record.publicCode);
  const startedAtIso = requireIsoTimestamp(record.startedAtIso);
  const form = record.form;

  return {
    schemaVersion: CONTRACT_VERSION,
    operation: "INCLUDE" as const,
    idempotencyKey: safeText(identifier),
    record: {
      identifier: safeText(identifier),
      startedAtIso: safeText(startedAtIso),
      language: safeText("pt-BR"),
      email: safeText(""),
      name: safeText(""),
      driverName: safeText(form.driverName),
      driverLicense: safeText(form.driverLicense),
      driverPhone: safeText(form.driverPhone),
      plate: excelPlate(form.plate),
      carrierName: safeText(form.carrierName),
      vehicleType: safeText(form.vehicleType),
      product: safeText(form.product),
      originPlant: safeText(form.originPlant),
      originInvoiceNumbers: safeText(form.originInvoiceNumbers),
      remittanceInvoiceNumber: safeText(form.remittanceInvoiceNumber),
      whatsappNoticeAccepted: safeText("Ciente"),
      queueLocationAccepted: safeText("Ciente")
    }
  };
}

const updateFieldNames = [
  "driverName",
  "driverLicense",
  "driverPhone",
  "plate",
  "carrierName",
  "vehicleType",
  "product",
  "originPlant",
  "originInvoiceNumbers",
  "remittanceInvoiceNumber",
  "whatsappNoticeAccepted",
  "queueLocationAccepted"
] as const satisfies ReadonlyArray<keyof DriverCheckinForm>;

function updatePayload(record: ExcelCheckinUpdateRecord) {
  const identifier = requirePublicCode(record.publicCode);
  const idempotencyKey = requireUpdateIdempotencyKey(
    record.idempotencyKey,
    identifier
  );
  const requestedAtIso = requireIsoTimestamp(record.requestedAtIso);
  const patchEntries = updateFieldNames.flatMap((field) => {
    const value = record.patch[field];
    if (value === undefined) return [];
    const normalizedValue =
      field === "plate"
        ? excelPlate(String(value))
        : safeText(value === true ? "Ciente" : value);
    return [[field, normalizedValue] as const];
  });
  if (patchEntries.length === 0) throw upstreamError();
  const patch = Object.fromEntries(patchEntries);
  // The Office Script stores this digest, rather than another copy of the
  // corrected personal data, to detect conflicting idempotency-key replays.
  // requestedAtIso intentionally stays outside the digest: a retry reuses the
  // same command key and patch but may start at a later time.
  const payloadHash = sha256Hex({ identifier, patch });

  return {
    schemaVersion: CONTRACT_VERSION,
    operation: "UPDATE" as const,
    idempotencyKey: safeText(idempotencyKey),
    identifier: safeText(identifier),
    requestedAtIso: safeText(requestedAtIso),
    payloadHash,
    patch
  };
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)
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
      if (totalBytes > maximumBytes) throw upstreamError();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
    }
  }
}

function responseAllowsResult(
  operation: AdapterOperation,
  result: z.infer<typeof confirmationResponseSchema>["data"]["result"]
): boolean {
  return operation === "INCLUDE"
    ? result === "CREATED" || result === "ALREADY_EXISTS"
    : result === "UPDATED" || result === "UNCHANGED";
}

async function sendCommand(input: {
  endpoint: string;
  operation: AdapterOperation;
  identifier: string;
  idempotencyKey: string;
  payload: unknown;
  accessTokenProvider?: PowerAutomateAccessTokenProvider;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl: FetchImplementation;
}): Promise<{ confirmedAtIso: string }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "x-idempotency-key": input.idempotencyKey
    };
    const bearerToken = await input.accessTokenProvider?.getAccessToken();
    if (!bearerToken) throw configurationError();
    headers.authorization = `Bearer ${bearerToken}`;

    // Token acquisition has its own 5-second budget. Start the independent
    // Power Automate request budget only after a usable token exists.
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), input.timeoutMs);

    let response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(input.payload),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      // Do not repeat the idempotent command automatically. Clearing the
      // rejected token makes the caller's explicit retry acquire a new one.
      input.accessTokenProvider?.invalidateAccessToken();
    }
    response = await awaitFinalResponse({
      initialResponse: response,
      fetchImpl: input.fetchImpl,
      signal: controller.signal
    });
    if (response.status !== 200) throw upstreamError();
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw upstreamError();
    }

    const rawBody = await readBoundedBody(response, input.maxResponseBytes);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      throw upstreamError();
    }
    const parsed = confirmationResponseSchema.safeParse(parsedBody);
    if (
      !parsed.success ||
      parsed.data.data.identifier !== input.identifier ||
      !responseAllowsResult(input.operation, parsed.data.data.result)
    ) {
      throw upstreamError();
    }
    return { confirmedAtIso: parsed.data.data.confirmedAtIso };
  } catch {
    throw upstreamError();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createPowerAutomateCheckinAdapter(
  config: PowerAutomateCheckinAdapterConfig
): PowerAutomateCheckinAdapter {
  const includeUrl = requireHttpsUrl(config.includeUrl);
  const updateUrl = requireHttpsUrl(config.updateUrl);
  const timeoutMs = requireBoundedInteger(
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  const maxResponseBytes = requireBoundedInteger(
    config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    MAX_CONFIGURABLE_RESPONSE_BYTES
  );
  const fetchImpl = config.fetchImpl ?? fetch;
  const accessTokenProvider = config.accessTokenProvider;
  if (!accessTokenProvider) throw configurationError();

  return {
    async includeIdempotently(record) {
      const payload = inclusionPayload(record);
      return sendCommand({
        endpoint: includeUrl,
        operation: "INCLUDE",
        identifier: payload.idempotencyKey,
        idempotencyKey: payload.idempotencyKey,
        payload,
        accessTokenProvider,
        timeoutMs,
        maxResponseBytes,
        fetchImpl
      });
    },
    async updateIdempotently(record) {
      const payload = updatePayload(record);
      return sendCommand({
        endpoint: updateUrl,
        operation: "UPDATE",
        identifier: payload.identifier,
        idempotencyKey: payload.idempotencyKey,
        payload,
        accessTokenProvider,
        timeoutMs,
        maxResponseBytes,
        fetchImpl
      });
    }
  };
}

export function createPowerAutomateCheckinAdapterFromEnv(
  environment: PowerAutomateEnvironment = process.env,
  dependencies: { fetchImpl?: FetchImplementation } = {}
): PowerAutomateCheckinAdapter {
  const authMode = environment.CHECKIN_POWER_AUTOMATE_AUTH_MODE?.trim();
  if (authMode !== "entra-client-credentials") throw configurationError();
  const tenantId = environment.CHECKIN_POWER_AUTOMATE_TENANT_ID ?? "";
  const clientId = environment.CHECKIN_POWER_AUTOMATE_CLIENT_ID ?? "";
  const clientSecret = environment.CHECKIN_POWER_AUTOMATE_CLIENT_SECRET ?? "";
  const cached = tokenProvidersByEnvironment.get(environment);
  const accessTokenProvider =
    cached?.tenantId === tenantId &&
    cached.clientId === clientId &&
    cached.clientSecret === clientSecret &&
    cached.fetchImpl === dependencies.fetchImpl
      ? cached.provider
      : createPowerAutomateEntraTokenProvider({
          tenantId,
          clientId,
          clientSecret,
          timeoutMs: DEFAULT_TOKEN_TIMEOUT_MS,
          fetchImpl: dependencies.fetchImpl
        });
  if (accessTokenProvider !== cached?.provider) {
    // The WeakMap never exposes credentials and lets obsolete environment
    // objects be collected. A secret rotation rebuilds the provider.
    tokenProvidersByEnvironment.set(environment, {
      tenantId,
      clientId,
      clientSecret,
      fetchImpl: dependencies.fetchImpl,
      provider: accessTokenProvider
    });
  }

  return createPowerAutomateCheckinAdapter({
    includeUrl: environment.CHECKIN_POWER_AUTOMATE_ADD_URL ?? "",
    updateUrl: environment.CHECKIN_POWER_AUTOMATE_UPDATE_URL ?? "",
    accessTokenProvider,
    fetchImpl: dependencies.fetchImpl
  });
}
