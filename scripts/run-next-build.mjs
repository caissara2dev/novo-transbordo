import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

const previewEnvironment = resolve(".vercel", ".env.preview.local");
if (existsSync(previewEnvironment)) {
  // Node preserves variables already supplied by CI/hosting, so the ignored
  // preview file is only a local fallback and never overrides deployment env.
  loadEnvFile(previewEnvironment);
}

const nextExecutable = resolve("node_modules", "next", "dist", "bin", "next");
const result = spawnSync(process.execPath, [nextExecutable, "build"], {
  stdio: "inherit",
  env: process.env
});

if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
