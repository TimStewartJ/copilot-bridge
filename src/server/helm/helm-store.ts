// Persistence for Helm conversations. A Helm conversation is an ordinary Bridge session
// with the Helm profile; this table records which sessions those are, which one is
// current, and the activity retention uses to let old ones expire.
import type { DatabaseSync } from "../db.js";

export interface HelmConversationRecord {
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  /** User-visible turns sent to the conversation (typed or spoken). */
  turnCount: number;
  isCurrent: boolean;
  /** Kept conversations are exempt from retention. */
  kept: boolean;
}

interface HelmConversationRow {
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  isCurrent: number;
  kept: number;
}

function hydrate(row: HelmConversationRow): HelmConversationRecord {
  return {
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    turnCount: Number(row.turnCount) || 0,
    isCurrent: Number(row.isCurrent) === 1,
    kept: Number(row.kept) === 1,
  };
}

export function createHelmStore(db: DatabaseSync) {
  // Session ids are consulted on every session-config build and session-list pass.
  let knownIds: Set<string> | undefined;

  function ids(): Set<string> {
    if (!knownIds) {
      const rows = db.prepare("SELECT sessionId FROM helm_conversations").all() as Array<{ sessionId: string }>;
      knownIds = new Set(rows.map((row) => row.sessionId));
    }
    return knownIds;
  }

  function isHelmSession(sessionId: string | undefined | null): boolean {
    return typeof sessionId === "string" && ids().has(sessionId);
  }

  function get(sessionId: string): HelmConversationRecord | undefined {
    const row = db.prepare("SELECT * FROM helm_conversations WHERE sessionId = ?").get(sessionId) as HelmConversationRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function list(): HelmConversationRecord[] {
    const rows = db.prepare(
      "SELECT * FROM helm_conversations ORDER BY lastActiveAt DESC, createdAt DESC",
    ).all() as unknown as HelmConversationRow[];
    return rows.map(hydrate);
  }

  function getCurrent(): HelmConversationRecord | undefined {
    const row = db.prepare(
      "SELECT * FROM helm_conversations WHERE isCurrent = 1 ORDER BY lastActiveAt DESC LIMIT 1",
    ).get() as HelmConversationRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function setCurrent(sessionId: string | null): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE helm_conversations SET isCurrent = 0 WHERE isCurrent = 1").run();
      if (sessionId) db.prepare("UPDATE helm_conversations SET isCurrent = 1 WHERE sessionId = ?").run(sessionId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Records a new conversation and makes it current. */
  function create(sessionId: string, now = new Date().toISOString()): HelmConversationRecord {
    db.prepare(
      `INSERT INTO helm_conversations (sessionId, createdAt, lastActiveAt, turnCount, isCurrent, kept)
       VALUES (?, ?, ?, 0, 0, 0)`,
    ).run(sessionId, now, now);
    ids().add(sessionId);
    setCurrent(sessionId);
    return get(sessionId)!;
  }

  function recordTurn(sessionId: string, now = new Date().toISOString()): void {
    db.prepare(
      "UPDATE helm_conversations SET turnCount = turnCount + 1, lastActiveAt = ? WHERE sessionId = ?",
    ).run(now, sessionId);
  }

  function touch(sessionId: string, now = new Date().toISOString()): void {
    db.prepare("UPDATE helm_conversations SET lastActiveAt = ? WHERE sessionId = ? AND lastActiveAt < ?").run(now, sessionId, now);
  }

  function setKept(sessionId: string, kept: boolean): HelmConversationRecord | undefined {
    db.prepare("UPDATE helm_conversations SET kept = ? WHERE sessionId = ?").run(kept ? 1 : 0, sessionId);
    return get(sessionId);
  }

  function remove(sessionId: string): boolean {
    const result = db.prepare("DELETE FROM helm_conversations WHERE sessionId = ?").run(sessionId) as { changes?: number | bigint };
    ids().delete(sessionId);
    return Number(result.changes ?? 0) > 0;
  }

  return { isHelmSession, get, list, getCurrent, setCurrent, create, recordTurn, touch, setKept, remove };
}

export type HelmStore = ReturnType<typeof createHelmStore>;
