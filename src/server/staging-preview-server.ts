import "./log-timestamps.js";
import "./load-bridge-env.js";
import express from "express";
import { createServer, type Server } from "node:http";
import { createApiRouter } from "./api-router.js";
import {
  createAppContext,
  initializeSchedulerAndDeferredRunners,
  shutdownAppContextServices,
} from "./app-context-factory.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const STAGING_EXCLUDED_TOOLS = new Set([
  "self_restart",
  "self_update",
  "staging_init",
  "staging_preview",
  "staging_deploy",
  "staging_cleanup",
]);

type ReadyMessage = {
  type: "ready";
  port: number;
};

type ErrorMessage = {
  type: "error";
  error: string;
};

function sendParentMessage(message: ReadyMessage | ErrorMessage): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function parsePort(value: string | undefined): number {
  if (!value) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid BRIDGE_STAGING_BACKEND_PORT: ${value}`);
  }
  return port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const apiBasePath = process.env.BRIDGE_STAGING_API_BASE_PATH;
  if (!apiBasePath) {
    throw new Error("BRIDGE_STAGING_API_BASE_PATH is required");
  }

  const runtimePaths = resolveRuntimePaths(process.env);
  const { ctx, db } = createAppContext({
    runtimePaths,
    apiBasePath,
    isStaging: true,
    sessionModel: process.env.BRIDGE_STAGING_MODEL,
    excludedToolNames: STAGING_EXCLUDED_TOOLS,
    enableStartupDocsSnapshot: false,
  });
  const app = express();
  let server: Server | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[staging-preview] ${signal} received — shutting down...`);
    try {
      if (server) {
        await closeServer(server);
      }
      await shutdownAppContextServices(ctx);
    } finally {
      db.close();
    }
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").then(
      () => process.exit(0),
      (error) => {
        console.error("[staging-preview] Shutdown failed:", error);
        process.exit(1);
      },
    );
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT").then(
      () => process.exit(0),
      (error) => {
        console.error("[staging-preview] Shutdown failed:", error);
        process.exit(1);
      },
    );
  });

  await ctx.sessionManager.initialize();
  ctx.voiceJobManager.resumePendingJobs();
  initializeSchedulerAndDeferredRunners(ctx);

  app.get("/__health", (_req, res) => {
    res.json({ ok: true, apiBasePath });
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  }, createApiRouter(ctx));

  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(parsePort(process.env.BRIDGE_STAGING_BACKEND_PORT), "127.0.0.1", () => {
      server!.off("error", reject);
      const address = server!.address();
      if (!address || typeof address === "string") {
        reject(new Error("Staging preview server did not bind to a TCP port"));
        return;
      }
      console.log(`[staging-preview] Ready on 127.0.0.1:${address.port}`);
      sendParentMessage({ type: "ready", port: address.port });
      resolve();
    });
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("[staging-preview] Fatal startup error:", message);
  sendParentMessage({ type: "error", error: message });
  process.exit(1);
});
