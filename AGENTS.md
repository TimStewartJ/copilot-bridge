# Agent Guidance

These rules apply to the whole repository. Keep changes small, typed, cross-platform, and consistent with existing patterns.

Rules for one area live in `.github/instructions/`. Read the matching file before you change code there:

- `src/client/**`: `.github/instructions/client-ui.instructions.md`
- `src/server/**`: `.github/instructions/server-runtime.instructions.md`
- `src/packages/**`: `.github/instructions/packages.instructions.md`
- Tests and test support: `.github/instructions/tests.instructions.md` (also read it before adding tests anywhere: it says which tests are worth writing)

Add a rule here only if it applies across the repository and no check enforces it. Put area rules in the matching instructions file, and the reasoning behind a check in its tests and its one-line comments.

## Project shape

- Runtime: Node 22+, ESM TypeScript, Express server, React/Vite client, SQLite storage.
- Server code lives in `src/server/`, client code in `src/client/`, launcher code in `src/launcher.ts`.
- `src/packages/` holds code that is published to npm by itself and that the Bridge imports by relative path. It must not import anything from the rest of the repository.
- Use existing stores, platform helpers, test helpers, and API/client patterns before adding new abstractions.
- This repository is public on GitHub, and a deploy pushes it there. Examples, tests, comments and docs use made-up values (`100.64.0.x`, `<host>.example.ts.net`, `bridge.example.devtunnels.ms`, `user@example.com`, `exampleorg`), never the owner's real addresses, machine names, accounts, people or data copied from their Bridge, and nothing from their employer: org, project or repo names, IDs, colleagues, or work item and pull request titles.

## Editing and validation

- Deployable Bridge changes go through the staging workflow. Never edit a production deployment checkout directly.
- Staging worktrees own their `node_modules`. Run `npm install --no-audit --no-fund --include=dev` in a fresh worktree before direct checks, and never link it to production dependencies.
- While implementing, run `npm run check:fast` and the lane for the area you changed: `check:client`, `check:server`, `check:packages`, `check:integration`, `check:launcher`, `check:staging`, or `check:native`.
- `npm run check:pr` is the review gate. `staging_preview` runs it, and `staging_deploy` runs it when preview validation was skipped or invalidated, so do not run it by hand right before them. Outside that workflow, run it before asking for review.
- Documentation-only edits need no test run unless they change generated docs, scripts, examples, or validation guidance.
- Agent shells get a scratch `COPILOT_HOME` (`src/server/agent-shell-env.ts`), so ad-hoc scripts that create a `CopilotClient` stay out of the Bridge's chat list. Never point such a script at the Bridge's own `COPILOT_HOME`.
- A chat a script starts through the REST API (`POST /api/sessions` or `/api/tasks/:id/session` without the web client's `X-Bridge-Client` header or a browser's `Sec-Fetch-Site`) is a scratch chat: it works and opens by URL, but no list, search or task shows it, and maintenance deletes it after a day idle (`src/server/scratch-sessions.ts`). Start a chat meant for the user with `session_start`.
- Docs must not copy figures that another file determines: package versions, download or definition sizes, counts, totals worked out from several constants, or benchmark results. Name the file or constant that holds the value instead. A single configured limit can be stated, ideally with its constant named. A measurement kept as evidence says what it was measured on.

## Comments

- A comment is one line of at most 100 columns, counting its indentation and any code before it. No multi-line `/* */` or `/** */` blocks, and no two comments without code between them. Exported functions, types and fields keep the `/** one line */` form so editors show it on hover.
- Comment only what the code cannot say: a constraint or a trap that someone would otherwise break. Leave out history, incident stories, measurements, and what names and types already say.
- When a trap needs more than a line to explain, write a test that fails when someone falls into it, name the test after the trap, and point to it from the comment. Longer background goes in the commit message.
- `npm run test:comment-audit` (in `check:fast`, `check:pr` and CI) enforces the form. Tool directives such as `@ts-expect-error`, `agent-text-audit:` and `/*#__PURE__*/` (listed in `src/server/comment-audit.ts`) may sit next to another comment.

## Agent output

Never decide anything from the words a model wrote. That covers assistant replies and reasoning, the replies of helper, Helm and hands-free models, sub-agent and defer results, and the free text an agent puts in tool arguments (notes, summaries, titles, descriptions). Do not test such text with `includes`, `startsWith`, `===`, regexes or word lists, and do not ask a model to say a word so that code can look for it.

- Decide from a structured signal instead: a tool call and its typed or enum arguments, a JSON reply with enum fields, event types, ids, or the Bridge's own state. When the Bridge needs to know what it said or showed (an offer, a placeholder), it decides that itself and keeps a record, rather than reading it back from text a model can also write.
- Parsing a defined format in model output is fine (JSON, ids, links, ISO dates, markup the Bridge inserts), and so are display formatting and using the text as a search query.
- Tests follow the same rule: mock model replies as structured values, check structured results, and never require a model to say particular words.

`npm run test:agent-text-audit` (in `check:fast` and `check:pr`) flags regex literals that match words and multi-word string literals compared or searched for in production code. Each must name where its text comes from in an `agent-text-audit:` comment, and `agent` is never an accepted source; `src/server/agent-text-audit.ts` lists the sources. The audit cannot see needles held in variables, word sets or single-word checks, so the rule applies where it is silent too.

## Cross-platform code

- Code and tests must work on Linux and Windows.
- Build paths with `path.join`, `path.resolve`, or `path.posix`/`path.win32`. Do not concatenate separators or assume `/`.
- Split text that may come from Windows with `/\r?\n/`.
- Keep OS-specific process, shell, and filesystem behavior behind `src/server/platform.ts` or an existing platform abstraction.
- Pass values to a program as arguments (`commandLine()`, `createGitCommand()`, `execFile`), never inside shell text. Shell text is a `ShellCommand`, made only by `` sh`...` `` in `src/server/shell-command.ts`, which accepts constant text. Every runner that can start a shell takes that type, so `tsc` rejects a command built from values.

## Server event loop

Server runtime code must never block the main thread:

- Do not import `node:child_process` (use `getProcessHost()`), call `execSync`/`execFileSync`/`spawnSync`, or delete or copy a directory tree synchronously.
- Do not synchronously open a file another program keeps writing. `node:sqlite` is synchronous, so only the modules listed in the boundary test open SQLite (chiefly `src/server/db.ts`, the Bridge's own database). The Copilot CLI's session store goes through the worker in `src/server/cli-session-store.ts`.

`src/server/__tests__/main-thread-boundary.test.ts` enforces the process, tree, and SQLite rules; nothing checks other externally written files. `server-runtime.instructions.md` lists what to use instead.
