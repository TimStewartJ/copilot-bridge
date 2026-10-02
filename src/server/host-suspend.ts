// The host's last wake from sleep, as this process saw it. A sleeping host stops timers, so a
// timer that fires minutes late was not held up by a busy event loop.

/** Event-loop stalls on record are under a minute; a sleeping host is away far longer. */
export const HOST_SUSPEND_GAP_MS = 2 * 60_000;

export interface HostResume {
  resumedAtMs: number;
  sleptMs: number;
}

let lastResume: HostResume | null = null;

/** Feed with how late a periodic timer fired. */
export function noteTimerDelay(delayMs: number, nowMs = Date.now()): void {
  if (delayMs >= HOST_SUSPEND_GAP_MS) lastResume = { resumedAtMs: nowMs, sleptMs: delayMs };
}

export function getLastHostResume(): HostResume | null {
  return lastResume;
}
