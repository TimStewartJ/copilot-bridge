// Scheduler — in-process cron scheduler for scheduled sessions
// Registers node-cron jobs, handles triggering, missed-run catch-up

import cron, { type ScheduledTask } from "node-cron";
import type { AutomaticRunClaim, ScheduleStore, ScheduleTriggerSource, SessionReuseClaim } from "./schedule-store.js";
import type { TaskStore } from "./task-store.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import {
  isRestartPending,
  isRestartPendingError,
  RESTART_PENDING_MESSAGE,
  refreshRestartState,
} from "./session-manager.js";

// ── State ─────────────────────────────────────────────────────────

const cronJobs = new Map<string, ScheduledTask>();
const oneShotTimers = new Map<string, ReturnType<typeof setTimeout>>();
const automaticRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retainedScheduleRunClaims = new Map<
  string,
  { scheduleId: string; scheduleName: string; claim: AutomaticRunClaim; renewTimer: ReturnType<typeof setInterval> }
>();
const retainedSessionReuseClaims = new Map<
  string,
  { scheduleId: string; scheduleName: string; claim: SessionReuseClaim; renewTimer: ReturnType<typeof setInterval> }
>();
let sessionMgr: SessionManager | null = null;
let busUnsubscribe: (() => void) | undefined;
let missedRunCatchUpInFlight: Promise<void> | undefined;
let missedRunCatchUpRequested = false;
let missedRunCatchUpRetryTimer: ReturnType<typeof setTimeout> | undefined;
const deferredMissedRunCandidates = new Map<string, MissedRunCandidate>();

// Injected stores (set via initialize)
let scheduleStore: ScheduleStore;
let taskStore: TaskStore;
let sessionMetaStore: SessionMetaStore;
let bus: GlobalBus;

// Safety: track in-flight schedule runs to prevent overlap
const activeRuns = new Set<string>();

// Global pause (runtime-only; settings-store could persist this later)
let _globalPause = false;

const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes minimum between runs
const MAX_CONCURRENT = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
const MISSED_RUN_GRACE_WINDOW_MS = 60 * 60 * 1000; // 1 hour grace for catch-up
const AUTOMATIC_CLAIM_RENEW_INTERVAL_MS = 30 * 1000;
const ONE_SHOT_RETRY_DELAY_MS = 30 * 1000;
const MISSED_RUN_CATCH_UP_RETRY_DELAY_MS = 5 * 1000;

// ── Public API ────────────────────────────────────────────────────

export interface SchedulerDeps {
  scheduleStore: ScheduleStore;
  taskStore: TaskStore;
  sessionMetaStore: SessionMetaStore;
  globalBus: GlobalBus;
}

export function initialize(manager: SessionManager, deps: SchedulerDeps): void {
  sessionMgr = manager;
  scheduleStore = deps.scheduleStore;
  taskStore = deps.taskStore;
  sessionMetaStore = deps.sessionMetaStore;
  bus = deps.globalBus;
  busUnsubscribe?.();
  busUnsubscribe = bus.subscribe((event) => {
    if (event.type === "session:idle" && event.sessionId) {
      releaseRetainedScheduleRunClaim(event.sessionId);
      releaseRetainedSessionReuseClaim(event.sessionId);
      return;
    }
    if (event.type === "server:restart-cleared") {
      checkMissedRuns();
    }
  });
  registerAllSchedules();
  checkMissedRuns();
  console.log("[scheduler] Initialized");
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
  clearMissedRunCatchUpRetryTimer();
  busUnsubscribe?.();
  busUnsubscribe = undefined;
  for (const { renewTimer } of retainedScheduleRunClaims.values()) {
    clearInterval(renewTimer);
  }
  retainedScheduleRunClaims.clear();
  for (const { renewTimer } of retainedSessionReuseClaims.values()) {
    clearInterval(renewTimer);
  }
  retainedSessionReuseClaims.clear();
  activeRuns.clear();
  _globalPause = false;
  missedRunCatchUpInFlight = undefined;
  missedRunCatchUpRequested = false;
  deferredMissedRunCandidates.clear();
  console.log("[scheduler] Shut down — all jobs stopped");
}

