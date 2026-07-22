import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    projects: [
      "./vitest.client.config.ts",
      "./vitest.server.config.ts",
      "./vitest.launcher.config.ts",
      "./vitest.staging.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts"],
      exclude: ["src/server/__tests__/**", "src/server/browser-fetch-tools.ts", "src/server/web-search-tools.ts"],
      reporter: ["text", "text-summary", "json-summary", "html"],
      thresholds: {
        statements: 30,
        branches: 22,
        functions: 37,
        lines: 33,
      },
    },
  },
});
