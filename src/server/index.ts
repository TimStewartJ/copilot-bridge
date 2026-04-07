// Copilot Web Bridge — Express server

import "./log-timestamps.js";
import express from "express";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, setMcpServersGetter } from "./config.js";
import { SessionManager, createBridgeTools } from "./session-manager.js";
import { openDatabase } from "./db.js";
import { migrateJsonToSqlite } from "./migrate-json-to-sqlite.js";
import { createTaskStore } from "./task-store.js";
import { createTaskGroupStore } from "./task-group-store.js";
import { createSessionMetaStore } from "./session-meta-store.js";
import { createSettingsStore } from "./settings-store.js";
import { createSessionTitlesStore } from "./session-titles.js";
import { createScheduleStore } from "./schedule-store.js";
import { createReadStateStore } from "./read-state-store.js";
import { createTodoStore } from "./todo-store.js";
import { createDocsStore } from "./docs-store.js";
import { createDocsIndex } from "./docs-index.js";
import { createTagStore } from "./tag-store.js";
import { createTelemetryStore } from "./telemetry-store.js";
import * as scheduler from "./scheduler.js";
import { defaultEventBusRegistry } from "./event-bus.js";
import { notifyWebhook, gitHash, getTunnelUrl, discoverTunnelUrl } from "./tunnel.js";
import { defaultGlobalBus } from "./global-bus.js";
import { pruneOrphanedWorktrees, getActivePreviews, getStagingRouter, registerExpressApp } from "./staging-tools.js";
import { initKeepAlive } from "./keep-alive.js";
import type { AppContext } from "./app-context.js";
import { createApiRouter } from "./api-router.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "20mb" }));

// Register Express app with staging tools so they can mount/unmount staged routers
registerExpressApp(app);

// ── Database ──────────────────────────────────────────────────────
const dataDir = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const db = openDatabase(dataDir);
migrateJsonToSqlite(db, dataDir);

// ── Stores (all backed by shared SQLite db) ───────────────────────
const taskStore = createTaskStore(db, defaultGlobalBus);
const taskGroupStore = createTaskGroupStore(db);
const scheduleStore = createScheduleStore(db);
const settingsStore = createSettingsStore(db);
const sessionMetaStore = createSessionMetaStore(db);
const sessionTitles = createSessionTitlesStore(db);
const readStateStore = createReadStateStore(db);
const todoStore = createTodoStore(db, defaultGlobalBus);
const tagStore = createTagStore(db);
const telemetryStore = createTelemetryStore(db);
const docsDir = process.env.BRIDGE_DOCS_DIR || join(dataDir, "docs");
const docsStore = createDocsStore(docsDir);
const docsIndex = createDocsIndex(db, docsStore);
docsIndex.reindex();

// Wire config getter now that settings store is ready
setMcpServersGetter(() => settingsStore.getMcpServers());

// Build default AppContext for production
const defaultContext: AppContext = {
  taskStore, taskGroupStore, scheduleStore, settingsStore,
  sessionMetaStore, sessionTitles, readStateStore, todoStore, docsStore, docsIndex, tagStore, telemetryStore,
  globalBus: defaultGlobalBus,
  eventBusRegistry: defaultEventBusRegistry,
  sessionManager: null as any, // assigned below after construction
};
const tools = createBridgeTools(defaultContext);
const sessionManager = new SessionManager({
  tools,
  globalBus: defaultGlobalBus,
  eventBusRegistry: defaultEventBusRegistry,
  sessionTitles,
  taskStore,
  todoStore,
  settingsStore,
  tagStore,
  telemetryStore,
  docsIndex,
  docsStore,
  config: { get sessionMcpServers() { return config.sessionMcpServers; } },
});
defaultContext.sessionManager = sessionManager;

// ── API routes (mounted from api-router.ts) ──────────────────────
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
}, createApiRouter(defaultContext));

// ── Static files (Vite build output) ──────────────────────────────

// Staging API — delegating middleware registered at startup, resolves routers dynamically
app.use("/staging/:prefix/api", (req, res, next) => {
  const router = getStagingRouter(req.params.prefix);
  if (router) {
    router(req, res, next);
  } else {
    next();
  }
});

// Staging previews — dynamically serves frontend builds registered by staging_preview tool
app.use("/staging/:prefix", (req, res, next) => {
  const prefix = req.params.prefix;
  const previews = getActivePreviews();
  const distDir = previews.get(prefix);
  if (!distDir || !existsSync(distDir)) {
    return res.status(404).send("Staging preview not found. It may have been cleaned up or deployed.");
  }
  express.static(distDir)(req, res, () => {
    // SPA fallback — serve index.html for unmatched routes within this staging preview
    res.sendFile(join(distDir, "index.html"));
  });
});

const distPath = join(__dirname, "..", "..", "dist", "client");
app.use(
  express.static(distPath, {
    maxAge: "1y",
    immutable: true,
    setHeaders: (res, filePath) => {
      // HTML must not be cached — browser needs to check for updates
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);
app.get("/{*splat}", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(join(distPath, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════╗");
  console.log("║      Copilot Web Bridge                ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();

  await sessionManager.initialize();

  // Prune old telemetry data
  const pruned = telemetryStore.pruneOldSpans(7);
  if (pruned > 0) console.log(`[telemetry] Pruned ${pruned} old spans`);

  // Clean up orphaned staging worktrees and restore surviving previews (incl. backends)
  await pruneOrphanedWorktrees();

  // Initialize scheduler after session manager is ready
  scheduler.initialize(sessionManager, {
    scheduleStore, taskStore, sessionMetaStore, globalBus: defaultGlobalBus,
  });

  // Initialize mouse-jiggle keep-alive (prevent idle timeout while sessions active)
  initKeepAlive();

  const port = config.web.port;
  app.listen(port, () => {
    console.log(`[web] 🟢 Server running at http://localhost:${port}`);
  });

  // Webhook 1: server is up
  await notifyWebhook(`🤖 Copilot Bridge is online! (${gitHash()}, PID ${process.pid})`);

  // Webhook 2: tunnel URL (may take a moment to be available)
  const tunnelUrl = getTunnelUrl();
  if (tunnelUrl) {
    await notifyWebhook(`🔗 Tunnel ready`, tunnelUrl);
  } else {
    // Retry after a short delay — tunnel PM2 process may still be starting
    setTimeout(async () => {
      const url = discoverTunnelUrl();
      if (url) {
        await notifyWebhook(`🔗 Tunnel ready`, url);
      }
    }, 15_000);
  }
}

async function gracefulExit(signal: string) {
  console.log(`\n[web] ${signal} received — graceful shutdown...`);
  try {
    scheduler.shutdown();
    await sessionManager.gracefulShutdown();
  } catch (err) {
    console.error("[web] Error during graceful shutdown:", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));

main().catch((err) => {
  console.error("[web] Fatal error:", err);
  process.exit(1);
});
