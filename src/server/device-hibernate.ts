// In-memory hibernate timer and idle watcher; the watcher disarms first so waking can't loop.

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
  /** Why hibernation is held off besides sessions (deploy/update job, restart cutover), or null. */
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
let intentListener: (() => void) | null = null;

/** Sets the one listener told when the next hibernation changes (armed, scheduled, off, fired). */
export function setHibernateIntentListener(listener: (() => void) | null): void {
  intentListener = listener;
}

function notifyIntentChanged(): void {
  try {
    intentListener?.();
  } catch (error) {
    console.error("[device] Hibernate intent listener failed:", error);
  }
}

/** The hibernation that is still to come, or null when none is. */
export function getHibernateIntent(): HibernateIntent | null {
  if (!pending && !idleWatch) return null;
  return {
    onIdleGraceMs: idleWatch?.graceMs ?? null,
    scheduledAt: pending?.scheduledAt ?? null,
  };
}

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
    // The device is going down; an armed watcher would hibernate again soon after the next wake.
    if (!disarmHibernateOnIdle()) notifyIntentChanged();
    void requestDeviceHibernate(command).catch((error) => {
      console.error("[device] Hibernate request failed:", error);
    });
  }, safeDelayMs);
  timer.unref();
  pending = { token, timer, scheduledAt, delayMs: safeDelayMs, handedOff: false };
  notifyIntentChanged();
  return getHibernateStatus();
}

export function cancelHibernate(): boolean {
  if (!pending) return false;
  pending.timer.cancel();
  pending = null;
  notifyIntentChanged();
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

/** True after a full idle grace; deploys and restarts count as busy, or a cutover may roll back. */
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

/** Never sample on arm: the API response must flush before the device can start hibernating. */
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
  notifyIntentChanged();
  return getHibernateOnIdleStatus();
}

/** Arms the idle watcher on the server's sessions, deploy/update jobs and pending restarts. */
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

/** For shutdown: stops this process firing it; status still reports it so polls don't flicker. */
export function handOffHibernateIntent(): HibernateIntent | null {
  const intent = getHibernateIntent();
  if (pending) pending.handedOff = true;
  if (idleWatch) idleWatch.handedOff = true;
  return intent;
}

export function disarmHibernateOnIdle(): boolean {
  if (!idleWatch) return false;
  clearInterval(idleWatch.interval);
  idleWatch = null;
  notifyIntentChanged();
  return true;
}
