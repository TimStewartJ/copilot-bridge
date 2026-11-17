// Task lane: triggers that start a fresh chat in their task, or create a task and start its first
// chat. Timing comes from SQLite (no in-memory schedule is authoritative). Each occurrence is
// claimed with a lease; the chat a fire starts is recorded under the claim before it is launched, so
// a run recovered after a crash is settled, never started twice.

import { computeRetryBackoffMs, isChatWorkWaitError, LEASE_EXPIRED_ERROR, LEASE_MS, LEASE_RENEW_INTERVAL_MS, MAX_ATTEMPTS, MAX_TIMER_DELAY_MS } from "../chat-work-runner.js";
import type { GlobalBus } from "../global-bus.js";
import type { ScheduleContext } from "../session-config-builder.js";
import type { SessionManager } from "../session-manager.js";
import type { SessionMetaStore } from "../session-meta-store.js";
import type { Task, TaskStore } from "../task-store.js";
import type { TaskHistoryStore } from "../task-history-store.js";
import type { TelemetryStore } from "../telemetry-store.js";
import { evaluateTriggerCheck, formatTriggerCheckChange, runTriggerCheck } from "./check.js";
import { isRecurringTrigger, scheduledNextRunAt } from "./chat-runner.js";
import { enforceTriggerChatRetention, resolveTriggerRunsKeep } from "./retention.js";
import type { TriggerStore } from "./store.js";
import { isMissedOccurrence, nextRunAfter } from "./timing.js";
import type { Trigger } from "./types.js";

/** Chats being started at once across all task triggers. */
export const MAX_CONCURRENT_TRIGGER_LAUNCHES = 3;
export const TRIGGER_TASK_WATCHDOG_INTERVAL_MS = 60_000;
/** A trigger the Bridge had no room for is looked at again after this long, not at once. */
export const TRIGGER_TASK_WAIT_RETRY_MS = 30_000;
/** A recurring task trigger writes to its task's history once when this many runs in a row failed. */
export const FAILING_TASK_TRIGGER_NOTICE_AFTER = 3;

