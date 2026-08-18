import { describe, expect, it, vi } from "vitest";
import { createPreviewPowerAutomateDiagnosticReporter } from "@/lib/server/checkins/power-automate-diagnostics";

const EVENT = {
  event: "power_automate_failure",
  component: "token",
  reason: "status",
  status: 401
} as const;

describe("Power Automate preview diagnostics", () => {
  it("stays disabled outside Preview even when the flag is on", () => {
    expect(
      createPreviewPowerAutomateDiagnosticReporter({
        VERCEL_ENV: "production",
        CHECKIN_POWER_AUTOMATE_DIAGNOSTICS: "on"
      })
    ).toBeUndefined();
  });

  it("stays disabled in Preview without the explicit flag", () => {
    expect(
      createPreviewPowerAutomateDiagnosticReporter({
        VERCEL_ENV: "preview",
        CHECKIN_POWER_AUTOMATE_DIAGNOSTICS: "off"
      })
    ).toBeUndefined();
  });

  it("is enabled for the staging Preview app without a manual flag", () => {
    expect(
      createPreviewPowerAutomateDiagnosticReporter({
        VERCEL_ENV: "preview",
        NEXT_PUBLIC_APP_ENV: "staging"
      })
    ).toEqual(expect.any(Function));
  });

  it("writes only the allowlisted event in an explicitly enabled Preview", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const reporter = createPreviewPowerAutomateDiagnosticReporter({
        VERCEL_ENV: "preview",
        CHECKIN_POWER_AUTOMATE_DIAGNOSTICS: "on"
      });

      reporter?.({
        ...EVENT,
        endpoint: "https://default72ef3102771143cf9879d7783b7ff2.6d.environment.api.powerplatform.com/private",
        unexpectedField: "fixture-should-not-be-logged",
        driverLicense: "12345678900"
      } as never);

      expect(consoleError).toHaveBeenCalledWith(
        "[CHECKIN_PA_DIAG_V1]",
        JSON.stringify(EVENT)
      );
      const serialized = JSON.stringify(consoleError.mock.calls);
      expect(serialized).not.toContain("default72ef3102771143cf9879d7783b7ff2");
      expect(serialized).not.toContain("fixture-should-not-be-logged");
      expect(serialized).not.toContain("12345678900");
    } finally {
      consoleError.mockRestore();
    }
  });
});
