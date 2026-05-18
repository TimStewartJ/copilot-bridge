import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["src/client/**/*.test.ts"],
    environment: "node",
    // Client React DOM tests are expected to use src/client/test-react-harness.ts
    // so each file owns DOM setup, React act boundaries, and root cleanup.
    fileParallelism: true,
    env: {
      NODE_ENV: "test",
    },
    testTimeout: 10_000,
  },
});
