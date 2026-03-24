import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const TASKS_FILE = join(DATA_DIR, "tasks.json");

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
  priority: number; // lower = higher priority
  order: number; // position within status group (lower = higher in list)
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  workItems: WorkItemRef[];
  pullRequests: PRRef[];
}

type TaskUpdate = Partial<Pick<Task, "title" | "status" | "notes" | "priority" | "cwd" | "groupId">>;

// ── Persistence ───────────────────────────────────────────────────

const STATUS_ORDER: Record<Task["status"], number> = {
  active: 0,
  paused: 1,
  done: 2,
  archived: 3,
};

function load(): Task[] {
  if (!existsSync(TASKS_FILE)) return [];
  try {
    const tasks: any[] = JSON.parse(readFileSync(TASKS_FILE, "utf-8"));

    // Migrate: workItemIds (number[]) → workItems (WorkItemRef[])
    let migrated = false;
    for (const t of tasks) {
      if (Array.isArray(t.workItemIds)) {
        t.workItems = t.workItemIds.map((id: number) => ({ id, provider: "ado" }));
        delete t.workItemIds;
        migrated = true;
      }
      if (!t.workItems) {
        t.workItems = [];
        migrated = true;
      }
      // Migrate PRs: add provider field if missing
      if (Array.isArray(t.pullRequests)) {
        for (const pr of t.pullRequests) {
          if (!pr.provider) {
            pr.provider = "ado";
            migrated = true;
          }
        }
      }
    }

    // Migrate: assign order if missing (based on updatedAt rank within status group)
    const needsOrderMigration = tasks.some((t) => t.order === undefined || t.order === null);
    if (needsOrderMigration) {
      const groups = new Map<string, Task[]>();
      for (const t of tasks) {
        if (t.order === undefined || t.order === null) (t as Task).order = 0;
        const g = groups.get(t.status) ?? [];
        g.push(t);
        groups.set(t.status, g);
      }
      for (const group of groups.values()) {
        group.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        group.forEach((t, i) => { t.order = i; });
      }
      migrated = true;
    }

    if (migrated) save(tasks as Task[]);
    return tasks as Task[];
  } catch {
    return [];
  }
}

function save(tasks: Task[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

// ── CRUD ──────────────────────────────────────────────────────────

export function listTasks(): Task[] {
  return load().sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    return a.order - b.order;
  });
}

export function getTask(id: string): Task | undefined {
  return load().find((t) => t.id === id);
}

export function createTask(title: string): Task {
  const tasks = load();
  // Bump order of all existing active tasks to make room at top
  for (const t of tasks) {
    if (t.status === "active") t.order++;
  }
  const task: Task = {
    id: crypto.randomUUID(),
    title,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionIds: [],
    workItems: [],
    pullRequests: [],
  };
  tasks.push(task);
  save(tasks);
  return task;
}

export function updateTask(id: string, updates: TaskUpdate): Task {
  const tasks = load();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Task ${id} not found`);

  const task = tasks[idx];
  const oldStatus = task.status;
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.notes !== undefined) task.notes = updates.notes;
  if (updates.priority !== undefined) task.priority = updates.priority;
  if (updates.cwd !== undefined) task.cwd = updates.cwd || undefined;
  if (updates.groupId !== undefined) task.groupId = updates.groupId || undefined;
  task.updatedAt = new Date().toISOString();

  // When status changes, place task at top of new group
  if (updates.status !== undefined && updates.status !== oldStatus) {
    for (const t of tasks) {
      if (t.status === updates.status && t.id !== id) t.order++;
    }
    task.order = 0;
  }

  tasks[idx] = task;
  save(tasks);
  return task;
}

export function deleteTask(id: string): void {
  const tasks = load().filter((t) => t.id !== id);
  save(tasks);
}

export function reorderTasks(taskIds: string[]): Task[] {
  const tasks = load();
  for (let i = 0; i < taskIds.length; i++) {
    const t = tasks.find((t) => t.id === taskIds[i]);
    if (t) t.order = i;
  }
  save(tasks);
  return listTasks();
}

// ── Link/Unlink ───────────────────────────────────────────────────

export function linkSession(taskId: string, sessionId: string): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!task.sessionIds.includes(sessionId)) {
    task.sessionIds.push(sessionId);
    task.updatedAt = new Date().toISOString();
    save(tasks);
  }
  return task;
}

export function unlinkSession(taskId: string, sessionId: string): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.sessionIds = task.sessionIds.filter((s) => s !== sessionId);
  task.updatedAt = new Date().toISOString();
  save(tasks);
  return task;
}

export function linkWorkItem(taskId: string, workItemId: number, provider: ProviderName = "ado"): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!task.workItems.some((w) => w.id === workItemId && w.provider === provider)) {
    task.workItems.push({ id: workItemId, provider });
    task.updatedAt = new Date().toISOString();
    save(tasks);
  }
  return task;
}

export function unlinkWorkItem(taskId: string, workItemId: number, provider?: ProviderName): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.workItems = task.workItems.filter(
    (w) => !(w.id === workItemId && (!provider || w.provider === provider)),
  );
  task.updatedAt = new Date().toISOString();
  save(tasks);
  return task;
}

export function findTaskBySessionId(sessionId: string): Task | undefined {
  return load().find((t) => t.sessionIds.includes(sessionId));
}

export function linkPR(taskId: string, pr: PRRef): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!task.pullRequests.some((p) => p.repoId === pr.repoId && p.prId === pr.prId && p.provider === pr.provider)) {
    task.pullRequests.push(pr);
    task.updatedAt = new Date().toISOString();
    save(tasks);
  }
  return task;
}

export function unlinkPR(taskId: string, repoId: string, prId: number, provider?: ProviderName): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.pullRequests = task.pullRequests.filter(
    (p) => !(p.repoId === repoId && p.prId === prId && (!provider || p.provider === provider)),
  );
  task.updatedAt = new Date().toISOString();
  save(tasks);
  return task;
}
