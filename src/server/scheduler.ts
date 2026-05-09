// Scheduler — in-process cron scheduler for scheduled sessions
// Registers node-cron jobs, handles triggering, missed-run catch-up

import cron, { type ScheduledTask } from "node-cron";
import type { AutomaticRunClaim, ScheduleStore, ScheduleTriggerSource } from "./schedule-store.js";
import type { TaskStore } from "./task-store.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { DeferredPromptStore } from "./deferred-prompt-store.js";
import type { DeferLoopStore } from "./defer-loop-store.js";
import {
  isRestartCutoverInProgress,
  isRestartPending,
  isRestartPendingError,
  RESTART_PENDING_MESSAGE,
  refreshRestartState,
  refreshRestartStateSync,
} from "./session-manager.js";
import { createMissedRunCatchUpController } from "./scheduler-missed-runs.js";
import { enforceScheduleSessionRetention } from "./schedule-session-retention.js";

// ── State ─────────────────────────────────────────────────────────

const cronJobs = new Map<string, ScheduledTask>();
const oneShotTimers = new Map<string, ReturnType<typeof setTimeout>>();
const automaticRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sessionMgr: SessionManager | null = null;
let busUnsubscribe: (() => void) | undefined;

// Injected stores (set via initialize)
let scheduleStore: ScheduleStore;
let taskStore: TaskStore;
let sessionMetaStore: SessionMetaStore;
let bus: GlobalBus;
let deferredPromptStore: DeferredPromptStore | undefined;
let deferLoopStore: DeferLoopStore | undefined;

// Safety: track in-flight schedule runs to prevent overlap
const activeRuns = new Set<string>();

// Global pause (runtime-only; settings-store could persist this later)
let _globalPause = false;

const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes minimum between runs
const MAX_CONCURRENT = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
const AUTOMATIC_CLAIM_RENEW_INTERVAL_MS = 30 * 1000;
const ONE_SHOT_RETRY_DELAY_MS = 30 * 1000;
const MISSED_RUN_WATCHDOG_INTERVAL_MS = 60 * 1000;
const NEXT_RUN_LOOKAHEAD_MINUTES = 35 * 24 * 60;
let missedRunWatchdogTimer: ReturnType<typeof setInterval> | undefined;

const missedRunCatchUp = createMissedRunCatchUpController({
  scheduleStore: () => scheduleStore,
  computeNextRunAt,
  unregisterSchedule,
  triggerSchedule,
  isRestartPending,
  refreshRestartState,
  getRestartPendingMessage: () => RESTART_PENDING_MESSAGE,
});

// ── Public API ────────────────────────────────────────────────────

export interface SchedulerDeps {
  scheduleStore: ScheduleStore;
  taskStore: TaskStore;
  sessionMetaStore: SessionMetaStore;
  globalBus: GlobalBus;
  deferredPromptStore?: DeferredPromptStore;
  deferLoopStore?: DeferLoopStore;
}

export function initialize(manager: SessionManager, deps: SchedulerDeps): void {
  sessionMgr = manager;
  scheduleStore = deps.scheduleStore;
  taskStore = deps.taskStore;
  sessionMetaStore = deps.sessionMetaStore;
  bus = deps.globalBus;
  deferredPromptStore = deps.deferredPromptStore;
  deferLoopStore = deps.deferLoopStore;
  busUnsubscribe?.();
  busUnsubscribe = bus.subscribe((event) => {
    if (event.type === "server:restart-cleared") {
      missedRunCatchUp.check();
    }
  });
  registerAllSchedules();
  missedRunCatchUp.check();
  startMissedRunWatchdog();
  console.log("[scheduler] Initialized");
}

export function isInitialized(): boolean {
  return sessionMgr !== null && scheduleStore !== undefined && taskStore !== undefined && sessionMetaStore !== undefined && bus !== undefined;
}

