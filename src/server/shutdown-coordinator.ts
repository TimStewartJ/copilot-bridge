import type { AppContext } from "./app-context.js";
import {
  SERVER_SHUTDOWN_BUDGET_MS,
  shutdownAppContextServices,
} from "./app-context-factory.js";
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
        try {
          await shutdownAppContextServices(ctx, deadline!);
        } catch (error) {
          console.error("[web] Error during graceful shutdown:", error);
        } finally {
          clearTimeout(exitTimer);
          if (!forcedExit) exit(0);
        }
      })();
      return operation;
    },
  };
}
