import type { AppContext } from "./app-context.js";
import {
  SERVER_SHUTDOWN_BUDGET_MS,
  shutdownAppContextServices,
} from "./app-context-shutdown.js";
import {
  createDeadline,
  deadlineFromUnixMs,
  remainingMs,
  type Deadline,
} from "./deadline.js";

export type ServerShutdownCoordinator = {
  request(reason: string, requestedDeadlineUnixMs?: number): Promise<void>;
  activeDeadline(): Deadline | null;
};

export function createServerShutdownCoordinator(
  ctx: AppContext,
  dependencies: {
    exit?: (code: number) => void;
    maxBudgetMs?: number;
    /**
     * State to leave for the next server. Started in the tick of the request, before the services
     * stop, so it is on disk even when the shutdown later runs out of time; awaited before exit.
     */
    saveHandoff?: () => Promise<unknown>;
  } = {},
): ServerShutdownCoordinator {
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  const maxBudgetMs = dependencies.maxBudgetMs ?? SERVER_SHUTDOWN_BUDGET_MS;
  let operation: Promise<void> | null = null;
  let deadline: Deadline | null = null;

  return {
    activeDeadline: () => deadline,
    request(reason, requestedDeadlineUnixMs) {
      if (operation) return operation;
      deadline = requestedDeadlineUnixMs === undefined
        ? createDeadline(maxBudgetMs)
        : deadlineFromUnixMs(requestedDeadlineUnixMs, maxBudgetMs);
      console.log(`[web] ${reason} — graceful shutdown...`);

      operation = (async () => {
        let forcedExit = false;
        const timeoutMs = Math.max(1, remainingMs(deadline!));
        const exitTimer = setTimeout(() => {
          forcedExit = true;
          console.error(`[web] Shutdown deadline exceeded after ${timeoutMs}ms; exiting for launcher recovery`);
          exit(1);
        }, timeoutMs);
        exitTimer.unref?.();
        // No await before shutdownAppContextServices: it stops admitting work in this same tick.
        const handoff = Promise.resolve()
          .then(() => dependencies.saveHandoff?.())
          .catch((error) => console.error("[web] Saving state for the next server failed:", error));
        try {
          await shutdownAppContextServices(ctx, deadline!);
        } catch (error) {
          console.error("[web] Error during graceful shutdown:", error);
        } finally {
          await handoff;
          clearTimeout(exitTimer);
          if (!forcedExit) exit(0);
        }
      })();
      return operation;
    },
  };
}
