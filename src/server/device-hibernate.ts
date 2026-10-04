// Delayed device hibernation scheduler and idle watcher.
//
// Holds a single in-memory pending hibernation timer so the API can schedule,
// inspect, and cancel a future hibernation. A generation token guards against a
// stale timer callback clearing newer pending state. Clients reflect the real
// server state by re-fetching status.
//
// The idle watcher is the "hibernate on idle" mode: while armed it samples the
// active session count on a poll interval and hibernates once every session has
// stayed idle for the whole grace window. It disarms itself before it hibernates,
// so waking the device does not hibernate again in a loop.
//
// Both live in memory only. A server that shuts down hands them to its
// replacement through device-hibernate-handoff.ts; a deploy restart would
// otherwise drop a hibernation the user asked for.

import { requestDeviceHibernate, type DeviceHibernateCommand } from "./platform.js";
import { safeSetTimeout, type LongTimeout } from "./long-timeout.js";
import { isRestartPending } from "./restart-state.js";

export type HibernateScheduleStatus = {
  pending: boolean;
  scheduledAt: number | null;
  delayMs: number | null;
};

export type HibernateOnIdleStatus = {
  armed: boolean;
  armedAt: number | null;
  graceMs: number | null;
  /** Active sessions observed at the last sample. 0 means everything is idle. */
  activeSessions: number;
  /** When the current uninterrupted idle window started, or null while busy. */
  idleSince: number | null;
  /** Projected hibernation time while idle, or null while sessions are active. */
  hibernateAt: number | null;
  /**
   * Why hibernation is held off for a reason other than session activity
   * (a deploy/update job or a restart cutover), or null when nothing blocks it.
   */
  blockedReason: string | null;
};

/** A hibernation that is still to come, as one server passes it to the next. */
export type HibernateIntent = {
  /** Grace window of the armed idle watcher, or null when it is not armed. */
  onIdleGraceMs: number | null;
  /** When the timed hibernation is due, or null when none is scheduled. */
  scheduledAt: number | null;
};

/** What the idle watcher reads from the running server. An `AppContext` satisfies it. */
export type HibernateIdleSources = {
  sessionManager: { getLifecycleBlockingSessionCount(): number };
  managementJobStore?: { listActive(): Array<{ type: string; status: string }> };
  runtimePaths?: { dataDir: string };
};

type PendingHibernate = {
  token: number;
  timer: LongTimeout;
  scheduledAt: number;
  delayMs: number;
  /** Set once the next server owns this hibernation; this process must no longer fire it. */
  handedOff: boolean;
};

type IdleWatch = {
  token: number;
  command: DeviceHibernateCommand;
  graceMs: number;
  getActiveSessionCount: () => number;
  getBlockingReason: (() => string | null) | undefined;
  interval: ReturnType<typeof setInterval>;
  armedAt: number;
  idleSince: number | null;
  activeSessions: number;
  blockedReason: string | null;
  /** Set once the next server owns this watcher; this process must no longer fire it. */
  handedOff: boolean;
};

/** How often the armed idle watcher re-samples the active session count. */
export const HIBERNATE_IDLE_POLL_INTERVAL_MS = 5_000;

let pending: PendingHibernate | null = null;
let idleWatch: IdleWatch | null = null;
let tokenCounter = 0;

export function getHibernateStatus(): HibernateScheduleStatus {
  if (!pending) return { pending: false, scheduledAt: null, delayMs: null };
  return { pending: true, scheduledAt: pending.scheduledAt, delayMs: pending.delayMs };
}

export function scheduleHibernate(
  command: DeviceHibernateCommand,
  delayMs: number,
): HibernateScheduleStatus {
  cancelHibernate();
  const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0;
  const token = ++tokenCounter;
  const scheduledAt = Date.now() + safeDelayMs;
  const timer = safeSetTimeout(() => {
    if (!pending || pending.token !== token || pending.handedOff) return;
    pending = null;
    // The device is going down now; leaving the watcher armed would hibernate
    // again shortly after the next wake.
    disarmHibernateOnIdle();
    void requestDeviceHibernate(command).catch((error) => {
      console.error("[device] Hibernate request failed:", error);
    });
  }, safeDelayMs);
  timer.unref();
  pending = { token, timer, scheduledAt, delayMs: safeDelayMs, handedOff: false };
  return getHibernateStatus();
}

export function cancelHibernate(): boolean {
  if (!pending) return false;
  pending.timer.cancel();
  pending = null;
  return true;
}

export function getHibernateOnIdleStatus(): HibernateOnIdleStatus {
  if (!idleWatch) {
    return {
      armed: false,
      armedAt: null,
      graceMs: null,
      activeSessions: 0,
      idleSince: null,
      hibernateAt: null,
      blockedReason: null,
    };
  }
  return {
    armed: true,
    armedAt: idleWatch.armedAt,
    graceMs: idleWatch.graceMs,
    activeSessions: idleWatch.activeSessions,
    idleSince: idleWatch.idleSince,
    hibernateAt: idleWatch.idleSince === null ? null : idleWatch.idleSince + idleWatch.graceMs,
    blockedReason: idleWatch.blockedReason,
  };
}

