// Todo store — per-task checklists for human tracking

import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";

// ── Types ─────────────────────────────────────────────────────────

export interface Todo {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  order: number;
  createdAt: string;
  completedAt?: string;
  deadline?: string; // YYYY-MM-DD date string
}

type TodoUpdate = Partial<Pick<Todo, "text" | "done" | "deadline">>;

// ── Factory ───────────────────────────────────────────────────────

export function createTodoStore(db: DatabaseSync, bus: GlobalBus) {
  function hydrate(row: any): Todo {
    return {
      id: row.id,
      taskId: row.taskId,
      text: row.text,
      done: row.done === 1,
      order: row.order,
      createdAt: row.createdAt,
      completedAt: row.completedAt ?? undefined,
      deadline: row.deadline ?? undefined,
    };
  }

  function emitChange(taskId: string): void {
    bus.emit({ type: "task:changed", taskId });
  }

  function listTodos(taskId: string): Todo[] {
    return (db.prepare('SELECT * FROM todos WHERE taskId = ? ORDER BY "order"').all(taskId) as any[]).map(hydrate);
  }

  function getTodo(id: string): Todo | undefined {
    const row = db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function createTodo(taskId: string, text: string, deadline?: string): Todo {
    // Verify task exists
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as any;
    if (!task) throw new Error(`Task ${taskId} not found`);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxOrder = (db.prepare('SELECT MAX("order") as mx FROM todos WHERE taskId = ?').get(taskId) as any).mx ?? -1;

    db.prepare(`
      INSERT INTO todos (id, taskId, text, done, "order", createdAt, deadline)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(id, taskId, text, maxOrder + 1, now, deadline ?? null);

    emitChange(taskId);
    return getTodo(id)!;
  }

  function updateTodo(id: string, updates: TodoUpdate): Todo {
    const todo = getTodo(id);
    if (!todo) throw new Error(`Todo ${id} not found`);

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.text !== undefined) { fields.push("text = ?"); values.push(updates.text); }
    if (updates.done !== undefined) {
      fields.push("done = ?");
      values.push(updates.done ? 1 : 0);
      if (updates.done && !todo.done) {
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
      db.prepare(`UPDATE todos SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }

    emitChange(todo.taskId);
    return getTodo(id)!;
  }

  function deleteTodo(id: string): void {
    const todo = getTodo(id);
    if (!todo) return;
    db.prepare("DELETE FROM todos WHERE id = ?").run(id);
    emitChange(todo.taskId);
  }

  function reorderTodos(taskId: string, todoIds: string[]): Todo[] {
    const stmt = db.prepare('UPDATE todos SET "order" = ? WHERE id = ? AND taskId = ?');
    for (let i = 0; i < todoIds.length; i++) {
      stmt.run(i, todoIds[i], taskId);
    }
    emitChange(taskId);
    return listTodos(taskId);
  }

  /** Get all unchecked todos across all tasks (for dashboard rollup) */
  function listAllOpen(): Todo[] {
    return (db.prepare(`
      SELECT todos.* FROM todos
      JOIN tasks ON todos.taskId = tasks.id
      WHERE todos.done = 0 AND tasks.status = 'active'
      ORDER BY tasks."order", todos."order"
    `).all() as any[]).map(hydrate);
  }

  /** Get recently completed todos (last 7 days) across active tasks */
  function listRecentlyCompleted(): Todo[] {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return (db.prepare(`
      SELECT todos.* FROM todos
      JOIN tasks ON todos.taskId = tasks.id
      WHERE todos.done = 1 AND tasks.status = 'active' AND todos.completedAt >= ?
      ORDER BY todos.completedAt DESC
    `).all(weekAgo) as any[]).map(hydrate);
  }

  return { listTodos, getTodo, createTodo, updateTodo, deleteTodo, reorderTodos, listAllOpen, listRecentlyCompleted };
}

export type TodoStore = ReturnType<typeof createTodoStore>;
