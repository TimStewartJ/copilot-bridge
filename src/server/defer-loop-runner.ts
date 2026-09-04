// Recurring defer loop runner — dispatches interval same-session prompts.

import {
  getDeferLoopOccurrenceStatus,
  type DeferLoop,
  type DeferLoopOccurrenceStatus,
  type DeferLoopStore,
} from "./defer-loop-store.js";
import { toIntervalDeferId } from "./defer-ids.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";
import type { DeferSummarySources } from "./defer-summary.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import {
  createFailedDeferDelivery,
  createReturnedDeferDelivery,
} from "./defer-result-message.js";
import type { DeferWorkerInput, DeferWorkerLease, DeferWorkerResult } from "./defer-worker.js";
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
  options: DeferRunnerOptions & { onParentMessageQueued?: () => void } = {},
) {
  const runWorker = async (input: DeferWorkerInput): Promise<DeferWorkerResult | undefined> => {
    const worker = (sessionManager as SessionManager & {
      runDeferWorker?: (workerInput: DeferWorkerInput) => Promise<DeferWorkerResult>;
    }).runDeferWorker;
    return worker ? worker.call(sessionManager, input) : undefined;
  };

  function buildWorkerInput(loop: DeferLoop, now = Date.now()): DeferWorkerInput {
    const runCount = loop.runCount + 1;
    const nextRunAt = new Date(now + loop.intervalSeconds * 1000).toISOString();
    const occurrenceStatus = getDeferLoopOccurrenceStatus(loop, runCount, nextRunAt);
    return {
      deferId: loop.deferId,
      kind: "interval",
      parentSessionId: loop.sessionId,
      prompt: loop.prompt,
      runCount,
      ...(loop.maxRuns !== undefined
        ? {
            maxRuns: loop.maxRuns,
            remainingRunsAfterThis: Math.max(0, loop.maxRuns - runCount),
          }
        : {}),
      isFinalRun: occurrenceStatus !== "active",
      intervalSeconds: loop.intervalSeconds,
      ...(loop.expiresAt ? { expiresAt: loop.expiresAt } : {}),
      ...(loop.checkpoint ? { checkpoint: loop.checkpoint } : {}),
    };
  }

  function terminalMessage(
    loop: DeferLoop,
    status: Exclude<DeferLoopOccurrenceStatus, "active">,
  ): string {
    return status === "completed"
      ? `Deferred work stopped after reaching its maximum of ${loop.maxRuns ?? loop.runCount} runs without returning a terminal result.`
      : "Deferred work expired before another check could run without returning a terminal result.";
  }

  function queuePreflightTerminalReturn(
    loop: DeferLoop,
    status: Exclude<DeferLoopOccurrenceStatus, "active">,
  ): boolean {
    const workerInput = buildWorkerInput(loop);
    const queued = store.markTerminalWithMessage(
      loop.id,
      status,
      createReturnedDeferDelivery(workerInput, terminalMessage(loop, status)),
    );
    if (queued) options.onParentMessageQueued?.();
    return queued;
  }

  function createProcessOne(ctx: DeferRunnerCoreContext) {
    async function processOne(id: string): Promise<ProcessOneResult> {
      if (!ctx.isStarted()) return "unchanged";
      const loop = store.get(id);
      if (!loop || loop.status !== "active") return "unchanged";
      if (ctx.deliveryGuard.isActive(loop.sessionId)) return "blocked";

      const now = new Date();
      if (loop.maxRuns !== undefined && loop.runCount >= loop.maxRuns) {
        const completed = queuePreflightTerminalReturn(loop, "completed");
        if (completed) {
          ctx.recordSessionAttention(loop.sessionId);
          ctx.emitDeferSummary(loop.sessionId);
        }
        return completed ? "changed" : "unchanged";
      }
      if (loop.expiresAt && Date.parse(loop.expiresAt) <= now.getTime()) {
        const expired = queuePreflightTerminalReturn(loop, "expired");
        if (expired) {
          ctx.recordSessionAttention(loop.sessionId);
          ctx.emitDeferSummary(loop.sessionId);
        }
        return expired ? "changed" : "unchanged";
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
      if (loop.attempts >= MAX_ATTEMPTS) {
        const lastError = loop.lastError ?? `Exceeded max attempts (${MAX_ATTEMPTS})`;
        const failed = store.failWithMessage(
          id,
          lastError,
          createFailedDeferDelivery(
            { ...buildWorkerInput(loop), ...(loop.name ? { name: loop.name } : {}) },
            loop.attempts,
            lastError,
          ),
        );
        if (failed) {
          ctx.recordSessionAttention(loop.sessionId);
          ctx.emitDeferSummary(loop.sessionId);
          options.onParentMessageQueued?.();
        }
        console.error(`[defer-loop-runner] Loop ${id} exceeded max attempts; stopping`);
        return failed ? "changed" : "unchanged";
      }

      if (sessionManager.isSessionBusy(loop.sessionId)) return "blocked";
      if (!ctx.deliveryGuard.tryClaim(loop.sessionId)) return "blocked";

      let claimToken: string | undefined;
      let workerLease: DeferWorkerLease | undefined;
      try {
        const acquireWorker = (sessionManager as SessionManager & {
          tryAcquireDeferWorker?: () => DeferWorkerLease | undefined;
        }).tryAcquireDeferWorker;
        if (acquireWorker) {
          workerLease = acquireWorker.call(sessionManager);
          if (!workerLease) {
            ctx.deliveryGuard.release(loop.sessionId);
            return "blocked";
          }
        }
        const claimed = store.claimDue(id, LEASE_MS);
        if (!claimed) {
          workerLease?.release();
          ctx.deliveryGuard.release(loop.sessionId);
          return "unchanged";
        }
        claimToken = claimed.claimToken;
        ctx.emitDeferSummary(loop.sessionId);

        const claimedLoop = claimed.loop;
        const renewalTimer = ctx.startRenewal(() => {
          const renewed = store.renewClaim(id, claimed.claimToken, LEASE_MS);
          if (!renewed) {
            console.warn(`[defer-loop-runner] Failed to renew lease for loop ${id}`);
          }
        });

        void finishDelivery(claimedLoop, claimed.claimToken, renewalTimer, workerLease).catch((err) => {
          console.error(`[defer-loop-runner] Unexpected delivery error for loop ${id}:`, err);
        });
        return "claimed";
      } catch (error) {
        if (claimToken) {
          try {
            if (!store.releaseClaimWithoutAttempt(id, claimToken)) {
              console.error(`[defer-loop-runner] Failed to roll back interrupted claim setup for loop ${id}`);
            }
          } catch (releaseError) {
            console.error(`[defer-loop-runner] Failed to roll back interrupted claim setup for loop ${id}:`, releaseError);
          }
        }
        workerLease?.release();
        ctx.deliveryGuard.release(loop.sessionId);
        throw error;
      }
    }

    async function finishDelivery(
      loop: DeferLoop,
      claimToken: string,
      renewalTimer: ReturnType<typeof setInterval>,
      workerLease?: DeferWorkerLease,
    ): Promise<void> {
      let shouldProcessNextDueLoop = false;
      let parentMessageQueued = false;
      try {
        const workerInput = buildWorkerInput(loop);
        const result = workerLease
          ? await workerLease.run(workerInput)
          : await runWorker(workerInput);
        if (!result) {
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
        }
        const acceptedAt = new Date();
        const nextRunAt = new Date(acceptedAt.getTime() + loop.intervalSeconds * 1000).toISOString();
        const occurrenceStatus = getDeferLoopOccurrenceStatus(
          loop,
          loop.runCount + 1,
          nextRunAt,
        );
        const action = result?.action ?? "continue";
        const status = action === "return" || action === "finish"
          ? "completed"
          : action === "expired"
            ? "expired"
            : occurrenceStatus;
        const message = action === "return"
          ? result?.message ?? "Deferred work completed."
          : action === "notify"
            ? status === "active"
              ? result?.message ?? "Deferred work update."
              : `${result?.message ?? "Deferred work update."}\n\n${terminalMessage(loop, status)}`
            : action === "finish"
              ? undefined
            : status === "active"
              ? undefined
              : terminalMessage(loop, status);
        const delivery = message
          ? createReturnedDeferDelivery(workerInput, message, {
              continues: status === "active",
              ...(result?.deliveryId ? { deliveryId: result.deliveryId } : {}),
            })
          : undefined;
        const updated = store.settleOccurrence(
          loop.id,
          claimToken,
          nextRunAt,
          acceptedAt.toISOString(),
          {
            ...(status === "active" ? {} : { status }),
            ...(delivery ? { delivery } : {}),
            ...(result?.checkpoint ? { checkpoint: result.checkpoint } : {}),
          },
        );
        if (!updated) {
          const current = store.get(loop.id);
          if (current?.status !== "cancelled") {
            console.error(`[defer-loop-runner] Worker result failed to settle loop ${loop.id}`);
          }
        } else {
          ctx.emitDeferSummary(loop.sessionId);
          parentMessageQueued = delivery !== undefined;
          shouldProcessNextDueLoop = updated.status === "active";
          if (updated.status !== "active" && action !== "finish") {
            ctx.recordSessionAttention(loop.sessionId);
          }
        }
      } catch (err: any) {
        const msg: string = err?.message ?? String(err);
        const isBusy =
          msg.includes("Session is busy processing another message") ||
          msg.includes("Session is busy processing another request");
        const classification = classifyDeferDeliveryError(err);
        if (classification === "pause") {
          const released = store.releaseClaimWithoutAttempt(loop.id, claimToken);
          if (!released) {
            console.error(`[defer-loop-runner] Failed to pause loop ${loop.id} without consuming an attempt`);
          } else {
            ctx.emitDeferSummary(loop.sessionId);
          }
          return;
        }

        const nextAttempts = loop.attempts; // attempts already incremented by claimDue
        if (nextAttempts < MAX_ATTEMPTS) {
          const backoffMs = computeDeferRetryBackoffMs(nextAttempts);
          const retryAt = new Date(Date.now() + backoffMs).toISOString();
          console.warn(
            `[defer-loop-runner] Retrying loop ${loop.id} after attempt ${nextAttempts}/${MAX_ATTEMPTS}${isBusy ? " (session busy)" : ""}: ${msg}`,
          );
          if (!store.retry(loop.id, claimToken, retryAt, msg)) {
            console.error(`[defer-loop-runner] Failed to re-queue loop ${loop.id}`);
          } else {
            ctx.emitDeferSummary(loop.sessionId);
          }
        } else {
          const failed = store.failWithMessage(
            loop.id,
            msg,
            createFailedDeferDelivery(
              { ...buildWorkerInput(loop), ...(loop.name ? { name: loop.name } : {}) },
              nextAttempts,
              msg,
            ),
            { claimToken },
          );
          if (!failed) {
            const current = store.get(loop.id);
            if (current?.status !== "cancelled") {
              console.error(`[defer-loop-runner] Failed to mark loop ${loop.id} failed`);
            }
          } else {
            ctx.recordSessionAttention(loop.sessionId);
            ctx.emitDeferSummary(loop.sessionId);
            parentMessageQueued = true;
          }
          console.error(`[defer-loop-runner] Loop ${loop.id} failed after ${nextAttempts} attempt(s): ${msg}`);
        }
      } finally {
        workerLease?.release();
        ctx.afterDeliverySettled(renewalTimer, loop.sessionId, shouldProcessNextDueLoop);
        if (parentMessageQueued) options.onParentMessageQueued?.();
      }
    }

    return processOne;
  }

  return createDeferRunnerCore({
    store: {
      getNextFutureWakeAt: () => store.getNextFutureActive()?.nextRunAt,
      getNextRunningLeaseWakeAt: () => store.getNextRunningLeaseExpiry()?.leaseExpiresAt,
      listDue: () => store.listDue().map((loop) => ({
        id: loop.id,
        sessionId: loop.sessionId,
        wakeAt: loop.nextRunAt,
      })),
      reclaimExpiredRunning: (now) => store.reclaimExpiredRunning(now),
      listExpiredRunningSessionIds: (now) => store.listExpiredRunningSessionIds(now),
      cancelForSession: (sessionId) => store.cancelForSession(sessionId),
    },
    sessionManager,
    globalBus,
    deliveryGuard,
    summarySources,
    labels: { tag: "defer-loop-runner", noun: "loop", kind: "interval" },
    createProcessOne,
    ...options,
  });
}

export type DeferLoopRunner = ReturnType<typeof createDeferLoopRunner>;
