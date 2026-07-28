import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/rules/**/*.test.ts"],
    fileParallelism: false,
    hookTimeout: 20_000,
    testTimeout: 20_000
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  }
});