export function shutdown(): void {
  for (const [id, job] of cronJobs) {
    job.stop();
    cronJobs.delete(id);
  }
  for (const [id, timer] of oneShotTimers) {
    clearTimeout(timer);
    oneShotTimers.delete(id);
  }
  clearAutomaticRetryTimers();
  missedRunCatchUp.reset();
  clearMissedRunWatchdog();
  busUnsubscribe?.();
  busUnsubscribe = undefined;
  deferredPromptStore = undefined;
  deferLoopStore = undefined;
  activeRuns.clear();
  _globalPause = false;
  console.log("[scheduler] Shut down — all jobs stopped");
}

export interface TriggerScheduleOptions {
  source?: ScheduleTriggerSource;
  scheduledFor?: string;
}

export function isGlobalPaused(): boolean {
  return _globalPause;
}

export function setGlobalPause(paused: boolean): void {
  _globalPause = paused;
  console.log(`[scheduler] Global pause: ${paused}`);
  if (paused) {
    // Stop all running cron jobs
    for (const job of cronJobs.values()) job.stop();
  } else {
    // Re-register everything
    registerAllSchedules();
  }
}

/**
 * Register or re-register a single schedule's cron job.
 * Call after creating or updating a schedule.
 */
export function registerSchedule(scheduleId: string): void {
  // Unregister existing job first
  unregisterSchedule(scheduleId);

  const schedule = scheduleStore.getSchedule(scheduleId);
  if (!schedule || !schedule.enabled || schedule.type !== "cron" || !schedule.cron) return;
  if (_globalPause) return;

  if (!cron.validate(schedule.cron)) {
    console.error(`[scheduler] Invalid cron expression for schedule ${scheduleId}: ${schedule.cron}`);
    return;
  }

  const opts: { scheduled?: boolean; timezone?: string } = { scheduled: true };
  if (schedule.timezone) opts.timezone = schedule.timezone;

  const job = cron.schedule(schedule.cron, () => {
    triggerSchedule(scheduleId, { source: "cron", scheduledFor: floorToMinuteIso(new Date()) }).catch((err) => {
      console.error(`[scheduler] Error triggering schedule ${scheduleId}:`, err);
    });
  }, opts);
  job.on("execution:missed", () => {
    console.warn(`[scheduler] Missed cron execution for "${schedule.name}" (${schedule.id}); checking catch-up`);
    missedRunCatchUp.check();
  });

  cronJobs.set(scheduleId, job);

  // Compute and store next run time
  const nextRunAt = computeNextRunAt(schedule.cron, schedule.timezone);
  if (nextRunAt) scheduleStore.updateNextRunAt(scheduleId, nextRunAt);

  console.log(`[scheduler] Registered cron job for "${schedule.name}" (${schedule.cron})`);
}

/**
 * Unregister a schedule's cron job. Call before deleting or disabling.
 */
export function unregisterSchedule(scheduleId: string): void {
  const existing = cronJobs.get(scheduleId);
  if (existing) {
    existing.stop();
    cronJobs.delete(scheduleId);
  }
  const timer = oneShotTimers.get(scheduleId);
  if (timer) {
    clearTimeout(timer);
    oneShotTimers.delete(scheduleId);
  }
  clearAutomaticRetryTimers(scheduleId);
}

/**
 * Arm (or re-arm) a one-shot schedule's setTimeout.
 * Clears any existing timer for this schedule first.
 */
export function armOneShot(scheduleId: string, runAt: string): void {
  // Clear existing timer
  const existing = oneShotTimers.get(scheduleId);
  if (existing) clearTimeout(existing);

  const delay = new Date(runAt).getTime() - Date.now();
  if (delay <= 0) return;

  const timer = setTimeout(() => {
    oneShotTimers.delete(scheduleId);
    triggerSchedule(scheduleId, { source: "once", scheduledFor: new Date(runAt).toISOString() }).catch((err) => {
      console.error(`[scheduler] One-shot trigger failed for ${scheduleId}:`, err);
    });
  }, delay);
  oneShotTimers.set(scheduleId, timer);
}