function readBlockingReason(watch: IdleWatch): string | null {
  if (!watch.getBlockingReason) return null;
  try {
    return watch.getBlockingReason();
  } catch (error) {
    console.error("[device] Hibernate-on-idle blocker check failed:", error);
    // An unknown lifecycle state must never be treated as safe to suspend.
    return "lifecycle state could not be read";
  }
}

function readActiveSessionCount(watch: IdleWatch): number {
  try {
    const count = watch.getActiveSessionCount();
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 1;
  } catch (error) {
    console.error("[device] Hibernate-on-idle activity check failed:", error);
    // Unknown activity must never be treated as idle.
    return 1;
  }
}

/**
 * Refresh the watcher's view of session activity. Returns true when the idle
 * window has been held for the full grace period and hibernation should fire.
 *
 * Deploy/restart work blocks the same way active sessions do — and resets the
 * grace window — because a self_update or staging_deploy cutover runs for
 * minutes with zero active sessions. Suspending the host there makes the
 * launcher's wall-clock health-check window look like a timeout and can roll
 * back a good release.
 */
function sampleIdleWatch(watch: IdleWatch): boolean {
  const blockedReason = readBlockingReason(watch);
  watch.blockedReason = blockedReason;
  const activeSessions = readActiveSessionCount(watch);
  watch.activeSessions = activeSessions;
  if (activeSessions > 0 || blockedReason !== null) {
    watch.idleSince = null;
    return false;
  }
  const now = Date.now();
  if (watch.idleSince === null) watch.idleSince = now;
  return now - watch.idleSince >= watch.graceMs;
}

/**
 * Hibernate as soon as every session has been idle for `graceMs`. Sampling only
 * fires from the poll interval, never from arming, so an API response always
 * flushes before the device can start hibernating.
 */
export function armHibernateOnIdle(options: {
  command: DeviceHibernateCommand;
  graceMs: number;
  getActiveSessionCount: () => number;
  /** Returns why hibernation must be held off, or null when nothing blocks it. */
  getBlockingReason?: () => string | null;
}): HibernateOnIdleStatus {
  disarmHibernateOnIdle();
  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, Math.floor(options.graceMs)) : 0;
  const token = ++tokenCounter;
  const interval = setInterval(() => {
    if (!idleWatch || idleWatch.token !== token) return;
    const watch = idleWatch;
    if (!sampleIdleWatch(watch) || watch.handedOff) return;
    disarmHibernateOnIdle();
    // A timed schedule is redundant once the device is hibernating.
    cancelHibernate();
    console.log("[device] Hibernate-on-idle triggered — all sessions idle");
    void requestDeviceHibernate(watch.command).catch((error) => {
      console.error("[device] Hibernate request failed:", error);
    });
  }, HIBERNATE_IDLE_POLL_INTERVAL_MS);
  interval.unref?.();
  idleWatch = {
    token,
    command: options.command,
    graceMs,
    getActiveSessionCount: options.getActiveSessionCount,
    getBlockingReason: options.getBlockingReason,
    interval,
    armedAt: Date.now(),
    idleSince: null,
    activeSessions: 0,
    blockedReason: null,
    handedOff: false,
  };
  sampleIdleWatch(idleWatch);
  return getHibernateOnIdleStatus();
}

/**
 * Arms the idle watcher against the server's own activity: running sessions, deploy and update
 * jobs, and a restart that is requested or under way.
 */
export function armHibernateOnIdleForServer(
  sources: HibernateIdleSources,
  command: DeviceHibernateCommand,
  graceMs: number,
): HibernateOnIdleStatus {
  return armHibernateOnIdle({
    command,
    graceMs,
    getActiveSessionCount: () => sources.sessionManager.getLifecycleBlockingSessionCount(),
    getBlockingReason: () => {
      const job = sources.managementJobStore?.listActive()[0];
      if (job) return `A ${job.type} management job is ${job.status}`;
      const dataDir = sources.runtimePaths?.dataDir;
      return dataDir && isRestartPending(dataDir) ? "A restart is pending" : null;
    },
  });
}

/**
 * Returns the hibernation that is still to come and stops this process from firing it, for a
 * server that is shutting down. Status keeps reporting it, so a client that polls through the
 * restart does not see it switch off and on again.
 */
export function handOffHibernateIntent(): HibernateIntent | null {
  if (!pending && !idleWatch) return null;
  if (pending) pending.handedOff = true;
  if (idleWatch) idleWatch.handedOff = true;
  return {
    onIdleGraceMs: idleWatch?.graceMs ?? null,
    scheduledAt: pending?.scheduledAt ?? null,
  };
}

export function disarmHibernateOnIdle(): boolean {
  if (!idleWatch) return false;
  clearInterval(idleWatch.interval);
  idleWatch = null;
  return true;
}
