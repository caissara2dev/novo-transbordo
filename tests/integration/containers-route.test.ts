import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn(async () => ({
    uid: "u1",
    email: "operator@x.com",
    profile: { role: "OPERATOR", approved: true, active: true }
  })),
  ensureApproved: vi.fn()
}));

vi.mock("@/lib/server/container-states", () => ({
  lookupContainer: vi.fn(async () => ({
    container: "ABCU 123456-0",
    current: null,
    availableStatuses: ["FULL", "PARTIAL", "BUFFER"],
    requiresNewCycleConfirmation: false
  })),
  listContainerStates: vi.fn(async () => [
    { container: "ABCU 123456-0", status: "PARTIAL" }
  ]),
  getContainerHistory: vi.fn(async () => [
    { id: "e1", container: "ABCU 123456-0", status: "PARTIAL" }
  ])
}));

describe("containers API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up the current state", async () => {
    const mod = await import("@/app/api/containers/lookup/route");
    const req = new NextRequest(
      "http://localhost/api/containers/lookup?container=ABCU1234560"
    );
    const res = await mod.GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.container).toBe("ABCU 123456-0");
  });

  it("lists open states", async () => {
    const mod = await import("@/app/api/containers/route");
    const req = new NextRequest("http://localhost/api/containers?scope=open");
    const res = await mod.GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  it("returns container history", async () => {
    const mod = await import("@/app/api/containers/history/route");
    const req = new NextRequest(
      "http://localhost/api/containers/history?container=ABCU1234560"
    );
    const res = await mod.GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items[0].id).toBe("e1");
  });
});
