import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const clientMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  listClients: vi.fn(),
  updateClient: vi.fn()
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn(async () => ({
    uid: "admin-1",
    email: "admin@example.com",
    profile: {
      role: "ADMIN",
      approved: true,
      active: true
    }
  })),
  ensureApproved: vi.fn(),
  ensureRole: vi.fn()
}));

vi.mock("@/lib/server/clients", () => ({
  createClient: clientMocks.createClient,
  listClients: clientMocks.listClients,
  updateClient: clientMocks.updateClient
}));

describe("clients HTTP contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMocks.listClients.mockResolvedValue([
      { id: "client-1", name: "Cliente A", active: true }
    ]);
    clientMocks.createClient.mockResolvedValue({
      id: "client-1",
      name: "Cliente A",
      active: true
    });
    clientMocks.updateClient.mockResolvedValue({
      id: "client-1",
      name: "Cliente A",
      active: false
    });
  });

  it("wraps list and create responses in the success envelope", async () => {
    const collectionRoute = await import("@/app/api/clients/route");
    const listResponse = await collectionRoute.GET(
      new NextRequest("http://localhost/api/clients")
    );
    const createResponse = await collectionRoute.POST(
      new NextRequest("http://localhost/api/clients", {
        method: "POST",
        body: JSON.stringify({ name: "Cliente A" })
      })
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ id: "client-1" }]
      }
    });
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        item: { id: "client-1" }
      }
    });
  });

  it("rejects malformed, mistyped and unknown create fields", async () => {
    const route = await import("@/app/api/clients/route");

    for (const body of [
      "{",
      JSON.stringify({ name: 123 }),
      JSON.stringify({ name: "Cliente A", active: true })
    ]) {
      const response = await route.POST(
        new NextRequest("http://localhost/api/clients", {
          method: "POST",
          body
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: {
          code: "VALIDATION_ERROR"
        }
      });
    }

    expect(clientMocks.createClient).not.toHaveBeenCalled();
  });

  it("accepts only strict name and active update fields", async () => {
    const route = await import("@/app/api/clients/[id]/route");
    const context = { params: Promise.resolve({ id: "client-1" }) };
    const response = await route.PATCH(
      new NextRequest("http://localhost/api/clients/client-1", {
        method: "PATCH",
        body: JSON.stringify({ active: false })
      }),
      context
    );
    const invalidResponse = await route.PATCH(
      new NextRequest("http://localhost/api/clients/client-1", {
        method: "PATCH",
        body: JSON.stringify({ active: "false" })
      }),
      context
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        item: { active: false }
      }
    });
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_ERROR"
      }
    });
  });
});
