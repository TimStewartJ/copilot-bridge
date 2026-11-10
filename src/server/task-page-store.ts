// A task's page: one HTML document a chat published so the user can see where the task stands.
// Publishing again replaces it; it goes when the task does.
import type { DatabaseSync } from "./db.js";

/** Largest page the Bridge keeps. */
export const MAX_TASK_PAGE_BYTES = 2 * 1024 * 1024;

export interface TaskPageInfo {
  taskId: string;
  updatedAt: string;
  /** The chat that published it. */
  sessionId?: string;
  size: number;
}

export function createTaskPageStore(db: DatabaseSync) {
  function info(taskId: string): TaskPageInfo | undefined {
    const row = db.prepare("SELECT taskId, sessionId, updatedAt, length(CAST(html AS BLOB)) AS size FROM task_pages WHERE taskId = ?").get(taskId) as any;
    if (!row) return undefined;
    return { taskId: String(row.taskId), updatedAt: String(row.updatedAt), ...(row.sessionId ? { sessionId: String(row.sessionId) } : {}), size: Number(row.size) };
  }

  function html(taskId: string): string | undefined {
    const row = db.prepare("SELECT html FROM task_pages WHERE taskId = ?").get(taskId) as { html: string } | undefined;
    return row?.html;
  }

  function publish(taskId: string, page: string, sessionId?: string, at = new Date().toISOString()): TaskPageInfo {
    db.prepare(`
      INSERT INTO task_pages (taskId, html, sessionId, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(taskId) DO UPDATE SET html = excluded.html, sessionId = excluded.sessionId, updatedAt = excluded.updatedAt
    `).run(taskId, page, sessionId ?? null, at);
    return info(taskId)!;
  }

  function remove(taskId: string): boolean {
    return Number(db.prepare("DELETE FROM task_pages WHERE taskId = ?").run(taskId).changes) > 0;
  }

  return { info, html, publish, remove };
}

export type TaskPageStore = ReturnType<typeof createTaskPageStore>;
