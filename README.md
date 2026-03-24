# Copilot Bridge

A personal work dashboard powered by the GitHub Copilot SDK and Azure DevOps MCP. Accessible from any device via dev tunnel.

## What It Does

- **Task management** — Create tasks, link ADO work items / PRs / Copilot sessions, take notes
- **Copilot chat** — Full agentic Copilot sessions with ADO, GitHub, and local tools
- **SSE streaming** — Real-time streamed responses with tool call indicators
- **Session persistence** — All sessions survive restarts, navigating away, closing the browser
- **Self-iteration** — The agent can edit its own source code and restart the server safely
- **Remote access** — Dev tunnel for remote access, optional webhook notification on startup

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Launcher (src/launcher.ts)                     │
│  Starts server + dev tunnel + webhook notify     │
│  Watches for self_restart signals               │
│  Auto-checkpoint (git) + build + rollback       │
├─────────────────────────────────────────────────┤
│  Express Server (src/server/)                   │
│  ├─ REST API: tasks, sessions, chat             │
│  ├─ SSE streaming via EventBus                  │
│  ├─ Copilot SDK (CopilotClient)                 │
│  │   ├─ ADO MCP (work items, PRs, pipelines)    │
│  │   └─ Custom tools (task mgmt, self_restart)  │
│  └─ Task store (JSON persistence)               │
├─────────────────────────────────────────────────┤
│  React Frontend (src/client/)                   │
│  ├─ Dashboard with task/session overview        │
│  ├─ Task detail view (links, notes, chat)       │
│  ├─ Chat with markdown + streaming              │
│  └─ Tailwind CSS dark theme                     │
└─────────────────────────────────────────────────┘
```

## Getting Started

### Prerequisites

- Node.js 22+ (uses `node:sqlite`)
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`npm install -g @github/copilot`)
- [Dev Tunnel CLI](https://aka.ms/devtunnels) (optional, for remote access)

### Install

```bash
git clone https://github.com/timstewartj/copilot-bridge.git
cd copilot-bridge
npm install
cp .env.example .env   # Edit .env with your settings (optional)
```

### Run (Development)

```bash
npm run dev          # Starts launcher (server + tunnel + webhook notify)
npm run dev:server   # Server only (no launcher/tunnel)
npm run dev:client   # Vite dev server with HMR (port 5173)
```

### Build

```bash
npm run build        # Build client + server
npm run build:client # Vite build only
npm run build:server # TypeScript compile only
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
├── launcher.ts                 # Parent process: server + tunnel + restart
├── server/
│   ├── index.ts                # Express routes (sessions, chat, tasks)
│   ├── session-manager.ts      # Copilot SDK wrapper + custom tools
│   ├── task-store.ts           # Task CRUD with JSON persistence
│   ├── event-bus.ts            # Per-session event buffer + pub/sub
│   └── config.ts               # Port, MCP server configs
└── client/
    ├── App.tsx                 # Root: sidebar + main view routing
    ├── api.ts                  # Typed API client functions
    ├── useSessionStream.ts     # SSE hook for streaming responses
    └── components/
        ├── Sidebar.tsx         # Tasks | Sessions tabs
        ├── TaskList.tsx        # Task list grouped by status
        ├── TaskDetailView.tsx  # Task detail with links + notes
        ├── ChatView.tsx        # Chat with streaming + history
        ├── ChatInput.tsx       # Auto-expanding input
        ├── MessageBubble.tsx   # Markdown rendering (react-markdown)
        ├── NotesEditor.tsx     # Markdown editor with preview
        ├── LinkDialog.tsx      # Modal to link work items/PRs/sessions
        └── Dashboard.tsx       # Home view with stats + quick actions

scripts/
├── start-bridge.ps1            # Start as hidden background process
└── stop-bridge.ps1             # Stop all bridge processes

data/                               # Runtime data (git-ignored)
└── tasks.json                  # Task persistence
```

## Self-Iteration

The agent can modify its own source code and restart:

1. Agent edits files in `src/`
2. Agent calls `self_restart` tool
3. Launcher detects signal → git commit → vite build + tsc → health check
4. If build passes → swap processes
5. If build fails → git reset, restart with old code
6. Max 3 consecutive failures before stopping

## Logs

```powershell
Get-Content data\bridge.log -Tail 30      # stdout
Get-Content data\bridge-error.log -Tail 30 # stderr
```
