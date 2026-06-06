// Delayed device hibernation scheduler.
//
// Holds a single in-memory pending hibernation timer so the API can schedule,
// inspect, and cancel a future hibernation. A generation token guards against a
// stale timer callback clearing newer pending state. Pending schedules are
// intentionally not persisted: a bridge restart clears them, and clients reflect
// the real server state by re-fetching status.

import { requestDeviceHibernate, type DeviceHibernateCommand } from "./platform.js";

export type HibernateScheduleStatus = {
  pending: boolean;
  scheduledAt: number | null;
  delayMs: number | null;
};

type PendingHibernate = {
  token: number;
  timer: NodeJS.Timeout;
  scheduledAt: number;
  delayMs: number;
};

let pending: PendingHibernate | null = null;
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
  const safeDelayMs = Math.max(0, Math.floor(delayMs));
  const token = ++tokenCounter;
  const scheduledAt = Date.now() + safeDelayMs;
  const timer = setTimeout(() => {
    if (!pending || pending.token !== token) return;
    pending = null;
    void requestDeviceHibernate(command).catch((error) => {
      console.error("[device] Hibernate request failed:", error);
    });
  }, safeDelayMs);
  timer.unref?.();
  pending = { token, timer, scheduledAt, delayMs: safeDelayMs };
  return getHibernateStatus();
}

export function cancelHibernate(): boolean {
  if (!pending) return false;
  clearTimeout(pending.timer);
  pending = null;
  return true;
}
