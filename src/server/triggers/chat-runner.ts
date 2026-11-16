// Chat lane: triggers that wake the chat that owns them. Each occurrence runs the trigger's check
// (if any) with no model, then either starts a temporary worker whose result may reach the chat, or
// queues the trigger's prompt for the chat directly. Built on the per-chat work runner, so a chat
// gets one automation at a time and capacity waits are never counted as failures.

import {
  computeRetryBackoffMs,
  createChatWorkRunner,
  LEASE_EXPIRED_ERROR,
  LEASE_MS,
  MAX_ATTEMPTS,
  type ChatWorkOptions,
} from "../chat-work-runner.js";
import { createDeferDeliveryGuard, type DeferDeliveryGuard } from "../defer-delivery-guard.js";
import type { GlobalBus } from "../global-bus.js";
import type { SessionManager } from "../session-manager.js";
import { evaluateTriggerCheck, runTriggerCheck, type TriggerCheckChange, type TriggerCheckOutcome, type TriggerCheckSpec } from "./check.js";
import {
  createFailedTriggerDelivery,
  createFailingTriggerDelivery,
  createTriggerMessageDelivery,
  createTriggerResultDelivery,
  type TriggerDelivery,
} from "./messages.js";
import { occurrenceStatus, type TriggerStore } from "./store.js";
import { describeTriggerWhen, nextRunAfter } from "./timing.js";
import type { Trigger } from "./types.js";
import type { TriggerWorkerInput } from "./worker.js";

/** A trigger in the chat lane: it always has the chat that owns it. */
export type ChatTrigger = Trigger & { sessionId: string };

/** The chat is told once when this many runs in a row have failed; the trigger itself carries on. */
export const FAILING_TRIGGER_NOTICE_AFTER = 3;

type EndStatus = "completed" | "expired";

function isChatTrigger(trigger: Trigger): trigger is ChatTrigger {
  return typeof trigger.sessionId === "string" && trigger.action.kind === "chat";
}

export function isRecurringTrigger(trigger: Pick<Trigger, "when">): boolean {
  return trigger.when.kind !== "at";
}

/**
 * The occurrence after one that settles at `now`. A run asked for ahead of time keeps a cron
 * trigger's next slot; an interval starts counting again from now.
 */
export function scheduledNextRunAt(trigger: Pick<Trigger, "when" | "runNow" | "nextRunAt">, now: Date): string | undefined {
  if (trigger.when.kind === "at") return undefined;
  if (trigger.runNow && trigger.when.kind === "cron" && trigger.nextRunAt && Date.parse(trigger.nextRunAt) > now.getTime()) {
    return trigger.nextRunAt;
  }
  return nextRunAfter(trigger.when, now, trigger.nextRunAt);
}

function pendingOutcome(trigger: Trigger): TriggerCheckOutcome {
  return trigger.check?.fireOn === "exit_code" ? "fired" : "changed";
}

function checkChange(trigger: Trigger): TriggerCheckChange | undefined {
  const pending = trigger.checkPending;
  if (!trigger.check || !pending) return undefined;
  return {
    command: trigger.check.command,
    fireOn: trigger.check.fireOn,
    ...(trigger.lastCheck?.output ? { previous: trigger.lastCheck.output } : {}),
    current: { exitCode: pending.exitCode, stdout: pending.stdout, stderr: pending.stderr },
  };
}

function settledCheck(trigger: Trigger) {
  const pending = trigger.checkPending;
  return pending ? { check: { result: pending, at: pending.at, outcome: pendingOutcome(trigger) } } : {};
}

function endMessage(trigger: Trigger, status: EndStatus): string {
  return status === "completed"
    ? `FINAL TRIGGER RESULT: The trigger stopped after ${trigger.maxRuns ?? trigger.runCount} runs without reaching a final result. It is no longer active.`
    : "FINAL TRIGGER RESULT: The trigger expired before its next run without reaching a final result. It is no longer active.";
}

