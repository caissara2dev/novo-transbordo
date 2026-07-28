import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  oxc: {
    // Next.js keeps JSX for its compiler, while Vitest/Vite must lower TSX
    // before running import analysis.
    jsx: {
      runtime: "automatic"
    }
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/coverage/**/*.test.ts"
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      // Unit/integration coverage gates the testable business seams. Thin Next.js
      // adapters and React views are verified separately by integration/E2E tests.
      include: [
        "src/lib/domain/**/*.ts",
        "src/lib/server/**/*.ts",
        "src/lib/ui/**/*.ts",
        "scripts/lib/**/*.mjs"
      ],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  }
});
