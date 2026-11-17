export const SESSION_RESUME_TIMEOUT_MS = 60_000;

export interface ResumeSessionWithTimeoutOptions<TSession> {
  /** Runs synchronously on timeout, e.g. to block another resume until the SDK request settles. */
  onTimeout?: () => void;
  /** Releases a session that resolved after the timeout; no caller holds it. */
  disconnectLateSession?: (session: TSession) => void | Promise<void>;
  /** Sees late rejections and disconnect failures so none becomes an unhandled rejection. */
  onLateError?: (error: unknown) => void;
  /** Called after a timed-out resume rejects or finishes cleaning up its late session. */
  onLateSettled?: () => void;
}

async function defaultDisconnectLateSession<TSession>(session: TSession): Promise<void> {
  const disconnect = (session as { disconnect?: unknown } | null | undefined)?.disconnect;
  if (typeof disconnect === "function") {
    await disconnect.call(session);
  }
}

/** The SDK can't cancel a resume: on timeout, a late session is disconnected and errors seen. */
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
