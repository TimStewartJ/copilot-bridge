---
applyTo: "**/*.test.ts,**/*.test.tsx,**/__tests__/**,src/test-support/**,src/client/test-*.ts,vitest*.ts"
description: "Tests: determinism, platform mocking, cross-platform helpers, React harness, audits"
---

# Tests

## Deterministic tests

- Do not depend on wall-clock budgets. The full suite runs one worker per core on a shared machine, so real I/O can be many times slower than on an idle machine.
- Wait for a completion signal (a returned promise, a `settle()`/`waitFor*Idle()` hook, a lifecycle callback) instead of polling. When polling is unavoidable, use the shared `vi.waitFor` default from `src/test-support/vitest-setup.ts`, not a tight explicit timeout.
- Fake only what the test needs. Code under test yields with `setImmediate` and does real I/O, so a test that only needs a fixed calendar uses `vi.useFakeTimers({ toFake: ["Date"] })`.
- Production deadlines (session release and retirement budgets, capacity waits, RPC bounds) run on real timers. A test that holds such an operation open and then asserts on state calls `freezeLifecycleDeadlines()` from `src/server/__tests__/helpers.ts` and restores real timers in `afterEach`.
- Background work a test starts must finish before the test ends, or it races temp-directory cleanup and the next test.
- Tests never see the live Bridge environment: `vitest.shared.ts` strips inherited `BRIDGE_*`, `COPILOT_*`, and GitHub token variables. Stub what a test needs with `vi.stubEnv()` or `withTestEnv()`.

## Platform mocking

- If a test forces a platform branch (sets `process.platform`, mocks `node:os.platform`, and so on), mock that branch's native side effects too: symlinks, junctions, chmod and permissions, `child_process` and process-tree commands, executable discovery, host-dependent path parsing.
- Mocked unit tests cover branch selection, arguments, and error handling for each platform. Real filesystem and process tests use the actual host platform.
- Name tests that drive real OS process trees (PowerShell/CIM snapshots, `taskkill`, staged backend children, the Copilot CLI) `*.native.test.ts`. Only the `native` project runs them, one file at a time on Windows.
- If a real integration test can fail because of local machine policy, skip only that test behind a narrow capability probe, and keep the mocked unit tests mandatory.
- Do not `skipIf(isWindows)` behavior that can be tested with mocks.
- Use `createDirectoryLink` (junctions on Windows, symlinks on POSIX) instead of `fs.symlinkSync`, and `src/server/__tests__/test-paths.ts` for fake homes, normalized path assertions, and fake executable paths.

## Client React tests

- Use `src/client/test-react-harness.ts`. It owns the DOM shim, React `act`, root unmount, and async flushing.
- Do not import `react-dom` or `react-dom/client`, or create roots, from client test files.
- Wrap interactions, rerenders, and timer advancement in the harness `act`. For known delays, use fake timers and `advanceTimersByTimeAct`, not sleeps. Harness flushes only drain microtasks under real timers.
- Tests must be safe under Vitest file parallelism: restore any global state you change.

## Audits

- `npm run test:xplat-audit` runs in `check:fast` and blocks known non-portable test patterns. Avoid `xplat-audit-ignore-*` comments; if one is truly necessary, keep it narrow and say why the test is still safe.
