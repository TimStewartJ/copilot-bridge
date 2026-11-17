// Copilot Web Bridge — Express server

import "./guard-stdio-writes.js";
import "./log-timestamps.js";
import "./load-bridge-env.js";
import { prepareDashboardRetirement } from "./dashboard-retirement.js";
import express from "express";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join, dirname, basename } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { rememberRequestOrigin, shouldTrustProxyHeaders } from "./public-url.js";
import { proxyStagingUpgrade } from "./staging-backend-manager.js";
import {
  pruneOrphanedWorktrees,
  getActivePreviews,
  getStagingRouter,
  isRegisteredStagingPreviewMissing,
  registerExistingPreviewsFromDisk,
  registerExpressApp,
  startStagingPreviewDiscovery,
} from "./staging-tools.js";
import { createApiRouter } from "./api-router.js";
import { createApiServices } from "./api-services.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { prepareNeutralWorkspaceDir } from "./neutral-workspace.js";
import { RESTART_STATE_FILE_NAME, sweepStaleRestartStateTempFiles } from "./restart-state.js";
import { createNotResumedOverlay, queueBootRecoveryPrompts } from "./restart-resume.js";
import { recoverBackgroundCommandsOnBoot } from "./background-commands.js";
import { setProcessLaunchObserver } from "./process-host.js";
import { runOnPerformanceCores } from "./platform.js";
import { noteTimerDelay } from "./host-suspend.js";
import {
  getEventLoopLagRequestTelemetryMetadata,
  startRequestTelemetryInflightReporter,
} from "./api-request-telemetry.js";
import {
  createAppContext,
  initializeTriggerAndDeliveryRunners,
} from "./app-context-factory.js";
import { createServerShutdownCoordinator } from "./shutdown-coordinator.js";
import {
  restoreHibernateHandoff,
  saveHibernateHandoff,
  startHibernateHandoffKeeper,
} from "./device-hibernate-handoff.js";
import { getBrowserRuntime } from "./browser-runtime.js";
import { createApiCacheControlMiddleware, createResponseCompressionMiddleware } from "./response-transport.js";
import { createSessionOverlayMaintenance } from "./session-overlay-maintenance.js";
import { createStorageMaintenance } from "./storage-maintenance.js";
import { PRODUCTION_ROOT } from "./staging-preview-shared.js";
import {
  getValidationCommandLogDir,
  scheduleValidationCommandLogSweep,
} from "./validation-command-log.js";

const SLOW_PROCESS_CREATE_MS = 250;

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

// Relays make bytes the bottleneck: compress, and let GET polls revalidate to a 304.
app.use(createResponseCompressionMiddleware());

const runtimePaths = resolveRuntimePaths(process.env);
await prepareDashboardRetirement(runtimePaths.dataDir);
await prepareNeutralWorkspaceDir(runtimePaths);
const { ctx: defaultContext } = createAppContext({
  runtimePaths,
  apiBasePath: "/api",
  launcherLogPath: process.env.BRIDGE_LAUNCHER_LOG_PATH,
  enableStartupDocsSnapshot: true,
});
const sessionManager = defaultContext.sessionManager;
const shutdownCoordinator = createServerShutdownCoordinator(defaultContext, {
  saveHandoff: () => saveHibernateHandoff(runtimePaths.dataDir),
});

// ── API routes (mounted from api-router.ts) ──────────────────────
const apiServices = createApiServices(defaultContext, { shutdownCoordinator });
app.use("/api", createApiCacheControlMiddleware(), createApiRouter(defaultContext, apiServices));

// Before the API handler: a missing preview must 404 and rediscover, not lazily start a backend.
app.use("/staging/:prefix", (req, res, next) => {
  if (!isRegisteredStagingPreviewMissing(req.params.prefix)) return next();
  void defaultContext.stagingPreviewDiscovery?.requestDiscovery();
  res.status(404).send("Staging preview not found. It may have been cleaned up or deployed.");
});

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
    res.sendFile("index.html", { root: distDir });
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
  res.sendFile("index.html", { root: distPath });
});

/** Sweeps validation command logs and management job logs and rows, which would grow forever. */
async function pruneBridgeLogArtifacts(): Promise<void> {
  const validationLogDirs = new Set([
    getValidationCommandLogDir(PRODUCTION_ROOT),
    join(runtimePaths.dataDir, "validation-logs"),
  ]);
  for (const logDir of validationLogDirs) {
    try {
      const result = await scheduleValidationCommandLogSweep(logDir, { force: true });
      if (result && (result.deleted > 0 || result.failed > 0)) {
        console.log(
          `[validation-logs] Pruned ${result.deleted} log file(s) in ${logDir}`
          + (result.failed > 0 ? ` (${result.failed} failed, retried on the next sweep)` : ""),
        );
      }
    } catch (error) {
      console.error(`[validation-logs] Prune failed for ${logDir}:`, error);
    }
  }

  try {
    const result = await defaultContext.managementJobStore?.pruneRetention();
    if (result && (result.deletedJobIds.length > 0 || result.deletedLogPaths.length > 0)) {
      console.log(
        `[management-jobs] Pruned ${result.deletedJobIds.length} job row(s) `
        + `and ${result.deletedLogPaths.length} log file(s)`
        + (result.failedLogDeletions > 0
          ? ` (${result.failedLogDeletions} log deletion(s) failed, retried on the next sweep)`
          : ""),
      );
    }
  } catch (error) {
    console.error("[management-jobs] Retention prune failed:", error);
  }
}

