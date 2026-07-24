import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn(async () => ({
    uid: "admin-1",
    email: "admin@x.com",
    profile: {
      role: "ADMIN",
      approved: true,
      active: true,
      email: "admin@x.com",
      name: null,
      createdAt: null,
      updatedAt: null,
      approvedAt: null,
      approvedByUid: null,
      approvedByEmail: null
    }
  })),
  ensureApproved: vi.fn(),
  ensureRole: vi.fn()
}));

vi.mock("@/lib/server/users", () => ({
  setRole: vi.fn(async (params: { role: string }) => ({ id: "u1", role: params.role }))
}));

describe("users role route", () => {
  it("rejects invalid role", async () => {
    const mod = await import("@/app/api/users/[uid]/role/route");

    const req = new NextRequest("http://localhost/api/users/u1/role", {
      method: "POST",
      body: JSON.stringify({ role: "HACKER" }),
      headers: {
        "content-type": "application/json"
      }
    });

    const res = await mod.POST(req, { params: Promise.resolve({ uid: "u1" }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Role inválido");
  });

  it("accepts DISPLAY role", async () => {
    const mod = await import("@/app/api/users/[uid]/role/route");
    const req = new NextRequest("http://localhost/api/users/u1/role", {
      method: "POST",
      body: JSON.stringify({ role: "DISPLAY" }),
      headers: {
        "content-type": "application/json"
      }
    });

    const res = await mod.POST(req, { params: Promise.resolve({ uid: "u1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.role).toBe("DISPLAY");
  });
});
