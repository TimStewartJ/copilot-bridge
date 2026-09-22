import { defineProject } from "vitest/config";
import { nativeProjectScheduling, NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    ...nativeProjectScheduling,
    name: "native",
    include: [NATIVE_TEST_FILES],
    env: {
      ...sharedTestConfig.env,
      // Native tests start real processes and mock nothing, so they run the production path:
      // process creation on worker threads. Other projects use the inline backend because their
      // suites mock node:child_process on the test's own thread.
      BRIDGE_PROCESS_HOST: "worker",
      // The shared setup stubs native process snapshots for parallel projects; see vitest-setup.ts.
      BRIDGE_TEST_REAL_PROCESS_SNAPSHOTS: "1",
    },
  },
});
