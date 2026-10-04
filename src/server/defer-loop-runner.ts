// Recurring defer loop runner — runs one check per interval in a worker session.

import {
  getDeferLoopOccurrenceStatus,
  type DeferLoop,
  type DeferLoopOccurrenceStatus,
  type DeferLoopStore,
} from "./defer-loop-store.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";
import type { DeferSummarySources } from "./defer-summary.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import {
  createFailingLoopDelivery,
  createReturnedDeferDelivery,
} from "./defer-result-message.js";
import type { DeferWorkerInput } from "./defer-worker.js";
import {
  createDeferRunnerCore,
  LEASE_EXPIRED_ERROR,
  LEASE_MS,
  type DeferRunnerOptions,
} from "./defer-runner-core.js";

/** The chat is told once when this many checks in a row have failed; the loop itself carries on. */
export const FAILING_LOOP_NOTICE_AFTER = 3;

type TerminalStatus = Exclude<DeferLoopOccurrenceStatus, "active">;

function terminalMessage(loop: DeferLoop, status: TerminalStatus): string {
  return status === "completed"
    ? `FINAL DEFER RESULT: Monitoring stopped after ${loop.maxRuns ?? loop.runCount} checks without reaching a terminal result. This defer is no longer active.`
    : "FINAL DEFER RESULT: Monitoring expired before another check could run without reaching a terminal result. This defer is no longer active.";
}

