import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const authCtx = {
  uid: "display-1",
  email: "display@x.com",
  profile: {
    role: "DISPLAY",
    approved: true,
    active: true
  }
};

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return {
    ...actual,
    requireAuth: vi.fn(async () => authCtx)
  };
});

const getDisplayOverviewMock = vi.fn(async () => ({
  operationalDate: "2026-07-23",
  generatedAt: "2026-07-24T03:20:00.000Z",
  finalizedTotal: 3,
  averageProductiveMinutes: 24.5,
  openContainers: {
    total: 2,
    partial: 1,
    buffer: 0,
    blendPartial: 1
  },
  clients: []
}));

vi.mock("@/lib/server/display-overview", () => ({
  getDisplayOverview: getDisplayOverviewMock
}));

describe("GET /api/display/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authCtx.profile.role = "DISPLAY";
    authCtx.profile.approved = true;
  });

  it("allows DISPLAY and disables caching", async () => {
    const mod = await import("@/app/api/display/overview/route");
    const response = await mod.GET(
      new NextRequest("http://localhost/api/display/overview")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.finalizedTotal).toBe(3);
  });

  it("allows ADMIN", async () => {
    authCtx.profile.role = "ADMIN";
    const mod = await import("@/app/api/display/overview/route");
    const response = await mod.GET(
      new NextRequest("http://localhost/api/display/overview")
    );

    expect(response.status).toBe(200);
  });

  it("blocks OPERATOR", async () => {
    authCtx.profile.role = "OPERATOR";
    const mod = await import("@/app/api/display/overview/route");
    const response = await mod.GET(
      new NextRequest("http://localhost/api/display/overview")
    );

    expect(response.status).toBe(403);
  });
});
