// Deferred prompt runner — dispatches deferred same-session prompts on schedule
// Recomputes all timers from SQLite on startup; no in-memory state is authoritative.

import { randomUUID } from "node:crypto";
import type { DeferredPrompt, DeferredPromptStore } from "./deferred-prompt-store.js";
import type { SessionManager } from "./session-manager.js";
import type { GlobalBus } from "./global-bus.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";
import type { DeferSummarySources } from "./defer-summary.js";
import {
  classifyDeferDeliveryError,
  computeDeferRetryBackoffMs,
  createDeferRunnerCore,
  LEASE_MS,
  MAX_ATTEMPTS,
  type DeferRunnerOptions,
  type DeferRunnerCoreContext,
  type ProcessOneResult,
} from "./defer-runner-core.js";
import { isRestartPending } from "./restart-controller.js";
import {
  createFailedDeferDelivery,
  createReturnedDeferDelivery,
} from "./defer-result-message.js";
import type { DeferWorkerInput, DeferWorkerLease, DeferWorkerResult } from "./defer-worker.js";
import { isRestartRecoveryPrompt } from "./restart-resume.js";

// Re-export the shared timing/lease constants so existing importers keep working.
export {
  DEFER_WATCHDOG_INTERVAL_MS,
  INITIAL_BACKOFF_MS,
  LEASE_MS,
  LEASE_RENEW_INTERVAL_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  MAX_TIMER_DELAY_MS,
} from "./defer-runner-core.js";

// ── Runner ────────────────────────────────────────────────────────

export interface DeferredPromptRunnerOptions extends DeferRunnerOptions {
  isRestartPending?: () => boolean;
}

