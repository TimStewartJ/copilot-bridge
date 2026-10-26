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

  function getReadStateFor(sessionIds: readonly string[]): ReadStateMap {
    if (sessionIds.length === 0) return {};
    const rows = db.prepare(
      "SELECT sessionId, lastReadAt FROM read_state WHERE sessionId IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(sessionIds)) as any[];
    return Object.fromEntries(rows.map((row) => [row.sessionId, row.lastReadAt]));
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

  /** Marks many conversations read through one moment in a single statement; a later read time is kept. */
  function markReadMany(sessionIds: readonly string[], readThroughActivityAt = new Date().toISOString()): void {
    if (sessionIds.length === 0) return;
    db.prepare(
      `INSERT INTO read_state (sessionId, lastReadAt)
       SELECT value, ? FROM json_each(?) WHERE true
       ON CONFLICT(sessionId) DO UPDATE SET
         lastReadAt = CASE
           WHEN read_state.lastReadAt < excluded.lastReadAt THEN excluded.lastReadAt
           ELSE read_state.lastReadAt
         END`,
    ).run(normalizeTimestamp(readThroughActivityAt), JSON.stringify(sessionIds));
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

  /**
   * Puts a conversation's read point back to what it was, only if nobody moved it since `expected`
   * was set. Returns false when it had moved (the user read it meanwhile), leaving it alone.
   */
  function restoreRead(sessionId: string, previous: string | null, expected: string): boolean {
    const row = db.prepare("SELECT lastReadAt FROM read_state WHERE sessionId = ?").get(sessionId) as any;
    if (!row || row.lastReadAt !== normalizeTimestamp(expected)) return false;
    if (previous) db.prepare("UPDATE read_state SET lastReadAt = ? WHERE sessionId = ?").run(normalizeTimestamp(previous), sessionId);
    else db.prepare("DELETE FROM read_state WHERE sessionId = ?").run(sessionId);
    return true;
  }

  return { getReadState, getReadStateFor, markRead, markReadMany, isUnread, markUnread, restoreRead };
}

export type ReadStateStore = ReturnType<typeof createReadStateStore>;
