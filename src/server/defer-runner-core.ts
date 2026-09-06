// Shared defer-runner scaffolding — owns the scheduling/lease/bus lifecycle common to
// the one-shot deferred-prompt runner and the recurring defer-loop runner.
// Recomputes all timers from SQLite on startup; no in-memory state is authoritative.

import type { GlobalBus } from "./global-bus.js";
import { isPromptDeliveryInterruptedError, isRestartPendingError, type SessionManager } from "./session-manager.js";
import type { DeferDeliveryGuard } from "./defer-delivery-guard.js";
import { emitSessionDeferSummary, type DeferSummarySources } from "./defer-summary.js";
import type { TelemetryStore } from "./telemetry-store.js";
import { isBackendUnavailableError } from "./backend-availability.js";
import { protectionRetryAt, type FocusProtectionStore } from "./focus-protection-store.js";
import type {
  FocusProtectionDisposition,
  FocusProtectionHold,
  FocusProtectionWindow,
} from "../shared/focus-protection.js";

// ── Shared timing/lease constants ─────────────────────────────────

export const MAX_ATTEMPTS = 5;
export const INITIAL_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const LEASE_MS = 2 * 60_000;
export const LEASE_RENEW_INTERVAL_MS = Math.floor(LEASE_MS / 2);
export const MAX_TIMER_DELAY_MS = 2_000_000_000;
export const DEFER_WATCHDOG_INTERVAL_MS = 60_000;

export type DeferDeliveryErrorClassification = "pause" | "retry";

export function classifyDeferDeliveryError(error: unknown): DeferDeliveryErrorClassification {
  if (
    isRestartPendingError(error)
    || isPromptDeliveryInterruptedError(error)
    || isBackendUnavailableError(error)
  ) {
    return "pause";
  }
  return "retry";
}

export function computeDeferRetryBackoffMs(attempts: number): number {
  const boundedAttempts = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  return Math.min(
    INITIAL_BACKOFF_MS * Math.pow(2, boundedAttempts - 1),
    MAX_BACKOFF_MS,
  );
}

export type ProcessOneResult = "changed" | "blocked" | "unchanged" | "claimed";

/** Minimal shape the core needs from each due item to enforce one-per-session-per-pass FIFO. */
export interface DeferRunnerDueItem {
  id: string;
  sessionId: string;
  wakeAt: string;
  title?: string;
  /** Recovery prompts and worker returns continue already-admitted work. */
  continuation?: boolean;
  /** Expiry/cancellation housekeeping does not admit new work. */
  terminal?: boolean;
  expiresAt?: string;
}

export interface DeferRunnerReadiness {
  ready: boolean;
  reason?: string;
  retryAfterMs?: number;
  /** Fixed deadlines must not slide or rearm on watchdog/idle/poke retries. */
  retryAt?: string;
  protectionWindow?: FocusProtectionWindow;
}

export function withFocusProtectionReadiness(
  store: FocusProtectionStore | undefined,
  kind: "defer" | "defer-loop",
  item: DeferRunnerDueItem,
  readiness: DeferRunnerReadiness = { ready: true },
): DeferRunnerReadiness {
  if (!readiness.ready || item.continuation || item.terminal || !store) return readiness;
  const now = Date.now();
  // The latest normal end also covers work that was offline or behind another readiness gate.
  // The same work/slot key makes a later window's release strictly later than any older release.
  const window = store.current(now) ?? store.latestCompleted(now);
  if (!window) return readiness;
  const retryAt = protectionRetryAt(window, `${kind}:${item.id}:${item.wakeAt}`);
  if (Date.parse(item.wakeAt) >= Date.parse(window.endsAt) || now >= retryAt) return readiness;
  return {
    ready: false,
    reason: `focus protection: ${window.reason}`,
    retryAt: new Date(retryAt).toISOString(),
    protectionWindow: window,
  };
}

interface DeferProtectionSettlement {
  disposition: FocusProtectionDisposition;
  details?: Record<string, unknown>;
}

interface DeferRunnerHold {
  item: DeferRunnerDueItem;
  reason: string;
  retryAt: number;
  logKey: string;
  telemetryKey: string;
  protectionWindowId?: string;
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
  getProtectionDisposition?(hold: FocusProtectionHold): DeferProtectionSettlement | undefined;
}

