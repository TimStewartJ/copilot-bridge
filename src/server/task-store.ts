import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";
import type { RuntimePaths } from "./runtime-paths.js";

// ── Types ─────────────────────────────────────────────────────────

import type { ProviderName } from "./providers/types.js";
import { canonicalizeGitHubWorkItemId } from "./providers/github.js";

export class InvalidTaskUpdateError extends Error {}
type TaskStatus = "active" | "done" | "archived";
const ACTIVE_TASK_MOMENTUM_ERROR = "nextAction, waitingOn, and nextTouchAt can only be set on active tasks";
const ARCHIVED_TASK_RECOMPLETE_ERROR = "Archived tasks cannot be completed again; reopen the task first";

const ISO_TIMESTAMP_WITH_TIMEZONE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

export interface WorkItemRef {
  id: string;
  provider: ProviderName;
}

export interface PRRef {
  repoId: string;
  repoName?: string;
  prId: number;
  provider: ProviderName;
}

export type TaskKind = "task" | "ongoing";

export interface Task {
  id: string;
  title: string;
  kind: TaskKind;
  muted: boolean;
  status: TaskStatus;
  groupId?: string;
  cwd?: string;
  notes: string;
  doneWhen?: string;
  nextAction?: string;
  waitingOn?: string;
  nextTouchAt?: string;
  priority: number;
  order: number;
  createdAt: string;
  completedAt?: string;
  updatedAt: string;
  sessionIds: string[];
  workItems: WorkItemRef[];
  pullRequests: PRRef[];
}

export type TaskCompletionAction = "complete-and-archive";

export function areSessionUnreadBubblesMuted(tasks: Task[]): boolean {
  const visibleLinkedTasks = tasks.filter((task) => task.status !== "archived");
  return visibleLinkedTasks.length > 0 && visibleLinkedTasks.every((task) => task.muted);
}

type TaskUpdate = {
  title?: string;
  kind?: TaskKind;
  muted?: boolean;
  status?: Task["status"];
  notes?: string;
  priority?: number;
  cwd?: string | null;
  groupId?: string | null;
  doneWhen?: string | null;
  nextAction?: string | null;
  waitingOn?: string | null;
  nextTouchAt?: string | null;
  completionAction?: TaskCompletionAction;
};

const STATUS_ORDER: Record<Task["status"], number> = {
  active: 0,
  done: 1,
  archived: 2,
};

function compareOngoingFirst(a: Pick<Task, "kind">, b: Pick<Task, "kind">): number {
  if (a.kind === b.kind) return 0;
  return a.kind === "ongoing" ? -1 : 1;
}

export function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function normalizeStoredTaskStatus(value: unknown): TaskStatus {
  if (value === "active" || value === "paused") return "active";
  if (value === "done" || value === "archived") return value;
  throw new Error(`Unsupported task status: ${String(value)}`);
}

function normalizeUpdatedTaskStatus(value: unknown): TaskStatus {
  if (value === "active" || value === "paused") return "active";
  if (value === "done" || value === "archived") return value;
  throw new InvalidTaskUpdateError("status must be one of: active, done, archived");
}

function normalizeTaskKind(value: unknown, opts: { strict?: boolean } = {}): TaskKind {
  if (value === "task" || value === "ongoing") return value;
  if (opts.strict) throw new InvalidTaskUpdateError("kind must be either 'task' or 'ongoing'");
  return "task";
}

function assertTaskInvariants(task: Pick<Task, "kind" | "status" | "doneWhen">): void {
  if (task.kind !== "ongoing") return;
  if (task.status === "done") throw new InvalidTaskUpdateError("Ongoing tasks cannot be marked done");
  if (task.doneWhen !== undefined) throw new InvalidTaskUpdateError("Ongoing tasks cannot keep doneWhen");
}

function normalizeCompletionAction(value: unknown): TaskCompletionAction | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "complete-and-archive") return value;
  throw new InvalidTaskUpdateError("completionAction must be 'complete-and-archive'");
}

function normalizeTaskMutedUpdate(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new InvalidTaskUpdateError("muted must be a boolean");
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, -1, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function parseIsoTimestampWithTimezone(text: string): string | undefined {
  const match = ISO_TIMESTAMP_WITH_TIMEZONE_RE.exec(text);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));

  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour < 0 || hour > 23
    || minute < 0 || minute > 59
    || second < 0 || second > 59
  ) {
    return undefined;
  }

  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
    const sign = match[9] === "-" ? -1 : 1;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (year >= 0 && year < 100) utcDate.setUTCFullYear(year);
  const utcMillis = utcDate.getTime() - offsetMinutes * 60_000;
  return new Date(utcMillis).toISOString();
}

