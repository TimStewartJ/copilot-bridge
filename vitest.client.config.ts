import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["src/client/**/*.test.ts"],
    environment: "node",
    env: {
      NODE_ENV: "test",
    },
    testTimeout: 10_000,
  },
});
