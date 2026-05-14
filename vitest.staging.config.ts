import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: [
      "src/server/__tests__/pre-deploy-checkpoint.test.ts",
      "src/server/__tests__/staging-preview-backend.test.ts",
      "src/server/__tests__/staging-tools.test.ts",
    ],
    environment: "node",
    env: {
      NODE_ENV: "test",
    },
    testTimeout: 10_000,
  },
});
