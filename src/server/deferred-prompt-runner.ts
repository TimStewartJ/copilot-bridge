// Deferred prompt runner — one-shot defers and messages queued for a chat.

import { randomUUID } from "node:crypto";
import type { DeferredPrompt, DeferredPromptStore } from "./deferred-prompt-store.js";
import type { SessionManager } from "./session-manager.js";
import type { GlobalBus } from "./global-bus.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";
import type { DeferSummarySources } from "./defer-summary.js";
import {
  computeDeferRetryBackoffMs,
  createDeferRunnerCore,
  LEASE_MS,
  MAX_ATTEMPTS,
  type DeferRunnerOptions,
} from "./defer-runner-core.js";
import {
  createFailedDeferDelivery,
  createReturnedDeferDelivery,
  type DeferredResultDelivery,
} from "./defer-result-message.js";
import type { DeferWorkerInput } from "./defer-worker.js";
import { isRestartRecoveryPrompt } from "./restart-resume.js";
import { chatMessageDeliveryClientId, isChatMessageDeliveryId } from "./chat-message-outbox.js";

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

export type DeferredPromptRunnerOptions = DeferRunnerOptions;

export function createDeferredPromptRunner(
  store: DeferredPromptStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
  summarySources: DeferSummarySources = { deferredPromptStore: store },
  options: DeferRunnerOptions = {},
) {
  const isDelivery = (item: DeferredPrompt) => item.purpose === "delivery";
  // A message is sent into the chat itself; anything else is a check that runs in a worker.
  const isMessage = (item: DeferredPrompt) => isDelivery(item) || isRestartRecoveryPrompt(item.prompt);

  return createDeferRunnerCore<DeferredPrompt>({
    sessionManager,
    globalBus,
    deliveryGuard,
    summarySources,
    labels: { tag: "deferred-runner", noun: "deferral", kind: "once" },
    ...options,
    createWork: (ctx) => {
      /** The attempt budget is used up: stop, and tell the chat unless the item is itself a message for it. */
      function giveUp(item: DeferredPrompt, error: string, claimToken?: string): boolean {
        const failed = store.fail(item.id, error, {
          claimToken,
          ...(isDelivery(item)
            ? {}
            : {
                message: createFailedDeferDelivery({
                  deferId: item.deferId,
                  kind: "once",
                  parentSessionId: item.sessionId,
                }, item.attempts, error),
              }),
        });
        console.error(`[deferred-runner] Deferral ${item.id} failed after ${item.attempts} attempt(s): ${error}`);
        if (failed) ctx.recordSessionAttention(item.sessionId);
        return failed;
      }

      return {
        listDue: () => store.listDue().map((item) => ({
          id: item.id,
          sessionId: item.sessionId,
          wakeAt: item.runAt,
        })),
        getNextWakeAt: () => store.getNextWakeAt(),
        reclaimExpired: (now) => store.reclaimExpiredRunning(now),
        cancelForSession: (sessionId) =>
          store.cancelForSession(sessionId) + store.cancelManagementJobDeliveriesForSession(sessionId),

        load: (id) => {
          const item = store.get(id);
          return item?.status === "pending" ? item : undefined;
        },
        usesWorker: (item) => !isMessage(item),
        reachesArchived: isDelivery,
        orphaned: (item) => {
          if (isDelivery(item)) return store.fail(item.id, "Parent session no longer exists.");
          const cancelled = store.cancelForSession(item.sessionId);
          console.warn(`[deferred-runner] Session ${item.sessionId} no longer exists; cancelling ${cancelled} deferral(s)`);
          return cancelled > 0;
        },
        preflight: async (item) => {
          if (
            isDelivery(item)
            // A chat message never tried cannot be on disk yet, and a short one ("yes") would match an older copy.
            && !(isChatMessageDeliveryId(item.id) && item.attempts === 0)
            && await sessionManager.hasPersistedUserMessage?.(item.sessionId, item.prompt)
          ) {
            return store.complete(item.id);
          }
          if (item.attempts >= MAX_ATTEMPTS) {
            return giveUp(item, item.lastError ?? `Exceeded max attempts (${MAX_ATTEMPTS})`);
          }
          return undefined;
        },
        noteWait: (item, reason) => store.noteWait(item.id, reason),
        claim: (id) => {
          const claimed = store.claimDue(id, LEASE_MS);
          return claimed && { item: claimed.prompt, claimToken: claimed.claimToken };
        },
        renew: (id, claimToken) => store.renewClaim(id, claimToken, LEASE_MS),
        release: (id, claimToken, reason) => store.release(id, claimToken, { error: reason }),

        run: async (item, claimToken, lease) => {
          const { id, sessionId, prompt } = item;
          let message: DeferredResultDelivery | undefined;
          if (lease) {
            const input: DeferWorkerInput = { deferId: item.deferId, kind: "once", parentSessionId: sessionId, prompt };
            const result = await lease.run(input);
            if (result.action === "continue" || result.action === "notify") {
              throw new Error(`One-shot defer worker cannot ${result.action}.`);
            }
            if (result.action === "return") {
              message = createReturnedDeferDelivery(
                input,
                result.message ?? "Deferred work completed.",
                { deliveryId: result.deliveryId ?? randomUUID() },
              );
            }
          } else {
            const clientMessageId = chatMessageDeliveryClientId(id);
            await sessionManager.startWorkAndWaitForDelivery(sessionId, prompt, undefined, {
              completionAttention: true,
              ...(clientMessageId ? { clientMessageId } : {}),
            });
          }
          // A false result means the deferral was cancelled or reactivated while this try ran; that state wins.
          store.complete(id, { claimToken, message });
        },
        failed: (item, claimToken, error) => {
          if (item.attempts >= MAX_ATTEMPTS) {
            giveUp(item, error, claimToken);
            return;
          }
          // The claim already counted this try.
          const retryAt = new Date(Date.now() + computeDeferRetryBackoffMs(item.attempts)).toISOString();
          console.warn(
            `[deferred-runner] Retrying deferral ${item.id} after attempt ${item.attempts}/${MAX_ATTEMPTS}: ${error}`,
          );
          if (!store.release(item.id, claimToken, { error, retryAt })) {
            console.error(`[deferred-runner] Failed to re-queue deferral ${item.id}`);
          }
        },
      };
    },
  });
}

export type DeferredPromptRunner = ReturnType<typeof createDeferredPromptRunner>;
