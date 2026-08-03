"use client";

import { FirebaseApp, getApp, getApps, initializeApp } from "firebase/app";
import {
  AppCheck,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider
} from "firebase/app-check";
import { connectAuthEmulator, getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

let app: FirebaseApp;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

const auth = getAuth(app);
const appCheckSiteKey = process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY?.trim();

let appCheck: AppCheck | undefined;

if (typeof window !== "undefined" && appCheckSiteKey) {
  const clientGlobal = globalThis as typeof globalThis & {
    __TRANSBORDO_FIREBASE_APP_CHECK__?: Record<string, AppCheck>;
  };
  const appCheckByApp = clientGlobal.__TRANSBORDO_FIREBASE_APP_CHECK__ ?? {};
  appCheck = appCheckByApp[app.name];

  if (!appCheck) {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true
    });
    clientGlobal.__TRANSBORDO_FIREBASE_APP_CHECK__ = {
      ...appCheckByApp,
      [app.name]: appCheck
    };
  }
}

if (
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true" &&
  typeof window !== "undefined"
) {
  const emulatorHost = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";

  if (!(auth as unknown as { emulatorConfigured?: boolean }).emulatorConfigured) {
    connectAuthEmulator(auth, `http://${emulatorHost}`, { disableWarnings: true });
    (auth as unknown as { emulatorConfigured?: boolean }).emulatorConfigured = true;
  }
}

export { app, appCheck, auth };
