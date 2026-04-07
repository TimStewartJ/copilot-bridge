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
        statements: 20,
        branches: 13,
        functions: 25,
        lines: 21,
      },
    },
  },
});
