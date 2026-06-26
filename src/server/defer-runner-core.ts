// Shared defer-runner scaffolding — owns the scheduling/lease/bus lifecycle common to
// the one-shot deferred-prompt runner and the recurring defer-loop runner.
// Recomputes all timers from SQLite on startup; no in-memory state is authoritative.

import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { DeferDeliveryGuard } from "./defer-delivery-guard.js";
import { emitSessionDeferSummary, type DeferSummarySources } from "./defer-summary.js";

// ── Shared timing/lease constants ─────────────────────────────────

export const MAX_ATTEMPTS = 5;
export const INITIAL_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const LEASE_MS = 2 * 60_000;
export const LEASE_RENEW_INTERVAL_MS = Math.floor(LEASE_MS / 2);
export const MAX_TIMER_DELAY_MS = 2_000_000_000;

export type ProcessOneResult = "changed" | "blocked" | "unchanged" | "claimed";

/** Minimal shape the core needs from each due item to enforce one-per-session-per-pass FIFO. */
export interface DeferRunnerDueItem {
  id: string;
  sessionId: string;
}

/**
 * Store-shaped read surface the core depends on. Runner-specific data operations
 * (claimDue/renewClaim/markCompleted/completeOccurrence/etc.) stay in each runner's
 * processOne/finishDelivery, closing over the real typed store.
 */
export interface DeferRunnerStoreAdapter {
  /** Next future pending/active wake time (deferred: getNextFuturePending().runAt; loop: getNextFutureActive().nextRunAt). */
  getNextFutureWakeAt(): string | undefined;
  /** Next running-lease expiry wake time. */
  getNextRunningLeaseWakeAt(): string | undefined;
  listDue(): ReadonlyArray<DeferRunnerDueItem>;
  reclaimExpiredRunning(now: string): number;
  listExpiredRunningSessionIds(now: string): string[];
  cancelForSession(sessionId: string): number;
}

/** Log/summary labels per runner. */
export interface DeferRunnerLabels {
  /** Bracketed log tag, e.g. "deferred-runner" or "defer-loop-runner". */
  tag: string;
  /** Singular noun for reclaim/cancel logs, e.g. "deferral" or "loop". */
  noun: string;
}

/**
 * Shared scaffolding exposed to each runner's processOne/finishDelivery strategy.
 * The core owns the delivery guard, renewal timers, summaries, and re-arm scheduling.
 */
export interface DeferRunnerCoreContext {
  isStarted(): boolean;
  readonly deliveryGuard: DeferDeliveryGuard;
  /** Start a lease-renewal interval (guards on started) and track it for shutdown cleanup. */
  startRenewal(renew: () => void): ReturnType<typeof setInterval>;
  emitDeferSummary(sessionId: string): void;
  emitDeferSummaries(sessionIds: Iterable<string>): void;
  recordSessionAttention(sessionId: string, at?: string): void;
  /**
   * Settle a finished delivery: stop the renewal timer, release the session guard,
   * then either process the next due item for the freed session or re-arm the timer.
   * Release MUST happen before the readiness check so a same-session follow-up is not stranded.
   */
  afterDeliverySettled(
    renewalTimer: ReturnType<typeof setInterval>,
    sessionId: string,
    shouldProcessNext: boolean,
  ): void;
}

export interface DeferRunnerCoreOptions {
  store: DeferRunnerStoreAdapter;
  sessionManager: SessionManager;
  globalBus: GlobalBus;
  deliveryGuard: DeferDeliveryGuard;
  summarySources: DeferSummarySources;
  labels: DeferRunnerLabels;
  /** Pure factory: returns the runner's processOne strategy. Must not synchronously start processing. */
  createProcessOne: (ctx: DeferRunnerCoreContext) => (id: string) => Promise<ProcessOneResult>;
}

export interface DeferRunnerCore {
  start(): void;
  poke(): void;
  shutdown(): void;
}

