import { describe, expect, it } from "vitest";
import { documentEnvironment, internalDocumentOrigin } from "@/lib/server/checkins/document-environment";

const production: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  CHECKIN_DOCUMENTS_ENABLED: "true",
  CHECKIN_DOCUMENT_ENVIRONMENT: "production",
  FIREBASE_PROJECT_ID: "line-transbordo",
  CHECKIN_DOCUMENT_BUCKET: "line-transbordo-checkin-nf",
  CHECKIN_PORTAL_ORIGIN: "https://checkin.linebot.com.br",
  CHECKIN_INDEX_HMAC_SECRET: "test-only-secret-never-used-in-cloud",
};
const staging: NodeJS.ProcessEnv = {
  ...production, CHECKIN_DOCUMENT_ENVIRONMENT: undefined,
  FIREBASE_PROJECT_ID: "line-transbordo-staging-382612",
  CHECKIN_DOCUMENT_BUCKET: "line-transbordo-staging-382612-checkin-nf",
  CHECKIN_PORTAL_ORIGIN: "https://checkin-portal-nf--line-transbordo-staging-382612.us-central1.hosted.app",
};

describe("document environment selection", () => {
  it("accepts the explicitly selected production destinations", () => {
    expect(documentEnvironment(production)).toEqual({
      bucket: production.CHECKIN_DOCUMENT_BUCKET,
      origin: production.CHECKIN_PORTAL_ORIGIN,
      secret: production.CHECKIN_INDEX_HMAC_SECRET,
    });
  });
  it.each([undefined, "staging"])("preserves staging with selector %s", (selector) => {
    expect(documentEnvironment({ ...staging, CHECKIN_DOCUMENT_ENVIRONMENT: selector }).bucket)
      .toBe(staging.CHECKIN_DOCUMENT_BUCKET);
  });
  it.each([
    { CHECKIN_DOCUMENTS_ENABLED: "false" },
    { CHECKIN_DOCUMENTS_ENABLED: undefined },
    { CHECKIN_DOCUMENT_ENVIRONMENT: undefined },
    { CHECKIN_DOCUMENT_ENVIRONMENT: "staging" },
    { CHECKIN_DOCUMENT_ENVIRONMENT: "prod" },
    { FIREBASE_PROJECT_ID: "unknown-project" },
    { FIREBASE_PROJECT_ID: undefined },
    { CHECKIN_DOCUMENT_BUCKET: staging.CHECKIN_DOCUMENT_BUCKET },
    { CHECKIN_DOCUMENT_BUCKET: undefined },
    { CHECKIN_PORTAL_ORIGIN: staging.CHECKIN_PORTAL_ORIGIN },
    { CHECKIN_PORTAL_ORIGIN: "http://checkin.linebot.com.br" },
    { CHECKIN_PORTAL_ORIGIN: "https://checkin.linebot.com.br/" },
    { CHECKIN_PORTAL_ORIGIN: undefined },
    { CHECKIN_INDEX_HMAC_SECRET: "short" },
    { CHECKIN_INDEX_HMAC_SECRET: undefined },
    { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8188" },
    { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" },
    { STORAGE_EMULATOR_HOST: "http://127.0.0.1:9199" },
    { FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199" },
  ])("rejects incomplete, crossed or disabled production: %j", (override) => {
    expect(() => documentEnvironment({ ...production, ...override })).toThrow();
  });
  it.each([
    { CHECKIN_DOCUMENT_BUCKET: production.CHECKIN_DOCUMENT_BUCKET },
    { CHECKIN_PORTAL_ORIGIN: production.CHECKIN_PORTAL_ORIGIN },
    { CHECKIN_DOCUMENT_ENVIRONMENT: "production" },
    { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8188" },
  ])("rejects crossed staging: %j", (override) => {
    expect(() => documentEnvironment({ ...staging, ...override })).toThrow();
  });
  it("keeps demo test destinations available only with Firestore emulation", () => {
    const demo = { ...production, FIREBASE_PROJECT_ID: "demo-checkin-nf",
      CHECKIN_DOCUMENT_ENVIRONMENT: "demo", CHECKIN_DOCUMENT_BUCKET: "demo-private",
      CHECKIN_PORTAL_ORIGIN: "https://portal.example.test", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8188" };
    expect(documentEnvironment(demo).bucket).toBe("demo-private");
    expect(documentEnvironment({ ...demo, CHECKIN_DOCUMENT_ENVIRONMENT: undefined }).bucket).toBe("demo-private");
    expect(() => documentEnvironment({ ...demo, FIRESTORE_EMULATOR_HOST: undefined })).toThrow();
    expect(() => documentEnvironment({ ...demo, CHECKIN_DOCUMENT_ENVIRONMENT: "production" })).toThrow();
    expect(() => documentEnvironment({ ...demo, CHECKIN_DOCUMENT_BUCKET: production.CHECKIN_DOCUMENT_BUCKET })).toThrow();
    expect(() => documentEnvironment({ ...demo, CHECKIN_DOCUMENT_BUCKET: staging.CHECKIN_DOCUMENT_BUCKET })).toThrow();
  });
});

describe("internal document origin", () => {
  const productionOrigin = "https://linebot.com.br";
  const stagingOrigin = "https://checkin-system-nf--line-transbordo-staging-382612.us-central1.hosted.app";

  it("accepts the staff production origin with the explicitly selected production environment", () => {
    expect(internalDocumentOrigin({ ...production, CHECKIN_DOCUMENT_INTERNAL_ORIGIN: productionOrigin }))
      .toBe(productionOrigin);
  });
  it.each([undefined, "staging"])("preserves the staff staging origin with selector %s", (selector) => {
    expect(internalDocumentOrigin({ ...staging, CHECKIN_DOCUMENT_ENVIRONMENT: selector, CHECKIN_DOCUMENT_INTERNAL_ORIGIN: stagingOrigin }))
      .toBe(stagingOrigin);
  });
  it.each([undefined, "", stagingOrigin, production.CHECKIN_PORTAL_ORIGIN,
    "http://linebot.com.br", "https://linebot.com.br/", "https://linebot.com.br.attacker.test"])
    ("rejects an absent or non-exact staff production origin: %s", (origin) => {
      expect(() => internalDocumentOrigin({ ...production, CHECKIN_DOCUMENT_INTERNAL_ORIGIN: origin })).toThrow();
    });
  it("rejects the production origin in staging", () => {
    expect(() => internalDocumentOrigin({ ...staging, CHECKIN_DOCUMENT_INTERNAL_ORIGIN: productionOrigin })).toThrow();
  });
  it.each([
    { CHECKIN_DOCUMENT_ENVIRONMENT: undefined },
    { CHECKIN_DOCUMENTS_ENABLED: "false" },
    { FIREBASE_PROJECT_ID: "unknown-project" },
    { CHECKIN_DOCUMENT_BUCKET: staging.CHECKIN_DOCUMENT_BUCKET },
    { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8188" },
    { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" },
    { STORAGE_EMULATOR_HOST: "http://127.0.0.1:9199" },
    { FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199" },
  ])("requires the full document environment boundary: %j", (override) => {
    expect(() => internalDocumentOrigin({ ...production, CHECKIN_DOCUMENT_INTERNAL_ORIGIN: productionOrigin, ...override })).toThrow();
  });
  it("preserves a custom internal origin only for a valid demo emulator", () => {
    const demo = { ...production, FIREBASE_PROJECT_ID: "demo-checkin-nf",
      CHECKIN_DOCUMENT_ENVIRONMENT: "demo", CHECKIN_DOCUMENT_BUCKET: "demo-private",
      CHECKIN_PORTAL_ORIGIN: "https://portal.example.test", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8188",
      CHECKIN_DOCUMENT_INTERNAL_ORIGIN: "https://staff.example.test" };
    expect(internalDocumentOrigin(demo)).toBe(demo.CHECKIN_DOCUMENT_INTERNAL_ORIGIN);
    expect(() => internalDocumentOrigin({ ...demo, FIRESTORE_EMULATOR_HOST: undefined })).toThrow();
    expect(() => internalDocumentOrigin({ ...demo, CHECKIN_DOCUMENT_INTERNAL_ORIGIN: undefined })).toThrow();
  });
});
