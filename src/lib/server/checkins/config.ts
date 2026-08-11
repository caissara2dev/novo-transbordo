import { HttpError } from "@/lib/domain/errors";
import { parseCheckinIntegrationMode } from "@/lib/server/checkins/integration-auth";
import {
  isAllowedPowerAutomateEndpoint,
  isPowerAutomateUuid,
  POWER_AUTOMATE_CLIENT_SECRET_MIN_LENGTH
} from "@/lib/server/checkins/power-automate-security";

type Environment = Record<string, string | undefined>;

export type CheckinRuntimeConfig =
  | { mode: "off" }
  | {
      mode: "observe" | "enforce";
      activeKeyId: string;
      integrationSecret: string;
      indexSecret: string;
      allowedArea: {
        latitude: number;
        longitude: number;
        radiusMeters: number;
      };
    };

function configurationError(): never {
  throw new HttpError(500, "Configuração privada do Check-in Line está incompleta.");
}

function hasEntraClientCredentials(env: Environment): boolean {
  return (
    env.CHECKIN_POWER_AUTOMATE_AUTH_MODE?.trim() ===
      "entra-client-credentials" &&
    isPowerAutomateUuid(env.CHECKIN_POWER_AUTOMATE_TENANT_ID) &&
    isPowerAutomateUuid(env.CHECKIN_POWER_AUTOMATE_CLIENT_ID) &&
    (env.CHECKIN_POWER_AUTOMATE_CLIENT_SECRET?.length ?? 0) >=
      POWER_AUTOMATE_CLIENT_SECRET_MIN_LENGTH
  );
}

export function resolveCheckinRuntimeConfig(env: Environment): CheckinRuntimeConfig {
  const mode = parseCheckinIntegrationMode(env.CHECKIN_INTEGRATION_MODE);
  if (mode === "off") return { mode };

  const activeKeyId = env.CHECKIN_INTEGRATION_KEY_ID?.trim() || "";
  const integrationSecret = env.CHECKIN_INTEGRATION_HMAC_SECRET || "";
  const indexSecret = env.CHECKIN_INDEX_HMAC_SECRET || "";
  const latitude = Number(env.CHECKIN_GEOFENCE_CENTER_LAT);
  const longitude = Number(env.CHECKIN_GEOFENCE_CENTER_LNG);
  const radiusMeters = Number(env.CHECKIN_GEOFENCE_RADIUS_METERS || "20000");

  if (
    !activeKeyId ||
    activeKeyId.length > 64 ||
    integrationSecret.length < 32 ||
    indexSecret.length < 32 ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters <= 0 ||
    radiusMeters > 100_000
  ) {
    configurationError();
  }

  if (
    mode === "enforce" &&
    (!isAllowedPowerAutomateEndpoint(env.CHECKIN_POWER_AUTOMATE_ADD_URL) ||
      !isAllowedPowerAutomateEndpoint(env.CHECKIN_POWER_AUTOMATE_UPDATE_URL) ||
      !hasEntraClientCredentials(env) ||
      env.CHECKIN_ENFORCE_ROLLOUT_APPROVED !== "true")
  ) {
    // This explicit gate prevents a single flag change from enforcing an
    // untested production workflow before Excel and rollback are approved.
    configurationError();
  }

  return {
    mode,
    activeKeyId,
    integrationSecret,
    indexSecret,
    allowedArea: { latitude, longitude, radiusMeters }
  };
}