/** Log/summary labels per runner. */
export interface DeferRunnerLabels {
  /** Bracketed log tag, e.g. "deferred-runner" or "defer-loop-runner". */
  tag: string;
  /** Singular noun for reclaim/cancel logs, e.g. "deferral" or "loop". */
  noun: string;
  /** Stable telemetry discriminator for the defer kind. */
  kind: "once" | "interval";
}

/**
 * Shared scaffolding exposed to each runner's processOne/finishDelivery strategy.
 * The core owns the delivery guard, renewal timers, summaries, and re-arm scheduling.
 */
export interface DeferRunnerCoreContext {
  isStarted(): boolean;
  readonly deliveryGuard: DeferDeliveryGuard;
  /** Synchronous admission check; repeat after asynchronous work and before taking any claims. */
  holdIfNotReady(item: DeferRunnerDueItem): boolean;
  settleProtectionHold(item: DeferRunnerDueItem, disposition: FocusProtectionDisposition): void;
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

export interface DeferRunnerOptions {
  telemetryStore?: Pick<TelemetryStore, "recordSpan">;
  focusProtectionStore?: FocusProtectionStore;
  additionalReadiness?: (item: DeferRunnerDueItem) => DeferRunnerReadiness;
}

export interface DeferRunnerCoreOptions extends DeferRunnerOptions {
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
  let nextTimerKey: string | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let idleImmediate: ReturnType<typeof setImmediate> | undefined;
  let watchdogSweepPromise: Promise<void> | undefined;
  let busUnsubscribe: (() => void) | undefined;
  let started = false;
  let generation = 0;
  let processDuePromise: Promise<void> | undefined;
  let rerunRequested = false;
  const heldItems = new Map<string, DeferRunnerHold>();
  const loggedHolds = new Set<string>();
  const recordedHolds = new Set<string>();
  const persistedHolds = new Map<string, string>();
  const renewalTimers = new Set<ReturnType<typeof setInterval>>();
  const protectionKind = labels.kind === "once" ? "defer" : "defer-loop";

