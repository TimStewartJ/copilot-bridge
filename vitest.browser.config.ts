import { defineConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

// Needs agent-browser and a real browser; not in `npm test`, run `npm run check:browser` instead.
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
