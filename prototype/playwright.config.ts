import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "../tests/prototype",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  outputDir: "../tmp/prototype-tests",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
