import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

const baseURL = "http://127.0.0.1:3000";
const projectRoot = process.cwd();
const hasE2ESuite = existsSync(path.join(projectRoot, "tests/e2e"));
const e2eProjectId = "demo-transbordo-e2e";

process.env.FIREBASE_PROJECT_ID = e2eProjectId;
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9199";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./tmp/playwright",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "./tmp/playwright-report" }]
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: hasE2ESuite
    ? [
        {
          command:
            "./node_modules/.bin/firebase emulators:start --config firebase.e2e.json --project demo-transbordo-e2e --only auth",
          url:
            "http://127.0.0.1:9199/emulator/v1/projects/demo-transbordo-e2e/config",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000
        },
        {
          // A production server avoids Turbopack's file watchers, which can hit
          // macOS EMFILE limits and make the E2E gate nondeterministic.
          command: "npm run build && npm run start -- --hostname 127.0.0.1",
          env: {
            APP_CHECK_MODE: "off",
            RATE_LIMIT_MODE: "off",
            FIREBASE_PROJECT_ID: e2eProjectId,
            FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9199",
            NEXT_PUBLIC_USE_FIREBASE_EMULATOR: "true",
            NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9199",
            NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
            NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "localhost",
            NEXT_PUBLIC_FIREBASE_PROJECT_ID: e2eProjectId,
            NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${e2eProjectId}.appspot.com`,
            NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "123456789",
            NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:e2e"
          },
          // The App Router intentionally has no `/` page. Probe a real route so
          // Playwright can distinguish a ready server from a valid 404.
          url: `${baseURL}/login`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000
        }
      ]
    : undefined
});
