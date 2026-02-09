import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authCtx = {
  uid: "u1",
  email: "operator@x.com",
  profile: {
    role: "OPERATOR",
    approved: true,
    active: true,
    email: "operator@x.com",
    name: null,
    createdAt: null,
    updatedAt: null,
    approvedAt: null,
    approvedByUid: null,
    approvedByEmail: null
  }
};

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn(async () => authCtx),
  ensureApproved: vi.fn(),
  ensureRole: vi.fn()
}));

vi.mock("@/lib/server/events", () => ({
  createEvent: vi.fn(async () => ({ id: "e1", warnings: [], pump: "BOMBA_1" })),
  listEvents: vi.fn(async () => [{ id: "e1", pump: "BOMBA_1" }]),
  updateEvent: vi.fn(async () => ({ id: "e1" })),
  softDeleteEvent: vi.fn(async () => ({ ok: true })),
  restoreEvent: vi.fn(async () => ({ ok: true }))
}));

describe("events API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/events returns list payload", async () => {
    const mod = await import("@/app/api/events/route");
    const req = new NextRequest("http://localhost/api/events?dateFrom=2026-02-06");

    const res = await mod.GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  it("POST /api/events returns created item", async () => {
    const mod = await import("@/app/api/events/route");
    const req = new NextRequest("http://localhost/api/events", {
      method: "POST",
      body: JSON.stringify({ pump: "BOMBA_1" }),
      headers: {
        "content-type": "application/json"
      }
    });

    const res = await mod.POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.item.id).toBe("e1");
  });
});