export function createDeferLoopRunner(
  store: DeferLoopStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
  summarySources: DeferSummarySources = { deferLoopStore: store },
  options: Omit<DeferRunnerOptions, "onSettled"> & {
    /** A message for the chat was queued, or a check let go of its chat and worker: wake the message runner. */
    onParentMessageQueued?: () => void;
  } = {},
) {
  function buildWorkerInput(loop: DeferLoop, now = Date.now()): DeferWorkerInput {
    const runCount = loop.runCount + 1;
    const nextRunAt = new Date(now + loop.intervalSeconds * 1000).toISOString();
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
      isFinalRun: getDeferLoopOccurrenceStatus(loop, runCount, nextRunAt) !== "active",
      intervalSeconds: loop.intervalSeconds,
      ...(loop.expiresAt ? { expiresAt: loop.expiresAt } : {}),
      ...(loop.checkpoint ? { checkpoint: loop.checkpoint } : {}),
    };
  }

  return createDeferRunnerCore<DeferLoop>({
    sessionManager,
    globalBus,
    deliveryGuard,
    summarySources,
    labels: { tag: "defer-loop-runner", noun: "loop", kind: "interval" },
    telemetryStore: options.telemetryStore,
    // A check's message for its chat is queued while the check still holds the chat's guard,
    // and a one-time check may be waiting for the worker this one held.
    onSettled: options.onParentMessageQueued,
    createWork: (ctx) => {
      /** The loop's run limit or expiry passed while it was waiting: end it and tell the chat. */
      function endBeforeRun(loop: DeferLoop, status: TerminalStatus): boolean {
        const ended = store.markTerminalWithMessage(
          loop.id,
          status,
          createReturnedDeferDelivery(buildWorkerInput(loop), [
            terminalMessage(loop, status),
            // Says why a loop that waited or kept failing until its end never got its last check.
            ...(loop.lastError ? [`Last error: ${loop.lastError}`] : []),
          ].join("\n\n")),
        );
        if (ended) {
          ctx.recordSessionAttention(loop.sessionId);
          options.onParentMessageQueued?.();
        }
        return ended;
      }

      /**
       * A check ran and failed. It counts as a run and the loop keeps its schedule, so one bad
       * check never ends the monitoring. `loop.attempts` is the number of failed checks in a row.
       */
      function failOccurrence(loop: DeferLoop, claimToken: string, error: string): boolean {
        const now = new Date();
        const nextRunAt = new Date(now.getTime() + loop.intervalSeconds * 1000).toISOString();
        const input = buildWorkerInput(loop, now.getTime());
        const status = getDeferLoopOccurrenceStatus(loop, loop.runCount + 1, nextRunAt);
        const delivery = status !== "active"
          ? createReturnedDeferDelivery(input, `${terminalMessage(loop, status)}\n\nThe last check failed: ${error}`)
          : loop.attempts === FAILING_LOOP_NOTICE_AFTER
            ? createFailingLoopDelivery({ ...input, name: loop.name }, loop.attempts, error, nextRunAt)
            : undefined;
        const updated = store.settleOccurrence(loop.id, claimToken, nextRunAt, now.toISOString(), {
          ...(status === "active" ? {} : { status }),
          ...(delivery ? { delivery } : {}),
          error,
        });
        console.warn(`[defer-loop-runner] Loop ${loop.id} check failed (${loop.attempts} in a row): ${error}`);
        if (updated && delivery) {
          ctx.recordSessionAttention(loop.sessionId);
          options.onParentMessageQueued?.();
        }
        return updated !== undefined;
      }

      return {
        listDue: () => store.listDue().map((loop) => ({
          id: loop.id,
          sessionId: loop.sessionId,
          wakeAt: loop.nextRunAt,
        })),
        getNextWakeAt: () => store.getNextWakeAt(),
        // The server stopped while these checks ran. Each is settled as a failed check.
        reclaimExpired: (now) => {
          const expired = store.listExpiredRunning(now);
          for (const loop of expired) {
            try {
              failOccurrence(loop, loop.claimToken!, LEASE_EXPIRED_ERROR);
            } catch (error) {
              // One loop that cannot be settled must not keep the others from being recovered.
              console.error(`[defer-loop-runner] Failed to recover loop ${loop.id} after its lease expired:`, error);
            }
          }
          return expired.map((loop) => loop.sessionId);
        },
        cancelForSession: (sessionId) => store.cancelForSession(sessionId),

        load: (id) => {
          const loop = store.get(id);
          return loop?.status === "active" ? loop : undefined;
        },
        usesWorker: () => true,
        reachesArchived: () => false,
        orphaned: (loop) => {
          const cancelled = store.cancelForSession(loop.sessionId);
          console.warn(`[defer-loop-runner] Session ${loop.sessionId} no longer exists; cancelling ${cancelled} loop(s)`);
          return cancelled > 0;
        },
        preflight: (loop) => {
          if (loop.maxRuns !== undefined && loop.runCount >= loop.maxRuns) return endBeforeRun(loop, "completed");
          if (loop.expiresAt && Date.parse(loop.expiresAt) <= Date.now()) return endBeforeRun(loop, "expired");
          return undefined;
        },
        noteWait: (loop, reason) => store.noteWait(loop.id, reason),
        claim: (id) => {
          const claimed = store.claimDue(id, LEASE_MS);
          return claimed && { item: claimed.loop, claimToken: claimed.claimToken };
        },
        renew: (id, claimToken) => store.renewClaim(id, claimToken, LEASE_MS),
        release: (id, claimToken, reason) => store.release(id, claimToken, { error: reason }),

        run: async (loop, claimToken, lease) => {
          const input = buildWorkerInput(loop);
          const result = await lease!.run(input);
          const acceptedAt = new Date();
          const nextRunAt = new Date(acceptedAt.getTime() + loop.intervalSeconds * 1000).toISOString();
          const { action } = result;
          const stops = action === "return" || action === "finish";
          const status = stops
            ? "completed"
            : action === "expired"
              ? "expired"
              : getDeferLoopOccurrenceStatus(loop, loop.runCount + 1, nextRunAt);
          const message = status === "active"
            ? action === "notify" ? result.message ?? "Deferred work update." : undefined
            : [
                action === "return" || action === "notify" ? result.message : undefined,
                stops
                  ? "FINAL DEFER RESULT: Monitoring completed. This defer is no longer active."
                  : terminalMessage(loop, status),
              ].filter(Boolean).join("\n\n");
          const delivery = message
            ? createReturnedDeferDelivery(input, message, {
                continues: status === "active",
                ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}),
              })
            : undefined;
          // No row back means the loop was cancelled or reactivated while the check ran; that state wins.
          const updated = store.settleOccurrence(loop.id, claimToken, nextRunAt, acceptedAt.toISOString(), {
            ...(status === "active" ? {} : { status }),
            ...(delivery ? { delivery } : {}),
            ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
          });
          if (updated && updated.status !== "active" && action !== "finish") {
            ctx.recordSessionAttention(loop.sessionId);
          }
        },
        failed: (loop, claimToken, error) => {
          failOccurrence(loop, claimToken, error);
        },
      };
    },
  });
}

export type DeferLoopRunner = ReturnType<typeof createDeferLoopRunner>;
