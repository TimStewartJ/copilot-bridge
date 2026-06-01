export const SESSION_RESUME_TIMEOUT_MS = 60_000;

export async function resumeSessionWithTimeout<TSession>(
  resume: Promise<TSession>,
  timeoutMessage: string,
  timeoutMs = SESSION_RESUME_TIMEOUT_MS,
): Promise<TSession> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resume,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
