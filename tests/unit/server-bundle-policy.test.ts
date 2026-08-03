import { describe, expect, it } from "vitest";
import {
  findServerBundleViolations
} from "../../scripts/lib/server-bundle-policy.mjs";

type BundleFile = {
  path: string;
  source: string;
};

const bundledAdminFile: BundleFile = {
  path: ".next/server/chunks/node_modules_firebase-admin_lib_example.js",
  source: "export const firebaseAdminAuth = {};"
};

describe("política do bundle do Firebase Admin", () => {
  it("aceita Firebase Admin empacotado apenas no servidor", () => {
    expect(
      findServerBundleViolations({
        serverFiles: [bundledAdminFile],
        clientFiles: []
      })
    ).toEqual([]);
  });

  it.each([
    'externalImport("firebase-admin-a14c8a5423a75469/auth")',
    'require("firebase-admin/auth")',
    'import("firebase-admin/app-check")',
    'import { getAuth } from"firebase-admin/auth";'
  ])("rejeita referência externa do Firebase Admin: %s", (source) => {
    expect(
      findServerBundleViolations({
        serverFiles: [
          bundledAdminFile,
          {
            path: ".next/server/app/api/display/overview/route.js",
            source
          }
        ],
        clientFiles: []
      })
    ).toContainEqual(
      expect.objectContaining({ code: "EXTERNAL_FIREBASE_ADMIN" })
    );
  });

  it("rejeita bundle sem evidência positiva do Firebase Admin", () => {
    expect(
      findServerBundleViolations({
        serverFiles: [
          {
            path: ".next/server/app/api/display/overview/route.js",
            source: "export const GET = () => new Response();"
          }
        ],
        clientFiles: []
      })
    ).toContainEqual(
      expect.objectContaining({ code: "MISSING_BUNDLED_FIREBASE_ADMIN" })
    );
  });

  it.each([
    "firebase-admin",
    "FIREBASE_PRIVATE_KEY",
    "FIREBASE_CLIENT_EMAIL"
  ])("rejeita marcador administrativo no bundle cliente: %s", (marker) => {
    expect(
      findServerBundleViolations({
        serverFiles: [bundledAdminFile],
        clientFiles: [
          {
            path: ".next/static/chunks/app.js",
            source: `const leakedMarker = ${JSON.stringify(marker)};`
          }
        ]
      })
    ).toContainEqual(
      expect.objectContaining({ code: "ADMIN_MARKER_IN_CLIENT_BUNDLE" })
    );
  });
});
