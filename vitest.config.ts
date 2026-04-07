import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts"],
      exclude: ["src/server/__tests__/**"],
      reporter: ["text", "text-summary"],
      thresholds: {
        statements: 30,
        branches: 22,
        functions: 37,
        lines: 33,
      },
    },
  },
});
