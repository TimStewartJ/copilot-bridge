// Recurring defer loop runner — dispatches interval same-session prompts.

import type { DeferLoop, DeferLoopStore } from "./defer-loop-store.js";
import { toIntervalDeferId } from "./defer-ids.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "./defer-delivery-guard.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import { isPromptDeliveryInterruptedError, isRestartPendingError } from "./session-manager.js";
import {
  INITIAL_BACKOFF_MS,
  LEASE_MS,
  LEASE_RENEW_INTERVAL_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  MAX_TIMER_DELAY_MS,
} from "./deferred-prompt-runner.js";

type ProcessOneResult = "changed" | "blocked" | "unchanged" | "claimed";

export function createDeferLoopRunner(
  store: DeferLoopStore,
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

  function getNextWakeAt(): string | undefined {
    const nextActive = store.getNextFutureActive();
    const nextRunningLease = store.getNextRunningLeaseExpiry();
    const activeWake = nextActive?.nextRunAt;
    const runningWake = nextRunningLease?.leaseExpiresAt;
    if (!activeWake) return runningWake;
    if (!runningWake) return activeWake;
    return Date.parse(runningWake) < Date.parse(activeWake) ? runningWake : activeWake;
  }

  function reclaimExpiredRunning(): void {
    const reclaimed = store.reclaimExpiredRunning();
    if (reclaimed > 0) {
      console.log(`[defer-loop-runner] Reclaimed ${reclaimed} expired running loop(s)`);
    }
  }

  function hasDueLoopReadyForAnotherPass(): boolean {
    return store.listDue().some((loop) =>
      !deliveryGuard.isActive(loop.sessionId) && !sessionManager.isSessionBusy(loop.sessionId)
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
        console.error("[defer-loop-runner] Unexpected error in processDue:", err);
      });
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
  }

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
      const toProcess = due.filter((loop) => {
        if (sessionsSeen.has(loop.sessionId)) return false;
        sessionsSeen.add(loop.sessionId);
        return true;
      });
      const results = await Promise.all(toProcess.map((loop) => processOne(loop.id)));
      if (results.includes("changed") && hasDueLoopReadyForAnotherPass()) {
        rerunRequested = true;
      }
    }

    armNext();
  }

  async function processOne(id: string): Promise<ProcessOneResult> {
    if (!started) return "unchanged";
    const loop = store.get(id);
    if (!loop || loop.status !== "active") return "unchanged";
    if (deliveryGuard.isActive(loop.sessionId)) return "blocked";

    const now = new Date();
    if (loop.maxRuns !== undefined && loop.runCount >= loop.maxRuns) {
      return store.markCompleted(id) ? "changed" : "unchanged";
    }
    if (loop.expiresAt && Date.parse(loop.expiresAt) <= now.getTime()) {
      return store.markExpired(id) ? "changed" : "unchanged";
    }
    if (loop.attempts >= MAX_ATTEMPTS) {
      const failed = store.markFailedById(id, `Exceeded max attempts (${MAX_ATTEMPTS})`);
      if (!failed) store.cancelById(id);
      console.error(`[defer-loop-runner] Loop ${id} exceeded max attempts; stopping`);
      return "changed";
    }

    const sessionList = await sessionManager.listSessionsFromDisk({ includeArchived: false });
    if (!started) return "unchanged";
    if (deliveryGuard.isActive(loop.sessionId)) return "blocked";
    const sessionExists = sessionList.some((s: any) => s.sessionId === loop.sessionId);
    if (!sessionExists) {
      const cancelled = store.cancelForSession(loop.sessionId);
      console.warn(`[defer-loop-runner] Session ${loop.sessionId} no longer exists; cancelling ${cancelled} loop(s)`);
      return cancelled > 0 ? "changed" : "unchanged";
    }

    if (sessionManager.isSessionBusy(loop.sessionId)) return "blocked";
    if (!deliveryGuard.tryClaim(loop.sessionId)) return "blocked";

    const claimed = store.claimDue(id, LEASE_MS);
    if (!claimed) {
      deliveryGuard.release(loop.sessionId);
      return "unchanged";
    }

    const { claimToken } = claimed;
    const claimedLoop = claimed.loop;
    const renewalTimer = setInterval(() => {
      if (!started) return;
      const renewed = store.renewClaim(id, claimToken, LEASE_MS);
      if (!renewed) {
        console.warn(`[defer-loop-runner] Failed to renew lease for loop ${id}`);
      }
    }, LEASE_RENEW_INTERVAL_MS);
    renewalTimers.add(renewalTimer);

    void finishDelivery(claimedLoop, claimToken, renewalTimer).catch((err) => {
      console.error(`[defer-loop-runner] Unexpected delivery error for loop ${id}:`, err);
    });
    return "claimed";
  }

  function formatLoopPrompt(loop: DeferLoop): string {
    const lines = [
      "<defer>",
      `deferId: ${toIntervalDeferId(loop.id)}`,
      "kind: interval",
      `runCount: ${loop.runCount + 1}`,
      `intervalSeconds: ${loop.intervalSeconds}`,
      `nextRunAt: ${loop.nextRunAt}`,
    ];
    if (loop.maxRuns !== undefined) lines.push(`maxRuns: ${loop.maxRuns}`);
    if (loop.expiresAt) lines.push(`expiresAt: ${loop.expiresAt}`);
    lines.push("</defer>", "", "User prompt:", loop.prompt);
    return lines.join("\n");
  }

  async function finishDelivery(
    loop: DeferLoop,
    claimToken: string,
    renewalTimer: ReturnType<typeof setInterval>,
  ): Promise<void> {
    let shouldProcessNextDueLoop = false;
    try {
      await sessionManager.startWorkAndWaitForDelivery(loop.sessionId, formatLoopPrompt(loop));
      const acceptedAt = new Date();
      const nextRunAt = new Date(acceptedAt.getTime() + loop.intervalSeconds * 1000).toISOString();
      const updated = store.completeOccurrence(loop.id, claimToken, nextRunAt, acceptedAt.toISOString());
      if (!updated) {
        const current = store.get(loop.id);
        if (current?.status !== "cancelled") {
          console.error(`[defer-loop-runner] Delivery completed but failed to update loop ${loop.id}`);
        }
      } else if (updated.status === "active") {
        shouldProcessNextDueLoop = true;
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
        }
        return;
      }

      const nextAttempts = loop.attempts;
      if (isBusy && nextAttempts < MAX_ATTEMPTS) {
        const backoffMs = Math.min(
          INITIAL_BACKOFF_MS * Math.pow(2, nextAttempts - 1),
          MAX_BACKOFF_MS,
        );
        const retryAt = new Date(Date.now() + backoffMs).toISOString();
        if (!store.retry(loop.id, claimToken, retryAt, msg)) {
          console.error(`[defer-loop-runner] Failed to re-queue loop ${loop.id}`);
        }
      } else {
        const failed = store.markFailed(loop.id, claimToken, msg);
        if (!failed) {
          const current = store.get(loop.id);
          if (current?.status !== "cancelled") {
            console.error(`[defer-loop-runner] Failed to mark loop ${loop.id} failed`);
          }
        }
        console.error(`[defer-loop-runner] Loop ${loop.id} failed after ${nextAttempts} attempt(s): ${msg}`);
      }
    } finally {
      clearInterval(renewalTimer);
      renewalTimers.delete(renewalTimer);
      deliveryGuard.release(loop.sessionId);
      if (started && shouldProcessNextDueLoop && hasDueLoopReadyForAnotherPass()) {
        processDue().catch((err) => {
          console.error("[defer-loop-runner] processDue error after delivery settled:", err);
        });
      } else {
        armNext();
      }
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    generation++;
    reclaimExpiredRunning();

    busUnsubscribe = globalBus.subscribe((event) => {
      if (event.type === "session:idle" && event.sessionId) {
        const scheduledGeneration = generation;
        setImmediate(() => {
          if (!started || scheduledGeneration !== generation) return;
          processDue().catch((err) => {
            console.error("[defer-loop-runner] processDue error on session:idle:", err);
          });
        });
        return;
      }
      if (event.type === "session:archived" && event.sessionId && event.archived === true) {
        const cancelled = store.cancelForSession(event.sessionId);
        if (cancelled > 0) {
          console.log(`[defer-loop-runner] Cancelled ${cancelled} loop(s) for archived session ${event.sessionId}`);
        }
        return;
      }
      if (event.type === "server:restart-cleared") {
        const scheduledGeneration = generation;
        if (!started || scheduledGeneration !== generation) return;
        processDue().catch((err) => {
          console.error("[defer-loop-runner] processDue error on server:restart-cleared:", err);
        });
      }
    });

    processDue().catch((err) => {
      console.error("[defer-loop-runner] Startup processDue error:", err);
    });
    console.log("[defer-loop-runner] Started");
  }

  function poke(): void {
    if (!started) return;
    processDue().catch((err) => {
      console.error("[defer-loop-runner] processDue error on poke:", err);
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

export type DeferLoopRunner = ReturnType<typeof createDeferLoopRunner>;