/** How often bounded-storage maintenance reruns while the server stays up. */
const STORAGE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function pruneTelemetrySpans(): void {
  const pruned = defaultContext.telemetryStore?.pruneOldSpans(7) ?? 0;
  if (pruned > 0) console.log(`[telemetry] Pruned ${pruned} old spans`);
}

const storageMaintenance = createStorageMaintenance({
  pruneTelemetrySpans,
  pruneLogArtifacts: pruneBridgeLogArtifacts,
  intervalMs: STORAGE_MAINTENANCE_INTERVAL_MS,
});

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════╗");
  console.log("║      Copilot Web Bridge                ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();

  // Before anything starts a child process: only processes created afterwards inherit it.
  const scheduling = await runOnPerformanceCores();
  if (process.platform === "win32") {
    console.log(scheduling.applied
      ? `[scheduling] Running on performance cores: ${scheduling.detail}`
      : `[scheduling] Leaving processor choice to Windows: ${scheduling.detail}`);
  }

  await sessionManager.initialize();
  const sweptRestartTemps = sweepStaleRestartStateTempFiles(
    join(runtimePaths.dataDir, RESTART_STATE_FILE_NAME),
  );
  if (sweptRestartTemps > 0) {
    console.log(`[restart] Swept ${sweptRestartTemps} stale restart-state temp file(s) at startup`);
  }
  try {
    const voiceJobMaintenance = await defaultContext.voiceJobManager.startMaintenance();
    if (voiceJobMaintenance.terminalRowsPruned > 0 || voiceJobMaintenance.orphanDirectoriesRemoved > 0) {
      console.log(
        `[voice-jobs] Pruned ${voiceJobMaintenance.terminalRowsPruned} terminal row(s) and removed `
        + `${voiceJobMaintenance.orphanDirectoriesRemoved} orphan director${voiceJobMaintenance.orphanDirectoriesRemoved === 1 ? "y" : "ies"}`,
      );
    }
  } catch (error) {
    console.error("[voice-jobs] Initial maintenance failed:", error);
  }
  defaultContext.voiceJobManager.resumePendingJobs();

  startRequestTelemetryInflightReporter(defaultContext.telemetryStore);
  // Slow process launches no longer block this loop, but recording them shows a struggling OS.
  setProcessLaunchObserver(({ kind, file, createMs, queuedMs }) => {
    if (createMs < SLOW_PROCESS_CREATE_MS && queuedMs < SLOW_PROCESS_CREATE_MS) return;
    defaultContext.telemetryStore?.recordSpan({
      name: "process.create.slow",
      duration: createMs,
      metadata: { kind, command: basename(file.split(" ")[0] ?? file).slice(0, 80), queuedMs: Math.round(queuedMs) },
      source: "server",
    });
  });
  // Not awaited: a first sweep on a long-unpruned host can delete tens of thousands of files.
  void storageMaintenance.runOnce();
  storageMaintenance.start();

  // Queue continues for runs a crash cut off; production only, never from a preview's copied DB.
  let resumedSessionIds: string[] = [];
  try {
    const { deferredPromptStore, interruptedRunStore } = defaultContext;
    if (deferredPromptStore && interruptedRunStore) {
      const recovery = queueBootRecoveryPrompts({
        deferredPromptStore,
        deferredPromptRunner: defaultContext.deferredPromptRunner,
        globalBus: defaultContext.globalBus,
        announce: (sessionId, message) => {
          defaultContext.sessionMetaStore.setTerminalOverlay(sessionId, createNotResumedOverlay(message));
          sessionManager.markSessionAttention(sessionId);
        },
      }, interruptedRunStore);
      // The cut-off commands notice must not start a run awaiting resume or left for the user.
      resumedSessionIds = [
        ...recovery.resumed,
        ...recovery.retryScheduled.map((retry) => retry.sessionId),
        ...recovery.gaveUp,
      ];
      if (recovery.resumed.length + recovery.retryScheduled.length + recovery.gaveUp.length > 0) {
        console.warn(
          `[restart-resume] Runs interrupted by the last server exit: resumed [${recovery.resumed.join(", ")}], `
          + `resumed later because they were resumed within the cooldown [${
            recovery.retryScheduled.map((retry) => `${retry.sessionId} at ${retry.resumeAt}`).join(", ")
          }], not resumed again [${recovery.gaveUp.join(", ")}]`,
        );
      }
    }
  } catch (error) {
    console.error("[restart-resume] Boot recovery failed:", error);
  }

  // Shell commands died with the last server: record that, and tell an agent likely waiting on one.
  try {
    const { backgroundCommandStore, deferredPromptStore } = defaultContext;
    if (backgroundCommandStore) {
      const recovery = recoverBackgroundCommandsOnBoot({
        backgroundCommandStore,
        deferredPromptStore,
        deferredPromptRunner: defaultContext.deferredPromptRunner,
        isSessionArchived: (sessionId) => defaultContext.sessionMetaStore.isArchived(sessionId),
      }, { wake: true, alreadyResumedSessionIds: resumedSessionIds });
      if (recovery.stopped > 0) {
        console.warn(
          `[restart-resume] ${recovery.stopped} background command(s) were still running at the last server exit; `
          + `told now: [${recovery.woken.join(", ")}], the rest with their session's next message`,
        );
        defaultContext.telemetryStore?.recordSpan({
          name: "session.background_commands.stopped",
          duration: 0,
          metadata: { cause: "restart", count: recovery.stopped, woken: recovery.woken.length },
          source: "server",
        });
      }
    }
  } catch (error) {
    console.error("[restart-resume] Background command recovery failed:", error);
  }

  // Start triggers and the chat outbox after the session manager is ready
  initializeTriggerAndDeliveryRunners(defaultContext);

  // A hibernation the user asked for before the last server stopped (deploy or crash).
  try {
    await restoreHibernateHandoff(defaultContext, runtimePaths.dataDir);
  } catch (error) {
    console.error("[device] Taking over the pending hibernation failed:", error);
  }
  // From here on a pending hibernation is kept on disk, so a server that dies does not lose it.
  startHibernateHandoffKeeper(runtimePaths.dataDir);

  try {
    defaultContext.sessionOverlayMaintenance = createSessionOverlayMaintenance(defaultContext, {
      deleteSession: (sessionId) => apiServices.deleteSessionWithOwnedState(sessionId, "scratch:expired"),
    });
    await defaultContext.sessionOverlayMaintenance.start();
  } catch (error) {
    console.error("[session-overlay] Initial maintenance failed:", error);
  }

  // Watch jobs before scanning disk, or a preview finishing between scan and resume is missed.
  defaultContext.stagingPreviewDiscovery = startStagingPreviewDiscovery({
    store: defaultContext.managementJobStore,
    // Covers results the runner did not queue, and wakes delivery now instead of at the next sweep.
    onJobsCompleted: () => {
      defaultContext.managementJobStore?.reconcileResultDeliveries();
      defaultContext.deferredPromptRunner?.poke();
    },
  }) ?? undefined;
  registerExistingPreviewsFromDisk();

  const port = config.web.port;
  // Event loop lag monitor — measures how late setInterval fires vs expected
  const LAG_INTERVAL = 200;
  const LAG_THRESHOLD = 50; // ms
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - LAG_INTERVAL;
    lastTick = now;
    noteTimerDelay(lag, now);
    if (lag > LAG_THRESHOLD) {
      defaultContext.telemetryStore?.recordSpan({
        name: "eventloop.lag",
        duration: lag,
        metadata: {
          activeSessions: sessionManager.getActiveSessions().length,
          ...getEventLoopLagRequestTelemetryMetadata(lag),
        },
        source: "server",
      });
    }
  }, LAG_INTERVAL);
  // Diagnostics only — must never be the reason the process refuses to exit.
  lagTimer.unref();

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      server.off("error", reject);
      console.log(`[web] 🟢 Server running at http://localhost:${port}`);
      resolve();
    });
    server.on("upgrade", handleServerUpgrade);
    server.once("error", reject);
  });

  // Pruning and backend warmup can be slow; run after listen so health checks pass.
  void pruneOrphanedWorktrees().catch((error) => {
    console.error("[web] Staging preview restore/prune failed:", error);
  });

}

function gracefulExit(signal: string): void {
  void shutdownCoordinator.request(`${signal} received`);
}

/** WebSocket upgrades: voice and live browser views here, others forwarded to a staged preview. */
function handleServerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }
  const staging = pathname.match(/^\/staging\/([^/]+)\/api\//);
  const handled = staging
    ? proxyStagingUpgrade(staging[1]!, req, socket, head)
    : defaultContext.voiceGateway?.handleUpgrade(req, socket, head) === true
      || getBrowserRuntime(defaultContext).live.handleUpgrade(req, socket, head);
  if (!handled) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  }
}

process.on("SIGINT", () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));

main().catch((err) => {
  console.error("[web] Fatal error:", err);
  process.exit(1);
});
