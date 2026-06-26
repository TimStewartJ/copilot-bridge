// Recurring defer loop runner — dispatches interval same-session prompts.

import type { DeferLoop, DeferLoopStore } from "./defer-loop-store.js";
import { toIntervalDeferId } from "./defer-ids.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";
import type { DeferSummarySources } from "./defer-summary.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import { isPromptDeliveryInterruptedError, isRestartPendingError } from "./session-manager.js";
import {
  createDeferRunnerCore,
  INITIAL_BACKOFF_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  type DeferRunnerCoreContext,
  type ProcessOneResult,
} from "./defer-runner-core.js";

function formatLoopPrompt(loop: DeferLoop): string {
  const lines = [
    "<defer>",
    `deferId: ${toIntervalDeferId(loop.id)}`,
    "kind: interval",
    "attentionMode: quiet",
    `runCount: ${loop.runCount + 1}`,
    `intervalSeconds: ${loop.intervalSeconds}`,
    `nextRunAt: ${loop.nextRunAt}`,
  ];
  if (loop.maxRuns !== undefined) lines.push(`maxRuns: ${loop.maxRuns}`);
  if (loop.expiresAt) lines.push(`expiresAt: ${loop.expiresAt}`);
  lines.push(
    "</defer>",
    "",
    "Quiet recurring deferral instructions:",
    "- This is an automated polling check. If there is nothing actionable for the user, give a concise status and stop.",
    "- Do not ask a question just to report no change.",
    "- If user action is needed, cancel this recurring deferral with the defer cancel tool using the deferId above, then clearly state the required next step and stop.",
    "",
    "User prompt:",
    loop.prompt,
  );
  return lines.join("\n");
}

