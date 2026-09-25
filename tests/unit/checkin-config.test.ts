import { describe, it, expect } from "vitest";
import { resolveCheckinRuntimeConfig } from "@/lib/server/checkins/config";
const config = {
  CHECKIN_INTEGRATION_MODE: "observe",
  CHECKIN_SYSTEM_RECORD_ENABLED: "true",
  CHECKIN_INTEGRATION_KEY_ID: "driver",
  CHECKIN_INTEGRATION_HMAC_SECRET: "a".repeat(32),
  CHECKIN_INDEX_HMAC_SECRET: "b".repeat(32),
  CHECKIN_GEOFENCE_CENTER_LAT: "-23.95",
  CHECKIN_GEOFENCE_CENTER_LNG: "-46.3",
  CHECKIN_GEOFENCE_RADIUS_METERS: "20000",
};
describe("official system configuration", () => {
  it("defaults to off without private configuration", () =>
    expect(resolveCheckinRuntimeConfig({})).toEqual({ mode: "off" }));
  it("observe needs no Excel settings", () =>
    expect(resolveCheckinRuntimeConfig(config)).toMatchObject({
      mode: "observe",
      allowedArea: { radiusMeters: 20000 },
    }));
  it("enforce requires the independent rollout guard", () => {
    expect(() =>
      resolveCheckinRuntimeConfig({
        ...config,
        CHECKIN_INTEGRATION_MODE: "enforce",
      }),
    ).toThrow();
    expect(
      resolveCheckinRuntimeConfig({
        ...config,
        CHECKIN_INTEGRATION_MODE: "enforce",
        CHECKIN_ENFORCE_ROLLOUT_APPROVED: "true",
      }),
    ).toMatchObject({ mode: "enforce" });
  });
  it.each([
    ["CHECKIN_SYSTEM_RECORD_ENABLED", "false"],
    ["CHECKIN_INTEGRATION_KEY_ID", ""],
    ["CHECKIN_INTEGRATION_KEY_ID", "x".repeat(65)],
    ["CHECKIN_INTEGRATION_HMAC_SECRET", "short"],
    ["CHECKIN_INDEX_HMAC_SECRET", "short"],
    ["CHECKIN_GEOFENCE_CENTER_LAT", ""],
    ["CHECKIN_GEOFENCE_CENTER_LNG", " "],
    ["CHECKIN_GEOFENCE_CENTER_LAT", "-91"],
    ["CHECKIN_GEOFENCE_CENTER_LAT", "91"],
    ["CHECKIN_GEOFENCE_CENTER_LNG", "-181"],
    ["CHECKIN_GEOFENCE_CENTER_LNG", "181"],
    ["CHECKIN_GEOFENCE_CENTER_LAT", "bad"],
    ["CHECKIN_GEOFENCE_RADIUS_METERS", "0"],
    ["CHECKIN_GEOFENCE_RADIUS_METERS", "100001"],
    ["CHECKIN_GEOFENCE_RADIUS_METERS", "bad"],
  ])("rejects invalid %s", (key, value) =>
    expect(() =>
      resolveCheckinRuntimeConfig({ ...config, [key]: value }),
    ).toThrow(),
  );
});
