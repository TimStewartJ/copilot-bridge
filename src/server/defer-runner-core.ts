// Shared defer runner — schedules due work and takes each item through its whole life:
// wait until the Bridge can take it, claim it, run it, and record the outcome.
// The one-shot/message runner and the recurring runner each supply a DeferWork.
// All timers are recomputed from SQLite on startup; no in-memory state is authoritative.

import type { GlobalBus } from "./global-bus.js";
import {
  isPromptDeliveryInterruptedError,
  SessionCapacityError,
  type SessionManager,
} from "./session-manager.js";
import type { DeferDeliveryGuard } from "./defer-delivery-guard.js";
import { emitSessionDeferSummary, type DeferSummarySources } from "./defer-summary.js";
import type { DeferWorkerLease } from "./defer-worker.js";
import type { TelemetryStore } from "./telemetry-store.js";
import { isBackendUnavailableError } from "./backend-availability.js";

// ── Shared timing/lease constants ─────────────────────────────────

export const MAX_ATTEMPTS = 5;
export const INITIAL_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const LEASE_MS = 2 * 60_000;
export const LEASE_RENEW_INTERVAL_MS = Math.floor(LEASE_MS / 2);
export const MAX_TIMER_DELAY_MS = 2_000_000_000;
export const DEFER_WATCHDOG_INTERVAL_MS = 60_000;
const PAST_WAKE_RETRY_MS = 1_000;
export const LEASE_EXPIRED_ERROR = "Deferred execution lease expired before completion.";

/**
 * Whether a failed try says the Bridge could not take the work, not that the work failed.
 * Such a try is not counted: the item stays due and is tried again when the Bridge can take it.
 */
export function isDeferWaitError(error: unknown): boolean {
  return error instanceof SessionCapacityError
    || isPromptDeliveryInterruptedError(error)
    || isBackendUnavailableError(error);
}

export function computeDeferRetryBackoffMs(attempts: number): number {
  const boundedAttempts = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  return Math.min(
    INITIAL_BACKOFF_MS * Math.pow(2, boundedAttempts - 1),
    MAX_BACKOFF_MS,
  );
}

/**
 * "blocked" means the item's chat cannot take anything right now, so nothing queued behind the item is
 * tried either. "waiting" means only this item is held up (it needs a worker or a new context), so the
 * pass goes on to the chat's next due item.
 */
export type ProcessOneResult = "changed" | "blocked" | "waiting" | "unchanged" | "claimed";

/** What the scheduler needs from each due item to enforce one-per-session-per-pass FIFO. */
export interface DeferRunnerDueItem {
  id: string;
  sessionId: string;
  wakeAt: string;
}

/** One kind of deferred work: where its items are queued and what trying one means. */
export interface DeferWork<Item extends { id: string; sessionId: string }> {
  // ── Queue ──
  listDue(): ReadonlyArray<DeferRunnerDueItem>;
  /** Earliest future due time or running lease expiry. */
  getNextWakeAt(): string | undefined;
  /** Recover items whose claim outlived its lease (the server stopped mid-run). Returns the chats affected. */
  reclaimExpired(now: string): string[];
  cancelForSession(sessionId: string): number;

  // ── One item ──
  /** The item, if it is still waiting to run. */
  load(id: string): Item | undefined;
  /** True when the item runs in a worker session of its own; false when it is a message for the chat itself. */
  usesWorker(item: Item): boolean;
  /** True when the item should still reach a chat that has been archived. */
  reachesArchived(item: Item): boolean;
  /** The chat is gone: end the item. Returns whether anything changed. */
  orphaned(item: Item): boolean;
  /** Reasons of the item's own to end it before running. Returns whether it ended one, or undefined to go on. */
  preflight(item: Item): Promise<boolean | undefined> | boolean | undefined;
  /** Record why the item is not being started yet. */
  noteWait(item: Item, reason: string): void;
  claim(id: string): { item: Item; claimToken: string } | undefined;
  renew(id: string, claimToken: string): boolean;
  /** Give the claim back without counting the try. */
  release(id: string, claimToken: string, reason?: string): boolean;
  /** Do the work and record its outcome. Throwing means this try did not produce one. */
  run(item: Item, claimToken: string, lease: DeferWorkerLease | undefined): Promise<void>;
  /** The work was tried and failed: apply this kind's policy. */
  failed(item: Item, claimToken: string, error: string): void;
}

