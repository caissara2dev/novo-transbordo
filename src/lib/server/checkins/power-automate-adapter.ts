import "server-only";

import { z } from "zod";
import { toSafeExcelText } from "@/lib/domain/checkin-excel";
import type { DriverCheckinForm } from "@/lib/domain/checkins";
import { HttpError } from "@/lib/domain/errors";
import type {
  CheckinExcelAdapter,
  ExcelCheckinRecord
} from "@/types/checkins";

const CONTRACT_VERSION = "checkin-excel.v1";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CONFIGURABLE_RESPONSE_BYTES = 64 * 1024;
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
  bearerToken?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: FetchImplementation;
};

type PowerAutomateEnvironment = Record<string, string | undefined>;

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
      parsed.password
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
      plate: safeText(form.plate),
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
    return [[field, safeText(value === true ? "Ciente" : value)] as const];
  });
  if (patchEntries.length === 0) throw upstreamError();

  return {
    schemaVersion: CONTRACT_VERSION,
    operation: "UPDATE" as const,
    idempotencyKey: safeText(idempotencyKey),
    identifier: safeText(identifier),
    requestedAtIso: safeText(requestedAtIso),
    patch: Object.fromEntries(patchEntries)
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
  bearerToken?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl: FetchImplementation;
}): Promise<{ confirmedAtIso: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "x-idempotency-key": input.idempotencyKey
    };
    if (input.bearerToken) {
      headers.authorization = `Bearer ${input.bearerToken}`;
    }

    const response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(input.payload),
      cache: "no-store",
      redirect: "manual",
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
    clearTimeout(timeout);
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
  const bearerToken = config.bearerToken?.trim() || undefined;

  return {
    async includeIdempotently(record) {
      const payload = inclusionPayload(record);
      return sendCommand({
        endpoint: includeUrl,
        operation: "INCLUDE",
        identifier: payload.idempotencyKey,
        idempotencyKey: payload.idempotencyKey,
        payload,
        bearerToken,
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
        bearerToken,
        timeoutMs,
        maxResponseBytes,
        fetchImpl
      });
    }
  };
}

export function createPowerAutomateCheckinAdapterFromEnv(
  environment: PowerAutomateEnvironment = process.env
): PowerAutomateCheckinAdapter {
  return createPowerAutomateCheckinAdapter({
    includeUrl: environment.CHECKIN_POWER_AUTOMATE_ADD_URL ?? "",
    updateUrl: environment.CHECKIN_POWER_AUTOMATE_UPDATE_URL ?? "",
    bearerToken: environment.CHECKIN_POWER_AUTOMATE_BEARER_TOKEN
  });
}
