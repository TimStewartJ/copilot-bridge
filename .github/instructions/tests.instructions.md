---
applyTo: "**/*.test.ts,**/*.test.tsx,**/__tests__/**,src/test-support/**,src/client/test-*.ts,vitest*.ts"
description: "Tests: what is worth testing, determinism, platform mocking, cross-platform helpers, React harness, audits"
---

# Tests

## What to test

Every test is code someone has to keep passing through later refactors, so add one only when it protects behavior that would otherwise break unnoticed.

- Write the fewest tests that prove the change. A behavior is covered by one test at the layer that owns it, not by a new test for each input you tried.
- Before adding an `it`, extend an existing case or `it.each` table when the new case differs only in its input. A new test needs a new branch, failure mode or contract.
- Test through public behavior: return values, persisted state, emitted events, HTTP responses, rendered text and roles. Do not reach into private fields with `as any` when a public method or observable effect can show the result, and do not assert internal call order or call counts unless the order or count is itself the contract (for example "sends exactly once").
- Do not write tests that cannot fail for a real bug:
  - a mock configured to return a value, then a check that the code returned that value
  - an expected value computed with the function under test
  - pass-through wrappers, constants, default labels, or shapes TypeScript already checks
  - a negative check for text or a feature the code no longer has
- Do not read source files and match their text. Run the code and check what it does. The deliberate structural guards (main-thread boundary, in-tree packages, the xplat and design audits) are the exceptions.
- HTTP route tests in `src/integration/` cover validation, status codes, serialization and wiring, with one representative case per behavior. Business rules belong in the owning store or service unit test and are checked once there.
- Client API wrappers in `src/client/api*.ts` only need tests for client-side logic such as ID encoding, query building or response projection. The route integration tests cover the request itself.
- Put logic that needs many cases (geometry, keyboard handling, formatting, classification) in a pure function and test it with a table. Keep a few component tests that prove the wiring.
- When a fix needs a regression test, first look for an existing test of that behavior and extend it rather than adding a new scenario with its own setup.
- Share setup through builders in the file or in a helper next to it (`src/server/__tests__/helpers.ts`, `test-app.ts`, per-area `*-helpers.ts` or `*-harness.ts`). Copying a 30-line fixture into each test is a sign a builder is missing.
- When you remove a feature or a compatibility shim, remove its tests in the same change.

## Deterministic tests

- Do not depend on wall-clock budgets. The full suite runs one worker per core on a shared machine, so real I/O can be many times slower than on an idle machine.
- Wait for a completion signal (a returned promise, a `settle()`/`waitFor*Idle()` hook, a lifecycle callback) instead of polling. When polling is unavoidable, use the shared `vi.waitFor` default from `src/test-support/vitest-setup.ts`, not a tight explicit timeout.
- Fake only what the test needs. Code under test yields with `setImmediate` and does real I/O, so a test that only needs a fixed calendar uses `vi.useFakeTimers({ toFake: ["Date"] })`.
- Production deadlines (session release and retirement budgets, capacity waits, RPC bounds) run on real timers. A test that holds such an operation open and then asserts on state calls `freezeLifecycleDeadlines()` from `src/server/__tests__/helpers.ts` and restores real timers in `afterEach`.
- Background work a test starts must finish before the test ends, or it races temp-directory cleanup and the next test.
- A run keeps its temp files in one folder of its own (`useRunTempDir` in `src/test-support/hermetic-test-env.ts`), removed when the run ends. `os.tmpdir()` is that folder in every worker and child process, so keep using `makeTestDir` and never build a path under `/tmp` by hand.
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
