# Copilot Bridge

Copilot Bridge is a local, task-centric AI workspace built on the GitHub Copilot SDK. It combines persistent Copilot sessions, tasks, notes, docs, schedules, linked work, and tool-rich automation in one opinionated app.

This repo is intentionally personal. The goal is not to build a generic SaaS product, but to shape an AI workspace around how one person actually works and then keep iterating on it.

## Screenshots

![Copilot Bridge dashboard with the seeded Acme launch workspace](assets/readme/dashboard-overview.png)

The seeded demo opens into a fictional Acme launch workspace so the first-run experience already shows the task rail, dashboard, docs, and follow-up workflow working together.

<table>
  <tr>
    <td width="50%">
      <img src="assets/readme/task-workspace.png" alt="Task workspace showing notes, todos, schedules, and related context" />
    </td>
    <td width="50%">
      <img src="assets/readme/docs-launch-notes.png" alt="Docs collection showing the seeded launch notes database" />
    </td>
  </tr>
  <tr>
    <td><strong>Task workspace</strong> — notes, todos, schedules, and linked context stay attached to the work.</td>
    <td><strong>Docs collection</strong> — markdown pages and database-style collections live in the same workspace.</td>
  </tr>
</table>

## Why It Is Interesting

- **Task-centric instead of chat-centric** - sessions live next to notes, todos, schedules, docs, and linked work.
- **Persistent local workspace** - SQLite-backed app state plus a markdown knowledge base means work survives restarts and browser refreshes.
- **Large tool surface** - the agent can manage tasks, tags, todos, docs, schedules, browser sessions, web search, and optional desktop automation from inside the same workspace.
- **Built to improve itself** - launcher-managed restart, update, staging preview, and rollback flows make local self-iteration practical.

## What It Does

- **Task workspace** - tasks, task groups, tags, notes, todos, linked sessions, linked work items, linked pull requests, and task dashboards.
- **Persistent Copilot sessions** - quick chats and task-scoped chats with SSE streaming, tool call indicators, unread state, drafts, and archive support.
- **Knowledge base** - markdown pages, wikilinks, preview sheets, and database-style collections for structured notes.
- **Schedules** - cron or one-shot prompts that can create a fresh session or reuse an existing one.
- **Provider enrichment** - optional Azure DevOps, GitHub, and Linear integrations for richer work item and pull request cards.
- **Tool-rich automation** - built-in task/doc/schedule tools, web search, browser fetch/exec/session tools, and optional computer-use tools.
- **Workspace customization** - model, reasoning effort, agent identity, custom instructions, theme, favicon, and MCP server registry from the UI.
- **Remote-friendly local deployment** - dev tunnels or your own ingress, optional startup webhooks, and canonical public URL support for previews.

## Architecture

```
┌────────────────────────────────────────────────────┐
│ Launcher (src/launcher.ts)                         │
│ - Starts server + optional tunnel/webhook          │
│ - Handles self_restart / self_update               │
│ - Performs build, health checks, rollback          │
├────────────────────────────────────────────────────┤
│ Express server (src/server/)                       │
│ - REST API + SSE streams                           │
│ - Copilot SDK session manager + custom tools       │
│ - SQLite stores (tasks, schedules, settings, etc.) │
│ - Docs KB, browser tools, staging tools            │
├────────────────────────────────────────────────────┤
│ React client (src/client/)                         │
│ - Dashboard, task rail/panel, chat, docs, settings │
│ - React Query + streaming UI                       │
│ - Mobile-friendly touches like pull-to-refresh     │
└────────────────────────────────────────────────────┘
```

## Getting Started

### Prerequisites

