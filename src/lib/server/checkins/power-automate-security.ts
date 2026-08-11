const POWER_AUTOMATE_HOST_SUFFIXES = [
  ".logic.azure.com",
  ".environment.api.powerplatform.com"
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const POWER_AUTOMATE_CLIENT_SECRET_MIN_LENGTH = 32;

export function isPowerAutomateUuid(value: string | undefined): boolean {
  return UUID_PATTERN.test(value?.trim() ?? "");
}

export function isAllowedPowerAutomateEndpoint(
  value: string | undefined
): boolean {
  try {
    const url = new URL(value ?? "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.port === "" || url.port === "443") &&
      POWER_AUTOMATE_HOST_SUFFIXES.some((suffix) =>
        url.hostname.toLowerCase().endsWith(suffix)
      )
    );
  } catch {
    return false;
  }
}
