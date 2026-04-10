import type { DatabaseSync } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────

type ReadStateMap = Record<string, string>; // sessionId → ISO lastReadAt

// ── Factory ───────────────────────────────────────────────────────

export function createReadStateStore(db: DatabaseSync) {
  function getReadState(): ReadStateMap {
    const rows = db.prepare("SELECT sessionId, lastReadAt FROM read_state").all() as any[];
    const result: ReadStateMap = {};
    for (const row of rows) {
      result[row.sessionId] = row.lastReadAt;
    }
    return result;
  }

  function markRead(sessionId: string): string {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO read_state (sessionId, lastReadAt) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET lastReadAt = ?",
    ).run(sessionId, now, now);
    return now;
  }

  function isUnread(sessionId: string, activityTime?: string): boolean {
    if (!activityTime) return false;
    const row = db.prepare("SELECT lastReadAt FROM read_state WHERE sessionId = ?").get(sessionId) as any;
    if (!row) return true; // never opened = unread
    return new Date(activityTime).getTime() > new Date(row.lastReadAt).getTime();
  }

  function markUnread(sessionId: string): void {
    db.prepare("DELETE FROM read_state WHERE sessionId = ?").run(sessionId);
  }

  function pruneReadState(validSessionIds: Set<string>): void {
    const rows = db.prepare("SELECT sessionId FROM read_state").all() as any[];
    for (const row of rows) {
      if (!validSessionIds.has(row.sessionId)) {
        db.prepare("DELETE FROM read_state WHERE sessionId = ?").run(row.sessionId);
      }
    }
  }

  return { getReadState, markRead, isUnread, markUnread, pruneReadState };
}

export type ReadStateStore = ReturnType<typeof createReadStateStore>;
