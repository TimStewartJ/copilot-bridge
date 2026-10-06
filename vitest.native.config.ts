import { defineProject } from "vitest/config";
import { nativeProjectScheduling, NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    ...nativeProjectScheduling,
    name: "native",
    include: [NATIVE_TEST_FILES],
    // These tests wait on real processes (the Copilot CLI, staged backends), so how long they take
    // follows the host: with other validations running, tests that take 3-8 s on an idle machine
    // took 25-60 s. Not higher: when a runtime shared by a file hangs, each of its tests waits
    // this long, and the gate has a limit of its own (VALIDATION_TIMEOUT_MS).
    testTimeout: 120_000,
    hookTimeout: 120_000,
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
