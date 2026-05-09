import type { DatabaseSync } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────

type ReadStateMap = Record<string, string>; // sessionId → ISO lastReadAt

// ── Factory ───────────────────────────────────────────────────────

export function createReadStateStore(db: DatabaseSync) {
  function normalizeTimestamp(timestamp: string): string {
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) throw new Error("Invalid read timestamp");
    return new Date(time).toISOString();
  }

  function getReadState(): ReadStateMap {
    const rows = db.prepare("SELECT sessionId, lastReadAt FROM read_state").all() as any[];
    const result: ReadStateMap = {};
    for (const row of rows) {
      result[row.sessionId] = row.lastReadAt;
    }
    return result;
  }

  function markRead(sessionId: string, readThroughActivityAt = new Date().toISOString()): string {
    const readThrough = normalizeTimestamp(readThroughActivityAt);
    db.prepare(
      `INSERT INTO read_state (sessionId, lastReadAt)
       VALUES (?, ?)
       ON CONFLICT(sessionId) DO UPDATE SET
         lastReadAt = CASE
           WHEN read_state.lastReadAt < excluded.lastReadAt THEN excluded.lastReadAt
           ELSE read_state.lastReadAt
         END`,
    ).run(sessionId, readThrough);
    const row = db.prepare("SELECT lastReadAt FROM read_state WHERE sessionId = ?").get(sessionId) as any;
    return row?.lastReadAt ?? readThrough;
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
