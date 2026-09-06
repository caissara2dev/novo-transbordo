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
  listContainerStates: vi.fn(async () => ({
    items: [{ container: "ABCU 123456-0", status: "PARTIAL" }],
    nextCursor: "next-containers",
    incomplete: false
  })),
  getContainerHistory: vi.fn(async () => ({ items: [
    { id: "e1", container: "ABCU 123456-0", status: "PARTIAL" }
  ], nextCursor: "history-next", incomplete: false }))
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
    const body = (await res.json()).data;

    expect(res.status).toBe(200);
    expect(body.container).toBe("ABCU 123456-0");
  });

  it("lists open states", async () => {
    const mod = await import("@/app/api/containers/route");
    const req = new NextRequest("http://localhost/api/containers?scope=open");
    const res = await mod.GET(req);
    const body = (await res.json()).data;

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBe("next-containers");
    expect(body.incomplete).toBe(false);
  });

  it("forwards validated pagination when listing states", async () => {
    const mod = await import("@/app/api/containers/route");
    const server = await import("@/lib/server/container-states");
    const req = new NextRequest(
      "http://localhost/api/containers?scope=all&limit=100&cursor=opaque-containers"
    );

    const res = await mod.GET(req);

    expect(res.status).toBe(200);
    expect(server.listContainerStates).toHaveBeenCalledWith(
      expect.objectContaining({
        pagination: {
          limit: 100,
          cursor: "opaque-containers"
        }
      })
    );
  });

  it("rejects an invalid page limit", async () => {
    const mod = await import("@/app/api/containers/route");
    const server = await import("@/lib/server/container-states");
    const req = new NextRequest("http://localhost/api/containers?limit=0");

    const res = await mod.GET(req);

    expect(res.status).toBe(400);
    expect(server.listContainerStates).not.toHaveBeenCalled();
  });

  it("rejects an empty cursor", async () => {
    const mod = await import("@/app/api/containers/route");
    const server = await import("@/lib/server/container-states");
    const req = new NextRequest("http://localhost/api/containers?cursor=");

    const res = await mod.GET(req);

    expect(res.status).toBe(400);
    expect(server.listContainerStates).not.toHaveBeenCalled();
  });

  it("returns container history", async () => {
    const mod = await import("@/app/api/containers/history/route");
    const req = new NextRequest(
      "http://localhost/api/containers/history?container=ABCU1234560"
    );
    const res = await mod.GET(req);
    const body = (await res.json()).data;

    expect(res.status).toBe(200);
    expect(body.items[0].id).toBe("e1");
  });
});
