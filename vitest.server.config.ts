import { defineProject } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "server",
    include: [
      "src/server/**/*.test.ts",
      "src/shared/**/*.test.ts",
    ],
    exclude: [
      "src/server/__tests__/pre-deploy-checkpoint.test.ts",
      "src/server/__tests__/staging-preview-backend.test.ts",
      "src/server/__tests__/staging-tools.test.ts",
    ],
    // Use threads pool instead of forks. Forks-on-Windows + node:sqlite +
    // high-volume server test output intermittently kills worker child
    // processes through IPC. Threads avoid that worker process boundary.
    pool: "threads",
  },
});
