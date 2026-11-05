import { safeSetTimeout, type LongTimeout } from "./long-timeout.js";

interface StartupReplay {
  previous(now: Date): Date | null;
  lastStartedAt(): string | undefined;
  graceMs: number;
  delayMs: number;
}

export interface DeadlineJob {
  /** The next regular slot, never the delayed replay of an earlier one. */
  readonly nextRunAt: Date | null;
  cancel(): void;
}

/** A slot at the boundary of the grace window is already stale. */
export function isRecentMissedSlot(slot: number, now: number, graceMs: number): boolean {
  const age = now - slot;
  return age >= 0 && age < graceMs;
}

/** Register one deadline, or a cadence that supplies its next slot after each dispatch. */
export function registerDeadlineJob(
  cadence: Date | ((now: Date) => Date | null),
  run: (slot: Date, stillDue: () => boolean) => void,
  options: { now?: () => Date; unref?: boolean; minimumDelayMs?: number; startupReplay?: StartupReplay } = {},
): DeadlineJob {
  const now = options.now ?? (() => new Date());
  let cancelled = false;
  let lastDispatched: Date | undefined;
  let nextRunAt: Date | null = null;
  let regular: LongTimeout | undefined;
  let replay: LongTimeout | undefined;

  function dispatch(slot: Date, revalidate?: () => boolean): void {
    if (cancelled || revalidate?.() === false) return;
    lastDispatched = slot;
    // Async admission must not start a job after cancellation or a newer dispatch.
    run(slot, () => !cancelled && lastDispatched === slot && revalidate?.() !== false);
  }

  function arm(from: Date): void {
    const slot = typeof cadence === "function" ? cadence(from) : cadence;
    if (!slot || slot <= from) return;
    nextRunAt = slot;
    regular = safeSetTimeout(() => {
      regular = undefined;
      nextRunAt = null;
      try {
        dispatch(slot);
      } finally {
        if (!cancelled && typeof cadence === "function") arm(now());
      }
    }, Math.max(options.minimumDelayMs ?? 0, slot.getTime() - from.getTime()));
    if (options.unref) regular.unref();
  }

  function replayableSlot(policy: StartupReplay, from: Date): Date | null {
    const slot = policy.previous(from);
    if (!slot || !isRecentMissedSlot(slot.getTime(), from.getTime(), policy.graceMs)) return null;
    const last = policy.lastStartedAt();
    return !last || Date.parse(last) < slot.getTime() ? slot : null;
  }

  const from = now();
  arm(from);
  const policy = options.startupReplay;
  if (policy) {
    const slot = replayableSlot(policy, from);
    if (slot) {
      replay = safeSetTimeout(() => {
        replay = undefined;
        dispatch(slot, () => replayableSlot(policy, now())?.getTime() === slot.getTime());
      }, policy.delayMs);
      if (options.unref) replay.unref();
    }
  }

  return {
    get nextRunAt() { return nextRunAt; },
    cancel() {
      cancelled = true;
      regular?.cancel();
      replay?.cancel();
      nextRunAt = null;
    },
  };
}
