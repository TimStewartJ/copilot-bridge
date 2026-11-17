import type { DatabaseSync } from "node:sqlite";

/** Prompts Bridge itself writes into a chat: trigger messages and results, restart notices. */
const AUTOMATED_PROMPT_PREFIXES = ["<defer>", "<deferred-work-result>", "<trigger-result>", "<trigger>", "<bridge_notice>"];
/** A stored defer prompt explains an identical message only if sent while that defer was live. */
const DEFER_DELIVERY_SLACK_MS = 10 * 60_000;
const BACKFILL_KEY = "backfilledFromSearchIndex";

/** Last time the user's own words entered each chat; automated prompts never write here. */
export function initializeSessionUserMessagesSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_user_messages (sessionId TEXT PRIMARY KEY, lastSentAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_user_messages_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (db.prepare("SELECT 1 FROM session_user_messages_state WHERE key = ?").get(BACKFILL_KEY)) return;
  // Wait for a populated search index; a later start retries rather than settling for no history.
  if (!tableExists(db, "search_chat_messages") || !tableExists(db, "search_indexed_sessions")
    || !db.prepare("SELECT 1 FROM search_indexed_sessions LIMIT 1").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    backfillFromSearchIndex(db);
    db.prepare("INSERT INTO session_user_messages_state (key, value) VALUES (?, ?)").run(BACKFILL_KEY, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

interface DeferWindow { from: number; to: number }

/** Backfill from search index minus Bridge-sent prompts (automation, live defers, run openers). */
function backfillFromSearchIndex(db: DatabaseSync): void {
  const rows = db.prepare("SELECT sessionId, timestamp, content FROM search_chat_messages WHERE role = 'user' AND timestamp IS NOT NULL")
    .all() as Array<{ sessionId: string; timestamp: string; content: string }>;
  const scheduled = new Set(tableExists(db, "bridge_session_state")
    ? (db.prepare("SELECT sessionId FROM bridge_session_state WHERE triggeredBy = 'schedule'").all() as Array<{ sessionId: string }>).map(row => row.sessionId)
    : []);
  const deferWindows = new Map<string, DeferWindow[]>();
  for (const table of ["deferred_prompts", "defer_loops"]) {
    if (!tableExists(db, table)) continue;
    for (const row of db.prepare(`SELECT sessionId, prompt, createdAt, updatedAt FROM ${table}`).all() as Array<Record<string, string>>) {
      const from = Date.parse(row.createdAt), to = Date.parse(row.updatedAt);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const key = `${row.sessionId}\u0000${row.prompt}`;
      deferWindows.set(key, [...deferWindows.get(key) ?? [], { from, to: to + DEFER_DELIVERY_SLACK_MS }]);
    }
  }
  const bySession = new Map<string, Array<{ at: number; content: string }>>();
  for (const row of rows) {
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at)) continue;
    bySession.set(row.sessionId, [...bySession.get(row.sessionId) ?? [], { at, content: row.content }]);
  }
  const insert = db.prepare(`INSERT INTO session_user_messages (sessionId, lastSentAt) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET lastSentAt = excluded.lastSentAt WHERE excluded.lastSentAt > lastSentAt`);
  for (const [sessionId, messages] of bySession) {
    messages.sort((a, b) => a.at - b.at);
    const candidates = scheduled.has(sessionId) ? messages.slice(1) : messages;
    const human = candidates.filter(message => !AUTOMATED_PROMPT_PREFIXES.some(prefix => message.content.startsWith(prefix))
      && !(deferWindows.get(`${sessionId}\u0000${message.content}`) ?? []).some(window => message.at >= window.from && message.at <= window.to));
    const last = human[human.length - 1];
    if (last) insert.run(sessionId, new Date(last.at).toISOString());
  }
}
