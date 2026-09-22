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

## Client design system

- Every client screen is built from `src/client/design/`. Read `src/client/design/README.md` before writing or changing UI: it holds the rules and says which primitive to use for what.
- Use the primitives in `primitives.tsx` and the class recipes in `tokens.ts` (`DS`, `cx`). Do not hand-write a class string for something the system already has; the legacy `components/shared/design-system.ts` module is retired.
- Use opaque semantic surface levels: canvas, pane, group, inset, selection and overlay. Significant regions use `Section surface`; loaded collections have one boundary and a header band, not a box per row/value. Never nest same-level groups. Preserve readable text (4.5:1), composed badge contrast, visible input boundaries (3:1), and use shadows only for overlays.
- When something is missing and a second screen will need it, add it to the design folder with a comment that says what it is for. Do not grow a private `Section`, `Card`, `Chip` or button style inside a component.
- `npm run test:design-audit` is part of `check:fast`, `check:client`, `check:pr` and CI. It blocks the retired patterns: accent fills and outlines, white-on-colour fills, tinted boxes, `rounded-full` state pills, bare coloured status dots (use `StatusIcon` or `IdentitySwatch`), raw Tailwind palette colours, dashed empty boxes, shadows on in-page surfaces, uppercase labels, nested `Panel` components.
- Never add a file to `src/client/design/audit-pending.ts`. The migration backlog is empty; a regression test keeps it empty. `npx tsx src/client/design/audit.ts --explain <file>` explains violations without exempting the screen.
- `// design-audit-ignore-next-line: <reason>` is for content with conventions of its own, such as a diff. It is not for a screen that is hard to restyle.
- Check UI work in both themes and at phone width, on the real screen, before calling it done.

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

## Never block the server's event loop

The server's main thread serves HTTP, health probes, and session event acknowledgements. When it stalls for a few seconds, sessions lose their tool-permission acknowledgements; when it stalls longer, the launcher's watchdog sees a dead server.

- Never start a process from server runtime code with `node:child_process`. Creating a process is a synchronous call on the calling thread (`CreateProcessW` on Windows) and has been measured taking tens of seconds under machine load. Use `getProcessHost()` from `src/server/process-host.ts`: `execFile`/`exec` run a command to completion, `spawn`/`fork` start a long-lived child. It creates every process on a worker thread and enforces `timeout` on the calling thread, so a command whose process cannot be created in time fails instead of holding its caller.
- `spawn` and `fork` are asynchronous. A process that cannot be created still resolves, with `pid` undefined and an `"error"` event, as `child_process.spawn` does. Test mocks must deliver a child's events after the caller subscribes, never from a microtask queued inside `spawn`.
- Never use `execSync`, `execFileSync`, or `spawnSync` in server runtime code. Synchronous helpers for the launcher live in `src/launcher-git.ts` and `src/server/sync-command-runner.ts` and must not be imported by the server.
- Never delete or copy a directory tree synchronously in server runtime code (`rmSync` with `recursive`, `cpSync`, `rmdirSync`). It holds the thread for the whole operation. Use `getProcessHost().removeTree(path)`, which deletes on a worker thread. Prefer it to `fs.promises.rm` for large trees: that keeps the event loop alive but crowds the thread pool every other async file read shares.
- Never open a file that another program keeps writing synchronously in server runtime code. On Windows an antivirus scan holds the open of a recently written file until the scan is done, and `node:sqlite` is synchronous: reading the Copilot CLI's `session-store.db` on the main thread froze the live server for 12.2 s under load. That store is read and written only through `src/server/cli-session-store.ts`, which runs `cli-session-store-worker.ts` on a worker thread and makes callers `await` the answer. For plain files outside the data directory use `fs.promises`.
- `src/server/__tests__/main-thread-boundary.test.ts` walks the real import graph from the server entry points. It fails on any process-creating import outside `src/server/process-host-worker.ts`, and on any synchronous tree delete or copy, or any module that opens a SQLite database, outside a short list of exceptions, each with its reason.
- Test suites run the inline backend because they mock `node:child_process` on their own thread. The native project sets `BRIDGE_PROCESS_HOST=worker` to run the production path. Setting `BRIDGE_PROCESS_HOST=inline` in `.env` restores calling-thread process creation as an operational fallback.
- Prefer in-process bindings over helper processes for small OS calls (see `loadWindowsKeepAwakeApi` in `src/server/platform.ts`).

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
