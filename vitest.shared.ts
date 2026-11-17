import { scrubAmbientRuntimeEnv, useRunHomeDir, useRunTempDir } from "./src/test-support/hermetic-test-env.js";

// Runs before any worker starts, so all inherit the scrubbed env and the run's temp and home.
scrubAmbientRuntimeEnv();
useRunHomeDir(useRunTempDir());

const isWindows = process.platform === "win32";

// Tests driving real OS process trees are *.native.test.ts and run only in native.
export const NATIVE_TEST_FILES = "src/**/*.native.test.ts";

// Windows: native runs serially after parallel projects; contention broke CIM snapshots.
export const nativeProjectScheduling = {
  pool: "threads",
  fileParallelism: !isWindows,
  maxWorkers: isWindows ? 1 : undefined,
  sequence: {
    groupOrder: isWindows ? 1 : 0,
  },
} as const;

export const sharedTestConfig = {
  root: ".",
  environment: "node",
  env: {
    NODE_ENV: "test",
    // No background log sweeps in tests: real code paths must not delete logs they didn't create.
    BRIDGE_DISABLE_BACKGROUND_LOG_RETENTION: "1",
  },
  // Each test file owns its HTTP listener; pin isolation so files never share and close it.
  isolate: true,
  // See src/test-support/vitest-setup.ts: contention-tolerant vi.waitFor defaults.
  setupFiles: ["./src/test-support/vitest-setup.ts"],
  // Under shared load 0.5-2 s tests took 20-34 s and 30 s failed; 60 s still surfaces hangs.
  testTimeout: 60_000,
  hookTimeout: 60_000,
} as const;