export interface TriggerTaskRunnerDeps {
  store: TriggerStore;
  taskStore: Pick<TaskStore, "getTask" | "createTask" | "deleteTask" | "linkSession" | "unlinkSession" | "attributeMomentumEventsToSchedule">;
  taskHistoryStore?: Pick<TaskHistoryStore, "addEntry" | "attributeToSchedule">;
  sessionManager: Pick<SessionManager,
    "createTaskSession" | "startWorkAndWaitForDelivery" | "deleteSession" | "abortSession" | "isSessionBusy"
    | "readSessionsFromDisk" | "getSessionCapacityWait" | "getDeferDeliveryReadiness">;
  sessionMetaStore: Pick<SessionMetaStore, "setScheduleMeta" | "isArchived" | "setArchived">;
  globalBus: GlobalBus;
  telemetryStore?: Pick<TelemetryStore, "recordSpan">;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function triggerName(trigger: Trigger): string {
  return trigger.name ?? (trigger.action.kind === "new_task" ? trigger.action.title : "Trigger");
}

/** The prompt a started chat gets: the trigger's own, after the check result that fired it. */
export function startedChatPrompt(trigger: Trigger): string {
  const pending = trigger.checkPending;
  if (!trigger.check || !pending) return trigger.prompt;
  return [
    formatTriggerCheckChange({
      command: trigger.check.command,
      fireOn: trigger.check.fireOn,
      ...(trigger.lastCheck?.output ? { previous: trigger.lastCheck.output } : {}),
      current: { exitCode: pending.exitCode, stdout: pending.stdout, stderr: pending.stderr },
    }),
    "",
    trigger.prompt,
  ].join("\n");
}

export function createTriggerTaskRunner(deps: TriggerTaskRunnerDeps) {
  const { store, taskStore, sessionManager, globalBus } = deps;
  let started = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let passPromise: Promise<void> | undefined;
  let rerun = false;
  const inFlight = new Map<string, Promise<void>>();
  /** Triggers that had to wait for room, and when to try them again. */
  const waitingUntil = new Map<string, number>();

  function holdForRoom(id: string): void {
    waitingUntil.set(id, Date.now() + TRIGGER_TASK_WAIT_RETRY_MS);
  }

  function emitChanged(trigger: Pick<Trigger, "id" | "taskId">): void {
    globalBus.emit({ type: "trigger:changed", triggerId: trigger.id, ...(trigger.taskId ? { taskId: trigger.taskId } : {}) });
  }

  function historyNote(trigger: Trigger, text: string): void {
    if (!trigger.taskId || !deps.taskHistoryStore) return;
    try {
      deps.taskHistoryStore.addEntry(trigger.taskId, text, { source: "system", scheduleId: trigger.id, scheduleName: triggerName(trigger) });
    } catch (error) {
      console.warn(`[trigger-task-runner] Could not write task history for trigger ${trigger.id}:`, errorMessage(error));
    }
  }

  function recordSpan(name: string, metadata: Record<string, unknown>): void {
    try {
      deps.telemetryStore?.recordSpan({ name, duration: 0, metadata, source: "server" });
    } catch { /* telemetry is best effort */ }
  }

  // ── Outcomes ─────────────────────────────────────────────────────

  function failRun(trigger: Trigger, claimToken: string, error: string): void {
    const now = new Date();
    if (!isRecurringTrigger(trigger)) {
      if (trigger.attempts >= MAX_ATTEMPTS) {
        if (store.settleOccurrence(trigger.id, claimToken, { status: "failed", error })) {
          historyNote(trigger, `Trigger "${triggerName(trigger)}" failed after ${trigger.attempts} tries and stopped. Last error: ${error}`);
        }
        return;
      }
      store.retryLater(trigger.id, claimToken, new Date(now.getTime() + computeRetryBackoffMs(trigger.attempts)).toISOString(), error);
      return;
    }
    const updated = store.settleOccurrence(trigger.id, claimToken, { nextRunAt: scheduledNextRunAt(trigger, now), error });
    if (updated && trigger.attempts === FAILING_TASK_TRIGGER_NOTICE_AFTER) {
      historyNote(trigger, `The last ${trigger.attempts} runs of trigger "${triggerName(trigger)}" failed. It stays active. Last error: ${error}`);
    }
  }

  /** Settle a run whose lease ran out: one that already recorded its chat counts as fired. */
  function recoverExpired(trigger: Trigger): void {
    const claimToken = trigger.claimToken!;
    const run = store.findRunByOccurrence(trigger.id, claimToken);
    if (run) {
      store.settleOccurrence(trigger.id, claimToken, {
        nextRunAt: scheduledNextRunAt(trigger, new Date()),
        fired: true,
        sessionId: run.sessionId,
        ...(run.taskId ? { taskId: run.taskId } : {}),
      });
    } else {
      failRun(trigger, claimToken, LEASE_EXPIRED_ERROR);
    }
    emitChanged(trigger);
  }

  // ── Starting a chat ──────────────────────────────────────────────

  async function rollback(taskId: string, sessionId: string, createdTaskId: string | undefined): Promise<void> {
    const errors: string[] = [];
    try { taskStore.unlinkSession(taskId, sessionId); } catch { /* the task may already be gone */ }
    try {
      if (sessionManager.isSessionBusy(sessionId)) await sessionManager.abortSession(sessionId);
    } catch (error) {
      errors.push(`abort failed: ${errorMessage(error)}`);
    }
    try {
      await sessionManager.deleteSession(sessionId);
    } catch (error) {
      errors.push(`delete failed: ${errorMessage(error)}`);
    }
    if (createdTaskId) {
      try { taskStore.deleteTask(createdTaskId); } catch (error) { errors.push(`task delete failed: ${errorMessage(error)}`); }
    }
    if (errors.length > 0) console.warn(`[trigger-task-runner] Rolling back chat ${sessionId.slice(0, 8)}: ${errors.join("; ")}`);
  }

  async function launch(trigger: Trigger, owner: Task, occurrence: string): Promise<{ sessionId: string; taskId?: string }> {
    const action = trigger.action;
    let target = owner;
    let createdTaskId: string | undefined;
    if (action.kind === "new_task") {
      target = taskStore.createTask(action.title, owner.groupId ?? null);
      createdTaskId = target.id;
    }
    const context: ScheduleContext = {
      name: triggerName(trigger),
      type: isRecurringTrigger(trigger) ? "cron" : "once",
      runCount: trigger.fireCount,
      ...(trigger.lastFiredAt ? { lastRunAt: trigger.lastFiredAt } : {}),
      ...(action.kind !== "chat" && action.modelTier ? { modelTier: action.modelTier } : {}),
      ...(action.kind !== "chat" && action.playbook ? { playbook: action.playbook } : {}),
      ...(action.kind === "new_chat" && trigger.lastSessionId ? { previousSessionId: trigger.lastSessionId } : {}),
    };
    let sessionId: string;
    try {
      ({ sessionId } = await sessionManager.createTaskSession(
        target.id, target.title, target.workItems, target.notes, target.cwd, context,
      ));
    } catch (error) {
      if (createdTaskId) {
        try { taskStore.deleteTask(createdTaskId); } catch { /* leave it; the error below is what matters */ }
      }
      throw error;
    }
    try {
      // Linked and recorded before the launch, so a crash from here on leaves the chat visible and
      // the occurrence settled as fired rather than started again.
      taskStore.linkSession(target.id, sessionId);
      store.recordRun({ triggerId: trigger.id, sessionId, ...(createdTaskId ? { taskId: createdTaskId } : {}), occurrence });
      await sessionManager.startWorkAndWaitForDelivery(sessionId, startedChatPrompt(trigger), undefined, { origin: "schedule", promptSource: "automation-schedule" });
    } catch (error) {
      store.deleteRunByOccurrence(trigger.id, occurrence);
      await rollback(target.id, sessionId, createdTaskId);
      throw error;
    }
    if (createdTaskId) {
      historyNote({ ...trigger, taskId: createdTaskId }, `Created by trigger "${triggerName(trigger)}" of task "${owner.title}".`);
    }
    return { sessionId, ...(createdTaskId ? { taskId: createdTaskId } : {}) };
  }

  async function afterFire(trigger: Trigger, sessionId: string): Promise<void> {
    const name = triggerName(trigger);
    try {
      deps.sessionMetaStore.setScheduleMeta(sessionId, trigger.id, name);
      taskStore.attributeMomentumEventsToSchedule(sessionId, trigger.id, name);
      deps.taskHistoryStore?.attributeToSchedule(sessionId, trigger.id, name);
    } catch (error) {
      console.warn(`[trigger-task-runner] Could not attribute chat ${sessionId.slice(0, 8)} to trigger "${name}":`, errorMessage(error));
    }
    if (trigger.action.kind !== "new_chat") return;
    try {
      const retention = await enforceTriggerChatRetention({
        triggerId: trigger.id,
        keepChats: trigger.action.keepChats,
        triggerStore: store,
        sessionMetaStore: deps.sessionMetaStore,
        sessionManager,
        globalBus,
      });
      store.pruneRuns(trigger.id, resolveTriggerRunsKeep(trigger.action.keepChats), retention.retainableSessionIds);
    } catch (error) {
      console.warn(`[trigger-task-runner] Retention failed for trigger "${name}":`, errorMessage(error));
    }
  }

  // ── One occurrence ───────────────────────────────────────────────

  async function runClaimed(claimed: Trigger, claimToken: string, owner: Task): Promise<void> {
    let trigger = claimed;
    const now = new Date();
    if (trigger.check && !trigger.checkPending && !trigger.runNow) {
      const result = await runTriggerCheck(trigger.check, trigger.check.cwd ?? owner.cwd ?? process.cwd());
      const at = new Date();
      const decision = evaluateTriggerCheck(trigger.check, result, trigger.lastCheck?.fingerprint);
      if (!decision.fire) {
        store.settleOccurrence(trigger.id, claimToken, {
          nextRunAt: scheduledNextRunAt(trigger, at),
          check: { result, at: at.toISOString(), outcome: decision.outcome },
        }, at.toISOString());
        return;
      }
      const pending = { ...result, at: at.toISOString(), ...(decision.stop ? { stop: true } : {}) };
      if (!store.savePendingCheck(trigger.id, claimToken, pending)) return;
      trigger = { ...trigger, checkPending: pending };
    }

    // One open task at a time: a firing result waits until the task made last is finished.
    if (trigger.action.kind === "new_task" && !trigger.runNow && trigger.lastTaskId) {
      const last = taskStore.getTask(trigger.lastTaskId);
      if (last && last.status === "active") {
        store.settleOccurrence(trigger.id, claimToken, { nextRunAt: scheduledNextRunAt(trigger, now), keepPending: true });
        return;
      }
    }

    const fired = await launch(trigger, owner, claimToken);
    const settledAt = new Date();
    const pending = trigger.checkPending;
    store.settleOccurrence(trigger.id, claimToken, {
      nextRunAt: scheduledNextRunAt(trigger, settledAt),
      ...(pending?.stop ? { status: "completed" as const } : {}),
      fired: true,
      sessionId: fired.sessionId,
      ...(fired.taskId ? { taskId: fired.taskId } : {}),
      ...(pending && trigger.check
        ? { check: { result: pending, at: pending.at, outcome: trigger.check.fireOn === "exit_code" ? "fired" as const : "changed" as const } }
        : {}),
    }, settledAt.toISOString());
    console.log(`[trigger-task-runner] "${triggerName(trigger)}" started chat ${fired.sessionId.slice(0, 8)}`);
    globalBus.emit({
      type: "trigger:fired",
      triggerId: trigger.id,
      triggerName: triggerName(trigger),
      taskId: fired.taskId ?? owner.id,
      sessionId: fired.sessionId,
    });
    await afterFire(trigger, fired.sessionId);
  }

  async function processOne(id: string): Promise<void> {
    const trigger = store.get(id);
    if (!trigger || trigger.status !== "active" || !trigger.taskId) return;
    const owner = taskStore.getTask(trigger.taskId);
    const now = new Date();
    if (!owner) {
      // Task deletion removes its triggers; this only happens if that was interrupted.
      if (store.endWaiting(id, "cancelled", { error: "Its task no longer exists." })) emitChanged(trigger);
      return;
    }
    if (!trigger.runNow) {
      if (trigger.maxRuns !== undefined && trigger.runCount >= trigger.maxRuns) {
        if (store.endWaiting(id, "completed")) emitChanged(trigger);
        return;
      }
      if (trigger.expiresAt && Date.parse(trigger.expiresAt) <= now.getTime()) {
        if (store.endWaiting(id, "expired")) emitChanged(trigger);
        return;
      }
      if (trigger.nextRunAt && isMissedOccurrence(trigger.when, "task", trigger.nextRunAt, now)) {
        const next = trigger.when.kind === "cron" ? nextRunAfter(trigger.when, now) : undefined;
        console.warn(`[trigger-task-runner] "${triggerName(trigger)}" missed its run at ${trigger.nextRunAt}; ${next ? `next at ${next}` : "it will not run"}`);
        if (next) store.update(id, { nextRunAt: next });
        else store.endWaiting(id, "expired", { error: "Missed: the Bridge was not running at its time." });
        emitChanged(trigger);
        return;
      }
    }
    const wait = sessionManager.getSessionCapacityWait?.();
    if (wait) {
      store.noteWait(id, wait);
      holdForRoom(id);
      return;
    }
    const claimed = store.claimDue(id, LEASE_MS);
    if (!claimed) return;
    const { claimToken } = claimed;
    emitChanged(trigger);
    const renewal = setInterval(() => {
      if (!store.renewClaim(id, claimToken, LEASE_MS)) console.warn(`[trigger-task-runner] Failed to renew lease for trigger ${id}`);
    }, LEASE_RENEW_INTERVAL_MS);
    try {
      await runClaimed(claimed.trigger, claimToken, owner);
    } catch (error) {
      const message = errorMessage(error);
      if (isChatWorkWaitError(error) || sessionManager.getDeferDeliveryReadiness?.().ready === false) {
        // The Bridge could not take the chat; the occurrence stays due and is not counted.
        store.release(id, claimToken, { error: message });
        holdForRoom(id);
      } else {
        console.error(`[trigger-task-runner] "${triggerName(claimed.trigger)}" failed: ${message}`);
        recordSpan("trigger.task_runner.failure", { triggerId: id, error: message });
        failRun(claimed.trigger, claimToken, message);
      }
    } finally {
      clearInterval(renewal);
      emitChanged(trigger);
    }
  }

  // ── Scheduling ───────────────────────────────────────────────────

  function armNext(): void {
    if (!started) return;
    clearTimeout(timer);
    const nextWakeAt = store.getNextWakeAt("task");
    // A hold already over is not a reason to wake: the trigger is due anyway, or the watchdog looks again.
    for (const [id, until] of waitingUntil) if (until <= Date.now()) waitingUntil.delete(id);
    const held = [...waitingUntil.values()];
    const wakeAt = Math.min(nextWakeAt ? Date.parse(nextWakeAt) : Number.POSITIVE_INFINITY, ...held);
    if (!Number.isFinite(wakeAt)) return;
    const delay = Math.min(Math.max(1_000, wakeAt - Date.now()), MAX_TIMER_DELAY_MS);
    const scheduledGeneration = generation;
    timer = setTimeout(() => {
      if (!started || scheduledGeneration !== generation) return;
      void processDue();
    }, delay);
  }

  async function passOnce(): Promise<void> {
    const now = new Date().toISOString();
    for (const trigger of store.listExpiredRunning("task", now)) {
      if (inFlight.has(trigger.id)) continue;
      try {
        recoverExpired(trigger);
      } catch (error) {
        console.error(`[trigger-task-runner] Failed to recover trigger ${trigger.id}:`, error);
      }
    }
    if (sessionManager.getDeferDeliveryReadiness?.().ready === false) return; // the watchdog looks again
    for (const trigger of store.listDue("task", now)) {
      if (inFlight.has(trigger.id)) continue;
      const holdUntil = waitingUntil.get(trigger.id);
      if (holdUntil !== undefined && holdUntil > Date.now()) continue;
      waitingUntil.delete(trigger.id);
      if (inFlight.size >= MAX_CONCURRENT_TRIGGER_LAUNCHES) break;
      const run = processOne(trigger.id)
        .catch((error) => console.error(`[trigger-task-runner] Unexpected error for trigger ${trigger.id}:`, error))
        .finally(() => {
          inFlight.delete(trigger.id);
          if (started) void processDue();
        });
      inFlight.set(trigger.id, run);
    }
  }

  function processDue(): Promise<void> {
    if (passPromise) {
      rerun = true;
      return passPromise;
    }
    passPromise = (async () => {
      try {
        do {
          rerun = false;
          await passOnce();
        } while (started && rerun);
      } finally {
        passPromise = undefined;
        armNext();
      }
    })();
    return passPromise;
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      generation += 1;
      watchdog = setInterval(() => { void processDue(); }, TRIGGER_TASK_WATCHDOG_INTERVAL_MS);
      watchdog.unref?.();
      void processDue();
      console.log("[trigger-task-runner] Started");
    },
    /** Look for due triggers now: call after creating, editing or asking to run one. */
    poke(): void {
      waitingUntil.clear();
      if (started) void processDue();
    },
    shutdown(): void {
      started = false;
      generation += 1;
      clearTimeout(timer);
      clearInterval(watchdog);
      timer = undefined;
      watchdog = undefined;
      rerun = false;
    },
    /** Test hook: wait for the current pass and every launch it started. */
    async waitForIdle(): Promise<void> {
      while (passPromise || inFlight.size > 0) {
        await passPromise;
        await Promise.all(inFlight.values());
      }
    },
  };
}

export type TriggerTaskRunner = ReturnType<typeof createTriggerTaskRunner>;