export function createDeferredPromptRunner(
  store: DeferredPromptStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
  summarySources: DeferSummarySources = { deferredPromptStore: store },
  options: DeferredPromptRunnerOptions = {},
) {
  const restartPending = options.isRestartPending ?? isRestartPending;
  const runWorker = async (input: DeferWorkerInput): Promise<DeferWorkerResult | undefined> => {
    const worker = (sessionManager as SessionManager & {
      runDeferWorker?: (workerInput: DeferWorkerInput) => Promise<DeferWorkerResult>;
    }).runDeferWorker;
    return worker ? worker.call(sessionManager, input) : undefined;
  };

  function createProcessOne(ctx: DeferRunnerCoreContext) {
    async function processOne(id: string): Promise<ProcessOneResult> {
      if (!ctx.isStarted()) return "unchanged";
      // Re-fetch prompt for fresh state
      const item = store.get(id);
      if (!item || item.status !== "pending") return "unchanged";
      if (ctx.deliveryGuard.isActive(item.sessionId)) return "blocked";
      const isDelivery = item.purpose === "delivery";

      if (
        isDelivery
        && await sessionManager.hasPersistedUserMessage?.(item.sessionId, item.prompt)
      ) {
        return store.markCompletedById(id) ? "changed" : "unchanged";
      }
      if (isDelivery && item.attempts >= MAX_ATTEMPTS) {
        const changed = store.markFailedById(
          id,
          item.lastError ?? `Exceeded max attempts (${MAX_ATTEMPTS})`,
        );
        console.error(`[deferred-runner] Delivery ${id} exceeded max attempts`);
        if (changed) {
          ctx.recordSessionAttention(item.sessionId);
          ctx.emitDeferSummary(item.sessionId);
        }
        return changed ? "changed" : "unchanged";
      }

      // Check session exists
      const sessionList = await sessionManager.listSessionsFromDisk({ includeArchived: isDelivery });
      if (!ctx.isStarted()) return "unchanged";
      if (ctx.deliveryGuard.isActive(item.sessionId)) return "blocked";
      const sessionExists = sessionList.some((s: any) => s.sessionId === item.sessionId);
      if (!sessionExists) {
        if (isDelivery) {
          return store.markFailedById(id, "Parent session no longer exists.")
            ? "changed"
            : "unchanged";
        }
        const cancelled = store.cancelForSession(item.sessionId);
        console.warn(`[deferred-runner] Session ${item.sessionId} no longer exists; cancelling ${cancelled} deferral(s)`);
        if (cancelled > 0) ctx.emitDeferSummary(item.sessionId);
        return cancelled > 0 ? "changed" : "unchanged";
      }
      if (item.attempts >= MAX_ATTEMPTS) {
        const lastError = item.lastError ?? `Exceeded max attempts (${MAX_ATTEMPTS})`;
        const changed = store.failWithMessage(
          id,
          lastError,
          createFailedDeferDelivery({
            deferId: item.deferId,
            kind: "once",
            parentSessionId: item.sessionId,
          }, item.attempts, lastError),
        );
        console.error(`[deferred-runner] Deferral ${id} exceeded max attempts`);
        if (changed) {
          ctx.recordSessionAttention(item.sessionId);
          ctx.emitDeferSummary(item.sessionId);
        }
        return changed ? "changed" : "unchanged";
      }

      // Check session is not busy
      if (sessionManager.isSessionBusy(item.sessionId)) {
        // session:idle is the fast path; the watchdog also retries overdue rows.
        return "blocked";
      }
      if (!ctx.deliveryGuard.tryClaim(item.sessionId)) return "blocked";

      let claimToken: string | undefined;
      let workerLease: DeferWorkerLease | undefined;
      try {
        const needsWorker = !isDelivery && !isRestartRecoveryPrompt(item.prompt);
        const acquireWorker = (sessionManager as SessionManager & {
          tryAcquireDeferWorker?: () => DeferWorkerLease | undefined;
        }).tryAcquireDeferWorker;
        if (needsWorker && acquireWorker) {
          workerLease = acquireWorker.call(sessionManager);
          if (!workerLease) {
            ctx.deliveryGuard.release(item.sessionId);
            return "blocked";
          }
        }
        // Claim the prompt (CAS)
        const claimed = store.claimDue(id, LEASE_MS);
        if (!claimed) {
          workerLease?.release();
          ctx.deliveryGuard.release(item.sessionId);
          return "unchanged"; // someone else claimed it
        }
        claimToken = claimed.claimToken;
        ctx.emitDeferSummary(item.sessionId);

        const claimedPrompt = claimed.prompt;
        const renewalTimer = ctx.startRenewal(() => {
          const renewed = store.renewClaim(id, claimed.claimToken, LEASE_MS);
          if (!renewed) {
            console.warn(`[deferred-runner] Failed to renew lease for deferral ${id}`);
          }
        });

        void finishDelivery(claimedPrompt, claimed.claimToken, renewalTimer, workerLease)
          .catch((err) => {
            console.error(`[deferred-runner] Unexpected delivery error for deferral ${id}:`, err);
          });
        return "claimed";
      } catch (error) {
        if (claimToken) {
          try {
            if (!store.releaseClaimWithoutAttempt(id, claimToken)) {
              console.error(`[deferred-runner] Failed to roll back interrupted claim setup for deferral ${id}`);
            }
          } catch (releaseError) {
            console.error(`[deferred-runner] Failed to roll back interrupted claim setup for deferral ${id}:`, releaseError);
          }
        }
        workerLease?.release();
        ctx.deliveryGuard.release(item.sessionId);
        throw error;
      }
    }

    async function finishDelivery(
      item: DeferredPrompt,
      claimToken: string,
      renewalTimer: ReturnType<typeof setInterval>,
      workerLease?: DeferWorkerLease,
    ): Promise<void> {
      const { id, sessionId, prompt, attempts } = item;
      let shouldProcessNextDuePrompt = false;
      try {
        if (item.purpose === "delivery" || isRestartRecoveryPrompt(item.prompt)) {
          await sessionManager.startWorkAndWaitForDelivery(sessionId, prompt, undefined, { completionAttention: true });
        } else {
          const workerInput: DeferWorkerInput = {
            deferId: item.deferId,
            kind: "once",
            parentSessionId: sessionId,
            prompt,
          };
          const result = workerLease
            ? await workerLease.run(workerInput)
            : await runWorker(workerInput);
          if (!result) {
            await sessionManager.startWorkAndWaitForDelivery(sessionId, prompt, undefined, { completionAttention: true });
          } else if (result.action === "return") {
            const delivery = createReturnedDeferDelivery(
              workerInput,
              result.message ?? "Deferred work completed.",
              { deliveryId: result.deliveryId ?? randomUUID() },
            );
            if (!store.completeWithMessage(id, claimToken, delivery)) {
              throw new Error(`Failed to queue deferred worker result ${item.deferId}.`);
            }
            ctx.emitDeferSummary(sessionId);
            shouldProcessNextDuePrompt = true;
            return;
          } else if (result.action === "continue" || result.action === "notify") {
            throw new Error(`One-shot defer worker cannot ${result.action}.`);
          }
        }
        const completed = store.markCompleted(id, claimToken);
        if (!completed) {
          const current = store.get(id);
          if (current?.status === "running" && current.claimToken === claimToken) {
            console.error(`[deferred-runner] Delivery completed but failed to mark deferral ${id} completed`);
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
        const classification = classifyDeferDeliveryError(err);
        if (classification === "pause") {
          const released = store.releaseClaimWithoutAttempt(id, claimToken);
          if (!released) {
            console.error(`[deferred-runner] Failed to pause deferral ${id} without consuming an attempt`);
          } else {
            ctx.emitDeferSummary(sessionId);
          }
          return;
        }

        const nextAttempts = attempts; // attempts already incremented by claimDue
        if (nextAttempts < MAX_ATTEMPTS) {
          const backoffMs = computeDeferRetryBackoffMs(nextAttempts);
          const retryAt = new Date(Date.now() + backoffMs).toISOString();
          console.warn(
            `[deferred-runner] Retrying deferral ${id} after attempt ${nextAttempts}/${MAX_ATTEMPTS}${isBusy ? " (session busy)" : ""}: ${msg}`,
          );
          const retried = store.retry(id, claimToken, retryAt, msg);
          if (!retried) {
            console.error(`[deferred-runner] Failed to re-queue deferral ${id}`);
          } else {
            ctx.emitDeferSummary(sessionId);
          }
        } else {
          const failed = item.purpose === "delivery"
            ? store.markFailed(id, claimToken, msg)
            : store.failWithMessage(
                id,
                msg,
                createFailedDeferDelivery({
                  deferId: item.deferId,
                  kind: "once",
                  parentSessionId: sessionId,
                }, nextAttempts, msg),
                { claimToken },
              );
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
        workerLease?.release();
        ctx.afterDeliverySettled(renewalTimer, sessionId, shouldProcessNextDuePrompt);
      }
    }

    return processOne;
  }

  return createDeferRunnerCore({
    store: {
      getNextFutureWakeAt: () => store.getNextFuturePending()?.runAt,
      getNextRunningLeaseWakeAt: () => store.getNextRunningLeaseExpiry()?.leaseExpiresAt,
      listDue: () => store.listDue().map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        wakeAt: item.runAt,
      })),
      reclaimExpiredRunning: (now) => store.reclaimExpiredRunning(now),
      listExpiredRunningSessionIds: (now) => store.listExpiredRunningSessionIds(now),
      cancelForSession: (sessionId) => store.cancelForSession(sessionId),
    },
    sessionManager,
    globalBus,
    deliveryGuard,
    summarySources,
    labels: { tag: "deferred-runner", noun: "deferral", kind: "once" },
    ...options,
    additionalReadiness: () => {
      const restartRecoveryDue = store.listDue().some((item) => isRestartRecoveryPrompt(item.prompt));
      return restartPending() && restartRecoveryDue
        ? { ready: false, reason: "restart recovery prompts wait for reconnect" }
        : { ready: true };
    },
    createProcessOne,
  });
}

export type DeferredPromptRunner = ReturnType<typeof createDeferredPromptRunner>;
