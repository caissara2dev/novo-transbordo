import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { UserDoc } from "@/types/domain";

const authMocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  ensureUserProfile: vi.fn(),
  getProfile: vi.fn()
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: authMocks.verifyIdToken
  },
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: authMocks.getProfile
      }))
    }))
  }
}));

vi.mock("@/lib/server/users", () => ({
  ensureUserProfile: authMocks.ensureUserProfile
}));

const activeProfile = {
  role: "OPERATOR",
  approved: true,
  active: true,
  email: "operator@example.com",
  name: null,
  createdAt: null,
  updatedAt: null,
  approvedAt: null,
  approvedByUid: null,
  approvedByEmail: null
} satisfies UserDoc;

function request(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: {
      authorization: "Bearer valid-token"
    }
  });
}

describe("verified email authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getProfile.mockResolvedValue({
      exists: true,
      data: () => activeProfile
    });
  });

  it("rejects an unverified token at the authenticated API boundary", async () => {
    authMocks.verifyIdToken.mockResolvedValue({
      uid: "operator-1",
      email: "operator@example.com",
      email_verified: false
    });

    const { requireAuth } = await import("@/lib/server/auth");

    await expect(requireAuth(request("/api/me"))).rejects.toMatchObject({
      status: 403,
      message: "Verifique seu e-mail antes de continuar."
    });
  });

  it("accepts a verified token for an active profile", async () => {
    authMocks.verifyIdToken.mockResolvedValue({
      uid: "operator-1",
      email: "operator@example.com",
      email_verified: true
    });

    const { requireAuth } = await import("@/lib/server/auth");

    await expect(requireAuth(request("/api/me"))).resolves.toMatchObject({
      uid: "operator-1",
      email: "operator@example.com",
      profile: activeProfile
    });
  });

  it("uses the profile email when the verified token has no email", async () => {
    authMocks.verifyIdToken.mockResolvedValue({
      uid: "operator-1",
      email_verified: true
    });

    const { requireAuth } = await import("@/lib/server/auth");

    await expect(requireAuth(request("/api/me"))).resolves.toMatchObject({
      email: activeProfile.email
    });
  });

  it("rejects missing and inactive profiles", async () => {
    authMocks.verifyIdToken.mockResolvedValue({
      uid: "operator-1",
      email: "operator@example.com",
      email_verified: true
    });
    const { requireAuth } = await import("@/lib/server/auth");

    authMocks.getProfile.mockResolvedValueOnce({ exists: false });
    await expect(requireAuth(request("/api/me"))).rejects.toMatchObject({
      status: 404,
      message: "Perfil de usuário não encontrado."
    });

    authMocks.getProfile.mockResolvedValueOnce({
      exists: true,
      data: () => ({ ...activeProfile, active: false })
    });
    await expect(requireAuth(request("/api/me"))).rejects.toMatchObject({
      status: 403,
      message: "Usuário inativo."
    });
  });

  it("enforces approval and role helpers", async () => {
    const { ensureApproved, ensureRole } = await import("@/lib/server/auth");

    expect(() => ensureApproved(activeProfile)).not.toThrow();
    expect(() =>
      ensureApproved({ ...activeProfile, approved: false })
    ).toThrow("Usuário ainda não aprovado.");
    expect(() => ensureRole(activeProfile, ["OPERATOR"])).not.toThrow();
    expect(() => ensureRole(activeProfile, ["ADMIN"])).toThrow(
      "Permissão insuficiente."
    );
  });

  it("does not create a profile for an unverified account", async () => {
    authMocks.verifyIdToken.mockResolvedValue({
      uid: "new-user",
      email: "new@example.com",
      email_verified: false
    });

    const { POST } = await import("@/app/api/auth/sync/route");
    const response = await POST(
      new NextRequest("http://localhost/api/auth/sync", {
        method: "POST",
        headers: {
          authorization: "Bearer valid-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ name: "Novo usuário" })
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "EMAIL_UNVERIFIED",
        message: "Verifique seu e-mail antes de continuar."
      }
    });
    expect(authMocks.ensureUserProfile).not.toHaveBeenCalled();
  });

  it("rejects mistyped and unknown sync fields before creating a profile", async () => {
    authMocks.verifyIdToken.mockResolvedValue({
      uid: "new-user",
      email: "new@example.com",
      email_verified: true
    });
    const { POST } = await import("@/app/api/auth/sync/route");

    for (const body of [
      JSON.stringify({ name: 123 }),
      JSON.stringify({ name: "Novo usuário", role: "ADMIN" }),
      "{"
    ]) {
      const response = await POST(
        new NextRequest("http://localhost/api/auth/sync", {
          method: "POST",
          headers: {
            authorization: "Bearer valid-token",
            "content-type": "application/json"
          },
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

    expect(authMocks.ensureUserProfile).not.toHaveBeenCalled();
  });
});