export function buildTriggerWorkerInput(trigger: ChatTrigger, now = new Date()): TriggerWorkerInput {
  const recurring = isRecurringTrigger(trigger);
  const runCount = trigger.runCount + 1;
  const next = scheduledNextRunAt(trigger, now);
  const change = checkChange(trigger);
  return {
    triggerId: trigger.id,
    recurring,
    parentSessionId: trigger.sessionId,
    prompt: trigger.prompt,
    ...(recurring
      ? {
          runCount,
          ...(trigger.maxRuns !== undefined
            ? { maxRuns: trigger.maxRuns, remainingRunsAfterThis: Math.max(0, trigger.maxRuns - runCount) }
            : {}),
          isFinalRun: trigger.checkPending?.stop === true || occurrenceStatus(trigger, runCount, next) !== "active",
          schedule: describeTriggerWhen(trigger.when),
          ...(trigger.expiresAt ? { expiresAt: trigger.expiresAt } : {}),
          ...(trigger.checkpoint ? { checkpoint: trigger.checkpoint } : {}),
        }
      : {}),
    ...(change ? { check: change } : {}),
  };
}

export interface TriggerChatRunnerOptions extends Omit<ChatWorkOptions, "onSettled"> {
  emitSummary?: (sessionId: string) => void;
  /** A message for a chat was queued, or a run let go of its chat and worker: wake the outbox runner. */
  onParentMessageQueued?: () => void;
}

