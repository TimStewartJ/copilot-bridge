/** Session id prefix of trigger workers' temporary sessions, deleted after each run. */
export const DISPOSABLE_DEFER_WORKER_SESSION_ID_PREFIX = "d3f3e000";

export function isDisposableDeferWorkerSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${DISPOSABLE_DEFER_WORKER_SESSION_ID_PREFIX}-`);
}
