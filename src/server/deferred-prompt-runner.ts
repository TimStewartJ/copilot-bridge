// Deferred prompt runner — dispatches deferred same-session prompts on schedule
// Recomputes all timers from SQLite on startup; no in-memory state is authoritative.

import type { DeferredPrompt, DeferredPromptStore } from "./deferred-prompt-store.js";
import type { SessionManager } from "./session-manager.js";
import { isPromptDeliveryInterruptedError, isRestartPendingError } from "./session-manager.js";
import type { GlobalBus } from "./global-bus.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";
import type { DeferSummarySources } from "./defer-summary.js";
import {
  createDeferRunnerCore,
  INITIAL_BACKOFF_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  type DeferRunnerCoreContext,
  type ProcessOneResult,
} from "./defer-runner-core.js";

// Re-export the shared timing/lease constants so existing importers keep working.
export {
  INITIAL_BACKOFF_MS,
  LEASE_MS,
  LEASE_RENEW_INTERVAL_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  MAX_TIMER_DELAY_MS,
} from "./defer-runner-core.js";

// ── Runner ────────────────────────────────────────────────────────

export function createDeferredPromptRunner(
  store: DeferredPromptStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
  summarySources: DeferSummarySources = { deferredPromptStore: store },
) {
  function createProcessOne(ctx: DeferRunnerCoreContext) {
    async function processOne(id: string): Promise<ProcessOneResult> {
      if (!ctx.isStarted()) return "unchanged";
      // Re-fetch prompt for fresh state
      const item = store.get(id);
      if (!item || item.status !== "pending") return "unchanged";
      if (ctx.deliveryGuard.isActive(item.sessionId)) return "blocked";

      if (item.attempts >= MAX_ATTEMPTS) {
        // Can't claim (no valid token), just directly cancel
        const cancelled = store.cancelById(id);
        console.error(`[deferred-runner] Deferral ${id} exceeded max attempts; cancelling`);
        if (cancelled) {
          ctx.recordSessionAttention(item.sessionId);
          ctx.emitDeferSummary(item.sessionId);
        }
        return cancelled ? "changed" : "unchanged";
      }

      // Check session exists
      const sessionList = await sessionManager.listSessionsFromDisk({ includeArchived: false });
      if (!ctx.isStarted()) return "unchanged";
      if (ctx.deliveryGuard.isActive(item.sessionId)) return "blocked";
      const sessionExists = sessionList.some((s: any) => s.sessionId === item.sessionId);
      if (!sessionExists) {
        const cancelled = store.cancelForSession(item.sessionId);
        console.warn(`[deferred-runner] Session ${item.sessionId} no longer exists; cancelling ${cancelled} deferral(s)`);
        if (cancelled > 0) ctx.emitDeferSummary(item.sessionId);
        return cancelled > 0 ? "changed" : "unchanged";
      }

      // Check session is not busy
      if (sessionManager.isSessionBusy(item.sessionId)) {
        // Will retry when session:idle fires
        return "blocked";
      }
      if (!ctx.deliveryGuard.tryClaim(item.sessionId)) return "blocked";

      // Claim the prompt (CAS)
      const claimed = store.claimDue(id, LEASE_MS);
      if (!claimed) {
        ctx.deliveryGuard.release(item.sessionId);
        return "unchanged"; // someone else claimed it
      }
      ctx.emitDeferSummary(item.sessionId);

      const { claimToken } = claimed;
      const claimedPrompt = claimed.prompt;
      const renewalTimer = ctx.startRenewal(() => {
        const renewed = store.renewClaim(id, claimToken, LEASE_MS);
        if (!renewed) {
          console.warn(`[deferred-runner] Failed to renew lease for deferral ${id}`);
        }
      });

      void finishDelivery(claimedPrompt, claimToken, renewalTimer)
        .catch((err) => {
          console.error(`[deferred-runner] Unexpected delivery error for deferral ${id}:`, err);
        });
      return "claimed";
    }

    async function finishDelivery(
      item: DeferredPrompt,
      claimToken: string,
      renewalTimer: ReturnType<typeof setInterval>,
    ): Promise<void> {
      const { id, sessionId, prompt, attempts } = item;
      let shouldProcessNextDuePrompt = false;
      try {
        await sessionManager.startWorkAndWaitForDelivery(sessionId, prompt, undefined, { completionAttention: true });
        const completed = store.markCompleted(id, claimToken);
        if (!completed) {
          const completedById = store.markCompletedById(id);
          if (!completedById) {
            console.error(`[deferred-runner] Delivery completed but failed to mark deferral ${id} completed`);
          } else {
            ctx.emitDeferSummary(sessionId);
            shouldProcessNextDuePrompt = true;
          }
        } else {
          ctx.emitDeferSummary(sessionId);
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
          } else {
            ctx.emitDeferSummary(sessionId);
          }
          return;
        }

        const nextAttempts = attempts; // attempts already incremented by claimDue
        if (isBusy && nextAttempts < MAX_ATTEMPTS) {
          const backoffMs = Math.min(
            INITIAL_BACKOFF_MS * Math.pow(2, nextAttempts - 1),
            MAX_BACKOFF_MS,
          );
          const retryAt = new Date(Date.now() + backoffMs).toISOString();
          const retried = store.retry(id, claimToken, retryAt);
          if (!retried) {
            console.error(`[deferred-runner] Failed to re-queue deferral ${id}`);
          } else {
            ctx.emitDeferSummary(sessionId);
          }
        } else {
          const failed = store.markFailed(id, claimToken, msg);
          if (!failed) {
            console.error(`[deferred-runner] Failed to mark deferral ${id} failed`);
          } else {
            ctx.recordSessionAttention(sessionId);
            ctx.emitDeferSummary(sessionId);
            shouldProcessNextDuePrompt = true;
          }
          console.error(`[deferred-runner] Deferral ${id} failed after ${nextAttempts} attempt(s): ${msg}`);
        }
      } finally {
        ctx.afterDeliverySettled(renewalTimer, sessionId, shouldProcessNextDuePrompt);
      }
    }

    return processOne;
  }

  return createDeferRunnerCore({
    store: {
      getNextFutureWakeAt: () => store.getNextFuturePending()?.runAt,
      getNextRunningLeaseWakeAt: () => store.getNextRunningLeaseExpiry()?.leaseExpiresAt,
      listDue: () => store.listDue(),
      reclaimExpiredRunning: (now) => store.reclaimExpiredRunning(now),
      listExpiredRunningSessionIds: (now) => store.listExpiredRunningSessionIds(now),
      cancelForSession: (sessionId) => store.cancelForSession(sessionId),
    },
    sessionManager,
    globalBus,
    deliveryGuard,
    summarySources,
    labels: { tag: "deferred-runner", noun: "deferral" },
    createProcessOne,
  });
}

export type DeferredPromptRunner = ReturnType<typeof createDeferredPromptRunner>;
