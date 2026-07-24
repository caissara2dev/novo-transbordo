import { describe, expect, it } from "vitest";
import { ensureDisplayApiAccess } from "@/lib/server/auth";
import { UserDoc } from "@/types/domain";

const displayProfile = {
  role: "DISPLAY",
  approved: true,
  active: true
} as UserDoc;

describe("DISPLAY API isolation", () => {
  it.each([
    "/api/events",
    "/api/containers",
    "/api/reports/overview",
    "/api/clients",
    "/api/users"
  ])("blocks operational endpoint %s", (pathname) => {
    expect(() => ensureDisplayApiAccess(displayProfile, pathname)).toThrowError(
      expect.objectContaining({ status: 403 })
    );
  });

  it.each(["/api/display/overview", "/api/me", "/api/auth/sync"])(
    "allows display-safe endpoint %s",
    (pathname) => {
      expect(() => ensureDisplayApiAccess(displayProfile, pathname)).not.toThrow();
    }
  );
});
