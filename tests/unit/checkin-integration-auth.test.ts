import { describe, expect, it } from "vitest";
import {
  createCheckinIntegrationSignature,
  parseCheckinIntegrationMode,
  verifyCheckinIntegrationSignature
} from "@/lib/server/checkins/integration-auth";

const request = {
  method: "POST",
  pathname: "/api/integrations/checkins/v1/pre-registrations",
  timestamp: "2026-08-10T12:00:00.000Z",
  requestId: "550e8400-e29b-41d4-a716-446655440000",
  rawBody: '{"plate":"ABC1234"}'
};
const keyMaterial = "0123456789abcdef0123456789abcdef";

describe("check-in integration authentication", () => {
  it("creates the documented HMAC-SHA256 signature", () => {
    expect(createCheckinIntegrationSignature({ ...request, secret: keyMaterial })).toBe(
      "2e3eda0b145683216e16cd33bf08628f5c26495fa41e63d92cac64c755aeccf3"
    );
  });

  it("accepts a current valid signature and rejects tampering", () => {
    const signature = createCheckinIntegrationSignature({ ...request, secret: keyMaterial });
    const nowMs = Date.parse("2026-08-10T12:03:00.000Z");

    expect(
      verifyCheckinIntegrationSignature({
        ...request,
        secret: keyMaterial,
        signature,
        nowMs
      })
    ).toBeUndefined();
    expect(() =>
      verifyCheckinIntegrationSignature({
        ...request,
        rawBody: '{"plate":"ZZZ9999"}',
        secret: keyMaterial,
        signature,
        nowMs
      })
    ).toThrow(/assinatura/i);
  });

  it("rejects expired requests, malformed IDs and weak secrets", () => {
    const signature = createCheckinIntegrationSignature({ ...request, secret: keyMaterial });

    expect(() =>
      verifyCheckinIntegrationSignature({
        ...request,
        secret: keyMaterial,
        signature,
        nowMs: Date.parse("2026-08-10T12:05:00.001Z")
      })
    ).toThrow(/expirou|relógio/i);
    expect(() =>
      createCheckinIntegrationSignature({
        ...request,
        requestId: "not-a-uuid",
        secret: keyMaterial
      })
    ).toThrow(/request id/i);
    expect(() =>
      createCheckinIntegrationSignature({ ...request, secret: "short" })
    ).toThrow(/segredo/i);
  });
});

describe("check-in integration mode", () => {
  it("fails closed for absent or invalid values", () => {
    expect(parseCheckinIntegrationMode(undefined)).toBe("off");
    expect(parseCheckinIntegrationMode("invalid")).toBe("off");
  });

  it.each(["off", "observe", "enforce"] as const)("accepts %s", (mode) => {
    expect(parseCheckinIntegrationMode(mode)).toBe(mode);
  });
});
