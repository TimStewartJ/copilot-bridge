import type { DatabaseSync } from "./db.js";
import type { TaskChangeActor, TaskChangeSource } from "./task-store.js";

export const MAX_TASK_HISTORY_TEXT_LENGTH = 4000;
export const MAX_TASK_HISTORY_LIST_LIMIT = 200;

/** One thing that happened in a task, written once and kept in order. */
export interface TaskHistoryEntry {
  id: number;
  taskId: string;
  at: string;
  source: TaskChangeSource;
  sessionId?: string;
  scheduleId?: string;
  scheduleName?: string;
  text: string;
}

export class InvalidTaskHistoryEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskHistoryEntryError";
  }
}

function hydrate(row: any): TaskHistoryEntry {
  return {
    id: Number(row.id),
    taskId: String(row.taskId),
    at: String(row.at),
    source: row.source === "user" || row.source === "agent" ? row.source : "system",
    ...(row.sessionId ? { sessionId: String(row.sessionId) } : {}),
    ...(row.scheduleId ? { scheduleId: String(row.scheduleId) } : {}),
    ...(row.scheduleName ? { scheduleName: String(row.scheduleName) } : {}),
    text: String(row.text),
  };
}

export function normalizeTaskHistoryText(value: unknown): string {
  if (typeof value !== "string") throw new InvalidTaskHistoryEntryError("text must be a string");
  const text = value.trim();
  if (!text) throw new InvalidTaskHistoryEntryError("text must not be empty");
  if (text.length > MAX_TASK_HISTORY_TEXT_LENGTH) {
    throw new InvalidTaskHistoryEntryError(`text must be at most ${MAX_TASK_HISTORY_TEXT_LENGTH} characters`);
  }
  return text;
}

export function createTaskHistoryStore(db: DatabaseSync) {
  function addEntry(taskId: string, text: unknown, actor: TaskChangeActor, at = new Date().toISOString()): TaskHistoryEntry {
    const normalized = normalizeTaskHistoryText(text);
    const result = db.prepare(`
      INSERT INTO task_history_entries (taskId, at, source, sessionId, scheduleId, scheduleName, text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId, at, actor.source,
      actor.sessionId ?? null, actor.scheduleId ?? null, actor.scheduleName ?? null,
      normalized,
    ) as { lastInsertRowid: number | bigint };
    return hydrate(db.prepare("SELECT * FROM task_history_entries WHERE id = ?").get(Number(result.lastInsertRowid)));
  }

  /** Newest first. `before` pages by entry id; `query` matches text case-insensitively. */
  function listEntries(taskId: string, options: { limit?: number; before?: number; query?: string } = {}): TaskHistoryEntry[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, MAX_TASK_HISTORY_LIST_LIMIT));
    const clauses = ["taskId = ?"];
    const values: Array<string | number> = [taskId];
    if (options.before !== undefined) { clauses.push("id < ?"); values.push(options.before); }
    const query = options.query?.trim();
    if (query) {
      clauses.push("text LIKE ? ESCAPE '!'");
      values.push(`%${query.replace(/[!%_]/g, (match) => `!${match}`)}%`);
    }
    return (db.prepare(`
      SELECT * FROM task_history_entries WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?
    `).all(...values, limit) as any[]).map(hydrate);
  }

  function countEntries(taskId: string): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM task_history_entries WHERE taskId = ?").get(taskId) as { n: number };
    return Number(row.n);
  }

  function deleteEntry(taskId: string, id: number): boolean {
    const result = db.prepare("DELETE FROM task_history_entries WHERE taskId = ? AND id = ?").run(taskId, id) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  /** Entries a scheduled run wrote before the scheduler recorded which schedule owns the session. */
  function attributeToSchedule(sessionId: string, scheduleId: string, scheduleName: string): number {
    const result = db.prepare(`
      UPDATE task_history_entries SET scheduleId = ?, scheduleName = ?
      WHERE sessionId = ? AND scheduleId IS NULL
    `).run(scheduleId, scheduleName, sessionId) as { changes?: number };
    return result.changes ?? 0;
  }

  return { addEntry, listEntries, countEntries, deleteEntry, attributeToSchedule };
}

export type TaskHistoryStore = ReturnType<typeof createTaskHistoryStore>;
