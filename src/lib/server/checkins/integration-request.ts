import { HttpError } from "@/lib/domain/errors";
import {
  type CheckinIntegrationMode,
  verifyCheckinIntegrationSignature
} from "@/lib/server/checkins/integration-auth";

const MAX_BODY_BYTES = 32 * 1_024;

export type CheckinIntegrationRequestConfig = {
  mode: CheckinIntegrationMode;
  activeKeyId: string;
  secret: string;
  nowMs?: number;
};

async function readBoundedBody(request: Request): Promise<string> {
  const advertisedLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Corpo da requisição excede 32 KiB.", {
      code: "PAYLOAD_TOO_LARGE"
    });
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) break;

    totalBytes += result.value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Corpo da requisição excede 32 KiB.", {
        code: "PAYLOAD_TOO_LARGE"
      });
    }
    chunks.push(result.value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function parseAndVerifyCheckinIntegrationRequest(
  request: Request,
  config: CheckinIntegrationRequestConfig
): Promise<{ rawBody: string; requestId: string; keyId: string }> {
  if (config.mode === "off") {
    throw new HttpError(503, "Integração de check-in indisponível.", {
      code: "INTEGRATION_DISABLED"
    });
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Use Content-Type application/json.", {
      code: "UNSUPPORTED_MEDIA_TYPE"
    });
  }

  const keyId = request.headers.get("x-checkin-key-id") || "";
  const timestamp = request.headers.get("x-checkin-timestamp") || "";
  const requestId = request.headers.get("x-checkin-request-id") || "";
  const signature = request.headers.get("x-checkin-signature") || "";
  if (!keyId || keyId !== config.activeKeyId) {
    throw new HttpError(401, "Credencial da integração é inválida.");
  }

  const rawBody = await readBoundedBody(request);
  verifyCheckinIntegrationSignature({
    method: request.method,
    pathname: new URL(request.url).pathname,
    timestamp,
    requestId,
    rawBody,
    secret: config.secret,
    signature,
    nowMs: config.nowMs
  });

  return { rawBody, requestId, keyId };
}