function armOneShotRetry(scheduleId: string, scheduledFor: string): void {
  const schedule = scheduleStore.getSchedule(scheduleId);
  if (!schedule || !schedule.enabled || schedule.type !== "once") return;

  const existing = oneShotTimers.get(scheduleId);
  if (existing) clearTimeout(existing);

  const retryAt = new Date(Date.now() + ONE_SHOT_RETRY_DELAY_MS).toISOString();
  const timer = setTimeout(() => {
    oneShotTimers.delete(scheduleId);
    triggerSchedule(scheduleId, { source: "once", scheduledFor }).catch((err) => {
      console.error(`[scheduler] One-shot retry failed for ${scheduleId}:`, err);
    });
  }, ONE_SHOT_RETRY_DELAY_MS);
  oneShotTimers.set(scheduleId, timer);
  scheduleStore.updateNextRunAt(scheduleId, retryAt);
  bus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId });
}

function clearAutomaticRetryTimers(scheduleId?: string): void {
  for (const [key, timer] of automaticRetryTimers) {
    if (scheduleId && !key.startsWith(`${scheduleId}:`)) continue;
    clearTimeout(timer);
    automaticRetryTimers.delete(key);
  }
}

function armAutomaticRetry(
  scheduleId: string,
  source: Exclude<ScheduleTriggerSource, "manual">,
  scheduledFor: string,
): void {
  if (source === "once") {
    armOneShotRetry(scheduleId, scheduledFor);
    return;
  }
  const schedule = scheduleStore.getSchedule(scheduleId);
  if (!schedule || !schedule.enabled) return;

  const retryKey = `${scheduleId}:${source}:${scheduledFor}`;
  const existing = automaticRetryTimers.get(retryKey);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    automaticRetryTimers.delete(retryKey);
    triggerSchedule(scheduleId, { source, scheduledFor }).catch((err) => {
      console.error(`[scheduler] ${source} retry failed for ${scheduleId}:`, err);
    });
  }, ONE_SHOT_RETRY_DELAY_MS);
  automaticRetryTimers.set(retryKey, timer);
}

/**
 * Validate an IANA timezone string. Returns true if valid.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Manually trigger a schedule immediately (for "Run Now" or catch-up).
 */
