import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "@/lib/domain/errors";

export type CheckinIntegrationMode = "off" | "observe" | "enforce";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SignatureInput = {
  method: string;
  pathname: string;
  timestamp: string;
  requestId: string;
  rawBody: string;
  secret: string;
};

function assertSignatureInput(input: SignatureInput): void {
  if (input.secret.length < 32) {
    throw new HttpError(500, "Segredo da integração de check-in é inválido.");
  }
  if (!UUID_PATTERN.test(input.requestId)) {
    throw new HttpError(400, "Request ID da integração é inválido.");
  }
  if (!Number.isFinite(Date.parse(input.timestamp))) {
    throw new HttpError(400, "Horário da integração é inválido.");
  }
  if (!input.pathname.startsWith("/api/integrations/checkins/v1/")) {
    throw new HttpError(400, "Caminho da integração é inválido.");
  }
}

function canonicalRequest(input: SignatureInput): string {
  const bodyHash = createHash("sha256").update(input.rawBody, "utf8").digest("hex");

  return [
    input.method.toUpperCase(),
    input.pathname,
    input.timestamp,
    input.requestId,
    bodyHash
  ].join("\n");
}

export function createCheckinIntegrationSignature(input: SignatureInput): string {
  assertSignatureInput(input);

  return createHmac("sha256", input.secret)
    .update(canonicalRequest(input), "utf8")
    .digest("hex");
}

export function verifyCheckinIntegrationSignature(
  input: SignatureInput & { signature: string; nowMs?: number }
): void {
  const requestTime = Date.parse(input.timestamp);
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - requestTime) > MAX_CLOCK_SKEW_MS) {
    throw new HttpError(401, "A requisição expirou ou o relógio está divergente.");
  }

  const expected = createCheckinIntegrationSignature(input);
  const received = input.signature.toLowerCase();
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");

  if (
    received.length !== 64 ||
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new HttpError(401, "Assinatura da integração é inválida.");
  }
}

export function parseCheckinIntegrationMode(
  raw: string | undefined
): CheckinIntegrationMode {
  return raw === "observe" || raw === "enforce" || raw === "off" ? raw : "off";
}
