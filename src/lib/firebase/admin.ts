import { App, cert, getApp, getApps, initializeApp } from "firebase-admin/app";
import type { AppCheck } from "firebase-admin/app-check";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = value.trim().replace(/^"(.*)"$/, "$1");
  if (!cleaned || cleaned === "replace_me") {
    return undefined;
  }

  return cleaned;
}

function buildApp(): App {
  if (getApps().length) {
    return getApp();
  }

  const projectId =
    cleanEnv(process.env.FIREBASE_PROJECT_ID) ||
    cleanEnv(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
  const clientEmail = cleanEnv(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = cleanEnv(process.env.FIREBASE_PRIVATE_KEY)?.replace(/\\n/g, "\n");

  if (clientEmail && privateKey && projectId) {
    return initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey
      })
    });
  }

  return initializeApp({ projectId });
}

const app = buildApp();

export const adminAuth = getAuth(app);
export const adminDb = getFirestore(app);

export async function getAdminAppCheck(): Promise<AppCheck> {
  const { getAppCheck } = await import("firebase-admin/app-check");
  return getAppCheck(app);
}
