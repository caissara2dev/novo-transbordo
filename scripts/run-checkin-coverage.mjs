import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// The document suite performs destructive fixture cleanup; never run against cloud.
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8188") {
  throw new Error("Coverage requires the local Firestore emulator on 127.0.0.1:8188.");
}
const environment = {
  ...process.env,
  FIREBASE_PROJECT_ID: "demo-checkin-nf",
  GCLOUD_PROJECT: "demo-checkin-nf",
  GOOGLE_CLOUD_PROJECT: "demo-checkin-nf"
};
delete environment.GOOGLE_APPLICATION_CREDENTIALS;
delete environment.FIREBASE_CLIENT_EMAIL;
delete environment.FIREBASE_PRIVATE_KEY;
const result = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--coverage"], {
  stdio: "inherit",
  env: environment
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
