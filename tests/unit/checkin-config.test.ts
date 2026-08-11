import { describe, expect, it } from "vitest";
import { resolveCheckinRuntimeConfig } from "@/lib/server/checkins/config";

describe("check-in runtime configuration", () => {
  it("stays off without requiring credentials", () => {
    expect(resolveCheckinRuntimeConfig({})).toEqual({ mode: "off" });
  });

  it("fails closed when an enabled integration is incomplete", () => {
    expect(() =>
      resolveCheckinRuntimeConfig({ CHECKIN_INTEGRATION_MODE: "observe" })
    ).toThrow(/configuração|segredo|coordenada/i);
  });

  it("returns private integration and geofence settings", () => {
    expect(
      resolveCheckinRuntimeConfig({
        CHECKIN_INTEGRATION_MODE: "enforce",
        CHECKIN_INTEGRATION_KEY_ID: "checkin-v1",
        CHECKIN_INTEGRATION_HMAC_SECRET: "a".repeat(32),
        CHECKIN_INDEX_HMAC_SECRET: "b".repeat(32),
        CHECKIN_GEOFENCE_CENTER_LAT: "-23.9608",
        CHECKIN_GEOFENCE_CENTER_LNG: "-46.3336",
        CHECKIN_GEOFENCE_RADIUS_METERS: "20000",
        CHECKIN_POWER_AUTOMATE_ADD_URL:
          "https://include.environment.api.powerplatform.com/checkins/add",
        CHECKIN_POWER_AUTOMATE_UPDATE_URL:
          "https://update.environment.api.powerplatform.com/checkins/update",
        CHECKIN_POWER_AUTOMATE_AUTH_MODE: "entra-client-credentials",
        CHECKIN_POWER_AUTOMATE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        CHECKIN_POWER_AUTOMATE_CLIENT_ID:
          "22222222-2222-4222-8222-222222222222",
        CHECKIN_POWER_AUTOMATE_CLIENT_SECRET: "c".repeat(32),
        CHECKIN_ENFORCE_ROLLOUT_APPROVED: "true"
      })
    ).toEqual({
      mode: "enforce",
      activeKeyId: "checkin-v1",
      integrationSecret: "a".repeat(32),
      indexSecret: "b".repeat(32),
      allowedArea: {
        latitude: -23.9608,
        longitude: -46.3336,
        radiusMeters: 20_000
      }
    });
  });

  it("refuses enforce until Excel endpoints and rollout approval are present", () => {
    const base = {
      CHECKIN_INTEGRATION_MODE: "enforce",
      CHECKIN_INTEGRATION_KEY_ID: "checkin-v1",
      CHECKIN_INTEGRATION_HMAC_SECRET: "a".repeat(32),
      CHECKIN_INDEX_HMAC_SECRET: "b".repeat(32),
      CHECKIN_GEOFENCE_CENTER_LAT: "-23.9608",
      CHECKIN_GEOFENCE_CENTER_LNG: "-46.3336"
    };

    expect(() => resolveCheckinRuntimeConfig(base)).toThrow(/configuração/i);
    expect(() =>
      resolveCheckinRuntimeConfig({
        ...base,
        CHECKIN_POWER_AUTOMATE_ADD_URL: "http://example.test/add",
        CHECKIN_POWER_AUTOMATE_UPDATE_URL:
          "https://update.environment.api.powerplatform.com/update",
        CHECKIN_POWER_AUTOMATE_AUTH_MODE: "entra-client-credentials",
        CHECKIN_POWER_AUTOMATE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        CHECKIN_POWER_AUTOMATE_CLIENT_ID:
          "22222222-2222-4222-8222-222222222222",
        CHECKIN_POWER_AUTOMATE_CLIENT_SECRET: "c".repeat(32),
        CHECKIN_ENFORCE_ROLLOUT_APPROVED: "true"
      })
    ).toThrow(/configuração/i);
    expect(() =>
      resolveCheckinRuntimeConfig({
        ...base,
        CHECKIN_POWER_AUTOMATE_ADD_URL:
          "https://include.environment.api.powerplatform.com/add",
        CHECKIN_POWER_AUTOMATE_UPDATE_URL:
          "https://update.environment.api.powerplatform.com/update",
        CHECKIN_POWER_AUTOMATE_AUTH_MODE: "entra-client-credentials",
        CHECKIN_POWER_AUTOMATE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        CHECKIN_POWER_AUTOMATE_CLIENT_ID:
          "22222222-2222-4222-8222-222222222222",
        CHECKIN_POWER_AUTOMATE_CLIENT_SECRET: "c".repeat(32)
      })
    ).toThrow(/configuração/i);
    expect(() =>
      resolveCheckinRuntimeConfig({
        ...base,
        CHECKIN_POWER_AUTOMATE_ADD_URL: "https://example.test/add",
        CHECKIN_POWER_AUTOMATE_UPDATE_URL: "https://example.test/update",
        CHECKIN_POWER_AUTOMATE_AUTH_MODE: "entra-client-credentials",
        CHECKIN_POWER_AUTOMATE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        CHECKIN_POWER_AUTOMATE_CLIENT_ID:
          "22222222-2222-4222-8222-222222222222",
        CHECKIN_POWER_AUTOMATE_CLIENT_SECRET: "c".repeat(32),
        CHECKIN_ENFORCE_ROLLOUT_APPROVED: "true"
      })
    ).toThrow(/configuração/i);
  });

  it("refuses enforce when Entra authentication is incomplete", () => {
    expect(() =>
      resolveCheckinRuntimeConfig({
        CHECKIN_INTEGRATION_MODE: "enforce",
        CHECKIN_INTEGRATION_KEY_ID: "checkin-v1",
        CHECKIN_INTEGRATION_HMAC_SECRET: "a".repeat(32),
        CHECKIN_INDEX_HMAC_SECRET: "b".repeat(32),
        CHECKIN_GEOFENCE_CENTER_LAT: "-23.927722",
        CHECKIN_GEOFENCE_CENTER_LNG: "-46.375806",
        CHECKIN_POWER_AUTOMATE_ADD_URL:
          "https://include.environment.api.powerplatform.com/add",
        CHECKIN_POWER_AUTOMATE_UPDATE_URL:
          "https://update.environment.api.powerplatform.com/update",
        CHECKIN_POWER_AUTOMATE_AUTH_MODE: "entra-client-credentials",
        CHECKIN_POWER_AUTOMATE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        CHECKIN_POWER_AUTOMATE_CLIENT_ID:
          "22222222-2222-4222-8222-222222222222",
        CHECKIN_ENFORCE_ROLLOUT_APPROVED: "true"
      })
    ).toThrow(/configuração/i);
  });

  it.each(["c".repeat(16), "c".repeat(31)])(
    "refuses enforce with a client secret shorter than 32 characters",
    (clientSecret) => {
      expect(() =>
        resolveCheckinRuntimeConfig({
          CHECKIN_INTEGRATION_MODE: "enforce",
          CHECKIN_INTEGRATION_KEY_ID: "checkin-v1",
          CHECKIN_INTEGRATION_HMAC_SECRET: "a".repeat(32),
          CHECKIN_INDEX_HMAC_SECRET: "b".repeat(32),
          CHECKIN_GEOFENCE_CENTER_LAT: "-23.927722",
          CHECKIN_GEOFENCE_CENTER_LNG: "-46.375806",
          CHECKIN_POWER_AUTOMATE_ADD_URL:
            "https://include.environment.api.powerplatform.com/add",
          CHECKIN_POWER_AUTOMATE_UPDATE_URL:
            "https://update.environment.api.powerplatform.com/update",
          CHECKIN_POWER_AUTOMATE_AUTH_MODE: " entra-client-credentials ",
          CHECKIN_POWER_AUTOMATE_TENANT_ID:
            "11111111-1111-4111-8111-111111111111",
          CHECKIN_POWER_AUTOMATE_CLIENT_ID:
            "22222222-2222-4222-8222-222222222222",
          CHECKIN_POWER_AUTOMATE_CLIENT_SECRET: clientSecret,
          CHECKIN_ENFORCE_ROLLOUT_APPROVED: "true"
        })
      ).toThrow(/configuração/i);
    }
  );
});
