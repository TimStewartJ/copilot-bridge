export const SESSION_RESUME_TIMEOUT_MS = 60_000;

export interface ResumeSessionWithTimeoutOptions<TSession> {
  /**
   * Called synchronously when the timeout wins the race. Callers can use this
   * to block another resume until the uncancellable SDK request settles.
   */
  onTimeout?: () => void;
  /**
   * Cleanup for a resume promise that resolves *after* the timeout already
   * rejected. Such a session is orphaned: no caller receives this value, so it
   * is never cached and must be released here. Defaults to a duck-typed
   * `session.disconnect()`.
   */
  disconnectLateSession?: (session: TSession) => void | Promise<void>;
  /**
   * Observer for a resume promise that rejects *after* the timeout already
   * rejected, and for failures thrown by `disconnectLateSession`. Defaults to a
   * no-op; the late settlement is always observed so it cannot surface as an
   * unhandled rejection.
   */
  onLateError?: (error: unknown) => void;
  /**
   * Called after a timed-out resume either rejects or completes its late
   * session cleanup.
   */
  onLateSettled?: () => void;
}

async function defaultDisconnectLateSession<TSession>(session: TSession): Promise<void> {
  const disconnect = (session as { disconnect?: unknown } | null | undefined)?.disconnect;
  if (typeof disconnect === "function") {
    await disconnect.call(session);
  }
}

/**
 * Races an SDK `resumeSession` promise against a timeout. On timeout the helper
 * rejects with `timeoutMessage`, but the underlying resume keeps running. Since
 * the SDK exposes no cancellation hook, this helper centralizes the lifecycle:
 * a late resolve disconnects the orphaned session and a late reject is observed,
 * so neither leaks a live session nor produces an unhandled rejection. The
 * normal (pre-timeout) success path is untouched and the caller still owns the
 * resolved session.
 */
export async function resumeSessionWithTimeout<TSession>(
  resume: Promise<TSession>,
  timeoutMessage: string,
  timeoutMs = SESSION_RESUME_TIMEOUT_MS,
  options: ResumeSessionWithTimeoutOptions<TSession> = {},
): Promise<TSession> {
  const {
    disconnectLateSession = defaultDisconnectLateSession,
    onTimeout,
    onLateError,
    onLateSettled,
  } = options;
  const safeOnLateError = (error: unknown): void => {
    if (!onLateError) return;
    try {
      onLateError(error);
    } catch {
      /* best-effort observer */
    }
  };
  const safeCall = (callback: (() => void) | undefined): void => {
    if (!callback) return;
    try {
      callback();
    } catch (error) {
      safeOnLateError(error);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      resume,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          safeCall(onTimeout);
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      void resume.then(
        async (session) => {
          try {
            await disconnectLateSession(session);
          } catch (error) {
            safeOnLateError(error);
          } finally {
            safeCall(onLateSettled);
          }
        },
        (error) => {
          safeOnLateError(error);
          safeCall(onLateSettled);
        },
      );
    }
  }
}