/** What the core lends to a DeferWork. */
export interface DeferRunnerCoreContext {
  recordSessionAttention(sessionId: string, at?: string): void;
  emitDeferSummary(sessionId: string): void;
}

export interface DeferRunnerOptions {
  telemetryStore?: Pick<TelemetryStore, "recordSpan">;
  /** Called after an item was tried and has let go of its chat and worker, so work waiting on either can start. */
  onSettled?: () => void;
}

/** Log/summary labels per runner. */
export interface DeferRunnerLabels {
  /** Bracketed log tag, e.g. "deferred-runner" or "defer-loop-runner". */
  tag: string;
  /** Singular noun for logs, e.g. "deferral" or "loop". */
  noun: string;
  /** Stable telemetry discriminator for the defer kind. */
  kind: "once" | "interval";
}

export interface DeferRunnerCoreOptions<Item extends { id: string; sessionId: string }> extends DeferRunnerOptions {
  sessionManager: SessionManager;
  globalBus: GlobalBus;
  deliveryGuard: DeferDeliveryGuard;
  summarySources: DeferSummarySources;
  labels: DeferRunnerLabels;
  /** Pure factory for this runner's work. Must not start processing. */
  createWork: (ctx: DeferRunnerCoreContext) => DeferWork<Item>;
}

export interface DeferRunnerCore {
  start(): void;
  poke(): void;
  shutdown(): void;
}

