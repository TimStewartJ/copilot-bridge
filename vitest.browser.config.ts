import { defineConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

// Checks that need agent-browser and a real browser on the machine. They are not part of
// `npm test`: run `npm run check:browser` after either of the two was updated.
export default defineConfig({
  test: {
    ...sharedTestConfig,
    name: "browser",
    include: ["src/**/*.browser-check.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    env: {
      ...sharedTestConfig.env,
      BRIDGE_PROCESS_HOST: "worker",
      BRIDGE_TEST_REAL_PROCESS_SNAPSHOTS: "1",
    },
  },
});
