import { describe, expect, it } from "vitest";
import {
  parseAndVerifyCheckinIntegrationRequest,
  type CheckinIntegrationRequestConfig
} from "@/lib/server/checkins/integration-request";
import { createCheckinIntegrationSignature } from "@/lib/server/checkins/integration-auth";

const keyMaterial = "0123456789abcdef0123456789abcdef";
const config: CheckinIntegrationRequestConfig = {
  mode: "observe",
  activeKeyId: "checkin-v1",
  secret: keyMaterial,
  nowMs: Date.parse("2026-08-10T12:00:30.000Z")
};

function signedRequest(rawBody: string, overrides: Record<string, string> = {}) {
  const pathname = "/api/integrations/checkins/v1/pre-registrations";
  const timestamp = "2026-08-10T12:00:00.000Z";
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const signature = createCheckinIntegrationSignature({
    method: "POST",
    pathname,
    timestamp,
    requestId,
    rawBody,
    secret: keyMaterial
  });

  return new Request(`https://linebot.com.br${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(rawBody)),
      "x-checkin-key-id": "checkin-v1",
      "x-checkin-timestamp": timestamp,
      "x-checkin-request-id": requestId,
      "x-checkin-signature": signature,
      ...overrides
    },
    body: rawBody
  });
}

describe("check-in integration request protection", () => {
  it("returns the bounded verified raw body and request metadata", async () => {
    const rawBody = '{"source":"CARRIER"}';

    await expect(
      parseAndVerifyCheckinIntegrationRequest(signedRequest(rawBody), config)
    ).resolves.toEqual({
      rawBody,
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      keyId: "checkin-v1"
    });
  });

  it("fails closed when the integration is off", async () => {
    await expect(
      parseAndVerifyCheckinIntegrationRequest(signedRequest("{}"), {
        ...config,
        mode: "off"
      })
    ).rejects.toMatchObject({ status: 503, code: "INTEGRATION_DISABLED" });
  });

  it("rejects unsupported content, unknown keys and bodies over 32 KiB", async () => {
    await expect(
      parseAndVerifyCheckinIntegrationRequest(
        signedRequest("{}", { "content-type": "text/plain" }),
        config
      )
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      parseAndVerifyCheckinIntegrationRequest(
        signedRequest("{}", { "x-checkin-key-id": "unknown" }),
        config
      )
    ).rejects.toMatchObject({ status: 401 });

    const tooLarge = JSON.stringify({ value: "x".repeat(32 * 1_024) });
    await expect(
      parseAndVerifyCheckinIntegrationRequest(signedRequest(tooLarge), config)
    ).rejects.toMatchObject({ status: 413 });
  });
});
