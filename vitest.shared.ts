export const sharedTestConfig = {
  root: ".",
  environment: "node",
  env: {
    NODE_ENV: "test",
    // Retention sweeps fire in the background as a side effect of writing a log.
    // Deploy validation runs this suite with BRIDGE_VALIDATION_LOG_DIR pointed at
    // the live data dir, so without this guard a test exercising a real code path
    // would delete real logs. Tests that assert sweep behavior call the prune
    // functions directly or clear this var explicitly.
    BRIDGE_DISABLE_BACKGROUND_LOG_RETENTION: "1",
  },
  // Deploy validation runs the full suite in parallel while the live bridge
  // server is still serving, so wall-clock work (SQLite migrations, docs FTS
  // indexing, React/esbuild transforms, real-timer deadline tests) can stall
  // well past an idle-machine baseline. The slowest legitimate test spends
  // ~6s on real timers, so a 10s budget left under 2x headroom and tripped a
  // different, unrelated pair of tests on every contended run. 30s keeps
  // genuine hangs fast to surface while absorbing load spikes.
  testTimeout: 30_000,
  hookTimeout: 30_000,
} as const;
