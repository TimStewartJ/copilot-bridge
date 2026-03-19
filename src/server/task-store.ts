import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const TASKS_FILE = join(DATA_DIR, "tasks.json");

// ── Types ─────────────────────────────────────────────────────────

export interface PRLink {
  repoId: string;
  repoName?: string;
  prId: number;
}

export interface Task {
  id: string;
  title: string;
  status: "active" | "paused" | "done";
  notes: string;
  priority: number; // lower = higher priority
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  workItemIds: number[];
  pullRequests: PRLink[];
}

type TaskUpdate = Partial<Pick<Task, "title" | "status" | "notes" | "priority">>;

// ── Persistence ───────────────────────────────────────────────────

function load(): Task[] {
  if (!existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
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
  return load().sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function getTask(id: string): Task | undefined {
  return load().find((t) => t.id === id);
}

export function createTask(title: string): Task {
  const tasks = load();
  const task: Task = {
    id: crypto.randomUUID(),
    title,
    status: "active",
    notes: "",
    priority: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionIds: [],
    workItemIds: [],
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
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.notes !== undefined) task.notes = updates.notes;
  if (updates.priority !== undefined) task.priority = updates.priority;
  task.updatedAt = new Date().toISOString();

  tasks[idx] = task;
  save(tasks);
  return task;
}

export function deleteTask(id: string): void {
  const tasks = load().filter((t) => t.id !== id);
  save(tasks);
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

export function linkWorkItem(taskId: string, workItemId: number): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!task.workItemIds.includes(workItemId)) {
    task.workItemIds.push(workItemId);
    task.updatedAt = new Date().toISOString();
    save(tasks);
  }
  return task;
}

export function unlinkWorkItem(taskId: string, workItemId: number): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.workItemIds = task.workItemIds.filter((w) => w !== workItemId);
  task.updatedAt = new Date().toISOString();
  save(tasks);
  return task;
}

export function linkPR(taskId: string, pr: PRLink): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!task.pullRequests.some((p) => p.repoId === pr.repoId && p.prId === pr.prId)) {
    task.pullRequests.push(pr);
    task.updatedAt = new Date().toISOString();
    save(tasks);
  }
  return task;
}

export function unlinkPR(taskId: string, repoId: string, prId: number): Task {
  const tasks = load();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.pullRequests = task.pullRequests.filter(
    (p) => !(p.repoId === repoId && p.prId === prId),
  );
  task.updatedAt = new Date().toISOString();
  save(tasks);
  return task;
}
