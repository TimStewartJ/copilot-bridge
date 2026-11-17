// Outbox runner: delivers messages queued for a chat, one at a time per chat.

import type { DeferredPrompt, DeferredPromptStore } from "./deferred-prompt-store.js";
import type { SessionManager } from "./session-manager.js";
import type { GlobalBus } from "./global-bus.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";
import {
  computeRetryBackoffMs,
  createChatWorkRunner,
  LEASE_MS,
  MAX_ATTEMPTS,
  type ChatWorkOptions,
} from "./chat-work-runner.js";
import { chatMessageDeliveryClientId, isChatMessageDeliveryId } from "./chat-message-outbox.js";

export type DeferredPromptRunnerOptions = ChatWorkOptions;

export function createDeferredPromptRunner(
  store: DeferredPromptStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
  options: ChatWorkOptions = {},
) {
  // Deliveries also reach archived chats; restart notices (the only other rows) do not.
  const isDelivery = (item: DeferredPrompt) => item.purpose === "delivery";

  return createChatWorkRunner<DeferredPrompt>({
    sessionManager,
    globalBus,
    deliveryGuard,
    labels: { tag: "outbox-runner", noun: "message", kind: "outbox" },
    ...options,
    createWork: (ctx) => {
      /** The attempt budget is used up: stop. */
      function giveUp(item: DeferredPrompt, error: string, claimToken?: string): boolean {
        const failed = store.fail(item.id, error, { claimToken });
        console.error(`[outbox-runner] Message ${item.id} failed after ${item.attempts} attempt(s): ${error}`);
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
        usesWorker: () => false,
        reachesArchived: isDelivery,
        orphaned: (item) => {
          if (isDelivery(item)) return store.fail(item.id, "Parent session no longer exists.");
          const cancelled = store.cancelForSession(item.sessionId);
          console.warn(`[outbox-runner] Session ${item.sessionId} no longer exists; cancelling ${cancelled} message(s)`);
          return cancelled > 0;
        },
        preflight: async (item) => {
          if (
            isDelivery(item)
            // An untried message is not on disk yet; a short one ("yes") could match an older copy.
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

        run: async (item, claimToken) => {
          const clientMessageId = chatMessageDeliveryClientId(item.id);
          await sessionManager.startWorkAndWaitForDelivery(item.sessionId, item.prompt, undefined, {
            completionAttention: true,
            origin: "defer",
            // A queued chat message is the person's own; everything else here is a trigger's.
            ...(clientMessageId ? { clientMessageId } : { promptSource: "automation-defer" }),
          });
          // False means it was cancelled or reactivated meanwhile; that state wins.
          store.complete(item.id, { claimToken });
        },
        failed: (item, claimToken, error) => {
          if (item.attempts >= MAX_ATTEMPTS) {
            giveUp(item, error, claimToken);
            return;
          }
          // The claim already counted this try.
          const retryAt = new Date(Date.now() + computeRetryBackoffMs(item.attempts)).toISOString();
          console.warn(
            `[outbox-runner] Retrying message ${item.id} after attempt ${item.attempts}/${MAX_ATTEMPTS}: ${error}`,
          );
          if (!store.release(item.id, claimToken, { error, retryAt })) {
            console.error(`[outbox-runner] Failed to re-queue message ${item.id}`);
          }
        },
      };
    },
  });
}

export type DeferredPromptRunner = ReturnType<typeof createDeferredPromptRunner>;
