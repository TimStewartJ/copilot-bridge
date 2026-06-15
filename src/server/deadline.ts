export type Deadline = Readonly<{
  /** Serializable wall-clock representation used when a deadline crosses HTTP. */
  expiresAtUnixMs: number;
  /** Monotonic in-process expiry, immune to wall-clock adjustments. */
  expiresAtMonotonicMs: number;
}>;

export type DeadlineSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timed-out" };

function monotonicNow(): number {
  return performance.now();
}

export function createDeadline(timeoutMs: number): Deadline {
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  return {
    expiresAtUnixMs: Date.now() + boundedTimeoutMs,
    expiresAtMonotonicMs: monotonicNow() + boundedTimeoutMs,
  };
}

export function deadlineFromUnixMs(expiresAtUnixMs: number, maxTimeoutMs = Number.POSITIVE_INFINITY): Deadline {
  const wallClockRemainingMs = Number.isFinite(expiresAtUnixMs)
    ? Math.max(0, expiresAtUnixMs - Date.now())
    : 0;
  const timeoutMs = Math.min(wallClockRemainingMs, Math.max(0, maxTimeoutMs));
  return {
    expiresAtUnixMs: Date.now() + timeoutMs,
    expiresAtMonotonicMs: monotonicNow() + timeoutMs,
  };
}

export function capDeadline(deadline: Deadline, maxDurationMs: number): Deadline {
  const timeoutMs = Math.min(remainingMs(deadline), Math.max(0, maxDurationMs));
  return {
    expiresAtUnixMs: Math.min(deadline.expiresAtUnixMs, Date.now() + timeoutMs),
    expiresAtMonotonicMs: Math.min(deadline.expiresAtMonotonicMs, monotonicNow() + timeoutMs),
  };
}

export function deadlineBefore(deadline: Deadline, reserveMs: number): Deadline {
  const boundedReserveMs = Math.max(0, reserveMs);
  const timeoutMs = Math.max(0, remainingMs(deadline) - boundedReserveMs);
  return capDeadline(deadline, timeoutMs);
}

export function remainingMs(deadline: Deadline, capMs = Number.POSITIVE_INFINITY): number {
  return Math.max(
    0,
    Math.floor(Math.min(deadline.expiresAtMonotonicMs - monotonicNow(), Math.max(0, capMs))),
  );
}

export function deadlineExpired(deadline: Deadline): boolean {
  return remainingMs(deadline) <= 0;
}

export async function settleByDeadline<T>(
  operation: () => Promise<T> | T,
  deadline: Deadline,
): Promise<DeadlineSettlement<T>> {
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) return { status: "timed-out" };

  let work: Promise<T>;
  try {
    work = Promise.resolve(operation());
  } catch (error) {
    return { status: "rejected", error };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timed-out" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
    timer.unref?.();
  });
  const settled: Promise<DeadlineSettlement<T>> = work.then(
    (value): DeadlineSettlement<T> => ({ status: "fulfilled", value }),
    (error): DeadlineSettlement<T> => ({ status: "rejected", error }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function sleepUntilDeadline(delayMs: number, deadline: Deadline): Promise<boolean> {
  const timeoutMs = Math.min(Math.max(0, delayMs), remainingMs(deadline));
  if (timeoutMs <= 0) return false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  return !deadlineExpired(deadline);
}
