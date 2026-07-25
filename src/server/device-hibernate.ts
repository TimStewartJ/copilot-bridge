// Delayed device hibernation scheduler and idle watcher.
//
// Holds a single in-memory pending hibernation timer so the API can schedule,
// inspect, and cancel a future hibernation. A generation token guards against a
// stale timer callback clearing newer pending state. Pending schedules are
// intentionally not persisted: a bridge restart clears them, and clients reflect
// the real server state by re-fetching status.
//
// The idle watcher is the "hibernate on idle" mode: while armed it samples the
// active session count on a poll interval and hibernates once every session has
// stayed idle for the whole grace window. It is also in-memory only, so waking
// the device leaves the watcher disarmed instead of hibernating again in a loop.

import { requestDeviceHibernate, type DeviceHibernateCommand } from "./platform.js";
import { safeSetTimeout, type LongTimeout } from "./long-timeout.js";

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
};

type PendingHibernate = {
  token: number;
  timer: LongTimeout;
  scheduledAt: number;
  delayMs: number;
};

type IdleWatch = {
  token: number;
  command: DeviceHibernateCommand;
  graceMs: number;
  getActiveSessionCount: () => number;
  interval: ReturnType<typeof setInterval>;
  armedAt: number;
  idleSince: number | null;
  activeSessions: number;
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
    if (!pending || pending.token !== token) return;
    pending = null;
    // The device is going down now; leaving the watcher armed would hibernate
    // again shortly after the next wake.
    disarmHibernateOnIdle();
    void requestDeviceHibernate(command).catch((error) => {
      console.error("[device] Hibernate request failed:", error);
    });
  }, safeDelayMs);
  timer.unref();
  pending = { token, timer, scheduledAt, delayMs: safeDelayMs };
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
    };
  }
  return {
    armed: true,
    armedAt: idleWatch.armedAt,
    graceMs: idleWatch.graceMs,
    activeSessions: idleWatch.activeSessions,
    idleSince: idleWatch.idleSince,
    hibernateAt: idleWatch.idleSince === null ? null : idleWatch.idleSince + idleWatch.graceMs,
  };
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
 */
function sampleIdleWatch(watch: IdleWatch): boolean {
  const activeSessions = readActiveSessionCount(watch);
  watch.activeSessions = activeSessions;
  if (activeSessions > 0) {
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
}): HibernateOnIdleStatus {
  disarmHibernateOnIdle();
  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, Math.floor(options.graceMs)) : 0;
  const token = ++tokenCounter;
  const interval = setInterval(() => {
    if (!idleWatch || idleWatch.token !== token) return;
    const watch = idleWatch;
    if (!sampleIdleWatch(watch)) return;
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
    interval,
    armedAt: Date.now(),
    idleSince: null,
    activeSessions: 0,
  };
  sampleIdleWatch(idleWatch);
  return getHibernateOnIdleStatus();
}

export function disarmHibernateOnIdle(): boolean {
  if (!idleWatch) return false;
  clearInterval(idleWatch.interval);
  idleWatch = null;
  return true;
}