interface MissedRunCandidate {
  id: string;
  name: string;
  source: "once" | "catchup";
  scheduledFor: string;
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

function retainScheduleRunClaim(
  scheduleId: string,
  sessionId: string,
  claim: AutomaticRunClaim,
  scheduleName: string,
): void {
  const existing = retainedScheduleRunClaims.get(sessionId);
  if (existing) clearInterval(existing.renewTimer);
  const renewTimer = setInterval(() => {
    const retained = retainedScheduleRunClaims.get(sessionId);
    if (!retained || retained.claim !== claim) {
      clearInterval(renewTimer);
      return;
    }
    try {
      const renewed = scheduleStore.renewClaimedAutomaticRun(scheduleId, claim);
      if (!renewed) {
        clearInterval(renewTimer);
        retainedScheduleRunClaims.delete(sessionId);
      }
    } catch (err) {
      console.warn(`[scheduler] Failed to renew retained schedule lock for "${scheduleName}":`, err);
      clearInterval(renewTimer);
      retainedScheduleRunClaims.delete(sessionId);
    }
  }, AUTOMATIC_CLAIM_RENEW_INTERVAL_MS);
  retainedScheduleRunClaims.set(sessionId, { scheduleId, scheduleName, claim, renewTimer });
}

function releaseRetainedScheduleRunClaim(sessionId: string): void {
  const retained = retainedScheduleRunClaims.get(sessionId);
  if (!retained) return;
  clearInterval(retained.renewTimer);
  retainedScheduleRunClaims.delete(sessionId);
  try {
    scheduleStore.releaseClaimedAutomaticRun(retained.scheduleId, retained.claim);
  } catch (err) {
    console.warn(`[scheduler] Failed to release retained schedule run claim for session ${sessionId.slice(0, 8)}:`, err);
  }
}

function retainSessionReuseClaim(
  scheduleId: string,
  sessionId: string,
  claim: SessionReuseClaim,
  scheduleName: string,
): void {
  const existing = retainedSessionReuseClaims.get(sessionId);
  if (existing) clearInterval(existing.renewTimer);
  const renewTimer = setInterval(() => {
    const retained = retainedSessionReuseClaims.get(sessionId);
    if (!retained || retained.claim !== claim) {
      clearInterval(renewTimer);
      return;
    }
    try {
      const renewed = scheduleStore.renewClaimedSessionReuse(sessionId, claim);
      if (!renewed) {
        clearInterval(renewTimer);
        retainedSessionReuseClaims.delete(sessionId);
      }
    } catch (err) {
      console.warn(`[scheduler] Failed to renew retained session reuse lock for "${scheduleName}":`, err);
      clearInterval(renewTimer);
      retainedSessionReuseClaims.delete(sessionId);
    }
  }, AUTOMATIC_CLAIM_RENEW_INTERVAL_MS);
  retainedSessionReuseClaims.set(sessionId, { scheduleId, scheduleName, claim, renewTimer });
}

function releaseRetainedSessionReuseClaim(sessionId: string): void {
  const retained = retainedSessionReuseClaims.get(sessionId);
  if (!retained) return;
  clearInterval(retained.renewTimer);
  retainedSessionReuseClaims.delete(sessionId);
  try {
    scheduleStore.releaseClaimedSessionReuse(sessionId, retained.claim);
  } catch (err) {
    console.warn(`[scheduler] Failed to release retained session reuse lock for session ${sessionId.slice(0, 8)}:`, err);
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

  if (isRestartPending()) {
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
  let retainScheduleRunLock = false;
  let scheduleRunClaimRenewTimer: ReturnType<typeof setInterval> | undefined;
  let sessionReuseClaim: SessionReuseClaim | undefined;
  let sessionReuseClaimResolved = false;
  let retainSessionReuseLock = false;
  let sessionReuseClaimRenewTimer: ReturnType<typeof setInterval> | undefined;
  let automaticSlotClaim: AutomaticRunClaim | undefined;
  let automaticSlotClaimResolved = false;
  let retryReleasedClaim = false;
  const retryAutomaticIfNeeded = (runKey: string, retryAutomatic: boolean) => {
    if (retryAutomatic && triggerSource !== "manual") {
      armAutomaticRetry(scheduleId, triggerSource, runKey);
    }
  };
  const releaseScheduleRunClaim = () => {
    if (!scheduleRunClaim || scheduleRunClaimResolved || retainScheduleRunLock) return;
    scheduleStore.releaseClaimedAutomaticRun(scheduleId, scheduleRunClaim);
    scheduleRunClaimResolved = true;
  };
  const releaseSessionReuseClaim = () => {
    if (!sessionReuseClaim || sessionReuseClaimResolved || retainSessionReuseLock) return;
    scheduleStore.releaseClaimedSessionReuse(sessionReuseClaim.sessionId, sessionReuseClaim);
    sessionReuseClaimResolved = true;
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
    const stopSessionReuseClaimRenewal = () => {
      if (sessionReuseClaimRenewTimer) {
        clearInterval(sessionReuseClaimRenewTimer);
        sessionReuseClaimRenewTimer = undefined;
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

    const skipClaimedRun = (
      reason: string,
      options: { retryAutomatic?: boolean; finalizeOneShot?: boolean } = {},
    ) => {
      if (
        options.finalizeOneShot
        && automaticSlotClaim
        && !automaticSlotClaimResolved
        && schedule.type === "once"
        && triggerSource === "once"
      ) {
        scheduleStore.skipAutomaticRun(scheduleId, automaticSlotClaim);
        automaticSlotClaimResolved = true;
        bus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId });
      } else {
        releaseAutomaticSlotClaim(options);
      }
      releaseSessionReuseClaim();
      releaseScheduleRunClaim();
      return { skipped: reason };
    };

    // Determine session: reuse-last or create new
    let sessionId: string;
    let createdSession = false;

    const reusableLastSessionId = schedule.sessionMode === "reuse-last"
      && schedule.lastSessionId
      && task.sessionIds.includes(schedule.lastSessionId)
      ? schedule.lastSessionId
      : undefined;

    if (reusableLastSessionId) {
      sessionId = reusableLastSessionId;
      const reuseClaim = scheduleStore.claimSessionReuse(sessionId, scheduleId);
      if (!reuseClaim.acquired) {
        return skipClaimedRun("Reuse session is busy", { retryAutomatic: true });
      }
      sessionReuseClaim = reuseClaim.claim;
      sessionReuseClaimRenewTimer = setInterval(() => {
        if (!sessionReuseClaim || sessionReuseClaimResolved) {
          stopSessionReuseClaimRenewal();
          return;
        }
        try {
          const renewed = scheduleStore.renewClaimedSessionReuse(sessionId, sessionReuseClaim);
          if (!renewed) stopSessionReuseClaimRenewal();
        } catch (err) {
          console.warn(`[scheduler] Failed to renew reused-session lock for "${schedule.name}":`, err);
          stopSessionReuseClaimRenewal();
        }
      }, AUTOMATIC_CLAIM_RENEW_INTERVAL_MS);
      if (sessionMgr.isSessionBusy(sessionId)) {
        return skipClaimedRun("Reuse session is busy", { retryAutomatic: true });
      }
      console.log(`[scheduler] Reusing session ${sessionId.slice(0, 8)} for "${schedule.name}"`);
    } else if (schedule.sessionMode === "reuse-last" && scheduleStore.requiresExistingReuseSession(schedule.id)) {
      return skipClaimedRun("Reuse session is unavailable", { finalizeOneShot: true });
    } else {
      // Create new task session
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
      releaseSessionReuseClaim();
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
        if (createdSession) {
          releaseScheduleRunClaim();
          await rollbackAcceptedScheduleRun(task.id, sessionId, `lost claim for slot ${automaticSlotClaim.runKey}`);
          return { skipped: "This scheduled slot is already being processed" };
        }
        retainScheduleRunLock = true;
        if (scheduleRunClaim) {
          stopScheduleRunClaimRenewal();
          retainScheduleRunClaim(scheduleId, sessionId, scheduleRunClaim, schedule.name);
          scheduleRunClaimResolved = true;
        }
        retainSessionReuseLock = true;
        if (sessionReuseClaim) {
          stopSessionReuseClaimRenewal();
          retainSessionReuseClaim(scheduleId, sessionId, sessionReuseClaim, schedule.name);
          sessionReuseClaimResolved = true;
        }
        throw new Error(
          `[scheduler] Lost automatic claim for reused session ${sessionId.slice(0, 8)} on slot ${automaticSlotClaim.runKey}; cannot safely roll back shared session state`,
        );
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
    if (createdSession) {
      releaseScheduleRunClaim();
    } else {
      retainScheduleRunLock = true;
      if (scheduleRunClaim) {
        stopScheduleRunClaimRenewal();
        retainScheduleRunClaim(scheduleId, sessionId, scheduleRunClaim, schedule.name);
        scheduleRunClaimResolved = true;
      }
      retainSessionReuseLock = true;
      if (sessionReuseClaim) {
        stopSessionReuseClaimRenewal();
        retainSessionReuseClaim(scheduleId, sessionId, sessionReuseClaim, schedule.name);
        sessionReuseClaimResolved = true;
      }
    }

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
    if (sessionReuseClaim && !sessionReuseClaimResolved) {
      try {
        releaseSessionReuseClaim();
      } catch (releaseErr) {
        console.warn(`[scheduler] Failed to release reused-session lock for "${schedule.name}":`, releaseErr);
      }
    }
    console.error(`[scheduler] ❌ Failed to trigger "${schedule.name}":`, err);
    throw err;
  } finally {
    if (scheduleRunClaimRenewTimer) {
      clearInterval(scheduleRunClaimRenewTimer);
    }
    if (sessionReuseClaimRenewTimer) {
      clearInterval(sessionReuseClaimRenewTimer);
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

function checkMissedRuns(): void {
  clearMissedRunCatchUpRetryTimer();
  if (missedRunCatchUpInFlight) {
    missedRunCatchUpRequested = true;
    return;
  }
  if (isRestartPending()) {
    rememberDeferredMissedRunCandidates(collectMissedRunCandidates({
      now: Date.now(),
      disableStaleOneShots: false,
    }));
    scheduleMissedRunCatchUpRetry();
  }
  missedRunCatchUpInFlight = catchUpMissedRuns()
    .catch((err) => {
      console.error("[scheduler] Failed missed-run catch-up:", err);
    })
    .finally(() => {
      missedRunCatchUpInFlight = undefined;
      if (missedRunCatchUpRequested) {
        missedRunCatchUpRequested = false;
        checkMissedRuns();
      }
    });
}

function clearMissedRunCatchUpRetryTimer(): void {
  if (!missedRunCatchUpRetryTimer) return;
  clearTimeout(missedRunCatchUpRetryTimer);
  missedRunCatchUpRetryTimer = undefined;
}

function scheduleMissedRunCatchUpRetry(): void {
  if (missedRunCatchUpRetryTimer) return;
  missedRunCatchUpRetryTimer = setTimeout(() => {
    missedRunCatchUpRetryTimer = undefined;
    checkMissedRuns();
  }, MISSED_RUN_CATCH_UP_RETRY_DELAY_MS);
}

function getMissedRunCandidateKey(candidate: MissedRunCandidate): string {
  return `${candidate.id}:${candidate.source}:${candidate.scheduledFor}`;
}

function rememberDeferredMissedRunCandidates(candidates: Iterable<MissedRunCandidate>): void {
  for (const candidate of candidates) {
    deferredMissedRunCandidates.set(getMissedRunCandidateKey(candidate), candidate);
  }
}

function isEligibleMissedRunTime(
  scheduledTime: number,
  now: number,
  restartRequestedAt?: string | null,
): boolean {
  if (scheduledTime >= now) return false;
  if ((now - scheduledTime) < MISSED_RUN_GRACE_WINDOW_MS) return true;

  if (!restartRequestedAt) return false;
  const restartRequestedTime = Date.parse(restartRequestedAt);
  if (Number.isNaN(restartRequestedTime)) return false;
  return scheduledTime >= (restartRequestedTime - MISSED_RUN_GRACE_WINDOW_MS);
}

function revalidateDeferredMissedRunCandidate(candidate: MissedRunCandidate, now: number): MissedRunCandidate | undefined {
  const schedule = scheduleStore.getSchedule(candidate.id);
  if (!schedule || !schedule.enabled) return undefined;

  if (candidate.source === "once") {
    if (schedule.type !== "once" || !schedule.runAt) return undefined;
    const scheduledFor = new Date(schedule.runAt).toISOString();
    if (scheduledFor !== candidate.scheduledFor) return undefined;
    if (Date.parse(scheduledFor) >= now) return undefined;
    return { id: schedule.id, name: schedule.name, source: "once", scheduledFor };
  }

  if (schedule.type !== "cron" || !schedule.cron || !schedule.lastRunAt) return undefined;
  const nextExpected = computeNextRunAt(schedule.cron, schedule.timezone, new Date(schedule.lastRunAt));
  if (!nextExpected || nextExpected !== candidate.scheduledFor) return undefined;
  if (Date.parse(nextExpected) >= now) return undefined;
  return { id: schedule.id, name: schedule.name, source: "catchup", scheduledFor: nextExpected };
}

function collectMissedRunCandidates(options: {
  now: number;
  disableStaleOneShots: boolean;
  preservedCandidateKeys?: ReadonlySet<string>;
  restartRequestedAt?: string | null;
}): MissedRunCandidate[] {
  const enabled = scheduleStore.getEnabledSchedules();
  const missedRuns: MissedRunCandidate[] = [];

  for (const schedule of enabled) {
    if (schedule.type === "once") {
      if (!schedule.runAt) continue;
      const candidate: MissedRunCandidate = {
        id: schedule.id,
        name: schedule.name,
        source: "once",
        scheduledFor: new Date(schedule.runAt).toISOString(),
      };
      const candidateKey = getMissedRunCandidateKey(candidate);
      const runAtTime = new Date(schedule.runAt).getTime();
      if (runAtTime >= options.now) continue;
      if (isEligibleMissedRunTime(runAtTime, options.now, options.restartRequestedAt)) {
        missedRuns.push(candidate);
      } else if (options.disableStaleOneShots && !options.preservedCandidateKeys?.has(candidateKey)) {
        console.log(`[scheduler] One-shot "${schedule.name}" is stale — disabling without replay`);
        scheduleStore.updateSchedule(schedule.id, { enabled: false });
        unregisterSchedule(schedule.id);
      }
      continue;
    }

    if (!schedule.cron || !schedule.lastRunAt) continue; // never ran — don't catch up on first boot
    const nextExpected = computeNextRunAt(schedule.cron, schedule.timezone, new Date(schedule.lastRunAt));
    if (!nextExpected) continue;

    const nextExpectedTime = new Date(nextExpected).getTime();
    if (isEligibleMissedRunTime(nextExpectedTime, options.now, options.restartRequestedAt)) {
      missedRuns.push({ id: schedule.id, name: schedule.name, source: "catchup", scheduledFor: nextExpected });
    }
  }

  return missedRuns;
}

async function catchUpMissedRuns(): Promise<void> {
  const restartState = await refreshRestartState();
  const restartPending = restartState.phase !== "idle";
  const preservedCandidateKeys = new Set(deferredMissedRunCandidates.keys());
  const currentMissedRuns = collectMissedRunCandidates({
    now: Date.now(),
    disableStaleOneShots: !restartPending,
    preservedCandidateKeys,
    restartRequestedAt: restartState.requestedAt,
  });
  if (restartPending) {
    rememberDeferredMissedRunCandidates(currentMissedRuns);
    scheduleMissedRunCatchUpRetry();
    console.log("[scheduler] Skipping missed-run catch-up while restart is pending");
    return;
  }
  clearMissedRunCatchUpRetryTimer();

  const missedRuns = new Map<string, MissedRunCandidate>();
  for (const deferredCandidate of deferredMissedRunCandidates.values()) {
    const revalidatedCandidate = revalidateDeferredMissedRunCandidate(deferredCandidate, Date.now());
    if (revalidatedCandidate) {
      missedRuns.set(getMissedRunCandidateKey(revalidatedCandidate), revalidatedCandidate);
    }
  }
  for (const schedule of currentMissedRuns) {
    missedRuns.set(getMissedRunCandidateKey(schedule), schedule);
  }
  deferredMissedRunCandidates.clear();

  for (const schedule of missedRuns.values()) {
    const currentSchedule = scheduleStore.getSchedule(schedule.id);
    if (!currentSchedule || !currentSchedule.enabled) continue;
    console.log(`[scheduler] Missed run detected for "${schedule.name}" — catching up`);
    try {
      const result = await triggerSchedule(schedule.id, { source: schedule.source, scheduledFor: schedule.scheduledFor });
      if ("skipped" in result && result.skipped === RESTART_PENDING_MESSAGE) {
        deferredMissedRunCandidates.set(getMissedRunCandidateKey(schedule), schedule);
      }
    } catch (err) {
      console.error(`[scheduler] Catch-up trigger failed for "${schedule.name}":`, err);
    }
  }
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
 * Uses a simple approach: check each minute for the next 48 hours.
 */
export function computeNextRunAt(cronExpr: string, timezone?: string, after?: Date): string | undefined {
  try {
    const now = after ?? new Date();
    const check = new Date(now.getTime() + 60_000); // start checking from next minute
    check.setSeconds(0, 0);

    const maxChecks = 48 * 60;
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
