import { defineProject } from "vitest/config";
import { nativeProjectScheduling, NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    ...nativeProjectScheduling,
    name: "native",
    include: [NATIVE_TEST_FILES],
    // Real processes: 3-8 s tests took 25-60 s under load; higher makes a hung runtime too slow.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      ...sharedTestConfig.env,
      // Production worker process host; other projects mock child_process on the test thread.
      BRIDGE_PROCESS_HOST: "worker",
      // The shared setup stubs native process snapshots for parallel projects; see vitest-setup.ts.
      BRIDGE_TEST_REAL_PROCESS_SNAPSHOTS: "1",
    },
  },
});