export function createDeferRunnerCore(options: DeferRunnerCoreOptions): DeferRunnerCore {
  const { store, sessionManager, globalBus, deliveryGuard, summarySources, labels } = options;
  const { tag, noun } = labels;

  let nextTimer: ReturnType<typeof setTimeout> | undefined;
  let busUnsubscribe: (() => void) | undefined;
  let started = false;
  let generation = 0;
  let processDuePromise: Promise<void> | undefined;
  let rerunRequested = false;
  const renewalTimers = new Set<ReturnType<typeof setInterval>>();

  // ── Internal helpers ──────────────────────────────────────────────

  function getNextWakeAt(): string | undefined {
    const pendingWake = store.getNextFutureWakeAt();
    const runningWake = store.getNextRunningLeaseWakeAt();
    if (!pendingWake) return runningWake;
    if (!runningWake) return pendingWake;
    return Date.parse(runningWake) < Date.parse(pendingWake) ? runningWake : pendingWake;
  }

  function reclaimExpiredRunning(): void {
    const now = new Date().toISOString();
    const sessionIds = store.listExpiredRunningSessionIds(now);
    const reclaimed = store.reclaimExpiredRunning(now);
    if (reclaimed > 0) {
      console.log(`[${tag}] Reclaimed ${reclaimed} expired running ${noun}(s)`);
      emitDeferSummaries(sessionIds);
    }
  }

  function hasDueReadyForAnotherPass(): boolean {
    return store.listDue().some((item) =>
      !deliveryGuard.isActive(item.sessionId) && !sessionManager.isSessionBusy(item.sessionId)
    );
  }

  function emitDeferSummary(sessionId: string): void {
    emitSessionDeferSummary(globalBus, sessionId, summarySources);
  }

  function emitDeferSummaries(sessionIds: Iterable<string>): void {
    for (const sessionId of new Set(sessionIds)) emitDeferSummary(sessionId);
  }

  function recordSessionAttention(sessionId: string, at = new Date().toISOString()): void {
    if (typeof sessionManager.markSessionAttention !== "function") return;
    sessionManager.markSessionAttention(sessionId, at);
  }

  function armNext(): void {
    if (!started) return;
    clearTimeout(nextTimer);
    nextTimer = undefined;

    const nextWakeAt = getNextWakeAt();
    if (!nextWakeAt) return;

    const delay = Math.max(0, Date.parse(nextWakeAt) - Date.now());
    const scheduledGeneration = generation;
    nextTimer = setTimeout(() => {
      if (!started || scheduledGeneration !== generation) return;
      nextTimer = undefined;
      processDue().catch((err) => {
        console.error(`[${tag}] Unexpected error in processDue:`, err);
      });
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
  }

  /**
   * Process all currently due items.
   * Runs at most one item per session per pass, FIFO by wake time then createdAt.
   */
  async function processDue(): Promise<void> {
    if (processDuePromise) {
      rerunRequested = true;
      return processDuePromise;
    }
    processDuePromise = processDueLoop().finally(() => {
      processDuePromise = undefined;
    });
    return processDuePromise;
  }

  async function processDueLoop(): Promise<void> {
    do {
      rerunRequested = false;
      await processDueOnce();
    } while (started && rerunRequested);
  }

  async function processDueOnce(): Promise<void> {
    if (!started) return;

    reclaimExpiredRunning();
    const due = store.listDue();
    if (due.length > 0) {
      const sessionsSeen = new Set<string>();
      const toProcess = due.filter((item) => {
        if (sessionsSeen.has(item.sessionId)) return false;
        sessionsSeen.add(item.sessionId);
        return true;
      });

      const results = await Promise.all(toProcess.map((item) => processOne(item.id)));
      if (results.includes("changed") && hasDueReadyForAnotherPass()) {
        rerunRequested = true;
      }
    }

    armNext();
  }

  function startRenewal(renew: () => void): ReturnType<typeof setInterval> {
    const renewalTimer = setInterval(() => {
      if (!started) return;
      renew();
    }, LEASE_RENEW_INTERVAL_MS);
    renewalTimers.add(renewalTimer);
    return renewalTimer;
  }

  function afterDeliverySettled(
    renewalTimer: ReturnType<typeof setInterval>,
    sessionId: string,
    shouldProcessNext: boolean,
  ): void {
    clearInterval(renewalTimer);
    renewalTimers.delete(renewalTimer);
    deliveryGuard.release(sessionId);
    if (started && shouldProcessNext && hasDueReadyForAnotherPass()) {
      processDue().catch((err) => {
        console.error(`[${tag}] processDue error after delivery settled:`, err);
      });
    } else {
      armNext();
    }
  }

  const ctx: DeferRunnerCoreContext = {
    isStarted: () => started,
    deliveryGuard,
    startRenewal,
    emitDeferSummary,
    emitDeferSummaries,
    recordSessionAttention,
    afterDeliverySettled,
  };

  const processOne = options.createProcessOne(ctx);

  // ── Public API ────────────────────────────────────────────────────

  function start(): void {
    if (started) return;
    started = true;
    generation++;

    // Reclaim any running rows whose leases have expired
    reclaimExpiredRunning();

    // Subscribe to global bus events
    busUnsubscribe = globalBus.subscribe((event) => {
      if (event.type === "session:idle" && event.sessionId) {
        // Give the session one tick to settle before we re-try
        const scheduledGeneration = generation;
        setImmediate(() => {
          if (!started || scheduledGeneration !== generation) return;
          processDue().catch((err) => {
            console.error(`[${tag}] processDue error on session:idle:`, err);
          });
        });
        return;
      }

      if (event.type === "session:archived" && event.sessionId && event.archived === true) {
        const cancelled = store.cancelForSession(event.sessionId);
        if (cancelled > 0) {
          console.log(`[${tag}] Cancelled ${cancelled} ${noun}(s) for archived session ${event.sessionId}`);
          emitDeferSummary(event.sessionId);
        }
        return;
      }

      if (event.type === "server:restart-cleared") {
        const scheduledGeneration = generation;
        if (!started || scheduledGeneration !== generation) return;
        processDue().catch((err) => {
          console.error(`[${tag}] processDue error on server:restart-cleared:`, err);
        });
      }
    });

    // Catch up and arm
    processDue().catch((err) => {
      console.error(`[${tag}] Startup processDue error:`, err);
    });

    console.log(`[${tag}] Started`);
  }

  /**
   * Re-run due processing immediately.
   * Call this after inserting a new item so the runner wakes up promptly.
   */
  function poke(): void {
    if (!started) return;
    processDue().catch((err) => {
      console.error(`[${tag}] processDue error on poke:`, err);
    });
  }

  function shutdown(): void {
    generation++;
    clearTimeout(nextTimer);
    nextTimer = undefined;
    busUnsubscribe?.();
    busUnsubscribe = undefined;
    rerunRequested = false;
    deliveryGuard.clear();
    for (const timer of renewalTimers) clearInterval(timer);
    renewalTimers.clear();
    started = false;
  }

  return { start, poke, shutdown };
}
