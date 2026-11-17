/** Largest `setTimeout` delay (2^31-1 ms); Node fires longer ones at once, so re-arm in chunks. */
export const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;

export interface LongTimeout {
  /** Cancel the timer and stop any pending re-arm. */
  cancel(): void;
  /** Allow the process to exit while pending. Applies to every re-armed chunk. */
  unref(): void;
}

/** setTimeout that honors delays past Node's max; bad or negative delays fire next tick. */
export function safeSetTimeout(callback: () => void, delayMs: number): LongTimeout {
  const normalizedDelayMs = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0;
  const targetAt = Date.now() + normalizedDelayMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unrefed = false;
  let cancelled = false;

  const arm = (): void => {
    if (cancelled) return;
    const remainingMs = targetAt - Date.now();
    const chunkMs = Math.min(Math.max(0, remainingMs), MAX_SAFE_TIMEOUT_DELAY_MS);
    timer = setTimeout(() => {
      if (cancelled) return;
      if (Date.now() < targetAt) {
        arm();
      } else {
        callback();
      }
    }, chunkMs);
    if (unrefed) timer.unref?.();
  };

  arm();

  return {
    cancel(): void {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    unref(): void {
      unrefed = true;
      timer?.unref?.();
    },
  };
}
