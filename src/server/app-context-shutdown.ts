// Graceful shutdown for AppContext-owned services.
//
// Deliberately kept free of app-context-factory.js imports: the factory pulls in
// every store, the session manager, and the whole MCP tool registry. Consumers
// that only need to shut a context down (shutdown-coordinator, api-router) must
// not pay for that graph.

import type { AppContext } from "./app-context.js";
import { stopAllStagingBackends } from "./staging-backend-manager.js";
import {
  createDeadline,
  settleByDeadline,
  type Deadline,
} from "./deadline.js";

export const SERVER_SHUTDOWN_BUDGET_MS = 13_000;

const appContextShutdownOperations = new WeakMap<AppContext, Promise<void>>();

export function shutdownAppContextServices(
  ctx: AppContext,
  deadline: Deadline = createDeadline(SERVER_SHUTDOWN_BUDGET_MS),
): Promise<void> {
  const existing = appContextShutdownOperations.get(ctx);
  if (existing) return existing;

  const operation = (async () => {
    // Before the first await: POST /api/shutdown checked that the server is idle in this same tick.
    ctx.sessionManager.stopAdmittingWork();
    ctx.scheduler?.setGlobalPause(true);
    ctx.sessionOverlayMaintenance?.stop();
    ctx.stagingPreviewDiscovery?.stop();
    const stagingShutdown = stopAllStagingBackends(deadline);
    ctx.deferredPromptRunner?.shutdown();
    ctx.deferLoopRunner?.shutdown();
    ctx.helm?.dispose();
    const handsFreeOutcome = await settleByDeadline(async () => {
      await ctx.voiceGateway?.shutdown();
    }, deadline);
    if (handsFreeOutcome.status !== "fulfilled") {
      console.error(`[web] Hands-free shutdown ${handsFreeOutcome.status}`);
    }
    try {
      await ctx.searchIndex?.shutdown();
    } catch (error) {
      console.error("[web] Search index shutdown failed:", error);
    }
    const notificationsOutcome = await settleByDeadline(async () => {
      await ctx.stopPushEventNotifications?.();
    }, deadline);
    if (notificationsOutcome.status !== "fulfilled") {
      console.error(`[web] Notification shutdown ${notificationsOutcome.status}`);
    }

    try {
      await ctx.copilotUsageReader?.shutdown();
    } catch (error) {
      console.error("[web] Copilot usage index shutdown failed:", error);
    }

    try {
      await ctx.sessionManager.gracefulShutdown(deadline);
    } catch (error) {
      console.error("[web] Session manager shutdown failed:", error);
    }
    const voiceOutcome = await settleByDeadline(
      () => ctx.voiceJobManager.shutdown(),
      deadline,
    );
    if (voiceOutcome.status !== "fulfilled") {
      console.error(`[web] Voice job shutdown ${voiceOutcome.status}`);
    }

    // Stopped last: in-flight chat mic transcriptions and voice conversations both use the engine.
    const speechEngineOutcome = await settleByDeadline(async () => {
      await ctx.voiceRuntime?.engine.stop("server shutdown");
    }, deadline);
    if (speechEngineOutcome.status !== "fulfilled") {
      console.error(`[web] Speech engine shutdown ${speechEngineOutcome.status}`);
    }

    ctx.scheduler?.shutdown();
    await stagingShutdown;
  })();
  appContextShutdownOperations.set(ctx, operation);
  return operation;
}
