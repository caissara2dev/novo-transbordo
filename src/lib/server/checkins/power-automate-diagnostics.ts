import "server-only";

export type PowerAutomateOAuthError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "temporarily_unavailable"
  | "server_error";

export type PowerAutomateDiagnosticEvent = {
  event: "power_automate_failure";
  component: "token" | "flow";
  reason:
    | "token"
    | "network"
    | "timeout"
    | "status"
    | "content_type"
    | "body"
    | "schema"
    | "poll"
    | "configuration";
  operation?: "INCLUDE" | "UPDATE";
  status?: number;
  oauthError?: PowerAutomateOAuthError;
};

export type PowerAutomateDiagnosticReporter = (
  event: PowerAutomateDiagnosticEvent
) => void;

function sanitizeDiagnosticEvent(
  event: PowerAutomateDiagnosticEvent
): PowerAutomateDiagnosticEvent {
  return {
    event: event.event,
    component: event.component,
    reason: event.reason,
    ...(event.operation === undefined ? {} : { operation: event.operation }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.oauthError === undefined
      ? {}
      : { oauthError: event.oauthError })
  };
}

export function reportPowerAutomateDiagnostic(
  reporter: PowerAutomateDiagnosticReporter | undefined,
  event: PowerAutomateDiagnosticEvent
): void {
  try {
    reporter?.(sanitizeDiagnosticEvent(event));
  } catch {
    // Diagnostics are best-effort and must never affect a check-in.
  }
}

export function createPreviewPowerAutomateDiagnosticReporter(
  environment: Record<string, string | undefined>
): PowerAutomateDiagnosticReporter | undefined {
  if (
    environment.VERCEL_ENV !== "preview" ||
    (environment.CHECKIN_POWER_AUTOMATE_DIAGNOSTICS !== "on" &&
      environment.NEXT_PUBLIC_APP_ENV !== "staging")
  ) {
    return undefined;
  }

  return (event) => {
    console.error(
      "[CHECKIN_PA_DIAG_V1]",
      JSON.stringify(sanitizeDiagnosticEvent(event))
    );
  };
}
