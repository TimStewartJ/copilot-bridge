// Deferred prompt runner — dispatches deferred same-session prompts on schedule
// Recomputes all timers from SQLite on startup; no in-memory state is authoritative.

import type { DeferredPromptStore } from "./deferred-prompt-store.js";
import type { SessionManager } from "./session-manager.js";
import { isPromptDeliveryInterruptedError, isRestartPendingError } from "./session-manager.js";
import type { GlobalBus } from "./global-bus.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";

// ── Constants ─────────────────────────────────────────────────────

export const MAX_ATTEMPTS = 5;
export const INITIAL_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const LEASE_MS = 2 * 60_000;
export const LEASE_RENEW_INTERVAL_MS = Math.floor(LEASE_MS / 2);
export const MAX_TIMER_DELAY_MS = 2_000_000_000;

type ProcessOneResult = "changed" | "blocked" | "unchanged" | "claimed";

// ── Runner ────────────────────────────────────────────────────────

export function createDeferredPromptRunner(
  store: DeferredPromptStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
) {
  let nextTimer: ReturnType<typeof setTimeout> | undefined;
  let busUnsubscribe: (() => void) | undefined;
  let started = false;
  let generation = 0;
  let processDuePromise: Promise<void> | undefined;
  let rerunRequested = false;
  const renewalTimers = new Set<ReturnType<typeof setInterval>>();

  // ── Internal helpers ──────────────────────────────────────────────

  function getNextWakeAt(): string | undefined {
    const nextPending = store.getNextFuturePending();
    const nextRunningLease = store.getNextRunningLeaseExpiry();
    const pendingWake = nextPending?.runAt;
    const runningWake = nextRunningLease?.leaseExpiresAt;
    if (!pendingWake) return runningWake;
    if (!runningWake) return pendingWake;
    return Date.parse(runningWake) < Date.parse(pendingWake) ? runningWake : pendingWake;
  }

  function reclaimExpiredRunning(): void {
    const reclaimed = store.reclaimExpiredRunning();
    if (reclaimed > 0) {
      console.log(`[deferred-runner] Reclaimed ${reclaimed} expired running deferral(s)`);
    }
  }

  function hasDuePromptReadyForAnotherPass(): boolean {
    return store.listDue().some((prompt) =>
      !deliveryGuard.isActive(prompt.sessionId) && !sessionManager.isSessionBusy(prompt.sessionId)
    );
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
        console.error("[deferred-runner] Unexpected error in processDue:", err);
      });
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
  }

  /**
   * Process all currently due prompts.
   * Runs at most one prompt per session per pass, FIFO by runAt then createdAt.
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
      const toProcess = due.filter((p) => {
        if (sessionsSeen.has(p.sessionId)) return false;
        sessionsSeen.add(p.sessionId);
        return true;
      });

      const results = await Promise.all(toProcess.map((item) => processOne(item.id)));
      if (results.includes("changed") && hasDuePromptReadyForAnotherPass()) {
        rerunRequested = true;
      }
    }

    armNext();
  }

  async function processOne(id: string): Promise<ProcessOneResult> {
    if (!started) return "unchanged";
    // Re-fetch prompt for fresh state
    const item = store.get(id);
    if (!item || item.status !== "pending") return "unchanged";
    if (deliveryGuard.isActive(item.sessionId)) return "blocked";

    if (item.attempts >= MAX_ATTEMPTS) {
      // Can't claim (no valid token), just directly cancel
      const cancelled = store.cancelById(id);
      console.error(`[deferred-runner] Deferral ${id} exceeded max attempts; cancelling`);
      return cancelled ? "changed" : "unchanged";
    }

    // Check session exists
    const sessionList = await sessionManager.listSessionsFromDisk({ includeArchived: false });
    if (!started) return "unchanged";
    if (deliveryGuard.isActive(item.sessionId)) return "blocked";
    const sessionExists = sessionList.some((s: any) => s.sessionId === item.sessionId);
    if (!sessionExists) {
      const cancelled = store.cancelForSession(item.sessionId);
      console.warn(`[deferred-runner] Session ${item.sessionId} no longer exists; cancelling ${cancelled} deferral(s)`);
      return cancelled > 0 ? "changed" : "unchanged";
    }

    // Check session is not busy
    if (sessionManager.isSessionBusy(item.sessionId)) {
      // Will retry when session:idle fires
      return "blocked";
    }
    if (!deliveryGuard.tryClaim(item.sessionId)) return "blocked";

    // Claim the prompt (CAS)
    const claimed = store.claimDue(id, LEASE_MS);
    if (!claimed) {
      deliveryGuard.release(item.sessionId);
      return "unchanged"; // someone else claimed it
    }

    const { claimToken } = claimed;
    const renewalTimer = setInterval(() => {
      if (!started) return;
      const renewed = store.renewClaim(id, claimToken, LEASE_MS);
      if (!renewed) {
        console.warn(`[deferred-runner] Failed to renew lease for deferral ${id}`);
      }
    }, LEASE_RENEW_INTERVAL_MS);
    renewalTimers.add(renewalTimer);

    void finishDelivery(item.id, item.sessionId, item.prompt, item.attempts, claimToken, renewalTimer)
      .catch((err) => {
        console.error(`[deferred-runner] Unexpected delivery error for deferral ${id}:`, err);
      });
    return "claimed";
  }

  async function finishDelivery(
    id: string,
    sessionId: string,
    prompt: string,
    attemptsBeforeClaim: number,
    claimToken: string,
    renewalTimer: ReturnType<typeof setInterval>,
  ): Promise<void> {
    let shouldProcessNextDuePrompt = false;
    try {
      await sessionManager.startWorkAndWaitForDelivery(sessionId, prompt);
      const completed = store.markCompleted(id, claimToken);
      if (!completed) {
        const completedById = store.markCompletedById(id);
        if (!completedById) {
          console.error(`[deferred-runner] Delivery completed but failed to mark deferral ${id} completed`);
        } else {
          shouldProcessNextDuePrompt = true;
        }
      } else {
        shouldProcessNextDuePrompt = true;
      }
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);

      const isBusy =
        msg.includes("Session is busy processing another message") ||
        msg.includes("Session is busy processing another request");
      const isRestartPending = isRestartPendingError(err);
      const isPromptDeliveryInterrupted = isPromptDeliveryInterruptedError(err);
      if (isRestartPending || isPromptDeliveryInterrupted) {
        const released = store.releaseClaimWithoutAttempt(id, claimToken);
        if (!released) {
          console.error(`[deferred-runner] Failed to pause deferral ${id} without consuming an attempt`);
        }
        return;
      }

      const nextAttempts = attemptsBeforeClaim + 1; // already incremented by claimDue
      if (isBusy && nextAttempts < MAX_ATTEMPTS) {
        const backoffMs = Math.min(
          INITIAL_BACKOFF_MS * Math.pow(2, nextAttempts - 1),
          MAX_BACKOFF_MS,
        );
        const retryAt = new Date(Date.now() + backoffMs).toISOString();
        const retried = store.retry(id, claimToken, retryAt);
        if (!retried) {
          console.error(`[deferred-runner] Failed to re-queue deferral ${id}`);
        }
      } else {
        const failed = store.markFailed(id, claimToken, msg);
        if (!failed) {
          console.error(`[deferred-runner] Failed to mark deferral ${id} failed`);
        } else {
          shouldProcessNextDuePrompt = true;
        }
        console.error(`[deferred-runner] Deferral ${id} failed after ${nextAttempts} attempt(s): ${msg}`);
      }
    } finally {
      clearInterval(renewalTimer);
      renewalTimers.delete(renewalTimer);
      deliveryGuard.release(sessionId);
      if (started && shouldProcessNextDuePrompt && hasDuePromptReadyForAnotherPass()) {
        processDue().catch((err) => {
          console.error("[deferred-runner] processDue error after delivery settled:", err);
        });
      } else {
        armNext();
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  function start(): void {
    if (started) return;
    started = true;
    generation++;

    // Reclaim any running rows whose leases have expired
    const reclaimed = store.reclaimExpiredRunning();
    if (reclaimed > 0) {
      console.log(`[deferred-runner] Reclaimed ${reclaimed} expired running deferral(s)`);
    }

    // Subscribe to global bus events
    busUnsubscribe = globalBus.subscribe((event) => {
      if (event.type === "session:idle" && event.sessionId) {
        // Give the session one tick to settle before we re-try
        const scheduledGeneration = generation;
        setImmediate(() => {
          if (!started || scheduledGeneration !== generation) return;
          processDue().catch((err) => {
            console.error("[deferred-runner] processDue error on session:idle:", err);
          });
        });
        return;
      }

      if (event.type === "session:archived" && event.sessionId && event.archived === true) {
        const cancelled = store.cancelForSession(event.sessionId);
        if (cancelled > 0) {
          console.log(`[deferred-runner] Cancelled ${cancelled} deferral(s) for archived session ${event.sessionId}`);
        }
        return;
      }

      if (event.type === "server:restart-cleared") {
        const scheduledGeneration = generation;
        if (!started || scheduledGeneration !== generation) return;
        processDue().catch((err) => {
          console.error("[deferred-runner] processDue error on server:restart-cleared:", err);
        });
      }
    });

    // Catch up and arm
    processDue().catch((err) => {
      console.error("[deferred-runner] Startup processDue error:", err);
    });

    console.log("[deferred-runner] Started");
  }

  /**
   * Re-arm the next timer immediately.
   * Call this after inserting a new deferral so the runner wakes up promptly.
   */
  function poke(): void {
    if (!started) return;
    processDue().catch((err) => {
      console.error("[deferred-runner] processDue error on poke:", err);
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

export type DeferredPromptRunner = ReturnType<typeof createDeferredPromptRunner>;
