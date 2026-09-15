# Agent Guidance

These instructions apply to the whole repository. Keep changes small, typed, cross-platform, and consistent with existing patterns.

## Project shape

- Runtime: Node 22+, ESM TypeScript, Express server, React/Vite client, SQLite storage.
- Main server code lives in `src/server/`; client code lives in `src/client/`; launcher code lives in `src/launcher.ts`.
- Prefer existing stores, platform helpers, test helpers, and API/client patterns before adding new abstractions.

## Editing and validation

- Use the established staging workflow for deployable Bridge changes; do not edit a production deployment checkout directly.
- Staging worktrees intentionally own their `node_modules`; run `npm install --no-audit --no-fund --include=dev` in a fresh worktree before direct checks, and never link it to production dependencies.
- Run `npm run check:fast` during normal implementation loops.
- Run the focused lane that matches the changed area: `check:client`, `check:server`, `check:integration`, `check:launcher`, `check:staging`, or `check:native`.
- Run `npm run check:pr` before asking for review, previewing, or preparing deployment.
- Documentation-only edits do not need the full test suite unless they change generated docs, scripts, examples, or validation guidance.

## Client React tests

- Use `src/client/test-react-harness.ts` for React DOM client tests so DOM shim setup, React `act`, root unmount, and async flushing stay consistent.
- Do not import `react-dom`, `react-dom/client`, or create React roots directly from client test files unless you are changing the harness itself.
- Keep React DOM imports after the DOM shim is installed. The shared harness already does this with dynamic imports.
- Wrap user interactions, rerenders, and timer advancement in the harness `act`. Prefer fake timers plus `advanceTimersByTimeAct` for known delays instead of wall-clock sleeps. Harness flushes only drain microtasks under real timers, so install fake timers when a client test depends on timers or non-microtask scheduling.
- Client tests should remain safe under Vitest file parallelism; avoid shared global mutation that is not restored by the harness cleanup.

## Cross-platform rules

- Code and tests must work on both Linux and Windows.
- Build paths with `path.join`, `path.resolve`, or the appropriate `path.posix`/`path.win32` helper. Do not concatenate separators or assume `/`.
- Split lines with `/\r?\n/` when reading text that may come from Windows.
- Put OS-specific process, shell, and filesystem behavior behind `src/server/platform.ts` or an existing platform abstraction.
- Prefer `execFile`/argument arrays over shell commands. Do not rely on shell escaping for correctness.
- Use `src/server/__tests__/test-paths.ts` helpers for fake homes, normalized path assertions, and fake executable paths.
- Do not skip Windows with `skipIf(isWindows)` when behavior can be tested with mocks.

## Platform mocking in tests

Do not mock platform detection while performing real native OS side effects. If a test sets `process.platform`, mocks `node:os.platform`, or otherwise forces a platform branch, then native side effects for that branch must also be mocked.

Examples of native side effects include:

- `fs.symlinkSync`, directory junctions, chmod/permission behavior, and other platform-sensitive filesystem calls.
- `child_process` calls, process tree commands, shell commands, and executable discovery.
- OS-specific path parsing where the host platform changes semantics.

Use this split instead:

- Mocked unit tests verify branch selection, arguments, and error handling for each platform.
- Real filesystem/process integration tests use the actual host platform and platform-native behavior.
- Name tests that drive real OS process trees (PowerShell/CIM snapshots, `taskkill`, staged backend children, the Copilot CLI) `*.native.test.ts`. Only the `native` project runs them, one file at a time on Windows after the parallel projects finish, so unit-test load cannot starve their process budgets.
- If a real integration test can fail because of local machine policy, use a narrow capability probe skip for that integration test only, and keep the mocked unit tests mandatory.

For directory links specifically, Windows should use junctions and POSIX should use directory symlinks. Prefer `createDirectoryLink` over direct `fs.symlinkSync` calls so this behavior stays centralized.

## Deterministic tests

- Tests must not depend on wall-clock budgets. The full suite runs one worker per core while the live bridge and other validations share the machine, so real I/O can take many times longer than on an idle machine.
- Wait for a completion signal (a returned promise, a `settle()`/`waitFor*Idle()` hook, or a lifecycle callback) rather than polling for background work. When polling is unavoidable, rely on the shared `vi.waitFor` default from `src/test-support/vitest-setup.ts` instead of a tight explicit timeout.
- Fake only what a test needs. Code under test yields with `setImmediate` and schedules real I/O, so a test that only needs a fixed calendar should use `vi.useFakeTimers({ toFake: ["Date"] })`.
- Production deadlines (session release and retirement budgets, capacity waits, RPC bounds) run on real timers. A test that holds such an operation open and then asserts on state should call `freezeLifecycleDeadlines()` from `src/server/__tests__/helpers.ts` and restore real timers in `afterEach`, so a starved worker cannot expire a deadline between arranging a state and asserting it.
- Background work a test starts must finish before the test ends; otherwise it races temp-directory cleanup and the next test.
- Tests never see the live Bridge runtime environment. `vitest.shared.ts` strips inherited `BRIDGE_*`, `COPILOT_*`, and GitHub token variables before workers start, so stub what a test needs with `vi.stubEnv()` or `withTestEnv()`.

## Test audit expectations

- `npm run test:xplat-audit` is part of `check:fast` and blocks known non-portable test patterns.
- Avoid adding `xplat-audit-ignore-*` comments. If one is truly necessary, keep it as narrow as possible and explain why the test remains safe.
