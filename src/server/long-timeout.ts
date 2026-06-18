// Long-delay timer helper.
//
// Node coerces any `setTimeout` delay greater than 2147483647 ms (2^31 - 1,
// ~24.8 days) — or a non-finite/negative delay — to 1ms, firing almost
// immediately instead of at the intended time. `safeSetTimeout` clamps each
// underlying timer to the Node maximum and re-arms in chunks against an
// absolute deadline so timers scheduled far in the future fire at (not far
// before) their target, and remain correct even if the host sleeps or the
// event loop stalls past a chunk boundary.

/** Maximum delay (ms) Node's `setTimeout` accepts without coercion (2^31 - 1). */
export const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;

export interface LongTimeout {
  /** Cancel the timer and stop any pending re-arm. */
  cancel(): void;
  /** Allow the process to exit while pending. Applies to every re-armed chunk. */
  unref(): void;
}

/**
 * Schedule `callback` to run once after `delayMs`, transparently re-arming
 * across Node's per-timer maximum so long delays are honored. Non-finite or
 * negative delays fire on the next tick, matching Node's native coercion.
 */
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
