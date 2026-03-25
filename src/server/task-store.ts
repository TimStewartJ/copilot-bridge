import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";

// ── Types ─────────────────────────────────────────────────────────

import type { ProviderName } from "./providers/types.js";

export interface WorkItemRef {
  id: number;
  provider: ProviderName;
}

export interface PRRef {
  repoId: string;
  repoName?: string;
  prId: number;
  provider: ProviderName;
}

export interface Task {
  id: string;
  title: string;
  status: "active" | "paused" | "done" | "archived";
  groupId?: string;
  cwd?: string;
  notes: string;
  priority: number;
  order: number;
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  workItems: WorkItemRef[];
  pullRequests: PRRef[];
}

type TaskUpdate = Partial<Pick<Task, "title" | "status" | "notes" | "priority" | "cwd" | "groupId">>;

const STATUS_ORDER: Record<Task["status"], number> = {
  active: 0,
  paused: 1,
  done: 2,
  archived: 3,
};

// ── Factory ───────────────────────────────────────────────────────

export function createTaskStore(db: DatabaseSync, bus: GlobalBus) {
  function hydrate(row: any): Task {
    const id = row.id;
    const sessions = db.prepare("SELECT sessionId FROM task_sessions WHERE taskId = ? ORDER BY linkedAt ASC").all(id) as any[];
    const workItems = db.prepare("SELECT itemId as id, provider FROM task_work_items WHERE taskId = ?").all(id) as any[];
    const prs = db.prepare("SELECT repoId, repoName, prId, provider FROM task_pull_requests WHERE taskId = ?").all(id) as any[];

    return {
      id,
      title: row.title,
      status: row.status,
      groupId: row.groupId ?? undefined,
      cwd: row.cwd ?? undefined,
      notes: row.notes,
      priority: row.priority,
      order: row.order,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sessionIds: sessions.map((s) => s.sessionId),
      workItems: workItems.map((w) => ({ id: w.id, provider: w.provider as ProviderName })),
      pullRequests: prs.map((p) => ({
        repoId: p.repoId,
        repoName: p.repoName ?? undefined,
        prId: p.prId,
        provider: p.provider as ProviderName,
      })),
    };
  }

  function emitChange(taskId: string): void {
    bus.emit({ type: "task:changed", taskId });
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  function listTasks(): Task[] {
    const rows = db.prepare('SELECT * FROM tasks ORDER BY status, "order"').all() as any[];
    const tasks = rows.map(hydrate);
    return tasks.sort((a, b) => {
      const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (statusDiff !== 0) return statusDiff;
      return a.order - b.order;
    });
  }

  function getTask(id: string): Task | undefined {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function createTask(title: string): Task {
    // Bump order of all existing active tasks to make room at top
    db.prepare('UPDATE tasks SET "order" = "order" + 1 WHERE status = \'active\'').run();

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tasks (id, title, status, notes, priority, "order", createdAt, updatedAt)
      VALUES (?, ?, 'active', '', 0, 0, ?, ?)
    `).run(id, title, now, now);

    const task = getTask(id)!;
    emitChange(id);
    return task;
  }

  function updateTask(id: string, updates: TaskUpdate): Task {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Task ${id} not found`);

    const oldStatus = row.status;
    const now = new Date().toISOString();

    const fields: string[] = ["updatedAt = ?"];
    const values: any[] = [now];

    if (updates.title !== undefined) { fields.push("title = ?"); values.push(updates.title); }
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.notes !== undefined) { fields.push("notes = ?"); values.push(updates.notes); }
    if (updates.priority !== undefined) { fields.push("priority = ?"); values.push(updates.priority); }
    if (updates.cwd !== undefined) { fields.push("cwd = ?"); values.push(updates.cwd || null); }
    if (updates.groupId !== undefined) { fields.push("groupId = ?"); values.push(updates.groupId || null); }

    // When status changes, place task at top of new group
    if (updates.status !== undefined && updates.status !== oldStatus) {
      db.prepare(`UPDATE tasks SET "order" = "order" + 1 WHERE status = ? AND id != ?`).run(updates.status, id);
      fields.push('"order" = ?');
      values.push(0);
    }

    values.push(id);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);

    const task = getTask(id)!;
    emitChange(id);
    return task;
  }

  function deleteTask(id: string): void {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    emitChange(id);
  }

  function reorderTasks(taskIds: string[]): Task[] {
    const stmt = db.prepare('UPDATE tasks SET "order" = ? WHERE id = ?');
    for (let i = 0; i < taskIds.length; i++) {
      stmt.run(i, taskIds[i]);
    }
    for (const id of taskIds) emitChange(id);
    return listTasks();
  }

  // ── Link/Unlink ───────────────────────────────────────────────────

  function linkSession(taskId: string, sessionId: string): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const existing = db.prepare("SELECT 1 FROM task_sessions WHERE taskId = ? AND sessionId = ?").get(taskId, sessionId);
    if (!existing) {
      db.prepare("INSERT INTO task_sessions (taskId, sessionId, linkedAt) VALUES (?, ?, ?)").run(taskId, sessionId, new Date().toISOString());
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      emitChange(taskId);
    }
    return getTask(taskId)!;
  }

  function unlinkSession(taskId: string, sessionId: string): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    db.prepare("DELETE FROM task_sessions WHERE taskId = ? AND sessionId = ?").run(taskId, sessionId);
    db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    emitChange(taskId);
    return getTask(taskId)!;
  }

  function linkWorkItem(taskId: string, workItemId: number, provider: ProviderName = "ado"): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const existing = db.prepare("SELECT 1 FROM task_work_items WHERE taskId = ? AND itemId = ? AND provider = ?").get(taskId, workItemId, provider);
    if (!existing) {
      db.prepare("INSERT INTO task_work_items (taskId, itemId, provider) VALUES (?, ?, ?)").run(taskId, workItemId, provider);
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      emitChange(taskId);
    }
    return getTask(taskId)!;
  }

  function unlinkWorkItem(taskId: string, workItemId: number, provider?: ProviderName): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (provider) {
      db.prepare("DELETE FROM task_work_items WHERE taskId = ? AND itemId = ? AND provider = ?").run(taskId, workItemId, provider);
    } else {
      db.prepare("DELETE FROM task_work_items WHERE taskId = ? AND itemId = ?").run(taskId, workItemId);
    }
    db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    emitChange(taskId);
    return getTask(taskId)!;
  }

  function findTaskBySessionId(sessionId: string): Task | undefined {
    const row = db.prepare("SELECT taskId FROM task_sessions WHERE sessionId = ?").get(sessionId) as any;
    return row ? getTask(row.taskId) : undefined;
  }

  function linkPR(taskId: string, pr: PRRef): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const existing = db.prepare("SELECT 1 FROM task_pull_requests WHERE taskId = ? AND repoId = ? AND prId = ? AND provider = ?").get(taskId, pr.repoId, pr.prId, pr.provider);
    if (!existing) {
      db.prepare("INSERT INTO task_pull_requests (taskId, repoId, repoName, prId, provider) VALUES (?, ?, ?, ?, ?)").run(taskId, pr.repoId, pr.repoName ?? null, pr.prId, pr.provider);
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      emitChange(taskId);
    }
    return getTask(taskId)!;
  }

  function unlinkPR(taskId: string, repoId: string, prId: number, provider?: ProviderName): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (provider) {
      db.prepare("DELETE FROM task_pull_requests WHERE taskId = ? AND repoId = ? AND prId = ? AND provider = ?").run(taskId, repoId, prId, provider);
    } else {
      db.prepare("DELETE FROM task_pull_requests WHERE taskId = ? AND repoId = ? AND prId = ?").run(taskId, repoId, prId);
    }
    db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    emitChange(taskId);
    return getTask(taskId)!;
  }

  return {
    listTasks, getTask, createTask, updateTask, deleteTask, reorderTasks,
    linkSession, unlinkSession, linkWorkItem, unlinkWorkItem,
    findTaskBySessionId, linkPR, unlinkPR,
  };
}

export type TaskStore = ReturnType<typeof createTaskStore>;
