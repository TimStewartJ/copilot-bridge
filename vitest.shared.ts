export const sharedTestConfig = {
  root: ".",
  environment: "node",
  env: {
    NODE_ENV: "test",
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
