import { scrubAmbientRuntimeEnv } from "./src/test-support/hermetic-test-env.js";

// Runs in the Vitest main process while configs load, before any worker starts,
// so every worker and child process inherits the scrubbed environment.
scrubAmbientRuntimeEnv();

const isWindows = process.platform === "win32";

// Tests that drive real OS process trees (PowerShell/CIM snapshots, taskkill,
// staged backend children, the Copilot CLI) are named *.native.test.ts and run
// only in the native project. Parallel projects exclude them.
export const NATIVE_TEST_FILES = "src/**/*.native.test.ts";

// On Windows the native project runs one file at a time after every parallel
// project finishes. Sharing the machine with one worker per core pushed CIM
// snapshots and child startup past their budgets and failed unrelated deploys.
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
    // Retention sweeps fire in the background as a side effect of writing a log.
    // Deploy validation exports BRIDGE_VALIDATION_LOG_DIR pointed at the live
    // data dir. The ambient env scrub drops it, and this guard keeps any test
    // exercising a real code path from sweeping logs it did not create. Tests
    // that assert sweep behavior call the prune functions directly or clear this
    // var explicitly.
    BRIDGE_DISABLE_BACKGROUND_LOG_RETENTION: "1",
  },
  // Test-only HTTP clients keep one listener and agent per isolated test file.
  // Pin this invariant so a future Vitest default or optimization cannot share
  // and close that transport while another file is still using it.
  isolate: true,
  // See src/test-support/vitest-setup.ts: contention-tolerant vi.waitFor defaults.
  setupFiles: ["./src/test-support/vitest-setup.ts"],
  // Deploy validation runs the full suite in parallel while the live bridge
  // server is still serving, and other sessions may be validating at the same
  // time, so wall-clock work (SQLite migrations, docs FTS indexing, React/esbuild
  // transforms, filesystem fixtures) can stall far past an idle-machine
  // baseline. Repeated full runs on a shared 16-thread machine saw tests that
  // normally take 0.5-2s take 20-34s under that load, so 30s still failed on
  // contention alone. Deterministic tests need no tighter bound, and a genuine
  // hang still surfaces within a minute.
  testTimeout: 60_000,
  hookTimeout: 60_000,
} as const;