type Readiness = { ready: boolean; reason?: string; retryAfterMs?: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDeferRunnerCore<Item extends { id: string; sessionId: string }>(
  options: DeferRunnerCoreOptions<Item>,
): DeferRunnerCore {
  const { sessionManager, globalBus, deliveryGuard, summarySources, labels } = options;
  const { tag, noun } = labels;

  let nextTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let watchdogSweepPromise: Promise<void> | undefined;
  let busUnsubscribe: (() => void) | undefined;
  let started = false;
  let generation = 0;
  let processDuePromise: Promise<void> | undefined;
  let rerunRequested = false;
  let holdLogged = false;
  const renewalTimers = new Set<ReturnType<typeof setInterval>>();

  const work = options.createWork({
    recordSessionAttention: (sessionId, at = new Date().toISOString()) => {
      sessionManager.markSessionAttention?.(sessionId, at);
    },
    emitDeferSummary,
  });

  // ── Internal helpers ──────────────────────────────────────────────

  function recordTelemetry(name: string, duration: number, metadata: Record<string, unknown>): void {
    if (!options.telemetryStore) return;
    try {
      options.telemetryStore.recordSpan({
        name,
        duration,
        metadata: { deferKind: labels.kind, ...metadata },
        source: "server",
      });
    } catch (error) {
      console.warn(`[${tag}] Failed to record ${name} telemetry:`, error);
    }
  }

  function emitDeferSummary(sessionId: string): void {
    emitSessionDeferSummary(globalBus, sessionId, summarySources);
  }

  function getReadiness(): Readiness {
    return sessionManager.getDeferDeliveryReadiness?.() ?? { ready: true };
  }

  function reclaimExpired(): void {
    const sessionIds = work.reclaimExpired(new Date().toISOString());
    if (sessionIds.length === 0) return;
    console.log(`[${tag}] Reclaimed ${sessionIds.length} expired running ${noun}(s)`);
    for (const sessionId of new Set(sessionIds)) emitDeferSummary(sessionId);
  }

  // ── Scheduling ────────────────────────────────────────────────────

  function armTimer(delayMs: number, onFire: () => void): void {
    if (!started) return;
    clearTimeout(nextTimer);
    const scheduledGeneration = generation;
    nextTimer = setTimeout(() => {
      if (!started || scheduledGeneration !== generation) return;
      nextTimer = undefined;
      onFire();
      processDue().catch((err) => {
        console.error(`[${tag}] Unexpected error in processDue:`, err);
      });
    }, Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS));
  }

  function armNext(): void {
    if (!started) return;
    clearTimeout(nextTimer);
    nextTimer = undefined;

    const nextWakeAt = work.getNextWakeAt();
    if (!nextWakeAt) return;
    const wakeAtMs = Date.parse(nextWakeAt);
    // A wake time already past is a lease the last pass could not recover; look again shortly, not at once.
    const untilWake = wakeAtMs - Date.now();
    const delay = untilWake > 0 ? untilWake : PAST_WAKE_RETRY_MS;
    armTimer(delay, () => {
      if (delay > MAX_TIMER_DELAY_MS) return;
      recordTelemetry("defer.runner.timer_wake", 0, {
        scheduledFor: nextWakeAt,
        wakeDriftMs: Math.max(0, Date.now() - wakeAtMs),
      });
    });
  }

  /** While the Bridge as a whole cannot take deferred work, leave everything due and look again shortly. */
  function holdIfNotReady(dueCount: number): boolean {
    if (dueCount === 0) {
      holdLogged = false;
      return false;
    }
    const readiness = getReadiness();
    if (readiness.ready) {
      holdLogged = false;
      return false;
    }
    const reason = readiness.reason ?? "defer delivery is not ready";
    if (!holdLogged) {
      console.info(`[${tag}] Holding ${dueCount} due item(s): ${reason}`);
      holdLogged = true;
    }
    recordTelemetry("defer.runner.hold", 0, { reason, dueCount });
    armTimer(readiness.retryAfterMs ?? 5_000, () => {});
    return true;
  }

  function getDueReadyForAnotherPass(): { ready: boolean; held: boolean } {
    const due = work.listDue();
    if (holdIfNotReady(due.length)) return { ready: false, held: true };
    return {
      held: false,
      ready: due.some((item) =>
        !deliveryGuard.isActive(item.sessionId) && !sessionManager.isSessionBusy(item.sessionId)
      ),
    };
  }

  /**
   * Process all currently due items.
   * Starts at most one item per session per pass, FIFO by wake time then createdAt.
   */
  function processDue(): Promise<void> {
    if (processDuePromise) {
      rerunRequested = true;
      return processDuePromise;
    }
    processDuePromise = processDueLoop();
    return processDuePromise;
  }

  async function processDueLoop(): Promise<void> {
    try {
      do {
        rerunRequested = false;
        await processDueOnce();
      } while (started && rerunRequested);
    } finally {
      // Cleared in the same step as the loop's last check, so a rerun asked for after it starts a new pass.
      processDuePromise = undefined;
    }
  }

  async function processDueOnce(): Promise<void> {
    if (!started) return;
    let held = false;

    try {
      reclaimExpired();
      const due = work.listDue();
      if (due.length === 0) return;
      if (holdIfNotReady(due.length)) {
        held = true;
        return;
      }
      const bySession = new Map<string, DeferRunnerDueItem[]>();
      for (const item of due) {
        const items = bySession.get(item.sessionId);
        if (items) items.push(item);
        else bySession.set(item.sessionId, [item]);
      }
      const results = await Promise.all([...bySession.values()].map(processSession));
      const changed = results.includes("changed");
      if (changed) {
        const nextPass = getDueReadyForAnotherPass();
        if (nextPass.ready) {
          rerunRequested = true;
        } else if (nextPass.held) {
          held = true;
        }
      }
    } finally {
      if (!held) armNext();
    }
  }

  /** Take a chat's due items in order until one is started, changes, or shows the chat cannot take any. */
  async function processSession(items: DeferRunnerDueItem[]): Promise<ProcessOneResult> {
    for (const item of items) {
      try {
        const result = await processOne(item.id);
        if (result !== "waiting") return result;
      } catch (error) {
        console.error(`[${tag}] Failed to process ${noun} ${item.id}:`, error);
        recordTelemetry("defer.runner.item_failure", 0, {
          itemId: item.id,
          sessionId: item.sessionId,
          error: errorMessage(error),
        });
        return "unchanged";
      }
    }
    return "waiting";
  }

  // ── One item ──────────────────────────────────────────────────────

  async function processOne(id: string): Promise<ProcessOneResult> {
    if (!started) return "unchanged";
    const item = work.load(id);
    if (!item) return "unchanged";
    const { sessionId } = item;
    if (deliveryGuard.isActive(sessionId)) return "blocked";

    const sessions = await sessionManager.listSessionsFromDisk({ includeArchived: work.reachesArchived(item) });
    if (!started) return "unchanged";
    if (deliveryGuard.isActive(sessionId)) return "blocked";
    if (!sessions.some((session: any) => session.sessionId === sessionId)) {
      const changed = work.orphaned(item);
      if (changed) emitDeferSummary(sessionId);
      return changed ? "changed" : "unchanged";
    }
    const ended = await work.preflight(item);
    if (ended !== undefined) {
      if (ended) emitDeferSummary(sessionId);
      return ended ? "changed" : "unchanged";
    }
    if (!started) return "unchanged";

    // session:idle is the fast path for a busy chat; the watchdog also retries overdue items.
    if (sessionManager.isSessionBusy(sessionId)) return "blocked";
    const usesWorker = work.usesWorker(item);
    const capacityWait = sessionManager.getSessionCapacityWait?.(usesWorker ? undefined : sessionId);
    if (capacityWait) {
      work.noteWait(item, capacityWait);
      // A check waits for a context of its own; a message waits for its chat, and so do the messages after it.
      return usesWorker ? "waiting" : "blocked";
    }
    if (!deliveryGuard.tryClaim(sessionId)) return "blocked";

    let claimToken: string | undefined;
    let lease: DeferWorkerLease | undefined;
    try {
      if (usesWorker) {
        lease = sessionManager.tryAcquireDeferWorker();
        if (!lease) {
          deliveryGuard.release(sessionId);
          return "waiting";
        }
      }
      const claimed = work.claim(id);
      if (!claimed) {
        lease?.release();
        deliveryGuard.release(sessionId);
        return "unchanged"; // someone else claimed it
      }
      claimToken = claimed.claimToken;
      emitDeferSummary(sessionId);

      const token = claimed.claimToken;
      const renewalTimer = setInterval(() => {
        if (!started) return;
        if (!work.renew(id, token)) {
          console.warn(`[${tag}] Failed to renew lease for ${noun} ${id}`);
        }
      }, LEASE_RENEW_INTERVAL_MS);
      renewalTimers.add(renewalTimer);

      void finish(claimed.item, token, renewalTimer, lease).catch((err) => {
        console.error(`[${tag}] Unexpected delivery error for ${noun} ${id}:`, err);
      });
      return "claimed";
    } catch (error) {
      if (claimToken) {
        try {
          if (!work.release(id, claimToken)) {
            console.error(`[${tag}] Failed to roll back interrupted claim setup for ${noun} ${id}`);
          }
        } catch (releaseError) {
          console.error(`[${tag}] Failed to roll back interrupted claim setup for ${noun} ${id}:`, releaseError);
        }
      }
      lease?.release();
      deliveryGuard.release(sessionId);
      throw error;
    }
  }

  async function finish(
    item: Item,
    claimToken: string,
    renewalTimer: ReturnType<typeof setInterval>,
    lease: DeferWorkerLease | undefined,
  ): Promise<void> {
    const { id, sessionId } = item;
    // A waiting item stays due, so going straight into another pass would spin on it.
    let waiting = false;
    try {
      await work.run(item, claimToken, lease);
    } catch (error) {
      const message = errorMessage(error);
      if (
        isDeferWaitError(error)
        || !getReadiness().ready
        // A message's capacity refusal arrives as plain text, so ask again whether its chat can be loaded.
        || (!lease && sessionManager.getSessionCapacityWait?.(sessionId) !== undefined)
      ) {
        waiting = true;
        if (!work.release(id, claimToken, message)) {
          console.error(`[${tag}] Failed to release ${noun} ${id} without counting the try`);
        }
      } else {
        work.failed(item, claimToken, message);
      }
    } finally {
      lease?.release();
      clearInterval(renewalTimer);
      renewalTimers.delete(renewalTimer);
      // Release before looking for more work, so a same-session follow-up is not stranded.
      deliveryGuard.release(sessionId);
      emitDeferSummary(sessionId);
      // Not after a wait: two runners that each hold a waiting item would wake each other without end.
      if (!waiting) options.onSettled?.();
      // A waiting item is retried by the hold poll while the Bridge is not ready, else by the watchdog or an idle chat.
      const nextPass = !started
        ? undefined
        : waiting
          ? { ready: false, held: holdIfNotReady(work.listDue().length) }
          : getDueReadyForAnotherPass();
      if (nextPass?.ready) {
        processDue().catch((err) => {
          console.error(`[${tag}] processDue error after delivery settled:`, err);
        });
      } else if (!nextPass?.held) {
        armNext();
      }
    }
  }

  // ── Watchdog ──────────────────────────────────────────────────────

  async function runWatchdogSweep(): Promise<void> {
    const sweepGeneration = generation;
    const startedAt = Date.now();
    try {
      const due = work.listDue();
      await processDue();
      if (!started || sweepGeneration !== generation || due.length === 0) return;
      let oldestWakeAt = startedAt;
      for (const item of due) {
        const wakeAt = Date.parse(item.wakeAt);
        if (Number.isFinite(wakeAt)) oldestWakeAt = Math.min(oldestWakeAt, wakeAt);
      }
      recordTelemetry("defer.runner.watchdog_sweep", Date.now() - startedAt, {
        overdueCount: due.length,
        oldestOverdueAgeMs: Math.max(0, startedAt - oldestWakeAt),
      });
    } catch (error) {
      if (!started || sweepGeneration !== generation) return;
      console.error(`[${tag}] Watchdog sweep failed:`, error);
      recordTelemetry("defer.runner.watchdog_sweep_failure", Date.now() - startedAt, {
        error: errorMessage(error),
      });
    }
  }

  function startWatchdog(): void {
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (!started || watchdogSweepPromise) return;
      const sweep = runWatchdogSweep();
      watchdogSweepPromise = sweep;
      void sweep.finally(() => {
        if (watchdogSweepPromise === sweep) watchdogSweepPromise = undefined;
      });
    }, DEFER_WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
  }

  // ── Public API ────────────────────────────────────────────────────

  function start(): void {
    if (started) return;
    started = true;
    generation++;

    reclaimExpired();
    startWatchdog();

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
        const cancelled = work.cancelForSession(event.sessionId);
        if (cancelled > 0) {
          console.log(`[${tag}] Cancelled ${cancelled} ${noun}(s) for archived session ${event.sessionId}`);
          emitDeferSummary(event.sessionId);
        }
      }
    });

    // Catch up and arm
    processDue().catch((err) => {
      console.error(`[${tag}] Startup processDue error:`, err);
    });

    console.log(`[${tag}] Started`);
  }

  /** Re-run due processing now. Call this after queuing an item so the runner wakes up promptly. */
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
    clearInterval(watchdogTimer);
    watchdogTimer = undefined;
    watchdogSweepPromise = undefined;
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
