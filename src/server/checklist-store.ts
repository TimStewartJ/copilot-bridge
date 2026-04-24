// Checklist store — per-task checklists for human tracking

import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";

// ── Types ─────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: string;
  taskId: string | null;
  text: string;
  done: boolean;
  order: number;
  createdAt: string;
  completedAt?: string;
  deadline?: string; // YYYY-MM-DD date string
}

type ChecklistItemUpdate = Partial<Pick<ChecklistItem, "text" | "done" | "deadline">>;

// ── Factory ───────────────────────────────────────────────────────

export function createChecklistStore(db: DatabaseSync, bus: GlobalBus) {
  function hydrate(row: any): ChecklistItem {
    return {
      id: row.id,
      taskId: row.taskId ?? null,
      text: row.text,
      done: row.done === 1,
      order: row.order,
      createdAt: row.createdAt,
      completedAt: row.completedAt ?? undefined,
      deadline: row.deadline ?? undefined,
    };
  }

  function emitChange(taskId: string | null): void {
    bus.emit({ type: "task:changed", taskId: taskId ?? undefined });
  }

  function listChecklistItems(taskId: string): ChecklistItem[] {
    return (db.prepare('SELECT * FROM checklist_items WHERE taskId = ? ORDER BY "order"').all(taskId) as any[]).map(hydrate);
  }

  function getChecklistItem(id: string): ChecklistItem | undefined {
    const row = db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function createChecklistItem(taskId: string | null, text: string, deadline?: string): ChecklistItem {
    if (taskId !== null) {
      const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as any;
      if (!task) throw new Error(`Task ${taskId} not found`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxOrder = taskId !== null
      ? (db.prepare('SELECT MAX("order") as mx FROM checklist_items WHERE taskId = ?').get(taskId) as any).mx ?? -1
      : (db.prepare('SELECT MAX("order") as mx FROM checklist_items WHERE taskId IS NULL').get() as any).mx ?? -1;

    db.prepare(`
      INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, deadline)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(id, taskId, text, maxOrder + 1, now, deadline ?? null);

    emitChange(taskId);
    return getChecklistItem(id)!;
  }

  function updateChecklistItem(id: string, updates: ChecklistItemUpdate): ChecklistItem {
    const checklistItem = getChecklistItem(id);
    if (!checklistItem) throw new Error(`Checklist item ${id} not found`);

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.text !== undefined) { fields.push("text = ?"); values.push(updates.text); }
    if (updates.done !== undefined) {
      fields.push("done = ?");
      values.push(updates.done ? 1 : 0);
      if (updates.done && !checklistItem.done) {
        fields.push("completedAt = ?");
        values.push(new Date().toISOString());
      } else if (!updates.done) {
        fields.push("completedAt = ?");
        values.push(null);
      }
    }
    if ("deadline" in updates) {
      fields.push("deadline = ?");
      values.push(updates.deadline ?? null);
    }

    if (fields.length > 0) {
      values.push(id);
      db.prepare(`UPDATE checklist_items SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }

    emitChange(checklistItem.taskId);
    return getChecklistItem(id)!;
  }

  function deleteChecklistItem(id: string): void {
    const checklistItem = getChecklistItem(id);
    if (!checklistItem) return;
    db.prepare("DELETE FROM checklist_items WHERE id = ?").run(id);
    emitChange(checklistItem.taskId);
  }

  function reorderChecklistItems(taskId: string, checklistItemIds: string[]): ChecklistItem[] {
    const stmt = db.prepare('UPDATE checklist_items SET "order" = ? WHERE id = ? AND taskId = ?');
    for (let i = 0; i < checklistItemIds.length; i++) {
      stmt.run(i, checklistItemIds[i], taskId);
    }
    emitChange(taskId);
    return listChecklistItems(taskId);
  }

  /** Get all unchecked checklist items across all active tasks and global (unparented) checklist items */
  function listAllOpenChecklistItems(): ChecklistItem[] {
    return (db.prepare(`
      SELECT checklist_items.* FROM checklist_items
      LEFT JOIN tasks ON checklist_items.taskId = tasks.id
      WHERE checklist_items.done = 0 AND (checklist_items.taskId IS NULL OR tasks.status = 'active')
      ORDER BY checklist_items.createdAt DESC, checklist_items.ROWID DESC
    `).all() as any[]).map(hydrate);
  }

  /** Get recently completed checklist items (last 7 days) across active tasks and global checklist items */
  function listRecentlyCompletedChecklistItems(): ChecklistItem[] {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return (db.prepare(`
      SELECT checklist_items.* FROM checklist_items
      LEFT JOIN tasks ON checklist_items.taskId = tasks.id
      WHERE checklist_items.done = 1 AND (checklist_items.taskId IS NULL OR tasks.status = 'active') AND checklist_items.completedAt >= ?
      ORDER BY checklist_items.completedAt DESC, checklist_items.ROWID DESC
    `).all(weekAgo) as any[]).map(hydrate);
  }

  return {
    listChecklistItems,
    getChecklistItem,
    createChecklistItem,
    updateChecklistItem,
    deleteChecklistItem,
    reorderChecklistItems,
    listAllOpenChecklistItems,
    listRecentlyCompletedChecklistItems,
  };
}

export type ChecklistStore = ReturnType<typeof createChecklistStore>;
