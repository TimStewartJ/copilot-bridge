import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./db.js";
import { runInOwnOrOuterTransaction } from "./db-transaction.js";
import type { TaskStarter, TaskStarterDraft, TaskStarterRefreshTrigger, TaskStarterSource } from "../shared/task-starters.js";

/** Used and dismissed suggestions are kept this long, then dropped when the task gets a new set. */
const KEEP_CLOSED_MS = 30 * 86_400_000;

interface Row {
  id: string; taskId: string; label: string; prompt: string; playbook: string | null; source: string; createdAt: string;
}

function toStarter(row: Row): TaskStarter {
  return {
    id: row.id, taskId: row.taskId, label: row.label, prompt: row.prompt,
    ...(row.playbook ? { playbook: row.playbook } : {}),
    source: row.source === "refresh" || row.source === "auto" ? row.source : "helm",
    createdAt: row.createdAt,
  };
}

export function createTaskStartersStore(db: DatabaseSync, now: () => Date = () => new Date()) {
  return {
    /** Open suggestions for a task, in the order they were written. */
    list(taskId: string): TaskStarter[] {
      const rows = db.prepare(`
        SELECT id, taskId, label, prompt, playbook, source, createdAt FROM task_starters
        WHERE taskId = ? AND usedAt IS NULL AND dismissedAt IS NULL ORDER BY position
      `).all(taskId) as unknown as Row[];
      return rows.map(toStarter);
    },
    /** Labels dismissed in the last 30 days, newest first, so writers don't offer them again. */
    listDismissedLabels(taskId: string, limit = 10): string[] {
      const rows = db.prepare(`
        SELECT label FROM task_starters WHERE taskId = ? AND dismissedAt IS NOT NULL ORDER BY dismissedAt DESC LIMIT ?
      `).all(taskId, limit) as Array<{ label: string }>;
      return rows.map((row) => row.label);
    },
    /** Replaces the task's open suggestions, joining the caller's transaction when one is open. */
    replace(taskId: string, starters: readonly TaskStarterDraft[], source: TaskStarterSource): TaskStarter[] {
      runInOwnOrOuterTransaction(db, () => this.replaceWithin(taskId, starters, source));
      return this.list(taskId);
    },
    replaceWithin(taskId: string, starters: readonly TaskStarterDraft[], source: TaskStarterSource): void {
      const at = now();
      db.prepare("DELETE FROM task_starters WHERE taskId = ? AND usedAt IS NULL AND dismissedAt IS NULL").run(taskId);
      db.prepare("DELETE FROM task_starters WHERE taskId = ? AND createdAt < ?").run(taskId, new Date(at.getTime() - KEEP_CLOSED_MS).toISOString());
      const insert = db.prepare(`
        INSERT INTO task_starters (id, taskId, position, label, prompt, playbook, source, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      starters.forEach((starter, position) => {
        insert.run(randomUUID(), taskId, position, starter.label, starter.prompt, starter.playbook ?? null, source, at.toISOString());
      });
    },
    /** Records that a refresh started; returns its id for finishRefresh. */
    startRefresh(taskId: string, trigger: TaskStarterRefreshTrigger): number {
      const result = db.prepare("INSERT INTO task_starter_refreshes (taskId, trigger, startedAt) VALUES (?, ?, ?)")
        .run(taskId, trigger, now().toISOString());
      return Number(result.lastInsertRowid);
    },
    finishRefresh(id: number, outcome: string, count: number | null): void {
      db.prepare("UPDATE task_starter_refreshes SET finishedAt = ?, outcome = ?, count = ? WHERE id = ?")
        .run(now().toISOString(), outcome.slice(0, 200), count, id);
    },
    /** When the task's last refresh of any kind started, or null. */
    lastRefreshAt(taskId: string): string | null {
      const row = db.prepare("SELECT MAX(startedAt) AS at FROM task_starter_refreshes WHERE taskId = ?").get(taskId) as { at: string | null } | undefined;
      return row?.at ?? null;
    },
    countRefreshesSince(trigger: TaskStarterRefreshTrigger, since: string): number {
      const row = db.prepare("SELECT COUNT(*) AS n FROM task_starter_refreshes WHERE trigger = ? AND startedAt >= ?").get(trigger, since) as { n: number };
      return Number(row.n);
    },
    /** Closes one suggestion. False when it is not an open suggestion of that task. */
    close(taskId: string, id: string, how: "used" | "dismissed"): boolean {
      const column = how === "used" ? "usedAt" : "dismissedAt";
      const result = db.prepare(`
        UPDATE task_starters SET ${column} = ? WHERE id = ? AND taskId = ? AND usedAt IS NULL AND dismissedAt IS NULL
      `).run(now().toISOString(), id, taskId);
      return Number(result.changes) > 0;
    },
  };
}

export type TaskStartersStore = ReturnType<typeof createTaskStartersStore>;
