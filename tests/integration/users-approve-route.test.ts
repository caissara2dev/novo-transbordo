import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const approveMocks = vi.hoisted(() => ({
  setApproval: vi.fn()
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn(async () => ({
    uid: "admin-1",
    email: "admin@example.com",
    profile: {
      role: "ADMIN",
      approved: true,
      active: true,
      email: "admin@example.com"
    }
  })),
  ensureApproved: vi.fn(),
  ensureRole: vi.fn()
}));

vi.mock("@/lib/server/users", () => ({
  setApproval: approveMocks.setApproval
}));

describe("users approval route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approveMocks.setApproval.mockImplementation(
      async ({ approved }: { approved: boolean }) => ({
        id: "operator-1",
        approved
      })
    );
  });

  it("rejects string values instead of coercing them to booleans", async () => {
    const { POST } = await import("@/app/api/users/[uid]/approve/route");
    const response = await POST(
      new NextRequest("http://localhost/api/users/operator-1/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ approved: "false" })
      }),
      { params: Promise.resolve({ uid: "operator-1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Dados da requisição inválidos.",
        details: {
          fieldErrors: {
            approved: expect.any(Array)
          }
        }
      }
    });
    expect(approveMocks.setApproval).not.toHaveBeenCalled();
  });

  it("accepts an actual boolean value", async () => {
    const { POST } = await import("@/app/api/users/[uid]/approve/route");
    const response = await POST(
      new NextRequest("http://localhost/api/users/operator-1/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ approved: false })
      }),
      { params: Promise.resolve({ uid: "operator-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        item: {
          approved: false
        }
      }
    });
    expect(approveMocks.setApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false })
    );
  });

  it("reports malformed JSON as a client error", async () => {
    const { POST } = await import("@/app/api/users/[uid]/approve/route");
    const response = await POST(
      new NextRequest("http://localhost/api/users/operator-1/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{"
      }),
      { params: Promise.resolve({ uid: "operator-1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Corpo da requisição inválido."
      }
    });
    expect(approveMocks.setApproval).not.toHaveBeenCalled();
  });

  it("rejects unknown approval fields", async () => {
    const { POST } = await import("@/app/api/users/[uid]/approve/route");
    const response = await POST(
      new NextRequest("http://localhost/api/users/operator-1/approve", {
        method: "POST",
        body: JSON.stringify({ approved: true, role: "ADMIN" })
      }),
      { params: Promise.resolve({ uid: "operator-1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_ERROR"
      }
    });
    expect(approveMocks.setApproval).not.toHaveBeenCalled();
  });
});
