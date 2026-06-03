import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: [
      "src/server/**/*.test.ts",
      "src/shared/**/*.test.ts",
    ],
    exclude: [
      "src/server/__tests__/pre-deploy-checkpoint.test.ts",
      "src/server/__tests__/staging-preview-backend.test.ts",
      "src/server/__tests__/staging-tools.test.ts",
    ],
    environment: "node",
    env: {
      NODE_ENV: "test",
    },
    testTimeout: 10_000,
    // Use threads pool instead of forks. Forks-on-Windows + node:sqlite +
    // chatty stdout from large api-routes-* test files (each spamming
    // "[scheduler] Shut down" per test) intermittently kills worker child
    // processes via what looks like an IPC buffer/handle issue. Threads
    // share the parent process so worker IPC is not involved, eliminating
    // the "Worker exited unexpectedly" flake without changing test behavior.
    pool: "threads",
  },
});
