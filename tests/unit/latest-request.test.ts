import { describe, expect, it } from "vitest";
import {
  createLatestRequestCoordinator,
  isAbortError
} from "@/lib/ui/latest-request";

describe("latest request coordinator", () => {
  it("aborts and invalidates an older request when a newer one starts", () => {
    const coordinator = createLatestRequestCoordinator();
    const older = coordinator.begin();
    const newer = coordinator.begin();

    expect(older.signal.aborted).toBe(true);
    expect(older.isCurrent()).toBe(false);
    expect(newer.signal.aborted).toBe(false);
    expect(newer.isCurrent()).toBe(true);
  });

  it("invalidates the active request when the coordinator is cancelled", () => {
    const coordinator = createLatestRequestCoordinator();
    const request = coordinator.begin();

    coordinator.cancel();

    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
  });

  it("allows cancellation before any request and identifies abort errors", () => {
    const coordinator = createLatestRequestCoordinator();

    expect(() => coordinator.cancel()).not.toThrow();
    expect(isAbortError(new DOMException("cancelled", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("cancelled"))).toBe(false);
  });
});
