// Copilot Web Bridge — Express server

import "./log-timestamps.js";
import "./load-bridge-env.js";
import express from "express";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { notifyWebhook, gitHash, getPublicBaseUrl, discoverTunnelUrl, rememberRequestOrigin, shouldTrustProxyHeaders } from "./tunnel.js";
import { pruneOrphanedWorktrees, getActivePreviews, getStagingRouter, registerExpressApp } from "./staging-tools.js";
import { initKeepAlive } from "./keep-alive.js";
import { createApiRouter } from "./api-router.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { configureRestartStateStore, refreshRestartState } from "./session-manager.js";
import {
  createAppContext,
  initializeSchedulerAndDeferredRunners,
  shutdownAppContextServices,
} from "./app-context-factory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

if (shouldTrustProxyHeaders()) {
  app.set("trust proxy", true);
  app.use((req, _res, next) => {
    rememberRequestOrigin(req);
    next();
  });
}

// Register Express app with staging tools so they can mount/unmount staged routers
registerExpressApp(app);

const runtimePaths = resolveRuntimePaths(process.env);
const { ctx: defaultContext } = createAppContext({
  runtimePaths,
  apiBasePath: "/api",
  launcherLogPath: process.env.BRIDGE_LAUNCHER_LOG_PATH,
  enableStartupDocsSnapshot: true,
});
const sessionManager = defaultContext.sessionManager;

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

function setClientStaticHeaders(res: express.Response, filePath: string): void {
  if (filePath.endsWith(".html") || filePath.endsWith("service-worker.js") || filePath.endsWith("manifest.json")) {
    res.setHeader("Cache-Control", "no-store");
  }
}

// Staging previews — dynamically serves frontend builds registered by staging_preview tool
app.use("/staging/:prefix", (req, res, next) => {
  const prefix = req.params.prefix;
  const previews = getActivePreviews();
  const distDir = previews.get(prefix);
  if (!distDir || !existsSync(distDir)) {
    return res.status(404).send("Staging preview not found. It may have been cleaned up or deployed.");
  }
  express.static(distDir, { setHeaders: setClientStaticHeaders })(req, res, () => {
    // SPA fallback — serve index.html for unmatched routes within this staging preview
    res.sendFile(join(distDir, "index.html"));
  });
});

const distPath = join(__dirname, "..", "..", "dist", "client");
app.use(
  express.static(distPath, {
    maxAge: "1y",
    immutable: true,
    setHeaders: setClientStaticHeaders,
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
  configureRestartStateStore(runtimePaths);
  await refreshRestartState();
  defaultContext.voiceJobManager.resumePendingJobs();

  // Prune old telemetry data
  const pruned = defaultContext.telemetryStore?.pruneOldSpans(7) ?? 0;
  if (pruned > 0) console.log(`[telemetry] Pruned ${pruned} old spans`);

  // Initialize scheduler after session manager is ready
  initializeSchedulerAndDeferredRunners(defaultContext);

  // Initialize mouse-jiggle keep-alive (prevent idle timeout while sessions active)
  initKeepAlive();

  const port = config.web.port;
  // Event loop lag monitor — measures how late setInterval fires vs expected
  const LAG_INTERVAL = 200;
  const LAG_THRESHOLD = 50; // ms
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - LAG_INTERVAL;
    lastTick = now;
    if (lag > LAG_THRESHOLD) {
      defaultContext.telemetryStore?.recordSpan({
        name: "eventloop.lag",
        duration: lag,
        metadata: { activeSessions: sessionManager.getActiveSessions().length },
        source: "server",
      });
    }
  }, LAG_INTERVAL);

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      server.off("error", reject);
      console.log(`[web] 🟢 Server running at http://localhost:${port}`);
      resolve();
    });
    server.once("error", reject);
  });

  // Stage artifact pruning and backend warmup can be slow; do it after listen so health checks pass.
  void pruneOrphanedWorktrees().catch((error) => {
    console.error("[web] Staging preview restore/prune failed:", error);
  });

  // Webhook 1: server is up
  await notifyWebhook(`🤖 Copilot Bridge is online! (${gitHash()}, PID ${process.pid})`);

  // Webhook 2: public URL (explicit config, learned origin, or tunnel URL)
  const publicUrl = getPublicBaseUrl();
  if (publicUrl) {
    await notifyWebhook(`🔗 Public URL ready`, publicUrl);
  } else {
    // Retry after a short delay — a tunnel process may still be starting
    setTimeout(async () => {
      const url = discoverTunnelUrl();
      if (url) {
        await notifyWebhook(`🔗 Public URL ready`, url);
      }
    }, 15_000);
  }
}

async function gracefulExit(signal: string) {
  console.log(`\n[web] ${signal} received — graceful shutdown...`);
  try {
    defaultContext.scheduler?.setGlobalPause(true);
    await shutdownAppContextServices(defaultContext);
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