- Node.js 22+ (uses `node:sqlite`)
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`npm install -g @github/copilot`)
- [Dev Tunnel CLI](https://aka.ms/devtunnels) (optional, for remote access)
- Optional provider config for Azure DevOps, GitHub, or Linear if you want enriched work items and pull requests
- Optional `COMPUTER_USE=true` if you want desktop automation tools on a trusted local machine

### Install

```bash
git clone https://github.com/timstewartj/copilot-bridge.git
cd copilot-bridge
npm install
cp .env.example .env   # Edit .env with your settings if needed
```

The launcher and direct server entrypoint load `.env` automatically at startup. Existing exported environment variables still win over values from the file.

### Demo Workspace

If you want a guided sample workspace instead of a blank local workspace, use the seeded demo:

```bash
npm run demo:start   # seed demo-data/, build the client, and start the demo workspace
npm run demo:reset   # recreate the demo workspace from scratch
```

The demo uses an isolated `demo-data/` directory, its own `.copilot` state, and a sandbox task workspace, so it does not touch your normal `data/` workspace or everyday bridge sessions.

It is intentionally scoped to the guided workspace experience. If you want the full launcher-driven restart/update flow, use `npm run dev` instead.

When it starts:

1. Open the pinned **Start Here - Acme Launch Workspace** task.
2. Read the task note and related docs.
3. Start a task chat and try one of the suggested prompts.
4. Trigger the sample schedule.
5. Add an item to the **Launch Notes** docs collection.

### Run (Development)

```bash
npm run dev          # Launcher + server + tunnel/webhook support
npm run dev:server   # Server only
npm run dev:client   # Vite dev server with HMR
```

### Fastest Path to Value

If you are opening the bridge for the first time, keep it simple:

1. Run `npm run demo:start` if you want the guided sample workspace, or `npm run dev` if you want a blank workspace.
2. Go to **Settings** and pick your model, reasoning effort, theme, and favicon.
3. Skip Azure DevOps/GitHub/Linear setup for now if you just want a clean local demo.
4. Create a task, add a todo and a note, then start a task session.
5. Open **Docs** and create a page or collection entry to exercise the knowledge base.
6. Ask the agent to do something bridge-native, like create a schedule, rename the session, or search the web.

You can get a lot of value on first run without any external work-tracking provider setup: tasks, notes, tags, docs, schedules, and local Copilot sessions all work locally.

### Validate

```bash
npx tsc --noEmit
npm run test:xplat-audit
npm test
npm run test:coverage
npm run build
```

### Cross-Platform Test Rules

- Use the shared helpers in `src/server/__tests__/test-paths.ts` for fake homes, normalized path assertions, and fake executable paths.
- Do not hardcode Unix-only fixtures like `/tmp/...` or `/usr/bin/...` in tests.
- Do not skip Windows with `skipIf(isWindows)` when the behavior can be tested with mocks instead.
- Prefer mocking failure paths over Unix-only filesystem tricks like `chmod`.
- Run `npm run test:xplat-audit` before preview/deploy; `staging_preview` also runs it automatically.

### Build

```bash
npm run build        # Build client + server
npm run build:client # Vite build only
npm run build:server # TypeScript compile only
```

### Public URL Configuration

If you expose the bridge through something other than dev tunnels (for example Cloudflare Tunnel, ngrok, or a reverse proxy), set a canonical public base URL so staging previews can return shareable absolute links:

```bash
BRIDGE_PUBLIC_BASE_URL=https://bridge.example.com
```

If the bridge sits behind a trusted proxy that terminates TLS, also set:

```bash
BRIDGE_TRUST_PROXY=true
```

That allows the server to learn the externally visible origin from incoming requests and use it for staging preview links when no explicit public base URL is configured.

### Auto-Start on Login / Persistent Service (Linux, optional)

You can run the launcher under a user-level `systemd` service:

```ini
# ~/.config/systemd/user/copilot-bridge.service
[Unit]
Description=Copilot Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/you/src/copilot-bridge
ExecStart=/path/to/node /home/you/src/copilot-bridge/node_modules/tsx/dist/cli.mjs /home/you/src/copilot-bridge/src/launcher.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Replace `/path/to/node` with the output of `which node`. If you installed Node through `nvm`, `fnm`, or `asdf`, using the full path is usually more reliable than relying on the service `PATH`.

Then enable it:

```bash
mkdir -p ~/.config/systemd/user
$EDITOR ~/.config/systemd/user/copilot-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now copilot-bridge
systemctl --user status copilot-bridge
journalctl --user -u copilot-bridge -f
```

Because `WorkingDirectory` points at the repo root, the launcher will still load `.env` automatically. If you want the user service to keep running after logout and start on boot, also run:

```bash
loginctl enable-linger "$USER"
```

### Auto-Start on Login (Windows, optional)

You can register a Windows Task Scheduler entry to start the bridge on login:

```powershell
pwsh scripts\start-bridge.ps1   # Start
pwsh scripts\stop-bridge.ps1    # Stop
```

## Project Structure

```
src/
├── launcher.ts                    # Parent process: lifecycle, tunnel, restart/update
├── server/
│   ├── index.ts                   # Express bootstrap
│   ├── api-router.ts              # REST API surface
│   ├── session-manager.ts         # Copilot SDK wrapper + tool registry
│   ├── db.ts                      # SQLite schema/bootstrap
│   ├── task-store.ts              # Tasks, links, ordering
│   ├── todo-store.ts              # Task/global todos
│   ├── schedule-store.ts          # Scheduled sessions
│   ├── docs-store.ts              # Markdown knowledge base
│   ├── settings-store.ts          # App settings + MCP registry
│   ├── staging-tools.ts           # staging_init / preview / deploy
│   └── browser-*.ts               # Browser and web tooling
└── client/
    ├── App.tsx                    # Root app shell + routing
    ├── api.ts                     # Typed client API
    ├── components/
    │   ├── Dashboard.tsx          # Home dashboard
    │   ├── TaskRail.tsx           # Task list and grouping UI
    │   ├── TaskPanel.tsx          # Task details, notes, docs, schedules
    │   ├── ChatView.tsx           # Session history + streaming chat
    │   ├── DocsView.tsx           # Knowledge base UI
    │   └── SettingsView.tsx       # Models, providers, appearance, MCP
    └── hooks/queries/             # React Query data hooks

scripts/
├── start-bridge.ps1               # Start on Windows
└── stop-bridge.ps1                # Stop on Windows

data/                              # Runtime data (git-ignored)
├── bridge.db                      # Primary SQLite store
├── docs/                          # Markdown knowledge base
└── ...                            # Logs, metadata, and runtime state
```

## Self-Iteration and Local Deployment

The bridge includes a few different maintenance paths:

1. **`self_restart`** - restart the bridge after local code/config changes, with launcher-managed build and rollback.
2. **`self_update`** - pull the latest repo state, sync dependencies, and restart safely.
3. **`staging_init` -> `staging_preview` -> `staging_deploy`** - make larger changes in an isolated worktree, preview them, then deploy after approval.

The launcher is responsible for checkpointing, building, health checks, and recovering from bad restarts.

## Logs

```bash
tail -n 30 data/bridge.log
tail -n 30 data/bridge-error.log
```

```powershell
Get-Content data\bridge.log -Tail 30
Get-Content data\bridge-error.log -Tail 30
```
