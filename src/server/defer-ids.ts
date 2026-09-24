export const DEFER_ONCE_ID_PREFIX = "once_";
export const DEFER_INTERVAL_ID_PREFIX = "interval_";

export type DeferKind = "once" | "interval";

export interface ParsedDeferId {
  kind: DeferKind;
  id: string;
}

export function toOnceDeferId(id: string): string {
  return `${DEFER_ONCE_ID_PREFIX}${id}`;
}

export function toIntervalDeferId(id: string): string {
  return `${DEFER_INTERVAL_ID_PREFIX}${id}`;
}

export function parseDeferId(deferId: string): ParsedDeferId | undefined {
  if (deferId.startsWith(DEFER_ONCE_ID_PREFIX)) {
    const id = deferId.slice(DEFER_ONCE_ID_PREFIX.length);
    return id ? { kind: "once", id } : undefined;
  }
  if (deferId.startsWith(DEFER_INTERVAL_ID_PREFIX)) {
    const id = deferId.slice(DEFER_INTERVAL_ID_PREFIX.length);
    return id ? { kind: "interval", id } : undefined;
  }
  return undefined;
}

/** Session id prefix of the temporary sessions defer workers run in; they are deleted after each check. */
export const DISPOSABLE_DEFER_WORKER_SESSION_ID_PREFIX = "d3f3e000";

export function isDisposableDeferWorkerSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${DISPOSABLE_DEFER_WORKER_SESSION_ID_PREFIX}-`);
}
