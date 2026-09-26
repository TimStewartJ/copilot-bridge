# Agent Guidance

These rules apply to the whole repository. Keep changes small, typed, cross-platform, and consistent with existing patterns.

Rules for one area live in `.github/instructions/`. Read the matching file before you change code there:

- `src/client/**`: `.github/instructions/client-ui.instructions.md`
- `src/server/**`: `.github/instructions/server-runtime.instructions.md`
- Tests and test support: `.github/instructions/tests.instructions.md`

Add a rule here only if it applies across the repository and no check enforces it. Put area rules in the matching instructions file, and the reasoning behind a check next to the check.

## Project shape

- Runtime: Node 22+, ESM TypeScript, Express server, React/Vite client, SQLite storage.
- Server code lives in `src/server/`, client code in `src/client/`, launcher code in `src/launcher.ts`.
- Use existing stores, platform helpers, test helpers, and API/client patterns before adding new abstractions.

## Editing and validation

- Deployable Bridge changes go through the staging workflow. Never edit a production deployment checkout directly.
- Staging worktrees own their `node_modules`. Run `npm install --no-audit --no-fund --include=dev` in a fresh worktree before direct checks, and never link it to production dependencies.
- While implementing, run `npm run check:fast` and the lane for the area you changed: `check:client`, `check:server`, `check:integration`, `check:launcher`, `check:staging`, or `check:native`.
- `npm run check:pr` is the review gate. `staging_preview` runs it, and `staging_deploy` runs it when preview validation was skipped or invalidated, so do not run it by hand right before them. Outside that workflow, run it before asking for review.
- Documentation-only edits need no test run unless they change generated docs, scripts, examples, or validation guidance.

## Cross-platform code

- Code and tests must work on Linux and Windows.
- Build paths with `path.join`, `path.resolve`, or `path.posix`/`path.win32`. Do not concatenate separators or assume `/`.
- Split text that may come from Windows with `/\r?\n/`.
- Keep OS-specific process, shell, and filesystem behavior behind `src/server/platform.ts` or an existing platform abstraction.
- Pass argument arrays (`execFile`-style) instead of shell strings. Do not rely on shell escaping for correctness.

## Server event loop

Server runtime code must never block the main thread:

- Do not import `node:child_process` (use `getProcessHost()`), call `execSync`/`execFileSync`/`spawnSync`, or delete or copy a directory tree synchronously.
- Do not synchronously open a file another program keeps writing. `node:sqlite` is synchronous, so only the modules listed in the boundary test open SQLite (chiefly `src/server/db.ts`, the Bridge's own database). The Copilot CLI's session store goes through the worker in `src/server/cli-session-store.ts`.

`src/server/__tests__/main-thread-boundary.test.ts` enforces the process, tree, and SQLite rules; nothing checks other externally written files. `server-runtime.instructions.md` lists what to use instead.