export function createTriggerChatRunner(
  store: TriggerStore,
  sessionManager: SessionManager,
  globalBus: GlobalBus,
  deliveryGuard: DeferDeliveryGuard = createDeferDeliveryGuard(),
  options: TriggerChatRunnerOptions = {},
) {
  const delivered = (sessionId: string, attention: (sessionId: string) => void) => {
    attention(sessionId);
    options.onParentMessageQueued?.();
  };

  return createChatWorkRunner<ChatTrigger>({
    sessionManager,
    globalBus,
    deliveryGuard,
    labels: { tag: "trigger-chat-runner", noun: "trigger", kind: "trigger" },
    telemetryStore: options.telemetryStore,
    emitSummary: options.emitSummary,
    // A run's message for its chat is queued while it still holds the chat's guard.
    onSettled: options.onParentMessageQueued,
    createWork: (ctx) => {
      const ref = (trigger: ChatTrigger) => ({ triggerId: trigger.id, parentSessionId: trigger.sessionId, name: trigger.name });

      /** Its run limit or expiry passed while it waited: end it and tell the chat. */
      function endBeforeRun(trigger: ChatTrigger, status: EndStatus): boolean {
        const message = [endMessage(trigger, status), ...(trigger.lastError ? [`Last error: ${trigger.lastError}`] : [])].join("\n\n");
        const ended = store.endWaiting(trigger.id, status, { delivery: createTriggerResultDelivery(ref(trigger), message) });
        if (ended) delivered(trigger.sessionId, ctx.recordSessionAttention);
        return ended;
      }

      /** A one-time trigger used its tries: stop it and tell the chat. */
      function giveUp(trigger: ChatTrigger, error: string, claimToken?: string): boolean {
        const delivery = createFailedTriggerDelivery(ref(trigger), trigger.attempts, error);
        const ended = claimToken
          ? store.settleOccurrence(trigger.id, claimToken, { status: "failed", error, delivery }) !== undefined
          : store.endWaiting(trigger.id, "failed", { delivery, error });
        console.error(`[trigger-chat-runner] Trigger ${trigger.id} failed after ${trigger.attempts} tries: ${error}`);
        if (ended) delivered(trigger.sessionId, ctx.recordSessionAttention);
        return ended;
      }

      /**
       * A run failed. A one-time trigger tries again later until its tries run out. A recurring one
       * counts the run and keeps its schedule, so one bad run never ends the monitoring; `attempts`
       * is the number of failed runs in a row.
       */
      function failRun(trigger: ChatTrigger, claimToken: string, error: string): boolean {
        const now = new Date();
        if (!isRecurringTrigger(trigger)) {
          if (trigger.attempts >= MAX_ATTEMPTS) return giveUp(trigger, error, claimToken);
          const retryAt = new Date(now.getTime() + computeRetryBackoffMs(trigger.attempts)).toISOString();
          console.warn(`[trigger-chat-runner] Retrying trigger ${trigger.id} after try ${trigger.attempts}/${MAX_ATTEMPTS}: ${error}`);
          return store.retryLater(trigger.id, claimToken, retryAt, error);
        }
        const next = scheduledNextRunAt(trigger, now);
        const status = occurrenceStatus(trigger, trigger.runCount + 1, next);
        const delivery: TriggerDelivery | undefined = status !== "active"
          ? createTriggerResultDelivery(ref(trigger), `${endMessage(trigger, status)}\n\nThe last run failed: ${error}`)
          : trigger.attempts === FAILING_TRIGGER_NOTICE_AFTER && next
            ? createFailingTriggerDelivery(ref(trigger), trigger.attempts, error, next)
            : undefined;
        const updated = store.settleOccurrence(trigger.id, claimToken, {
          nextRunAt: next,
          ...(status === "active" ? {} : { status }),
          ...(delivery ? { delivery } : {}),
          error,
        });
        console.warn(`[trigger-chat-runner] Trigger ${trigger.id} run failed (${trigger.attempts} in a row): ${error}`);
        if (updated && delivery) delivered(trigger.sessionId, ctx.recordSessionAttention);
        return updated !== undefined;
      }

      /**
       * Run the trigger's check with no worker held. A result that does not fire settles the run quietly
       * and becomes the next baseline; a firing result is kept for the action.
       */
      async function runCheckGate(trigger: ChatTrigger, check: TriggerCheckSpec, claimToken: string) {
        const cwd = check.cwd ?? sessionManager.getEffectiveSessionCwd?.(trigger.sessionId) ?? process.cwd();
        const result = await runTriggerCheck(check, cwd);
        const at = new Date();
        const decision = evaluateTriggerCheck(check, result, trigger.lastCheck?.fingerprint);
        if (decision.fire) {
          return store.savePendingCheck(trigger.id, claimToken, {
            ...result,
            at: at.toISOString(),
            ...(decision.stop ? { stop: true } : {}),
          })
            ? "wake" as const
            : "settled" as const;
        }
        const next = scheduledNextRunAt(trigger, at);
        const status = occurrenceStatus(trigger, trigger.runCount + 1, next);
        const delivery = status === "active" ? undefined : createTriggerResultDelivery(ref(trigger), endMessage(trigger, status));
        const updated = store.settleOccurrence(trigger.id, claimToken, {
          nextRunAt: next,
          ...(status === "active" ? {} : { status }),
          ...(delivery ? { delivery } : {}),
          check: { result, at: at.toISOString(), outcome: decision.outcome },
        }, at.toISOString());
        if (updated && delivery) ctx.recordSessionAttention(trigger.sessionId);
        return "settled" as const;
      }

      return {
        listDue: () => store.listDue("chat").filter(isChatTrigger).map((trigger) => ({
          id: trigger.id,
          sessionId: trigger.sessionId,
          wakeAt: trigger.runNow ? trigger.updatedAt : trigger.nextRunAt ?? trigger.updatedAt,
        })),
        getNextWakeAt: () => store.getNextWakeAt("chat"),
        // The server stopped while these ran. Each is settled as a failed run.
        reclaimExpired: (now) => {
          const expired = store.listExpiredRunning("chat", now);
          for (const trigger of expired.filter(isChatTrigger)) {
            try {
              failRun(trigger, trigger.claimToken!, LEASE_EXPIRED_ERROR);
            } catch (error) {
              // One trigger that cannot be settled must not keep the others from being recovered.
              console.error(`[trigger-chat-runner] Failed to recover trigger ${trigger.id} after its lease expired:`, error);
            }
          }
          return expired.filter(isChatTrigger).map((trigger) => trigger.sessionId);
        },
        cancelForSession: (sessionId) => store.cancelForSession(sessionId),

        load: (id) => {
          const trigger = store.get(id);
          return trigger?.status === "active" && isChatTrigger(trigger) ? trigger : undefined;
        },
        usesWorker: (trigger) => trigger.action.kind === "chat" && trigger.action.via === "worker",
        // A trigger with a check runs it first; one with a firing result waiting, or asked to run now, goes to its action.
        gate: (trigger) => {
          const { check } = trigger;
          if (!check || trigger.checkPending || trigger.runNow) return undefined;
          return (claimed, claimToken) => runCheckGate(claimed, check, claimToken);
        },
        reachesArchived: () => false,
        orphaned: (trigger) => {
          const cancelled = store.cancelForSession(trigger.sessionId);
          console.warn(`[trigger-chat-runner] Chat ${trigger.sessionId} no longer exists; cancelling ${cancelled} trigger(s)`);
          return cancelled > 0;
        },
        preflight: (trigger) => {
          if (!trigger.runNow && trigger.maxRuns !== undefined && trigger.runCount >= trigger.maxRuns) return endBeforeRun(trigger, "completed");
          if (trigger.expiresAt && Date.parse(trigger.expiresAt) <= Date.now()) return endBeforeRun(trigger, "expired");
          if (!isRecurringTrigger(trigger) && trigger.attempts >= MAX_ATTEMPTS) {
            return giveUp(trigger, trigger.lastError ?? `Exceeded max tries (${MAX_ATTEMPTS})`);
          }
          return undefined;
        },
        noteWait: (trigger, reason) => store.noteWait(trigger.id, reason),
        claim: (id) => {
          const claimed = store.claimDue(id, LEASE_MS);
          if (!claimed) return undefined;
          if (!isChatTrigger(claimed.trigger)) {
            store.release(id, claimed.claimToken);
            return undefined;
          }
          return { item: claimed.trigger, claimToken: claimed.claimToken };
        },
        renew: (id, claimToken) => store.renewClaim(id, claimToken, LEASE_MS),
        release: (id, claimToken, reason) => store.release(id, claimToken, { error: reason }),

        run: async (trigger, claimToken, lease) => {
          const recurring = isRecurringTrigger(trigger);
          const stopAfter = trigger.checkPending?.stop === true;

          if (!lease) {
            // Message action: queue the prompt for the chat; the outbox delivers it.
            const now = new Date();
            const next = scheduledNextRunAt(trigger, now);
            const status = stopAfter ? "completed" : occurrenceStatus(trigger, trigger.runCount + 1, next);
            store.settleOccurrence(trigger.id, claimToken, {
              nextRunAt: next,
              ...(status === "active" ? {} : { status }),
              fired: true,
              sessionId: trigger.sessionId,
              delivery: createTriggerMessageDelivery(
                { ...ref(trigger), prompt: trigger.prompt, continues: status === "active" },
                checkChange(trigger),
              ),
              ...settledCheck(trigger),
            }, now.toISOString());
            return;
          }

          const input = buildTriggerWorkerInput(trigger);
          const result = await lease.run(input);
          const acceptedAt = new Date();
          const { action } = result;
          if (!recurring && (action === "continue" || action === "notify")) {
            throw new Error(`A one-time trigger's worker cannot ${action}.`);
          }
          const next = recurring ? scheduledNextRunAt(trigger, acceptedAt) : undefined;
          const stops = action === "return" || action === "finish" || stopAfter || !recurring;
          const status = stops
            ? "completed"
            : action === "expired"
              ? "expired"
              : occurrenceStatus(trigger, trigger.runCount + 1, next);
          const parts = status === "active"
            ? action === "notify" ? [result.message ?? "Trigger update."] : []
            : [
                action === "return" || action === "notify" ? result.message : undefined,
                ...(recurring
                  ? [action === "return" || action === "finish" || stopAfter
                      ? "FINAL TRIGGER RESULT: Monitoring completed. This trigger is no longer active."
                      : endMessage(trigger, status as EndStatus)]
                  : []),
              ].filter((part): part is string => Boolean(part));
          // A one-time trigger that finished silently tells the chat nothing.
          const delivery = parts.length > 0 && (recurring || action === "return")
            ? createTriggerResultDelivery(ref(trigger), parts.join("\n\n"), {
                continues: status === "active",
                ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}),
              })
            : undefined;
          // No row back means the trigger was cancelled or reactivated while it ran; that state wins.
          const updated = store.settleOccurrence(trigger.id, claimToken, {
            nextRunAt: next,
            ...(status === "active" ? {} : { status }),
            fired: true,
            ...(delivery ? { delivery } : {}),
            ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
            ...settledCheck(trigger),
          }, acceptedAt.toISOString());
          if (updated && (delivery || (updated.status !== "active" && action !== "finish"))) {
            ctx.recordSessionAttention(trigger.sessionId);
          }
        },
        failed: (trigger, claimToken, error) => {
          failRun(trigger, claimToken, error);
        },
      };
    },
  });
}

export type TriggerChatRunner = ReturnType<typeof createTriggerChatRunner>;