export function normalizeOptionalTimestamp(value: unknown, opts: { strict?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    if (opts.strict) throw new InvalidTaskUpdateError("nextTouchAt must be a valid ISO timestamp with timezone");
    return undefined;
  }
  const text = value.trim();
  if (text === "") return undefined;
  const normalized = parseIsoTimestampWithTimezone(text);
  if (!normalized) {
    if (opts.strict) throw new InvalidTaskUpdateError("nextTouchAt must be a valid ISO timestamp with timezone");
    return undefined;
  }
  return normalized;
}

// ── Factory ───────────────────────────────────────────────────────

export function createTaskStore(
  db: DatabaseSync,
  bus: GlobalBus,
  _opts: { runtimePaths?: RuntimePaths } = {},
) {
  function defaultTaskCwd(): string | undefined {
    return undefined;
  }

  function hydrate(row: any): Task {
    const id = row.id;
    const sessions = db.prepare("SELECT sessionId FROM task_sessions WHERE taskId = ? ORDER BY linkedAt ASC").all(id) as any[];
    const workItems = db.prepare("SELECT itemId as id, provider FROM task_work_items WHERE taskId = ?").all(id) as any[];
    const prs = db.prepare("SELECT repoId, repoName, prId, provider FROM task_pull_requests WHERE taskId = ?").all(id) as any[];

    return {
      id,
      title: row.title,
      kind: normalizeTaskKind(row.kind),
      muted: row.muted === 1 || row.muted === true,
      status: normalizeStoredTaskStatus(row.status),
      groupId: row.groupId ?? undefined,
      cwd: row.cwd ?? undefined,
      notes: row.notes,
      doneWhen: normalizeOptionalText(row.doneWhen),
      nextAction: normalizeOptionalText(row.nextAction),
      waitingOn: normalizeOptionalText(row.waitingOn),
      nextTouchAt: normalizeOptionalTimestamp(row.nextTouchAt),
      priority: row.priority,
      order: row.order,
      createdAt: row.createdAt,
      completedAt: normalizeOptionalTimestamp(row.completedAt),
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
      const kindDiff = compareOngoingFirst(a, b);
      if (kindDiff !== 0) return kindDiff;
      return a.order - b.order;
    });
  }

  function getTask(id: string): Task | undefined {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function createTask(title: string, groupId?: string, kind?: TaskKind): Task {
    const normalizedKind = kind === undefined ? "task" : normalizeTaskKind(kind, { strict: true });

    // Bump order of all existing active tasks to make room at top
    db.prepare('UPDATE tasks SET "order" = "order" + 1 WHERE status = \'active\'').run();

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const cwd = defaultTaskCwd();

    db.prepare(`
      INSERT INTO tasks (id, title, kind, status, notes, priority, "order", groupId, cwd, createdAt, updatedAt)
      VALUES (?, ?, ?, 'active', '', 0, 0, ?, ?, ?, ?)
    `).run(id, title, normalizedKind, groupId || null, cwd ?? null, now, now);

    const task = getTask(id)!;
    emitChange(id);
    return task;
  }

  function updateTask(id: string, updates: TaskUpdate): Task {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Task ${id} not found`);

    const oldStatus = normalizeStoredTaskStatus(row.status);
    const oldCompletedAt = normalizeOptionalTimestamp(row.completedAt);
    const completionAction = normalizeCompletionAction(updates.completionAction);
    const legacyDoneRequested = updates.status === "done";
    if (completionAction && updates.status !== undefined) {
      throw new InvalidTaskUpdateError("completionAction cannot be combined with status");
    }
    const now = new Date().toISOString();
    const hasDoneWhenUpdate = updates.doneWhen !== undefined;
    const hasNextActionUpdate = updates.nextAction !== undefined;
    const hasWaitingOnUpdate = updates.waitingOn !== undefined;
    const hasNextTouchAtUpdate = updates.nextTouchAt !== undefined;
    const currentKind = normalizeTaskKind(row.kind);
    const nextKind = updates.kind !== undefined
      ? normalizeTaskKind(updates.kind, { strict: true })
      : currentKind;
    if (nextKind === "ongoing" && legacyDoneRequested) {
      throw new InvalidTaskUpdateError("Ongoing tasks cannot be marked done");
    }
    if (nextKind === "ongoing" && completionAction === "complete-and-archive") {
      throw new InvalidTaskUpdateError("Ongoing tasks cannot be completed");
    }
    if ((completionAction === "complete-and-archive" || legacyDoneRequested) && oldStatus === "archived") {
      throw new InvalidTaskUpdateError(ARCHIVED_TASK_RECOMPLETE_ERROR);
    }
    const completeAndArchiveRequested = completionAction === "complete-and-archive" || legacyDoneRequested;
    const switchingToOngoing = nextKind === "ongoing" && currentKind !== "ongoing";
    const requestedStatus = updates.status !== undefined
      ? normalizeUpdatedTaskStatus(updates.status)
      : undefined;
    const targetStatus = completeAndArchiveRequested
      ? "archived"
      : (requestedStatus
      ?? (switchingToOngoing && (oldStatus === "done" || oldCompletedAt !== undefined)
        ? "active"
        : oldStatus));
    const shouldPersistStatus = completeAndArchiveRequested
      || requestedStatus !== undefined
      || (switchingToOngoing && (oldStatus === "done" || oldCompletedAt !== undefined));
    const shouldPersistDoneWhen = hasDoneWhenUpdate
      || (switchingToOngoing && row.doneWhen !== null && row.doneWhen !== undefined);
    const doneWhen = hasDoneWhenUpdate ? normalizeOptionalText(updates.doneWhen) ?? null : undefined;
    const nextDoneWhen = hasDoneWhenUpdate
      ? doneWhen ?? undefined
      : switchingToOngoing
        ? undefined
        : normalizeOptionalText(row.doneWhen);

    assertTaskInvariants({
      kind: nextKind,
      status: targetStatus,
      doneWhen: nextDoneWhen,
    });
    const fields: string[] = ["updatedAt = ?"];
    const values: any[] = [now];

    if (updates.title !== undefined) { fields.push("title = ?"); values.push(updates.title); }
    if (updates.kind !== undefined) { fields.push("kind = ?"); values.push(nextKind); }
    if (updates.muted !== undefined) { fields.push("muted = ?"); values.push(normalizeTaskMutedUpdate(updates.muted) ? 1 : 0); }
    if (shouldPersistStatus) { fields.push("status = ?"); values.push(targetStatus); }
    if (updates.notes !== undefined) { fields.push("notes = ?"); values.push(updates.notes); }
    if (updates.priority !== undefined) { fields.push("priority = ?"); values.push(updates.priority); }
    if (updates.cwd !== undefined) { fields.push("cwd = ?"); values.push(updates.cwd || null); }
    if (updates.groupId !== undefined) { fields.push("groupId = ?"); values.push(updates.groupId || null); }
    const nextAction = hasNextActionUpdate ? normalizeOptionalText(updates.nextAction) ?? null : undefined;
    const waitingOn = hasWaitingOnUpdate ? normalizeOptionalText(updates.waitingOn) ?? null : undefined;
    const nextTouchAt = hasNextTouchAtUpdate
      ? normalizeOptionalTimestamp(updates.nextTouchAt, { strict: true }) ?? null
      : undefined;
    const isSettingActiveTaskMomentum = nextAction !== undefined && nextAction !== null
      || waitingOn !== undefined && waitingOn !== null
      || nextTouchAt !== undefined && nextTouchAt !== null;

    if (targetStatus !== "active" && isSettingActiveTaskMomentum) {
      throw new InvalidTaskUpdateError(ACTIVE_TASK_MOMENTUM_ERROR);
    }

    if (shouldPersistDoneWhen) { fields.push("doneWhen = ?"); values.push(hasDoneWhenUpdate ? doneWhen : null); }
    if (hasNextActionUpdate) { fields.push("nextAction = ?"); values.push(nextAction); }
    if (hasWaitingOnUpdate) { fields.push("waitingOn = ?"); values.push(waitingOn); }
    if (hasNextTouchAtUpdate) { fields.push("nextTouchAt = ?"); values.push(nextTouchAt); }

    if (targetStatus !== "active") {
      if (!hasNextActionUpdate) { fields.push("nextAction = ?"); values.push(null); }
      if (!hasWaitingOnUpdate) { fields.push("waitingOn = ?"); values.push(null); }
      if (!hasNextTouchAtUpdate) { fields.push("nextTouchAt = ?"); values.push(null); }
    }

    // When status changes, place task at top of new group
    if (shouldPersistStatus && targetStatus !== oldStatus) {
      db.prepare(`UPDATE tasks SET "order" = "order" + 1 WHERE status = ? AND id != ?`).run(targetStatus, id);
      fields.push('"order" = ?');
      values.push(0);
    }

    if (completeAndArchiveRequested) {
      fields.push("completedAt = ?");
      values.push(oldCompletedAt ?? now);
    } else if (switchingToOngoing) {
      fields.push("completedAt = ?");
      values.push(null);
    } else if (shouldPersistStatus && targetStatus !== oldStatus) {
      let nextCompletedAt = oldCompletedAt;
      if (targetStatus === "active") {
        nextCompletedAt = undefined;
      }
      fields.push("completedAt = ?");
      values.push(nextCompletedAt ?? null);
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

  /** Session IDs linked to a task, oldest link first. */
  function listSessionIdsForTask(id: string): string[] {
    return (db
      .prepare("SELECT sessionId FROM task_sessions WHERE taskId = ? ORDER BY linkedAt ASC")
      .all(id) as Array<{ sessionId: string }>).map((row) => row.sessionId);
  }

  /**
   * Counts backing the delete-confirmation dialog, in one query.
   *
   * The client cannot derive these: its session list is noise-filtered and
   * excludes archived sessions, so it would undercount badly.
   */
  function getTaskSessionCounts(id: string): { total: number; archived: number; shared: number } {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN COALESCE(b.archived, 0) = 1 THEN 1 ELSE 0 END), 0) AS archived,
        COALESCE(SUM(CASE WHEN EXISTS (
          SELECT 1 FROM task_sessions other
          WHERE other.sessionId = ts.sessionId AND other.taskId != ts.taskId
        ) THEN 1 ELSE 0 END), 0) AS shared
      FROM task_sessions ts
      LEFT JOIN bridge_session_state b ON b.sessionId = ts.sessionId
      WHERE ts.taskId = ?
    `).get(id) as { total: number; archived: number; shared: number } | undefined;
    return {
      total: Number(row?.total ?? 0),
      archived: Number(row?.archived ?? 0),
      shared: Number(row?.shared ?? 0),
    };
  }

  /**
   * Session IDs linked to this task and to no other task.
   *
   * Deleting a session unlinks it from *every* task, so a bulk "delete the
   * task's sessions" must not reach sessions another task still owns. Callers
   * delete these and merely unlink the rest.
   */
  function listExclusiveSessionIdsForTask(id: string): string[] {
    return (db.prepare(`
      SELECT ts.sessionId FROM task_sessions ts
      WHERE ts.taskId = ?
        AND NOT EXISTS (
          SELECT 1 FROM task_sessions other
          WHERE other.sessionId = ts.sessionId AND other.taskId != ts.taskId
        )
      ORDER BY ts.linkedAt ASC
    `).all(id) as Array<{ sessionId: string }>).map((row) => row.sessionId);
  }

  /**
   * Delete the task's owned rows. Must run inside an open transaction.
   *
   * `schedules.taskId` has no foreign key, so schedule rows do not cascade with
   * the task. Neither do `entity_tags` rows. Both are deleted here — rather than
   * through `ScheduleStore`/`TagStore` — so the parent and everything it owns
   * commit or roll back together; SQLite has no nested transactions, so the
   * cascade cannot be split across stores that each own a transaction.
   */
  function cascadeWithinTransaction(id: string): string[] {
    const deletedScheduleIds = (db
      .prepare("SELECT id FROM schedules WHERE taskId = ?")
      .all(id) as Array<{ id: string }>).map((row) => row.id);
    for (const scheduleId of deletedScheduleIds) {
      db.prepare("DELETE FROM schedule_run_claims WHERE scheduleId = ?").run(scheduleId);
      db.prepare("DELETE FROM schedule_runs WHERE scheduleId = ?").run(scheduleId);
      // Sessions that survive the task keep `scheduleName` as provenance, but a
      // `scheduleId` pointing at a deleted schedule is a dangling reference.
      db.prepare(`
        UPDATE bridge_session_state
        SET scheduleId = NULL, updatedAt = ?
        WHERE scheduleId = ?
      `).run(new Date().toISOString(), scheduleId);
    }
    db.prepare("DELETE FROM schedules WHERE taskId = ?").run(id);
    db.prepare("DELETE FROM entity_tags WHERE entityType = 'task' AND entityId = ?").run(id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return deletedScheduleIds;
  }

  /**
   * Delete a task and every child schedule (plus that schedule's run history and
   * claims) in one transaction, returning the deleted schedule IDs so the caller
   * can unregister their timers.
   */
  function deleteTaskCascade(id: string): { deletedScheduleIds: string[] } {
    db.exec("BEGIN");
    let deletedScheduleIds: string[];
    try {
      deletedScheduleIds = cascadeWithinTransaction(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    emitChange(id);
    return { deletedScheduleIds };
  }

  /**
   * Archive every session linked to a task and delete the task in one
   * transaction.
   *
   * Archiving is pure SQLite, so it can commit atomically with the cascade —
   * the task can never be left alive with its sessions unexpectedly archived,
   * and sessions can never be archived for a task that survived. Callers still
   * own the non-transactional side effects (timer unregistration, events).
   */
  function archiveSessionsAndDeleteTask(id: string): {
    deletedScheduleIds: string[];
    archivedSessionIds: string[];
  } {
    db.exec("BEGIN");
    let deletedScheduleIds: string[];
    let archivedSessionIds: string[];
    try {
      archivedSessionIds = (db
        .prepare("SELECT sessionId FROM task_sessions WHERE taskId = ? ORDER BY linkedAt ASC")
        .all(id) as Array<{ sessionId: string }>).map((row) => row.sessionId);
      const now = new Date().toISOString();
      const archive = db.prepare(`
        INSERT INTO bridge_session_state (sessionId, archived, archivedAt, createdAt, updatedAt)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(sessionId) DO UPDATE SET
          archived = 1,
          archivedAt = excluded.archivedAt,
          updatedAt = excluded.updatedAt
      `);
      for (const sessionId of archivedSessionIds) archive.run(sessionId, now, now, now);
      deletedScheduleIds = cascadeWithinTransaction(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    emitChange(id);
    return { deletedScheduleIds, archivedSessionIds };
  }

  /**
   * Remove a session link from every task that has it, in one transaction, and
   * return the affected task IDs. Replaces the caller-side
   * `listTasks()` → filter → per-task `unlinkSession()` loop, which rehydrated
   * every task (three relation queries each) just to find matches.
   */
  function unlinkSessionFromAllTasks(sessionId: string): string[] {
    const affectedTaskIds = (db
      .prepare("SELECT taskId FROM task_sessions WHERE sessionId = ?")
      .all(sessionId) as Array<{ taskId: string }>).map((row) => row.taskId);
    if (affectedTaskIds.length === 0) return [];

    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM task_sessions WHERE sessionId = ?").run(sessionId);
      const touch = db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?");
      for (const taskId of affectedTaskIds) touch.run(now, taskId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    for (const taskId of affectedTaskIds) emitChange(taskId);
    return affectedTaskIds;
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

  /** Normalize numeric-looking IDs (e.g. "00123" → "123") and GitHub refs (URL → "owner/repo#123") */
  function normalizeWorkItemId(id: string): string {
    const trimmed = canonicalizeGitHubWorkItemId(id);
    if (/^\d+$/.test(trimmed)) return String(Number(trimmed));
    return trimmed;
  }

  function linkWorkItem(taskId: string, workItemId: string, provider: ProviderName = "ado"): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const normalizedId = normalizeWorkItemId(workItemId);
    const existing = db.prepare("SELECT 1 FROM task_work_items WHERE taskId = ? AND itemId = ? AND provider = ?").get(taskId, normalizedId, provider);
    if (!existing) {
      db.prepare("INSERT INTO task_work_items (taskId, itemId, provider) VALUES (?, ?, ?)").run(taskId, normalizedId, provider);
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      emitChange(taskId);
    }
    return getTask(taskId)!;
  }

  function unlinkWorkItem(taskId: string, workItemId: string, provider?: ProviderName): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const normalizedId = normalizeWorkItemId(workItemId);
    if (provider) {
      db.prepare("DELETE FROM task_work_items WHERE taskId = ? AND itemId = ? AND provider = ?").run(taskId, normalizedId, provider);
    } else {
      db.prepare("DELETE FROM task_work_items WHERE taskId = ? AND itemId = ?").run(taskId, normalizedId);
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
    listTasks, getTask, createTask, updateTask, deleteTask, deleteTaskCascade, reorderTasks,
    archiveSessionsAndDeleteTask, listSessionIdsForTask, listExclusiveSessionIdsForTask,
    getTaskSessionCounts,
    linkSession, unlinkSession, unlinkSessionFromAllTasks, linkWorkItem, unlinkWorkItem,
    findTaskBySessionId, linkPR, unlinkPR,
  };
}

export type TaskStore = ReturnType<typeof createTaskStore>;
