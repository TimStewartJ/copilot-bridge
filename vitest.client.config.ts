import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["src/client/**/*.test.ts"],
    environment: "node",
    // Client component tests use a lightweight global DOM shim and real timers.
    // Running files concurrently can starve timing-sensitive React waits, so the
    // PR gate keeps this lane deterministic by executing client files serially.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
    },
    testTimeout: 10_000,
  },
});
