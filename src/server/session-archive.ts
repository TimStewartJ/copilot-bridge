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

/** Announce once: each event makes every client refetch; sync so listeners run in the same turn. */
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