  // ── Internal helpers ──────────────────────────────────────────────

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function recordTelemetry(name: string, duration: number, metadata: Record<string, unknown>): void {
    if (!started || !options.telemetryStore) return;
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

  function getOverdueTelemetry(due: ReadonlyArray<DeferRunnerDueItem>, now: number): {
    overdueCount: number;
    oldestOverdueAgeMs: number;
  } {
    let oldestWakeAt = now;
    for (const item of due) {
      const wakeAt = Date.parse(item.wakeAt);
      if (Number.isFinite(wakeAt)) oldestWakeAt = Math.min(oldestWakeAt, wakeAt);
    }
    return {
      overdueCount: due.length,
      oldestOverdueAgeMs: Math.max(0, now - oldestWakeAt),
    };
  }

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

  function getDeferDeliveryReadiness(item: DeferRunnerDueItem): DeferRunnerReadiness {
    if (item.terminal) return { ready: true };
    const sessionReadiness = sessionManager.getDeferDeliveryReadiness?.() ?? { ready: true };
    if (!sessionReadiness.ready) return sessionReadiness;
    return withFocusProtectionReadiness(
      options.focusProtectionStore, protectionKind, item,
      options.additionalReadiness?.(item) ?? sessionReadiness,
    );
  }

  function settleProtectionHold(item: DeferRunnerDueItem, disposition: FocusProtectionDisposition): void {
    options.focusProtectionStore?.settle({
      kind: protectionKind, workId: item.id, scheduledFor: item.wakeAt,
    }, disposition);
    persistedHolds.delete(item.id);
  }

  function reconcileProtectionHolds(): void {
    if (!started || !options.focusProtectionStore || !store.getProtectionDisposition) return;
    for (const hold of options.focusProtectionStore.outstanding(protectionKind)) {
      const settlement = store.getProtectionDisposition(hold);
      if (!settlement) continue;
      options.focusProtectionStore.settle({
        kind: protectionKind, workId: hold.workId, scheduledFor: hold.scheduledFor,
      }, settlement.disposition, settlement.details);
      if (heldItems.get(hold.workId)?.item.wakeAt === hold.scheduledFor) heldItems.delete(hold.workId);
      persistedHolds.delete(hold.workId);
    }
  }

  function holdIfNotReady(item: DeferRunnerDueItem): boolean {
    if (!started) return true;
    const readiness = getDeferDeliveryReadiness(item);
    if (readiness.ready) {
      heldItems.delete(item.id);
      return false;
    }
    const reason = readiness.reason ?? "defer delivery is not ready";
    const logKey = JSON.stringify([reason, readiness.retryAt, readiness.protectionWindow?.id]);
    const previous = heldItems.get(item.id);
    const retryAt = readiness.retryAt ? Date.parse(readiness.retryAt)
      : previous?.logKey === logKey && previous.retryAt > Date.now() ? previous.retryAt
        : Date.now() + Math.max(1, readiness.retryAfterMs ?? 5_000);
    heldItems.set(item.id, {
      item, reason, retryAt, logKey,
      telemetryKey: JSON.stringify([logKey, retryAt]),
      protectionWindowId: readiness.protectionWindow?.id,
    });
    if (readiness.protectionWindow && options.focusProtectionStore) {
      const key = JSON.stringify([readiness.protectionWindow.id, readiness.retryAt, item.wakeAt]);
      if (persistedHolds.get(item.id) !== key) {
        options.focusProtectionStore.hold(readiness.protectionWindow, {
          kind: protectionKind, workId: item.id, scheduledFor: item.wakeAt,
          sessionId: item.sessionId, title: item.title,
        });
        persistedHolds.set(item.id, key);
      }
    }
    return true;
  }

  function reportHolds(): void {
    const groups = new Map<string, { hold: DeferRunnerHold; count: number }>();
    for (const hold of heldItems.values()) {
      const group = groups.get(hold.telemetryKey);
      if (group) group.count++;
      else groups.set(hold.telemetryKey, { hold, count: 1 });
    }
    const logKeys = new Set([...heldItems.values()].map((hold) => hold.logKey));
    for (const key of loggedHolds) if (!logKeys.has(key)) loggedHolds.delete(key);
    for (const key of recordedHolds) if (!groups.has(key)) recordedHolds.delete(key);
    for (const [key, { hold, count }] of groups) {
      if (!loggedHolds.has(hold.logKey)) {
        console.info(`[${tag}] Holding ${count} due item(s): ${hold.reason}`);
        loggedHolds.add(hold.logKey);
      }
      if (!recordedHolds.has(key)) {
        recordTelemetry("defer.runner.hold", 0, {
          reason: hold.reason, dueCount: count,
          ...(hold.protectionWindowId ? {
            protectionWindowId: hold.protectionWindowId,
            resumeAt: new Date(hold.retryAt).toISOString(),
          } : {}),
        });
        recordedHolds.add(key);
      }
    }
  }

  function getReadyDue(): ReadonlyArray<DeferRunnerDueItem> {
    const due = store.listDue();
    const ids = new Set(due.map((item) => item.id));
    for (const id of heldItems.keys()) if (!ids.has(id)) heldItems.delete(id);
    for (const id of persistedHolds.keys()) if (!ids.has(id)) persistedHolds.delete(id);
    const ready = due.filter((item) => !holdIfNotReady(item));
    reportHolds();
    return ready;
  }

  function getDueReadyForAnotherPass(): boolean {
    return getReadyDue().some((item) => item.terminal
      || (!deliveryGuard.isActive(item.sessionId) && !sessionManager.isSessionBusy(item.sessionId)));
  }

  function emitDeferSummary(sessionId: string): void {
    if (!started) return;
    emitSessionDeferSummary(globalBus, sessionId, summarySources);
  }

  function emitDeferSummaries(sessionIds: Iterable<string>): void {
    for (const sessionId of new Set(sessionIds)) emitDeferSummary(sessionId);
  }

  function recordSessionAttention(sessionId: string, at = new Date().toISOString()): void {
    if (!started || typeof sessionManager.markSessionAttention !== "function") return;
    sessionManager.markSessionAttention(sessionId, at);
  }

  function armNext(): void {
    if (!started) return;
    const nextWakeAt = getNextWakeAt();
    let wakeAtMs = nextWakeAt ? Date.parse(nextWakeAt) : Infinity;
    let timerKey = nextWakeAt;
    let isHold = false;
    for (const hold of heldItems.values()) {
      const expiresAt = hold.item.expiresAt ? Date.parse(hold.item.expiresAt) : Infinity;
      const retryAt = Math.min(hold.retryAt, expiresAt);
      if (retryAt < wakeAtMs) {
        wakeAtMs = retryAt;
        timerKey = `${hold.logKey}:${retryAt}`;
        isHold = true;
      }
    }
    if (nextTimer && nextTimerKey === timerKey) return;
    clearTimeout(nextTimer);
    nextTimer = undefined;
    nextTimerKey = timerKey;
    if (!Number.isFinite(wakeAtMs)) return;
    const delay = Math.max(0, wakeAtMs - Date.now());
    const timerDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
    const scheduledGeneration = generation;
    nextTimer = setTimeout(() => {
      if (!started || scheduledGeneration !== generation) return;
      nextTimer = undefined;
      nextTimerKey = undefined;
      if (!isHold && timerDelay === delay) {
        recordTelemetry("defer.runner.timer_wake", 0, {
          scheduledFor: nextWakeAt,
          wakeDriftMs: Math.max(0, Date.now() - wakeAtMs),
        });
      }
      processDue().catch((err) => {
        console.error(`[${tag}] Unexpected error in processDue:`, err);
      });
    }, timerDelay);
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

    try {
      reconcileProtectionHolds();
      reclaimExpiredRunning();
      // Remove per-item holds before FIFO dedup so they cannot strand a continuation.
      const due = getReadyDue();
      if (due.length > 0) {
        const sessionsSeen = new Set<string>();
        const toProcess = due.filter((item) => {
          if (item.terminal) return true;
          if (sessionsSeen.has(item.sessionId)) return false;
          sessionsSeen.add(item.sessionId);
          return true;
        });

        const settled = await Promise.allSettled(toProcess.map((item) => processOne(item.id)));
        const results: ProcessOneResult[] = [];
        for (let index = 0; index < settled.length; index++) {
          const result = settled[index];
          const item = toProcess[index];
          if (result.status === "fulfilled") {
            results.push(result.value);
            continue;
          }
          console.error(`[${tag}] Failed to process ${noun} ${item.id}:`, result.reason);
          recordTelemetry("defer.runner.item_failure", 0, {
            itemId: item.id,
            sessionId: item.sessionId,
            error: errorMessage(result.reason),
          });
        }
        if (results.includes("changed")) {
          if (getDueReadyForAnotherPass()) rerunRequested = true;
        }
      }
    } finally {
      if (started) {
        try {
          reconcileProtectionHolds();
          reportHolds();
        } finally {
          armNext();
        }
      }
    }
  }

  async function runWatchdogSweep(): Promise<void> {
    const sweepGeneration = generation;
    const startedAt = Date.now();
    try {
      const due = store.listDue();
      await processDue();
      if (!started || sweepGeneration !== generation || due.length === 0) return;
      recordTelemetry("defer.runner.watchdog_sweep", Date.now() - startedAt, {
        ...getOverdueTelemetry(due, startedAt),
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
    if (started && shouldProcessNext) {
      if (getDueReadyForAnotherPass()) {
        processDue().catch((err) => {
          console.error(`[${tag}] processDue error after delivery settled:`, err);
        });
      } else {
        armNext();
      }
    } else {
      armNext();
    }
  }

  const ctx: DeferRunnerCoreContext = {
    isStarted: () => started,
    deliveryGuard,
    holdIfNotReady,
    settleProtectionHold,
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
    reconcileProtectionHolds();
    reclaimExpiredRunning();
    startWatchdog();

    // Subscribe to global bus events
    busUnsubscribe = globalBus.subscribe((event) => {
      if (event.type === "session:idle" && event.sessionId) {
        // Give the session one tick to settle before we re-try
        if (idleImmediate) return;
        const scheduledGeneration = generation;
        idleImmediate = setImmediate(() => {
          idleImmediate = undefined;
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
        poke();
        return;
      }

      if (event.type === "server:restart-cleared"
        || event.type === "focus:protection-cleared"
        || event.type === "focus:protection-changed") {
        const scheduledGeneration = generation;
        if (!started || scheduledGeneration !== generation) return;
        processDue().catch((err) => {
          console.error(`[${tag}] processDue error on ${event.type}:`, err);
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
    nextTimerKey = undefined;
    clearImmediate(idleImmediate);
    idleImmediate = undefined;
    clearInterval(watchdogTimer);
    watchdogTimer = undefined;
    watchdogSweepPromise = undefined;
    busUnsubscribe?.();
    busUnsubscribe = undefined;
    rerunRequested = false;
    deliveryGuard.clear();
    for (const timer of renewalTimers) clearInterval(timer);
    renewalTimers.clear();
    heldItems.clear();
    loggedHolds.clear();
    recordedHolds.clear();
    persistedHolds.clear();
    started = false;
  }

  return { start, poke, shutdown };
}