export function createDeferLoopRunner(
  store: DeferLoopStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
  summarySources: DeferSummarySources = { deferLoopStore: store },
) {
  function createProcessOne(ctx: DeferRunnerCoreContext) {
    async function processOne(id: string): Promise<ProcessOneResult> {
      if (!ctx.isStarted()) return "unchanged";
      const loop = store.get(id);
      if (!loop || loop.status !== "active") return "unchanged";
      if (ctx.deliveryGuard.isActive(loop.sessionId)) return "blocked";

      const now = new Date();
      if (loop.maxRuns !== undefined && loop.runCount >= loop.maxRuns) {
        const completed = store.markCompleted(id);
        if (completed) {
          ctx.recordSessionAttention(loop.sessionId);
          ctx.emitDeferSummary(loop.sessionId);
        }
        return completed ? "changed" : "unchanged";
      }
      if (loop.expiresAt && Date.parse(loop.expiresAt) <= now.getTime()) {
        const expired = store.markExpired(id);
        if (expired) {
          ctx.recordSessionAttention(loop.sessionId);
          ctx.emitDeferSummary(loop.sessionId);
        }
        return expired ? "changed" : "unchanged";
      }
      if (loop.attempts >= MAX_ATTEMPTS) {
        const failed = store.markFailedById(id, `Exceeded max attempts (${MAX_ATTEMPTS})`);
        const cancelled = !failed && store.cancelById(id);
        if (failed || cancelled) {
          ctx.recordSessionAttention(loop.sessionId);
          ctx.emitDeferSummary(loop.sessionId);
        }
        console.error(`[defer-loop-runner] Loop ${id} exceeded max attempts; stopping`);
        return "changed";
      }

      const sessionList = await sessionManager.listSessionsFromDisk({ includeArchived: false });
      if (!ctx.isStarted()) return "unchanged";
      if (ctx.deliveryGuard.isActive(loop.sessionId)) return "blocked";
      const sessionExists = sessionList.some((s: any) => s.sessionId === loop.sessionId);
      if (!sessionExists) {
        const cancelled = store.cancelForSession(loop.sessionId);
        console.warn(`[defer-loop-runner] Session ${loop.sessionId} no longer exists; cancelling ${cancelled} loop(s)`);
        if (cancelled > 0) ctx.emitDeferSummary(loop.sessionId);
        return cancelled > 0 ? "changed" : "unchanged";
      }

      if (sessionManager.isSessionBusy(loop.sessionId)) return "blocked";
      if (!ctx.deliveryGuard.tryClaim(loop.sessionId)) return "blocked";

      const claimed = store.claimDue(id, LEASE_MS);
      if (!claimed) {
        ctx.deliveryGuard.release(loop.sessionId);
        return "unchanged";
      }
      ctx.emitDeferSummary(loop.sessionId);

      const { claimToken } = claimed;
      const claimedLoop = claimed.loop;
      const renewalTimer = ctx.startRenewal(() => {
        const renewed = store.renewClaim(id, claimToken, LEASE_MS);
        if (!renewed) {
          console.warn(`[defer-loop-runner] Failed to renew lease for loop ${id}`);
        }
      });

      void finishDelivery(claimedLoop, claimToken, renewalTimer).catch((err) => {
        console.error(`[defer-loop-runner] Unexpected delivery error for loop ${id}:`, err);
      });
      return "claimed";
    }

    async function finishDelivery(
      loop: DeferLoop,
      claimToken: string,
      renewalTimer: ReturnType<typeof setInterval>,
    ): Promise<void> {
      let shouldProcessNextDueLoop = false;
      try {
        await sessionManager.startWorkAndWaitForDelivery(
          loop.sessionId,
          formatLoopPrompt(loop),
          undefined,
          {
            attentionMode: "quiet",
            historyTruncation: {
              mode: "replace-quiet-interval-defer-tail",
              deferId: loop.deferId,
            },
          },
        );
        const acceptedAt = new Date();
        const nextRunAt = new Date(acceptedAt.getTime() + loop.intervalSeconds * 1000).toISOString();
        const updated = store.completeOccurrence(loop.id, claimToken, nextRunAt, acceptedAt.toISOString());
        if (!updated) {
          const current = store.get(loop.id);
          if (current?.status !== "cancelled") {
            console.error(`[defer-loop-runner] Delivery completed but failed to update loop ${loop.id}`);
          }
        } else {
          ctx.emitDeferSummary(loop.sessionId);
          if (updated.status === "active") {
            shouldProcessNextDueLoop = true;
          } else {
            ctx.recordSessionAttention(loop.sessionId);
          }
        }
      } catch (err: any) {
        const msg: string = err?.message ?? String(err);
        const isBusy =
          msg.includes("Session is busy processing another message") ||
          msg.includes("Session is busy processing another request");
        const isRestartPending = isRestartPendingError(err);
        const isPromptDeliveryInterrupted = isPromptDeliveryInterruptedError(err);
        if (isRestartPending || isPromptDeliveryInterrupted) {
          const released = store.releaseClaimWithoutAttempt(loop.id, claimToken);
          if (!released) {
            console.error(`[defer-loop-runner] Failed to pause loop ${loop.id} without consuming an attempt`);
          } else {
            ctx.emitDeferSummary(loop.sessionId);
          }
          return;
        }

        const nextAttempts = loop.attempts; // attempts already incremented by claimDue
        if (isBusy && nextAttempts < MAX_ATTEMPTS) {
          const backoffMs = Math.min(
            INITIAL_BACKOFF_MS * Math.pow(2, nextAttempts - 1),
            MAX_BACKOFF_MS,
          );
          const retryAt = new Date(Date.now() + backoffMs).toISOString();
          if (!store.retry(loop.id, claimToken, retryAt, msg)) {
            console.error(`[defer-loop-runner] Failed to re-queue loop ${loop.id}`);
          } else {
            ctx.emitDeferSummary(loop.sessionId);
          }
        } else {
          const failed = store.markFailed(loop.id, claimToken, msg);
          if (!failed) {
            const current = store.get(loop.id);
            if (current?.status !== "cancelled") {
              console.error(`[defer-loop-runner] Failed to mark loop ${loop.id} failed`);
            }
          } else {
            ctx.recordSessionAttention(loop.sessionId);
            ctx.emitDeferSummary(loop.sessionId);
          }
          console.error(`[defer-loop-runner] Loop ${loop.id} failed after ${nextAttempts} attempt(s): ${msg}`);
        }
      } finally {
        ctx.afterDeliverySettled(renewalTimer, loop.sessionId, shouldProcessNextDueLoop);
      }
    }

    return processOne;
  }

  return createDeferRunnerCore({
    store: {
      getNextFutureWakeAt: () => store.getNextFutureActive()?.nextRunAt,
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
    labels: { tag: "defer-loop-runner", noun: "loop" },
    createProcessOne,
  });
}

export type DeferLoopRunner = ReturnType<typeof createDeferLoopRunner>;
