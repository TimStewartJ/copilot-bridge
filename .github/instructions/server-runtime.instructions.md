---
applyTo: "src/server/**"
description: "Server runtime: keep the event loop free (processes, tree deletes, SQLite, busy files)"
---

# Server runtime: never block the event loop

The server's main thread serves HTTP, health probes, and session event acknowledgements. A stall of a few seconds makes sessions lose tool-permission acknowledgements; a longer one makes the launcher's watchdog see a dead server.

- **Processes.** Do not use `node:child_process` in server runtime code. Creating a process is a synchronous call on the calling thread (`CreateProcessW` on Windows) and has taken tens of seconds under load. Use `getProcessHost()` from `src/server/process-host.ts`: `execFile`/`exec` run a command to completion, `spawn`/`fork` start a long-lived child. It creates processes on a worker thread and enforces `timeout` on the calling thread.
- `spawn` and `fork` are asynchronous. A process that cannot be created still resolves, with `pid` undefined and an `"error"` event, as `child_process.spawn` does.
- **No synchronous process calls.** Never use `execSync`, `execFileSync`, or `spawnSync`. The launcher's synchronous helpers (`src/launcher-git.ts`, `src/server/sync-command-runner.ts`) must not be imported by the server.
- **Directory trees.** Never delete or copy a tree synchronously (`rmSync` with `recursive`, `cpSync`, `rmdirSync`). Use `getProcessHost().removeTree(path)`, which deletes on a worker thread. Prefer it to `fs.promises.rm` for large trees, which crowds the thread pool that other async file reads share.
- **Files other programs write.** Never open such a file synchronously. On Windows an antivirus scan can hold the open of a recently written file, and `node:sqlite` is synchronous. The Copilot CLI's `session-store.db` is read and written only through `src/server/cli-session-store.ts`, which uses a worker thread (`cli-session-store-worker.ts`). For plain files outside the data directory use `fs.promises`.
- Prefer in-process bindings over helper processes for small OS calls (see `loadWindowsKeepAwakeApi` in `src/server/platform.ts`).

## Enforcement and testing

- `src/server/__tests__/main-thread-boundary.test.ts` walks the import graph from the server entry points. It fails on a process-creating import outside `src/server/process-host-worker.ts`, and on a synchronous tree delete or copy or a SQLite open outside a short list of exceptions, each with its reason. The SQLite list is `db.ts` (the Bridge's own database), the session-store worker, and the staging backend manager's preview seeding. It does not check other files that external programs write.
- Test suites run the inline process host because they mock `node:child_process` on their own thread. The native project sets `BRIDGE_PROCESS_HOST=worker` to run the production path. `BRIDGE_PROCESS_HOST=inline` in `.env` is an operational fallback.
- Test mocks must deliver a child's events after the caller subscribes, never from a microtask queued inside `spawn`.
