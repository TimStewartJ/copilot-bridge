// Scheduler — in-process cron scheduler for scheduled sessions
// Registers node-cron jobs, handles triggering, missed-run catch-up

import cron, { type ScheduledTask } from "node-cron";
import type { ScheduleStore } from "./schedule-store.js";
import type { TaskStore } from "./task-store.js";
import type { SessionMetaStore } from "./session-meta-store.js";
import type { GlobalBus } from "./global-bus.js";
import type { SessionManager } from "./session-manager.js";
import { isRestartPending, isRestartPendingError, RESTART_PENDING_MESSAGE } from "./session-manager.js";

// ── State ─────────────────────────────────────────────────────────

const cronJobs = new Map<string, ScheduledTask>();
let sessionMgr: SessionManager | null = null;

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
  registerAllSchedules();
  checkMissedRuns();
  console.log("[scheduler] Initialized");
}

export function shutdown(): void {
  for (const [id, job] of cronJobs) {
    job.stop();
    cronJobs.delete(id);
  }
  console.log("[scheduler] Shut down — all jobs stopped");
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
    triggerSchedule(scheduleId).catch((err) => {
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
}

/**
 * Manually trigger a schedule immediately (for "Run Now" or catch-up).
 */
export async function triggerSchedule(scheduleId: string): Promise<{ sessionId: string } | { skipped: string }> {
  if (!sessionMgr) throw new Error("Scheduler not initialized");

  const schedule = scheduleStore.getSchedule(scheduleId);
  if (!schedule) throw new Error(`Schedule ${scheduleId} not found`);

  // Check global pause
  if (_globalPause) return { skipped: "Scheduling is globally paused" };

  if (isRestartPending()) {
    return { skipped: RESTART_PENDING_MESSAGE };
  }

  // Check if schedule is enabled (manual trigger bypasses this)
  // We allow manual triggers even when disabled

  // Skip if this schedule is already running
  if (activeRuns.has(scheduleId)) {
    console.log(`[scheduler] Skipping "${schedule.name}" — previous run still active`);
    return { skipped: "Previous run still active" };
  }

  // Check rate limiting (not for manual triggers via API)
  if (schedule.lastRunAt) {
    const elapsed = Date.now() - new Date(schedule.lastRunAt).getTime();
    if (elapsed < MIN_INTERVAL_MS) {
      console.log(`[scheduler] Skipping "${schedule.name}" — too soon (${Math.round(elapsed / 1000)}s since last run)`);
      return { skipped: `Too soon — ${Math.round((MIN_INTERVAL_MS - elapsed) / 1000)}s until next allowed run` };
    }
  }

  // Check max concurrent
  if (activeRuns.size >= MAX_CONCURRENT) {
    console.log(`[scheduler] Skipping "${schedule.name}" — max concurrent (${MAX_CONCURRENT}) reached`);
    return { skipped: "Max concurrent scheduled sessions reached" };
  }

  // Check expiration
  if (schedule.expiresAt && new Date() >= new Date(schedule.expiresAt)) {
    scheduleStore.updateSchedule(scheduleId, { enabled: false });
    unregisterSchedule(scheduleId);
    return { skipped: "Schedule expired" };
  }

  // Check maxRuns
  if (schedule.maxRuns && schedule.runCount >= schedule.maxRuns) {
    scheduleStore.updateSchedule(scheduleId, { enabled: false });
    unregisterSchedule(scheduleId);
    return { skipped: "Max runs reached" };
  }

  const task = taskStore.getTask(schedule.taskId);
  if (!task) {
    console.error(`[scheduler] Task ${schedule.taskId} not found for schedule "${schedule.name}"`);
    return { skipped: "Parent task not found" };
  }

  console.log(`[scheduler] ⏰ Triggering "${schedule.name}" for task "${task.title}"`);
  activeRuns.add(scheduleId);

  try {
    // Determine session: reuse or create new
    let sessionId: string;
    let createdSession = false;

    if (schedule.reuseSession && schedule.lastSessionId) {
      // Reuse existing session — check if it's busy
      if (sessionMgr.isSessionBusy(schedule.lastSessionId)) {
        return { skipped: "Reuse session is busy" };
      }
      sessionId = schedule.lastSessionId;
      console.log(`[scheduler] Reusing session ${sessionId.slice(0, 8)} for "${schedule.name}"`);
    } else {
      // Create new task session
      const prDescriptions = task.pullRequests.map(
        (pr) => `${pr.repoName || pr.repoId} PR #${pr.prId}`,
      );
      const result = await sessionMgr.createTaskSession(
        task.id,
        task.title,
        task.workItems,
        prDescriptions,
        task.notes,
        task.cwd,
        { name: schedule.name, type: schedule.type, runCount: schedule.runCount, lastRunAt: schedule.lastRunAt },
      );
      sessionId = result.sessionId;
      createdSession = true;

      // Link session to task
      taskStore.linkSession(task.id, sessionId);

      // Mark session metadata as schedule-triggered
      sessionMetaStore.setScheduleMeta(sessionId, scheduleId, schedule.name);

      console.log(`[scheduler] Created session ${sessionId.slice(0, 8)} for "${schedule.name}"`);
    }

    // Fire the prompt
    try {
      sessionMgr.startWork(sessionId, schedule.prompt);
    } catch (err) {
      if (isRestartPendingError(err)) {
        if (createdSession) {
          try { taskStore.unlinkSession(task.id, sessionId); } catch {}
          try { sessionMetaStore.deleteMeta(sessionId); } catch {}
          try { await sessionMgr.deleteSession(sessionId); } catch (cleanupErr) {
            console.warn(`[scheduler] Failed to roll back session ${sessionId.slice(0, 8)} after restart gate:`, cleanupErr);
          }
        }
        return { skipped: RESTART_PENDING_MESSAGE };
      }
      throw err;
    }

    // Record the run
    const nextRunAt = schedule.type === "cron" && schedule.cron
      ? computeNextRunAt(schedule.cron, schedule.timezone)
      : undefined;
    scheduleStore.recordRun(scheduleId, sessionId, nextRunAt);

    // Emit global event
    bus.emit({
      type: "schedule:triggered",
      scheduleId,
      scheduleName: schedule.name,
      sessionId,
    } as any);

    // Notify UI that schedule metadata changed (runCount, lastRunAt, nextRunAt)
    bus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId });

    console.log(`[scheduler] ✅ "${schedule.name}" triggered — session ${sessionId.slice(0, 8)}`);
    return { sessionId };
  } catch (err) {
    console.error(`[scheduler] ❌ Failed to trigger "${schedule.name}":`, err);
    throw err;
  } finally {
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

  const enabled = scheduleStore.getEnabledSchedules();
  for (const schedule of enabled) {
    if (schedule.type === "cron" && schedule.cron) {
      registerSchedule(schedule.id);
    }
  }
  console.log(`[scheduler] Registered ${cronJobs.size} cron job(s)`);
}

function checkMissedRuns(): void {
  const enabled = scheduleStore.getEnabledSchedules();
  const now = Date.now();

  for (const schedule of enabled) {
    if (schedule.type !== "cron" || !schedule.cron) continue;
    if (!schedule.lastRunAt) continue; // never ran — don't catch up on first boot

    const lastRun = new Date(schedule.lastRunAt).getTime();
    const nextExpected = computeNextRunAt(schedule.cron, schedule.timezone, new Date(schedule.lastRunAt));
    if (!nextExpected) continue;

    const nextExpectedTime = new Date(nextExpected).getTime();

    // If the next expected run was in the past and within grace window, trigger catch-up
    if (nextExpectedTime < now && (now - nextExpectedTime) < MISSED_RUN_GRACE_WINDOW_MS) {
      console.log(`[scheduler] Missed run detected for "${schedule.name}" — catching up`);
      triggerSchedule(schedule.id).catch((err) => {
        console.error(`[scheduler] Catch-up trigger failed for "${schedule.name}":`, err);
      });
    }
  }
}

/**
 * Compute the next run time for a cron expression.
 * Uses a simple approach: check each minute for the next 48 hours.
 */
function computeNextRunAt(cronExpr: string, timezone?: string, after?: Date): string | undefined {
  try {
    // node-cron doesn't expose a "next run" API, so we parse manually
    // For display purposes, a rough calculation is fine
    const now = after ?? new Date();
    const check = new Date(now.getTime() + 60_000); // start checking from next minute
    check.setSeconds(0, 0);

    // Check each minute for the next 48 hours
    const maxChecks = 48 * 60;
    for (let i = 0; i < maxChecks; i++) {
      const testDate = new Date(check.getTime() + i * 60_000);
      if (matchesCron(cronExpr, testDate)) {
        return testDate.toISOString();
      }
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

/**
 * Simple cron matcher for 5-field cron expressions.
 * Fields: minute hour day-of-month month day-of-week
 */
function matchesCron(cronExpr: string, date: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length < 5) return false;

  const checks = [
    { value: date.getMinutes(), field: fields[0] },
    { value: date.getHours(), field: fields[1] },
    { value: date.getDate(), field: fields[2] },
    { value: date.getMonth() + 1, field: fields[3] },
    { value: date.getDay(), field: fields[4] },
  ];

  return checks.every(({ value, field }) => matchesField(value, field));
}

function matchesField(value: number, field: string): boolean {
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
