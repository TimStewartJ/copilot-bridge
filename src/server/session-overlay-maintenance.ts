// Session overlay maintenance — the periodic owner of Bridge-side overlay
// cleanup.
//
// `runSessionOverlayReaper` used to be reachable only from a maintenance REST
// route that nothing called, so overlay rows, run history for deleted
// schedules, and terminal defer rows accumulated for the lifetime of an
// install. This module gives that cleanup a real owner: one startup pass plus a
// low-frequency interval, with an unref'd timer and explicit shutdown disposal.

import type { AppContext } from "./app-context.js";
import { runSessionOverlayReaper } from "./session-overlay-reaper.js";

/** Overlay rows are only reaped once they are at least this old. */
export const OVERLAY_MAINTENANCE_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;
/** Terminal defer rows are only pruned once they are at least this old. */
export const DEFER_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How often maintenance runs after the startup pass. */
export const OVERLAY_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SessionOverlayMaintenanceResult {
  reaped: number;
  deletedScheduleRuns: number;
  prunedDeferredPrompts: number;
  prunedDeferLoops: number;
  prunedSessionMessages: number;
}

export interface SessionOverlayMaintenanceOptions {
  intervalMs?: number;
  minimumAgeMs?: number;
  deferRetentionMs?: number;
  now?: () => number;
  logger?: Pick<Console, "log" | "error">;
}

export interface SessionOverlayMaintenance {
  /** Runs one pass immediately and arms the recurring timer. */
  start(): SessionOverlayMaintenanceResult;
  /** Runs one pass without touching the timer. Exposed for tests. */
  runOnce(): SessionOverlayMaintenanceResult;
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

  function runOnce(): SessionOverlayMaintenanceResult {
    const report = runSessionOverlayReaper(ctx, {
      dryRun: false,
      cleanupDeletedScheduleRuns: true,
      minimumAgeMs,
    });

    const deferCutoff = new Date(now() - deferRetentionMs).toISOString();
    const prunedDeferredPrompts = ctx.deferredPromptStore?.pruneTerminalRows(deferCutoff) ?? 0;
    const prunedDeferLoops = ctx.deferLoopStore?.pruneTerminalRows(deferCutoff) ?? 0;
    const prunedSessionMessages =
      ctx.sessionMessageOutboxStore?.pruneTerminalRows(deferCutoff) ?? 0;

    const result: SessionOverlayMaintenanceResult = {
      reaped: report.reaped,
      deletedScheduleRuns: report.deletedScheduleRuns.deleted,
      prunedDeferredPrompts,
      prunedDeferLoops,
      prunedSessionMessages,
    };

    if (result.reaped > 0 || result.deletedScheduleRuns > 0) {
      // Mirrors what the old maintenance route did: the enriched session cache
      // is rebuilt from this bus event.
      ctx.globalBus.emit({ type: "sessions:changed" });
    }

    return result;
  }

  function start(): SessionOverlayMaintenanceResult {
    if (!timer && !stopped) {
      timer = setInterval(() => {
        try {
          const result = runOnce();
          logMaintenance(result);
        } catch (error) {
          logger.error("[session-overlay] Maintenance failed:", error);
        }
      }, intervalMs);
      timer.unref?.();
    }
    const result = runOnce();
    logMaintenance(result);
    return result;
  }

  function logMaintenance(result: SessionOverlayMaintenanceResult): void {
    const total = result.reaped
      + result.deletedScheduleRuns
      + result.prunedDeferredPrompts
      + result.prunedDeferLoops
      + result.prunedSessionMessages;
    if (total === 0) return;
    logger.log(
      `[session-overlay] Reaped ${result.reaped} overlay row(s), `
      + `${result.deletedScheduleRuns} deleted-schedule run(s), `
      + `${result.prunedDeferredPrompts} terminal deferred prompt(s), `
      + `${result.prunedDeferLoops} terminal defer loop(s), `
      + `${result.prunedSessionMessages} terminal session message(s)`,
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
