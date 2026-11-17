// Periodic owner of overlay cleanup: a startup pass plus a slow unref'd interval.

import type { AppContext } from "./app-context.js";
import { sweepExpiredScratchSessions } from "./scratch-sessions.js";
import { getCopilotHome, runSessionOverlayReaper } from "./session-overlay-reaper.js";
import { repairDanglingTaskSessionLinks } from "./task-session-link-repair.js";

/** Overlay rows are only reaped once they are at least this old. */
export const OVERLAY_MAINTENANCE_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;
/** Terminal defer rows are only pruned once they are at least this old. */
export const DEFER_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How often maintenance runs after the startup pass. */
export const OVERLAY_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SessionOverlayMaintenanceResult {
  /** Scratch chats idle for a day, deleted. */
  deletedScratchSessions: number;
  /** Task links to conversations that no longer exist, removed. */
  removedDanglingLinks: number;
  reaped: number;
  deletedTriggerRuns: number;
  prunedDeferredPrompts: number;
  prunedTriggers: number;
}

export interface SessionOverlayMaintenanceOptions {
  intervalMs?: number;
  minimumAgeMs?: number;
  deferRetentionMs?: number;
  now?: () => number;
  logger?: Pick<Console, "log" | "error">;
  /** Deletes a chat with everything the Bridge keeps for it. Without it, scratch chats are kept. */
  deleteSession?: (sessionId: string) => Promise<void>;
}

export interface SessionOverlayMaintenance {
  /** Runs one pass immediately and arms the recurring timer. */
  start(): Promise<SessionOverlayMaintenanceResult>;
  /** Runs one pass without touching the timer. Exposed for tests. */
  runOnce(): Promise<SessionOverlayMaintenanceResult>;
  stop(): void;
}

export function createSessionOverlayMaintenance(
  ctx: AppContext,
  options: SessionOverlayMaintenanceOptions = {},
): SessionOverlayMaintenance {
  const intervalMs = options.intervalMs ?? OVERLAY_MAINTENANCE_INTERVAL_MS;
  const minimumAgeMs = options.minimumAgeMs ?? OVERLAY_MAINTENANCE_MINIMUM_AGE_MS;
  const deferRetentionMs = options.deferRetentionMs ?? DEFER_TERMINAL_RETENTION_MS;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? console;

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  async function sweepScratchSessions(): Promise<number> {
    const deleteSession = options.deleteSession;
    if (!deleteSession) return 0;
    try {
      const deleted = await sweepExpiredScratchSessions({
        copilotHome: getCopilotHome(ctx),
        isProtected: (sessionId) => ctx.sessionManager.getLifecycleBlockingSessionIds().includes(sessionId)
          || ctx.sessionManager.isSessionBusy(sessionId)
          || ctx.sessionManager.getPendingUserInputCount(sessionId) > 0
          || Boolean(ctx.deferredPromptStore?.hasActiveForSession(sessionId))
          || Boolean(ctx.triggerStore?.hasActiveForSession(sessionId)),
        deleteSession,
        now,
        logger,
      });
      return deleted.length;
    } catch (error) {
      logger.error("[scratch] Deleting idle scratch chats failed:", error);
      return 0;
    }
  }

  async function runOnce(): Promise<SessionOverlayMaintenanceResult> {
    const deletedScratchSessions = await sweepScratchSessions();
    // Before the reaper, so overlay rows of gone conversations lose their last task link.
    let removedDanglingLinks = 0;
    try {
      const repair = await repairDanglingTaskSessionLinks(ctx, { now });
      removedDanglingLinks = repair.removedLinks;
      if (repair.removedLinks > 0) {
        logger.log(`[task-links] Removed ${repair.removedLinks} task link(s) to ${repair.goneSessionIds.length} `
          + `conversation(s) that no longer exist: ${repair.goneSessionIds.join(", ")}`);
      } else if (repair.skipped === "mass_loss" || repair.skipped === "session_state_unreadable") {
        logger.error(`[task-links] Left task links alone (${repair.skipped}): the session-state folder is empty `
          + "or most linked conversations are missing from it, so check COPILOT_HOME.");
      }
    } catch (error) {
      logger.error("[task-links] Repairing task links failed:", error);
    }

    const report = await runSessionOverlayReaper(ctx, {
      dryRun: false,
      cleanupDeletedTriggerRuns: true,
      minimumAgeMs,
    });

    const deferCutoff = new Date(now() - deferRetentionMs).toISOString();
    const prunedDeferredPrompts = ctx.deferredPromptStore?.pruneTerminalRows(deferCutoff) ?? 0;
    const prunedTriggers = ctx.triggerStore?.pruneTerminal(deferCutoff) ?? 0;

    const result: SessionOverlayMaintenanceResult = {
      deletedScratchSessions,
      removedDanglingLinks,
      reaped: report.reaped,
      deletedTriggerRuns: report.deletedTriggerRuns.deleted,
      prunedDeferredPrompts,
      prunedTriggers,
    };

    if (result.reaped > 0 || result.deletedTriggerRuns > 0) {
      // The enriched session cache is rebuilt from this event.
      ctx.globalBus.emit({ type: "sessions:changed" });
    }

    return result;
  }

  async function start(): Promise<SessionOverlayMaintenanceResult> {
    if (!timer && !stopped) {
      timer = setInterval(() => {
        runOnce().then(logMaintenance, (error) => logger.error("[session-overlay] Maintenance failed:", error));
      }, intervalMs);
      timer.unref?.();
    }
    const result = await runOnce();
    logMaintenance(result);
    return result;
  }

  function logMaintenance(result: SessionOverlayMaintenanceResult): void {
    const total = result.deletedScratchSessions
      + result.reaped
      + result.deletedTriggerRuns
      + result.prunedDeferredPrompts
      + result.prunedTriggers;
    if (total === 0) return;
    logger.log(
      `[session-overlay] Deleted ${result.deletedScratchSessions} idle scratch chat(s), `
      + `reaped ${result.reaped} overlay row(s), `
      + `${result.deletedTriggerRuns} deleted-trigger run(s), `
      + `${result.prunedDeferredPrompts} delivered outbox message(s), `
      + `${result.prunedTriggers} stopped chat trigger(s)`,
    );
  }

  function stop(): void {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { start, runOnce, stop };
}