export async function triggerSchedule(
  scheduleId: string,
  options: TriggerScheduleOptions = {},
): Promise<{ sessionId: string } | { skipped: string }> {
  if (!sessionMgr) throw new Error("Scheduler not initialized");
  const triggerSource = options.source ?? "manual";

  const schedule = scheduleStore.getSchedule(scheduleId);
  if (!schedule) throw new Error(`Schedule ${scheduleId} not found`);
  const retryWithoutClaim = (reason: string, retryAutomatic = false) => {
    if (retryAutomatic && triggerSource !== "manual") {
      armAutomaticRetry(scheduleId, triggerSource, getAutomaticRunKey(triggerSource, options.scheduledFor ?? schedule.runAt));
    }
    return { skipped: reason };
  };

  // Check global pause
  if (_globalPause) return retryWithoutClaim("Scheduling is globally paused", triggerSource === "once");

  if (isRestartCutoverInProgress(refreshRestartStateSync())) {
    return retryWithoutClaim(RESTART_PENDING_MESSAGE, triggerSource === "once");
  }

  if (triggerSource !== "manual" && !schedule.enabled) {
    return { skipped: "Schedule is disabled" };
  }

  // Skip if this schedule is already running
  if (activeRuns.has(scheduleId)) {
    console.log(`[scheduler] Skipping "${schedule.name}" — previous run still active`);
    return retryWithoutClaim("Previous run still active", triggerSource !== "manual");
  }

  // Check rate limiting for automatic triggers only.
  if (triggerSource !== "manual" && schedule.lastRunAt) {
    const lastRunAtMs = new Date(schedule.lastRunAt).getTime();
    const comparisonMs = options.scheduledFor ? new Date(options.scheduledFor).getTime() : Date.now();
    const elapsed = comparisonMs - lastRunAtMs;
    if (elapsed >= 0 && elapsed < MIN_INTERVAL_MS) {
      console.log(`[scheduler] Skipping "${schedule.name}" — too soon (${Math.round(elapsed / 1000)}s since last run)`);
      return { skipped: `Too soon — ${Math.round((MIN_INTERVAL_MS - elapsed) / 1000)}s until next allowed run` };
    }
  }

  // Check max concurrent
  if (activeRuns.size >= MAX_CONCURRENT) {
    console.log(`[scheduler] Skipping "${schedule.name}" — max concurrent (${MAX_CONCURRENT}) reached`);
    return retryWithoutClaim("Max concurrent scheduled sessions reached", triggerSource !== "manual");
  }

  // Check expiration
  if (schedule.expiresAt && new Date() >= new Date(schedule.expiresAt)) {
    scheduleStore.updateSchedule(scheduleId, { enabled: false });
    unregisterSchedule(scheduleId);
    bus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId });
    return { skipped: "Schedule expired" };
  }

  // Check maxRuns
  if (schedule.maxRuns && schedule.runCount >= schedule.maxRuns) {
    scheduleStore.updateSchedule(scheduleId, { enabled: false });
    unregisterSchedule(scheduleId);
    bus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId });
    return { skipped: "Max runs reached" };
  }

  const task = taskStore.getTask(schedule.taskId);
  if (!task) {
    console.error(`[scheduler] Task ${schedule.taskId} not found for schedule "${schedule.name}"`);
    return { skipped: "Parent task not found" };
  }

  console.log(`[scheduler] ⏰ Triggering "${schedule.name}" for task "${task.title}"`);
  activeRuns.add(scheduleId);
  let scheduleRunClaim: AutomaticRunClaim | undefined;
  let scheduleRunClaimResolved = false;
  let scheduleRunClaimRenewTimer: ReturnType<typeof setInterval> | undefined;
  let automaticSlotClaim: AutomaticRunClaim | undefined;
  let automaticSlotClaimResolved = false;
  let retryReleasedClaim = false;
  const retryAutomaticIfNeeded = (runKey: string, retryAutomatic: boolean) => {
    if (retryAutomatic && triggerSource !== "manual") {
      armAutomaticRetry(scheduleId, triggerSource, runKey);
    }
  };
  const releaseScheduleRunClaim = () => {
    if (!scheduleRunClaim || scheduleRunClaimResolved) return;
    scheduleStore.releaseClaimedAutomaticRun(scheduleId, scheduleRunClaim);
    scheduleRunClaimResolved = true;
  };
  const releaseAutomaticSlotClaim = (options: { retryAutomatic?: boolean } = {}) => {
    if (!automaticSlotClaim || automaticSlotClaimResolved) return;
    scheduleStore.releaseClaimedAutomaticRun(scheduleId, automaticSlotClaim);
    automaticSlotClaimResolved = true;
    retryAutomaticIfNeeded(automaticSlotClaim.runKey, options.retryAutomatic ?? false);
  };

  try {
    const stopScheduleRunClaimRenewal = () => {
      if (scheduleRunClaimRenewTimer) {
        clearInterval(scheduleRunClaimRenewTimer);
        scheduleRunClaimRenewTimer = undefined;
      }
    };

    const scheduleLock = scheduleStore.claimScheduleRun(scheduleId, triggerSource);
    if (!scheduleLock.acquired) {
      console.log(`[scheduler] Skipping "${schedule.name}" — previous run still active`);
      return retryWithoutClaim("Previous run still active", triggerSource !== "manual");
    }
    scheduleRunClaim = scheduleLock.claim;
    scheduleRunClaimRenewTimer = setInterval(() => {
      if (!scheduleRunClaim || scheduleRunClaimResolved) {
        stopScheduleRunClaimRenewal();
        return;
      }
      try {
        const renewed = scheduleStore.renewClaimedAutomaticRun(scheduleId, scheduleRunClaim);
        if (!renewed) stopScheduleRunClaimRenewal();
      } catch (err) {
        console.warn(`[scheduler] Failed to renew schedule lock for "${schedule.name}":`, err);
        stopScheduleRunClaimRenewal();
      }
    }, AUTOMATIC_CLAIM_RENEW_INTERVAL_MS);

    if (triggerSource !== "manual") {
      const runKey = getAutomaticRunKey(triggerSource, options.scheduledFor);
      const claim = scheduleStore.claimAutomaticRun(scheduleId, runKey, triggerSource);
      if (!claim.acquired) {
        releaseScheduleRunClaim();
        console.log(`[scheduler] Skipping "${schedule.name}" — ${claim.reason}`);
        return { skipped: claim.reason };
      }
      automaticSlotClaim = claim.claim;
    }

    // Create a fresh task session for every schedule run.
    let sessionId: string;
    let createdSession = false;

    const prDescriptions = task.pullRequests.map(
      (pr) => `${pr.repoName || pr.repoId} PR #${pr.prId}`,
    );
    let result: Awaited<ReturnType<SessionManager["createTaskSession"]>>;
    try {
      result = await sessionMgr.createTaskSession(
        task.id,
        task.title,
        task.workItems,
        prDescriptions,
        task.notes,
        task.cwd,
        { name: schedule.name, type: schedule.type, runCount: schedule.runCount, lastRunAt: schedule.lastRunAt },
      );
    } catch (err) {
      retryReleasedClaim = true;
      throw err;
    }
    sessionId = result.sessionId;
    createdSession = true;

    console.log(`[scheduler] Created session ${sessionId.slice(0, 8)} for "${schedule.name}"`);

    // Link before launch so any later persistence failure still leaves the session visible on the task.
    try {
      taskStore.linkSession(task.id, sessionId);
    } catch (linkErr) {
      try {
        await sessionMgr.deleteSession(sessionId);
      } catch (cleanupErr) {
        const linkMessage = linkErr instanceof Error ? linkErr.message : String(linkErr);
        const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        throw new Error(
          `[scheduler] Failed to roll back session ${sessionId.slice(0, 8)} after link rejection: link failed: ${linkMessage}; delete failed: ${cleanupMessage}`,
        );
      }
      retryReleasedClaim = true;
      throw linkErr;
    }

    // Fire the prompt
    try {
      sessionMgr.startWork(sessionId, schedule.prompt);
    } catch (err) {
      const cleanupErrors: string[] = [];
      let unlinkedCreatedSession = false;
      if (createdSession) {
        try {
          taskStore.unlinkSession(task.id, sessionId);
          unlinkedCreatedSession = true;
        } catch (unlinkErr) {
          const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
          if (!/Task .* not found/.test(message)) {
            cleanupErrors.push(`unlink failed: ${message}`);
          }
        }
        try {
          await sessionMgr.deleteSession(sessionId);
        } catch (cleanupErr) {
          cleanupErrors.push(`delete failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
      }
      if (cleanupErrors.length > 0 && createdSession && unlinkedCreatedSession) {
        try {
          taskStore.linkSession(task.id, sessionId);
        } catch (relinkErr) {
          cleanupErrors.push(`relink failed: ${relinkErr instanceof Error ? relinkErr.message : String(relinkErr)}`);
        }
      }
      releaseAutomaticSlotClaim({ retryAutomatic: cleanupErrors.length === 0 });
      releaseScheduleRunClaim();
      if (cleanupErrors.length > 0) {
        throw new Error(
          `[scheduler] Failed to roll back session ${sessionId.slice(0, 8)} after launch rejection: ${cleanupErrors.join("; ")}`,
        );
      }
      if (isRestartPendingError(err)) {
        return { skipped: RESTART_PENDING_MESSAGE };
      }
      throw err;
    }

    const nextRunAt = schedule.type === "cron" && schedule.cron
      ? computeNextRunAt(schedule.cron, schedule.timezone)
      : undefined;
    if (automaticSlotClaim && triggerSource !== "manual") {
      const finalized = scheduleStore.completeAutomaticRun(scheduleId, automaticSlotClaim, sessionId, nextRunAt);
      automaticSlotClaimResolved = true;
      if (!finalized) {
        console.warn(`[scheduler] Lost automatic claim for "${schedule.name}" slot ${automaticSlotClaim.runKey} before finalizing`);
        releaseScheduleRunClaim();
        await rollbackAcceptedScheduleRun(task.id, sessionId, `lost claim for slot ${automaticSlotClaim.runKey}`);
        return { skipped: "This scheduled slot is already being processed" };
      }
    } else {
      scheduleStore.recordRun(scheduleId, sessionId, nextRunAt);
    }
    if (schedule.type === "once") {
      unregisterSchedule(scheduleId);
    }

    // Record schedule ownership/association and append run history.
    sessionMetaStore.setScheduleMeta(sessionId, scheduleId, schedule.name);
    sessionMetaStore.recordScheduleRun(scheduleId, sessionId);
    try {
      await enforceScheduleSessionRetention({
        schedule,
        sessionMetaStore,
        sessionManager: sessionMgr,
        globalBus: bus,
        deferredPromptStore,
        deferLoopStore,
      });
    } catch (err) {
      console.warn(`[scheduler] Failed to apply retention for "${schedule.name}" (${schedule.id}):`, err);
    }
    releaseScheduleRunClaim();

    // Emit global event
    bus.emit({
      type: "schedule:triggered",
      scheduleId,
      scheduleName: schedule.name,
      sessionId,
    });

    // Notify UI that schedule metadata changed (runCount, lastRunAt, nextRunAt)
    bus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId });

    console.log(`[scheduler] ✅ "${schedule.name}" triggered — session ${sessionId.slice(0, 8)}`);
    return { sessionId };
  } catch (err) {
    if (automaticSlotClaim && !automaticSlotClaimResolved) {
      try {
        releaseAutomaticSlotClaim({ retryAutomatic: retryReleasedClaim });
      } catch (releaseErr) {
        console.warn(`[scheduler] Failed to release automatic slot claim for "${schedule.name}":`, releaseErr);
      }
    }
    if (scheduleRunClaim && !scheduleRunClaimResolved) {
      try {
        releaseScheduleRunClaim();
      } catch (releaseErr) {
        console.warn(`[scheduler] Failed to release schedule lock for "${schedule.name}":`, releaseErr);
      }
    }
    console.error(`[scheduler] ❌ Failed to trigger "${schedule.name}":`, err);
    throw err;
  } finally {
    if (scheduleRunClaimRenewTimer) {
      clearInterval(scheduleRunClaimRenewTimer);
    }
    // Clean up active run tracking after a delay
    // (the session itself runs async; we just track the trigger phase)
    activeRuns.delete(scheduleId);
  }
}

// ── Internal ──────────────────────────────────────────────────────

function registerAllSchedules(): void {
  // Clear existing jobs
  for (const job of cronJobs.values()) job.stop();
  cronJobs.clear();
  for (const timer of oneShotTimers.values()) clearTimeout(timer);
  oneShotTimers.clear();
  clearAutomaticRetryTimers();

  const enabled = scheduleStore.getEnabledSchedules();
  let oneShotCount = 0;
  for (const schedule of enabled) {
    if (schedule.type === "cron" && schedule.cron) {
      try {
        registerSchedule(schedule.id);
      } catch (err) {
        console.error(`[scheduler] Failed to register schedule "${schedule.name}" (${schedule.id}):`, err);
      }
    } else if (schedule.type === "once" && schedule.runAt) {
      armOneShot(schedule.id, schedule.runAt);
      scheduleStore.updateNextRunAt(schedule.id, schedule.runAt);
      oneShotCount += 1;
    }
  }
  console.log(`[scheduler] Registered ${cronJobs.size} cron job(s) and ${oneShotCount} one-shot timer(s)`);
}

function clearMissedRunWatchdog(): void {
  if (!missedRunWatchdogTimer) return;
  clearInterval(missedRunWatchdogTimer);
  missedRunWatchdogTimer = undefined;
}

function startMissedRunWatchdog(): void {
  clearMissedRunWatchdog();
  missedRunWatchdogTimer = setInterval(() => {
    missedRunCatchUp.check();
  }, MISSED_RUN_WATCHDOG_INTERVAL_MS);
}

/**
 * Get date components in a specific timezone (or local if not provided).
 */
function getDatePartsInTz(date: Date, timezone?: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  if (!timezone) {
    return { minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(), month: date.getMonth() + 1, weekday: date.getDay() };
  }
  // Use en-US with numeric parts to get reliable integer extraction
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  // For weekday, construct a date string in the target TZ and get day-of-week
  const tzDateStr = date.toLocaleDateString("en-US", { timeZone: timezone });
  const weekday = new Date(tzDateStr).getDay();
  return { minute: get("minute"), hour: get("hour") % 24, day: get("day"), month: get("month"), weekday };
}

function floorToMinuteIso(date: Date): string {
  const slot = new Date(date);
  slot.setSeconds(0, 0);
  return slot.toISOString();
}

async function rollbackAcceptedScheduleRun(
  taskId: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  const sid = sessionId.slice(0, 8);
  const cleanupErrors: string[] = [];
  let unlinked = false;
  try {
    taskStore.unlinkSession(taskId, sessionId);
    unlinked = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/Task .* not found/.test(message)) {
      cleanupErrors.push(`unlink failed: ${message}`);
    }
  }

  try {
    if (sessionMgr?.isSessionBusy(sessionId)) {
      const aborted = await sessionMgr.abortSession(sessionId);
      if (!aborted && sessionMgr.isSessionBusy(sessionId)) {
        cleanupErrors.push("abort failed: session remained busy");
      }
    }
  } catch (err) {
    if (sessionMgr?.isSessionBusy(sessionId)) {
      cleanupErrors.push(`abort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    await sessionMgr?.deleteSession(sessionId);
  } catch (err) {
    cleanupErrors.push(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (cleanupErrors.length > 0 && unlinked) {
    try {
      taskStore.linkSession(taskId, sessionId);
    } catch (relinkErr) {
      cleanupErrors.push(`relink failed: ${relinkErr instanceof Error ? relinkErr.message : String(relinkErr)}`);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new Error(`[scheduler] Failed to roll back session ${sid} during ${reason}: ${cleanupErrors.join("; ")}`);
  }
}

function getAutomaticRunKey(source: Exclude<ScheduleTriggerSource, "manual">, scheduledFor?: string): string {
  const candidate = scheduledFor ?? floorToMinuteIso(new Date());
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`[scheduler] Invalid scheduled slot for ${source}: ${candidate}`);
  }
  return parsed.toISOString();
}

/**
 * Compute the next run time for a cron expression, respecting timezone.
 * Uses a simple approach: check each minute for the next 35 days.
 * This covers monthly schedules while keeping invalid expressions bounded.
 */
export function computeNextRunAt(cronExpr: string, timezone?: string, after?: Date): string | undefined {
  try {
    const now = after ?? new Date();
    const check = new Date(now.getTime() + 60_000); // start checking from next minute
    check.setSeconds(0, 0);

    const maxChecks = NEXT_RUN_LOOKAHEAD_MINUTES;
    for (let i = 0; i < maxChecks; i++) {
      const testDate = new Date(check.getTime() + i * 60_000);
      if (matchesCron(cronExpr, testDate, timezone)) {
        return testDate.toISOString();
      }
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

/**
 * Simple cron matcher for 5-field cron expressions.
 * Respects timezone when extracting date components.
 */
export function matchesCron(cronExpr: string, date: Date, timezone?: string): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length < 5) return false;

  const { minute, hour, day, month, weekday } = getDatePartsInTz(date, timezone);
  const checks = [
    { value: minute, field: fields[0] },
    { value: hour, field: fields[1] },
    { value: day, field: fields[2] },
    { value: month, field: fields[3] },
    { value: weekday, field: fields[4] },
  ];

  return checks.every(({ value, field }) => matchesField(value, field));
}

export function matchesField(value: number, field: string): boolean {
  if (field === "*") return true;

  // Handle step values: */N or N-M/S
  if (field.includes("/")) {
    const [range, stepStr] = field.split("/");
    const step = parseInt(stepStr, 10);
    if (range === "*") return value % step === 0;
    // Range with step
    const [start, end] = range.split("-").map(Number);
    return value >= start && value <= end && (value - start) % step === 0;
  }

  // Handle ranges: N-M
  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number);
    return value >= start && value <= end;
  }

  // Handle lists: N,M,O
  if (field.includes(",")) {
    return field.split(",").map(Number).includes(value);
  }

  // Simple number
  return value === parseInt(field, 10);
}
