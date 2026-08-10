import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "firebase.cmd" : "firebase"
);
const temporaryConfig = join(tmpdir(), "transbordoline-firebase-cli");
const result = spawnSync(
  executable,
  [
    "emulators:exec",
    "--project",
    "demo-transbordo",
    "--only",
    "firestore",
    "vitest run --config vitest.rules.config.ts"
  ],
  {
    stdio: "inherit",
    env: { ...process.env, XDG_CONFIG_HOME: temporaryConfig }
  }
);

if (result.error) {
  console.error(result.error.message);
}
process.exit(result.status ?? 1);
