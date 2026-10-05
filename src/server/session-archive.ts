import type { GlobalBus } from "./global-bus.js";
import type { SessionMetaStore } from "./session-meta-store.js";

export interface SessionArchiveDeps {
  sessionMetaStore: Pick<SessionMetaStore, "setArchived">;
  globalBus: Pick<GlobalBus, "emit">;
}

export interface SetSessionsArchivedResult {
  /** Sessions whose state was written, in the order given. */
  sessionIds: string[];
  errors: Record<string, string>;
}

/**
 * Archives or restores sessions and announces it once. Each `session:archived` event drops the
 * session list caches and makes every open client fetch the list and the tasks again, so a change
 * to many sessions must not announce them one by one.
 *
 * Synchronous on purpose: listeners (deferred work is cancelled from this event) run in the same
 * turn as the writes.
 */
export function setSessionsArchived(
  deps: SessionArchiveDeps,
  sessionIds: Iterable<string>,
  archived: boolean,
): SetSessionsArchivedResult {
  const written: string[] = [];
  const errors: Record<string, string> = {};
  for (const sessionId of new Set(sessionIds)) {
    try {
      deps.sessionMetaStore.setArchived(sessionId, archived);
      written.push(sessionId);
    } catch (error) {
      errors[String(sessionId)] = String(error);
    }
  }
  if (written.length === 1) {
    deps.globalBus.emit({ type: "session:archived", sessionId: written[0], archived });
  } else if (written.length > 1) {
    deps.globalBus.emit({ type: "session:archived", sessionIds: written, archived });
  }
  return { sessionIds: written, errors };
}
