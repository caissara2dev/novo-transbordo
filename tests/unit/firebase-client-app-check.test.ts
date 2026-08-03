import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firebaseClientBoundary = vi.hoisted(() => {
  const firebaseApp = { name: "default-app" };

  return {
    appCheck: { name: "app-check" },
    firebaseApp,
    getApp: vi.fn(() => firebaseApp),
    getApps: vi.fn(() => [firebaseApp]),
    getAuth: vi.fn(() => ({ name: "auth" })),
    initializeApp: vi.fn(() => firebaseApp),
    initializeAppCheck: vi.fn(),
    recaptchaProvider: vi.fn()
  };
});

vi.mock("firebase/app", () => ({
  getApp: firebaseClientBoundary.getApp,
  getApps: firebaseClientBoundary.getApps,
  initializeApp: firebaseClientBoundary.initializeApp
}));

vi.mock("firebase/auth", () => ({
  connectAuthEmulator: vi.fn(),
  getAuth: firebaseClientBoundary.getAuth
}));

vi.mock("firebase/app-check", () => ({
  initializeAppCheck: firebaseClientBoundary.initializeAppCheck,
  ReCaptchaEnterpriseProvider: firebaseClientBoundary.recaptchaProvider
}));

describe("Firebase client App Check initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("window", {});
    vi.stubEnv("NEXT_PUBLIC_USE_FIREBASE_EMULATOR", "false");
    delete (globalThis as Record<string, unknown>).__TRANSBORDO_FIREBASE_APP_CHECK__;
    firebaseClientBoundary.initializeAppCheck.mockReturnValue(firebaseClientBoundary.appCheck);
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TRANSBORDO_FIREBASE_APP_CHECK__;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not initialize App Check without a configured Enterprise site key", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY", "");

    const { appCheck } = await import("@/lib/firebase/client");

    expect(appCheck).toBeUndefined();
    expect(firebaseClientBoundary.initializeAppCheck).not.toHaveBeenCalled();
  });

  it("initializes ReCaptcha Enterprise only when its site key is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY", "enterprise-site-key");

    const { appCheck } = await import("@/lib/firebase/client");

    expect(firebaseClientBoundary.recaptchaProvider).toHaveBeenCalledWith("enterprise-site-key");
    expect(firebaseClientBoundary.initializeAppCheck).toHaveBeenCalledWith(
      firebaseClientBoundary.firebaseApp,
      {
        provider: expect.anything(),
        isTokenAutoRefreshEnabled: true
      }
    );
    expect(appCheck).toBe(firebaseClientBoundary.appCheck);
  });

  it("reuses the initialized App Check instance after an HMR-style module reload", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY", "enterprise-site-key");

    const firstModule = await import("@/lib/firebase/client");
    vi.resetModules();
    const reloadedModule = await import("@/lib/firebase/client");

    expect(firstModule.appCheck).toBe(firebaseClientBoundary.appCheck);
    expect(reloadedModule.appCheck).toBe(firebaseClientBoundary.appCheck);
    expect(firebaseClientBoundary.initializeAppCheck).toHaveBeenCalledTimes(1);
  });
});
