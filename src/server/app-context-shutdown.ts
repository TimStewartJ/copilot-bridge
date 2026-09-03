// Graceful shutdown for AppContext-owned services.
//
// Deliberately kept free of app-context-factory.js imports: the factory pulls in
// every store, the session manager, and the whole MCP tool registry. Consumers
// that only need to shut a context down (shutdown-coordinator, api-router) must
// not pay for that graph.

import type { AppContext } from "./app-context.js";
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
    ctx.scheduler?.setGlobalPause(true);
    ctx.sessionOverlayMaintenance?.stop();
    ctx.stagingPreviewDiscovery?.stop();
    ctx.sessionMessageOutboxRunner?.shutdown();
    ctx.deferredPromptRunner?.shutdown();
    ctx.deferLoopRunner?.shutdown();

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

    ctx.scheduler?.shutdown();
  })();
  appContextShutdownOperations.set(ctx, operation);
  return operation;
}
