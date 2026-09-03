import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { DeferDeliveryGuard } from "./defer-delivery-guard.js";
import { createDeferDeliveryGuard } from "./defer-delivery-guard.js";
import {
  classifyDeferDeliveryError,
  computeDeferRetryBackoffMs,
  createDeferRunnerCore,
  LEASE_MS,
  MAX_ATTEMPTS,
  type DeferRunnerCoreContext,
  type DeferRunnerOptions,
  type ProcessOneResult,
} from "./defer-runner-core.js";
import type {
  SessionMessageOutboxItem,
  SessionMessageOutboxStore,
} from "./session-message-outbox-store.js";

export function createSessionMessageOutboxRunner(
  store: SessionMessageOutboxStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
  options: DeferRunnerOptions = {},
) {
  function createProcessOne(ctx: DeferRunnerCoreContext) {
    async function processOne(id: string): Promise<ProcessOneResult> {
      if (!ctx.isStarted()) return "unchanged";
      const item = store.get(id);
      if (!item || item.status !== "pending") return "unchanged";
      if (ctx.deliveryGuard.isActive(item.sessionId)) return "blocked";

      if (await sessionManager.hasPersistedUserMessage?.(item.sessionId, item.prompt)) {
        return store.markCompletedById(item.id) ? "changed" : "unchanged";
      }
      if (item.attempts >= MAX_ATTEMPTS) {
        const failed = store.markFailedById(item.id, `Exceeded max attempts (${MAX_ATTEMPTS})`);
        if (failed) ctx.recordSessionAttention(item.sessionId);
        return failed ? "changed" : "unchanged";
      }

      const sessions = await sessionManager.listSessionsFromDisk({ includeArchived: true });
      if (!ctx.isStarted()) return "unchanged";
      if (!sessions.some((session: { sessionId: string }) => session.sessionId === item.sessionId)) {
        const failed = store.markFailedById(item.id, "Parent session no longer exists.");
        return failed ? "changed" : "unchanged";
      }
      if (sessionManager.isSessionBusy(item.sessionId)) return "blocked";
      if (!ctx.deliveryGuard.tryClaim(item.sessionId)) return "blocked";

      const claimed = store.claimDue(id, LEASE_MS);
      if (!claimed) {
        ctx.deliveryGuard.release(item.sessionId);
        return "unchanged";
      }
      const renewalTimer = ctx.startRenewal(() => {
        if (!store.renewClaim(id, claimed.claimToken, LEASE_MS)) {
          console.warn(`[session-message-outbox] Failed to renew lease for message ${id}`);
        }
      });
      void finishDelivery(claimed.item, claimed.claimToken, renewalTimer).catch((error) => {
        console.error(`[session-message-outbox] Unexpected delivery error for message ${id}:`, error);
      });
      return "claimed";
    }

    async function finishDelivery(
      item: SessionMessageOutboxItem,
      claimToken: string,
      renewalTimer: ReturnType<typeof setInterval>,
    ): Promise<void> {
      if (!item) return;
      let processNext = false;
      try {
        await sessionManager.startWorkAndWaitForDelivery(
          item.sessionId,
          item.prompt,
          undefined,
          { completionAttention: true },
        );
        if (!store.markCompleted(item.id, claimToken)) {
          console.error(`[session-message-outbox] Delivered message ${item.id} but failed to mark it completed`);
        } else {
          processNext = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (classifyDeferDeliveryError(error) === "pause") {
          if (!store.releaseClaimWithoutAttempt(item.id, claimToken)) {
            console.error(`[session-message-outbox] Failed to pause message ${item.id}`);
          }
          return;
        }
        if (item.attempts < MAX_ATTEMPTS) {
          const retryAt = new Date(Date.now() + computeDeferRetryBackoffMs(item.attempts)).toISOString();
          if (!store.retry(item.id, claimToken, retryAt, message)) {
            console.error(`[session-message-outbox] Failed to retry message ${item.id}`);
          }
        } else if (store.markFailed(item.id, claimToken, message)) {
          ctx.recordSessionAttention(item.sessionId);
        }
      } finally {
        ctx.afterDeliverySettled(renewalTimer, item.sessionId, processNext);
      }
    }

    return processOne;
  }

  return createDeferRunnerCore({
    store: {
      getNextFutureWakeAt: () => store.getNextFuturePending()?.availableAt,
      getNextRunningLeaseWakeAt: () => store.getNextRunningLeaseExpiry()?.leaseExpiresAt,
      listDue: () => store.listDue().map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        wakeAt: item.availableAt,
      })),
      reclaimExpiredRunning: (now) => store.reclaimExpiredRunning(now),
      listExpiredRunningSessionIds: (now) => store.listExpiredRunningSessionIds(now),
    },
    sessionManager,
    globalBus,
    deliveryGuard,
    summarySources: {},
    labels: { tag: "session-message-outbox", noun: "message", kind: "outbox" },
    cancelOnArchive: false,
    emitDeferSummary: false,
    createProcessOne,
    ...options,
  });
}

export type SessionMessageOutboxRunner = ReturnType<typeof createSessionMessageOutboxRunner>;
