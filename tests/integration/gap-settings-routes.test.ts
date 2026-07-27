import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const authContext = {
  uid: "admin-1",
  email: "admin@example.com",
  profile: {
    role: "ADMIN",
    approved: true,
    active: true
  }
};

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn(async () => authContext),
  ensureApproved: vi.fn(),
  ensureRole: vi.fn()
}));

vi.mock("@/lib/server/gaps", () => ({
  previewEventGap: vi.fn(async () => ({
    toleranceMinutes: 10,
    gapVersion: "timeline-v1",
    uncoveredSegments: [{
      id: "1-2",
      startTime: "10:00",
      endTime: "10:11",
      durationMinutes: 11
    }],
    uncoveredMinutes: 11,
    requiresJustification: true
  }))
}));

vi.mock("@/lib/server/operational-settings", () => ({
  getOperationalSettings: vi.fn(async () => ({ idleToleranceMinutes: 10 })),
  updateOperationalSettings: vi.fn(async (raw) => raw)
}));

describe("gap preview and operations settings routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the versioned uncovered gap", async () => {
    const route = await import("@/app/api/events/gap-preview/route");
    const response = await route.POST(new NextRequest("http://localhost/api/events/gap-preview", {
      method: "POST",
      body: JSON.stringify({
        pump: "BOMBA_1",
        shiftDate: "2026-07-27",
        shiftType: "MANHA",
        startTime: "10:11",
        endTime: "10:30"
      })
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      gapVersion: "timeline-v1",
      requiresJustification: true
    });
  });

  it("loads and updates the global tolerance for an admin", async () => {
    const route = await import("@/app/api/settings/operations/route");
    const getResponse = await route.GET(
      new NextRequest("http://localhost/api/settings/operations")
    );
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({ idleToleranceMinutes: 10 });

    const patchResponse = await route.PATCH(
      new NextRequest("http://localhost/api/settings/operations", {
        method: "PATCH",
        body: JSON.stringify({ idleToleranceMinutes: 12 })
      })
    );
    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toEqual({ idleToleranceMinutes: 12 });
  });
});
