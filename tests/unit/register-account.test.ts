import { beforeEach, describe, expect, it, vi } from "vitest";

const firebaseAuth = vi.hoisted(() => ({
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn()
}));

vi.mock("firebase/auth", () => firebaseAuth);

describe("registerAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firebaseAuth.signOut.mockResolvedValue(undefined);
    firebaseAuth.sendEmailVerification.mockResolvedValue(undefined);
    firebaseAuth.updateProfile.mockResolvedValue(undefined);
  });

  it("signs out the newly created unverified account after success", async () => {
    const auth = { name: "auth" };
    const user = { email: "operator@example.com" };
    firebaseAuth.createUserWithEmailAndPassword.mockResolvedValue({ user });
    const { registerAccount } = await import("@/lib/auth/register-account");

    await expect(
      registerAccount({
        auth: auth as never,
        email: " operator@example.com ",
        name: " Operator ",
        password: "secret123"
      })
    ).resolves.toBe("operator@example.com");

    expect(firebaseAuth.updateProfile).toHaveBeenCalledWith(user, {
      displayName: "Operator"
    });
    expect(firebaseAuth.sendEmailVerification).toHaveBeenCalledWith(user);
    expect(firebaseAuth.signOut).toHaveBeenCalledWith(auth);
  });

  it("still signs out when profile update fails after account creation", async () => {
    const auth = { name: "auth" };
    const user = { email: "operator@example.com" };
    firebaseAuth.createUserWithEmailAndPassword.mockResolvedValue({ user });
    firebaseAuth.updateProfile.mockRejectedValue(new Error("profile failed"));
    const { registerAccount } = await import("@/lib/auth/register-account");

    await expect(
      registerAccount({
        auth: auth as never,
        email: "operator@example.com",
        name: "Operator",
        password: "secret123"
      })
    ).rejects.toThrow("profile failed");

    expect(firebaseAuth.sendEmailVerification).not.toHaveBeenCalled();
    expect(firebaseAuth.signOut).toHaveBeenCalledWith(auth);
  });
});
