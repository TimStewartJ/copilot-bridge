import { isPlaybookName } from "../shared/workflow-vocabulary.js";
import type { MomentumFieldStamp } from "../shared/momentum-age.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";
import type { RuntimePaths } from "./runtime-paths.js";

// ── Types ─────────────────────────────────────────────────────────

import type { ProviderName } from "./providers/types.js";
import { runTransaction } from "./db-transaction.js";
import { normalizeWorkItemIdValue } from "./work-item-id.js";

export class InvalidTaskUpdateError extends Error {}
type TaskStatus = "active" | "archived";
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
  deferred: boolean;
  status: TaskStatus;
  /** When the user last opened the task in the UI. Not a task change: it never bumps updatedAt. */
  groupId?: string;
  cwd?: string;
  /** Current state of the work, delivered with user messages. */
  notes: string;
  /** Standing rules for every session of this task, part of the system prompt. */
  instructions?: string;
  /** The playbook every chat of this task follows unless the user or agent picks another. */
  playbook?: string;
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

/** The browser's view of a task's sessions; the full id list stays on the server. */
export interface TaskSessionSummary {
  /** Linked sessions that are not archived, oldest link first. */
  activeSessionIds: string[];
  sessionCount: number;
  archivedSessionCount: number;
  /** Changes whenever a session is linked or unlinked, even when the count does not. */
  sessionLinksRevision: string;
}

/** One task a session is linked to, with the only task field the session list needs. */
export interface SessionTaskLink {
  id: string;
  cwd?: string;
}

/** A task without its session links, which can number thousands and most readers skip. */
export type TaskWithoutSessions = Omit<Task, "sessionIds">;

export type ClientTask<T extends TaskWithoutSessions = Task> = Omit<T, "sessionIds"> & TaskSessionSummary;

const EMPTY_SESSION_LINKS_REVISION = createHash("sha1").digest("hex").slice(0, 16);

export function toClientTask<T extends TaskWithoutSessions>(
  task: T & { sessionIds?: string[] },
  summary: TaskSessionSummary | undefined,
): ClientTask<T> {
  const { sessionIds: _sessionIds, ...rest } = task;
  return {
    ...(rest as unknown as Omit<T, "sessionIds">),
    ...(summary ?? {
      activeSessionIds: [],
      sessionCount: 0,
      archivedSessionCount: 0,
      sessionLinksRevision: EMPTY_SESSION_LINKS_REVISION,
    }),
  };
}

export type TaskCompletionAction = "complete-and-archive";

export const TASK_MOMENTUM_FIELDS = ["nextAction", "waitingOn", "nextTouchAt", "deferred", "doneWhen"] as const;
export type TaskMomentumField = typeof TASK_MOMENTUM_FIELDS[number];
export type TaskChangeSource = "agent" | "user" | "system";

/** Title the client gives a task created without one. */
export const PLACEHOLDER_TASK_TITLE = "New Task";
const TITLE_HISTORY_PREVIEW_CHARS = 300;

/** Who is changing a task, recorded on momentum audit events. */
export interface TaskChangeActor {
  source: TaskChangeSource;
  sessionId?: string;
  scheduleId?: string;
  scheduleName?: string;
}

export interface TaskMomentumChange {
  field: TaskMomentumField;
  before: string | boolean | null;
  after: string | boolean | null;
  /** Original length, present only when the stored value was truncated to a preview. */
  beforeLength?: number;
  afterLength?: number;
}

export interface TaskMomentumEvent {
  id: number;
  taskId: string;
  at: string;
  source: TaskChangeSource;
  sessionId?: string;
  scheduleId?: string;
  scheduleName?: string;
  changes: TaskMomentumChange[];
}

/** Newest audit events kept per task. */
export const TASK_MOMENTUM_EVENTS_KEEP = 200;
/** Values are stored as bounded previews so run-log-sized writes cannot bloat history. */
export const TASK_MOMENTUM_EVENT_PREVIEW_CHARS = 500;
export const TASK_MOMENTUM_EVENTS_MAX_LIMIT = 100;

/** `removed` is false when no row matched, so callers can report a no-op honestly. */
export interface UnlinkWorkItemResult {
  task: Task;
  removed: boolean;
}

export const TASK_UPDATE_FIELDS = [
  "title",
  "kind",
  "muted",
  "deferred",
  "status",
  "notes",
  "instructions",
  "playbook",
  "priority",
  "cwd",
  "groupId",
  "doneWhen",
  "nextAction",
  "waitingOn",
  "nextTouchAt",
  "completionAction",
] as const;

type TaskUpdate = {
  title?: string;
  kind?: TaskKind;
  muted?: boolean;
  deferred?: boolean;
  status?: Task["status"];
  notes?: string;
  instructions?: string;
  playbook?: string | null;
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
  archived: 1,
};

function compareOngoingFirst(a: Pick<Task, "kind">, b: Pick<Task, "kind">): number {
  if (a.kind === b.kind) return 0;
  return a.kind === "ongoing" ? -1 : 1;
}

/** The order of the task list: active before archived, ongoing first, then the user's order. */
function compareTaskListOrder(a: Pick<Task, "status" | "kind" | "order">, b: Pick<Task, "status" | "kind" | "order">): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || compareOngoingFirst(a, b) || a.order - b.order;
}

export function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function normalizeStoredTaskStatus(value: unknown): TaskStatus {
  if (value === "active" || value === "archived") return value;
  throw new Error(`Unsupported task status: ${String(value)}`);
}

function normalizeUpdatedTaskStatus(value: unknown): TaskStatus {
  if (value === "active" || value === "archived") return value;
  throw new InvalidTaskUpdateError("status must be one of: active, archived");
}

function normalizeTaskKind(value: unknown, opts: { strict?: boolean } = {}): TaskKind {
  if (value === "task" || value === "ongoing") return value;
  if (opts.strict) throw new InvalidTaskUpdateError("kind must be either 'task' or 'ongoing'");
  return "task";
}

function assertTaskInvariants(task: Pick<Task, "kind" | "doneWhen">): void {
  if (task.kind !== "ongoing") return;
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

function normalizeTaskPriority(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  throw new InvalidTaskUpdateError("priority must be a finite integer");
}

function normalizeTaskGroupId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new InvalidTaskUpdateError("groupId must be a string or null");
  const groupId = value.trim();
  return groupId === "" ? null : groupId;
}

function assertTaskGroupExists(db: DatabaseSync, groupId: string | null | undefined): void {
  if (groupId === undefined || groupId === null) return;
  if (!db.prepare("SELECT 1 FROM task_groups WHERE id = ?").get(groupId)) {
    throw new InvalidTaskUpdateError(`Task group ${groupId} not found`);
  }
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

// ── Momentum audit ────────────────────────────────────────────────

type MomentumSnapshot = Record<TaskMomentumField, string | boolean | null>;

function readMomentumSnapshot(db: DatabaseSync, id: string): MomentumSnapshot | undefined {
  const row = db.prepare("SELECT nextAction, waitingOn, nextTouchAt, deferred, doneWhen FROM tasks WHERE id = ?").get(id) as Record<TaskMomentumField, unknown> | undefined;
  if (!row) return undefined;
  return {
    nextAction: normalizeOptionalText(row.nextAction) ?? null,
    waitingOn: normalizeOptionalText(row.waitingOn) ?? null,
    nextTouchAt: normalizeOptionalTimestamp(row.nextTouchAt) ?? null,
    deferred: row.deferred === 1 || row.deferred === true,
    doneWhen: normalizeOptionalText(row.doneWhen) ?? null,
  };
}

function previewMomentumValue(value: string | boolean | null): { value: string | boolean | null; length?: number } {
  if (typeof value !== "string" || value.length <= TASK_MOMENTUM_EVENT_PREVIEW_CHARS) return { value };
  return { value: value.slice(0, TASK_MOMENTUM_EVENT_PREVIEW_CHARS), length: value.length };
}

function diffMomentumSnapshots(before: MomentumSnapshot, after: MomentumSnapshot): TaskMomentumChange[] {
  const changes: TaskMomentumChange[] = [];
  for (const field of TASK_MOMENTUM_FIELDS) {
    if (before[field] === after[field]) continue;
    const b = previewMomentumValue(before[field]);
    const a = previewMomentumValue(after[field]);
    changes.push({
      field,
      before: b.value,
      after: a.value,
      ...(b.length !== undefined ? { beforeLength: b.length } : {}),
      ...(a.length !== undefined ? { afterLength: a.length } : {}),
    });
  }
  return changes;
}

function normalizeActorText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function recordMomentumEvent(
  db: DatabaseSync,
  taskId: string,
  at: string,
  actor: TaskChangeActor,
  changes: TaskMomentumChange[],
): void {
  db.prepare(`
    INSERT INTO task_momentum_events (taskId, at, source, sessionId, scheduleId, scheduleName, changesJson)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    at,
    actor.source,
    normalizeActorText(actor.sessionId),
    normalizeActorText(actor.scheduleId),
    normalizeActorText(actor.scheduleName),
    JSON.stringify(changes),
  );
  db.prepare(`
    DELETE FROM task_momentum_events
    WHERE taskId = ? AND id NOT IN (
      SELECT id FROM task_momentum_events WHERE taskId = ? ORDER BY id DESC LIMIT ?
    )
  `).run(taskId, taskId, TASK_MOMENTUM_EVENTS_KEEP);
}

function quoteTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return `"${flat.length > TITLE_HISTORY_PREVIEW_CHARS ? `${flat.slice(0, TITLE_HISTORY_PREVIEW_CHARS - 1)}…` : flat}"`;
}

// Renames go to task history so a wrong one is easy to undo; naming a placeholder is skipped.
function recordTitleChange(
  db: DatabaseSync,
  taskId: string,
  at: string,
  actor: TaskChangeActor,
  before: string,
  after: string,
): void {
  if (before === after || before === PLACEHOLDER_TASK_TITLE) return;
  const by = actor.source === "user" ? "the user" : actor.source === "agent" ? "an agent" : "Bridge";
  db.prepare(`
    INSERT INTO task_history_entries (taskId, at, source, sessionId, scheduleId, scheduleName, text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    at,
    actor.source,
    normalizeActorText(actor.sessionId),
    normalizeActorText(actor.scheduleId),
    normalizeActorText(actor.scheduleName),
    `Renamed by ${by} from ${quoteTitle(before)} to ${quoteTitle(after)}.`,
  );
}

function parseMomentumChanges(raw: unknown, eventId: unknown): TaskMomentumChange[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : undefined;
    if (Array.isArray(parsed)) return parsed.filter((change) => change && typeof change.field === "string");
  } catch {
    // Reported below.
  }
  console.warn(`[tasks] Momentum event ${String(eventId)} has unreadable changes; showing it without details`);
  return [];
}

// ── Factory ───────────────────────────────────────────────────────

type TaskRow = {
  id: string;
  title: string;
  kind: string;
  muted: number;
  deferred: number;
  status: string;
  groupId: string | null;
  cwd: string | null;
  notes: string;
  instructions: string | null;
  playbook: string | null;
  doneWhen: string | null;
  nextAction: string | null;
  waitingOn: string | null;
  nextTouchAt: string | null;
  priority: number;
  order: number;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
};

export function createTaskStore(
  db: DatabaseSync,
  bus: GlobalBus,
  opts: {
    runtimePaths?: RuntimePaths;
  } = {},
) {
  function defaultTaskCwd(): string | undefined {
    return undefined;
  }

  function hydrate(row: TaskRow): Task {
    const { workItems, pullRequests, ...task } = hydrateWithoutSessions(row);
    // Same key order as before the split, so task JSON (and its ETag) is unchanged.
    return { ...task, sessionIds: listSessionIdsForTask(row.id), workItems, pullRequests };
  }

  function hydrateWithoutSessions(row: TaskRow): TaskWithoutSessions {
    const id = row.id;
    const workItems = db.prepare("SELECT itemId as id, provider FROM task_work_items WHERE taskId = ?").all(id) as Array<{ id: string; provider: string }>;
    const prs = db.prepare("SELECT repoId, repoName, prId, provider FROM task_pull_requests WHERE taskId = ?").all(id) as Array<{
      repoId: string; repoName: string | null; prId: number; provider: string;
    }>;

    return {
      id,
      title: row.title,
      kind: normalizeTaskKind(row.kind),
      muted: row.muted === 1,
      deferred: row.deferred === 1,
      status: normalizeStoredTaskStatus(row.status),
      groupId: row.groupId ?? undefined,
      cwd: row.cwd ?? undefined,
      notes: row.notes,
      instructions: row.instructions ?? "",
      ...(isPlaybookName(row.playbook) ? { playbook: row.playbook } : {}),
      doneWhen: normalizeOptionalText(row.doneWhen),
      nextAction: normalizeOptionalText(row.nextAction),
      waitingOn: normalizeOptionalText(row.waitingOn),
      nextTouchAt: normalizeOptionalTimestamp(row.nextTouchAt),
      priority: row.priority,
      order: row.order,
      createdAt: row.createdAt,
      completedAt: normalizeOptionalTimestamp(row.completedAt),
      updatedAt: row.updatedAt,
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
    const rows = db.prepare('SELECT * FROM tasks ORDER BY status, "order"').all() as TaskRow[];
    return rows.map(hydrate).sort(compareTaskListOrder);
  }

  /** The task list without each task's session links, for readers that send or use none of them. */
  function listTasksWithoutSessions(): TaskWithoutSessions[] {
    const rows = db.prepare('SELECT * FROM tasks ORDER BY status, "order"').all() as TaskRow[];
    return rows.map(hydrateWithoutSessions).sort(compareTaskListOrder);
  }

  /** Each given session's linked tasks in list order; with no sessions named, reads every link. */
  function listTaskLinksBySession(sessionIds?: readonly string[]): Map<string, SessionTaskLink[]> {
    const links = new Map<string, Array<SessionTaskLink & Pick<Task, "status" | "kind" | "order">>>();
    if (sessionIds?.length === 0) return links;
    const select = `SELECT ts.sessionId, t.id, t.cwd, t.status, t.kind, t."order"
      FROM task_sessions ts JOIN tasks t ON t.id = ts.taskId`;
    const rows = (sessionIds
      ? db.prepare(`${select} WHERE ts.sessionId IN (SELECT value FROM json_each(?))`).all(JSON.stringify(sessionIds))
      : db.prepare(select).all()) as Array<{
      sessionId: string; id: string; cwd: string | null; status: string; kind: string; order: number;
    }>;
    for (const row of rows) {
      const link = {
        id: row.id as string,
        cwd: (row.cwd ?? undefined) as string | undefined,
        status: normalizeStoredTaskStatus(row.status),
        kind: normalizeTaskKind(row.kind),
        order: row.order as number,
      };
      const existing = links.get(row.sessionId);
      if (existing) existing.push(link);
      else links.set(row.sessionId, [link]);
    }
    for (const linked of links.values()) linked.sort(compareTaskListOrder);
    return links;
  }

  /** Records the user's own message or answer in a chat; feeds task states, not history. */
  function recordUserMessage(sessionId: string, at = new Date().toISOString()): void {
    db.prepare(`INSERT INTO session_user_messages (sessionId, lastSentAt) VALUES (?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET lastSentAt = excluded.lastSentAt WHERE excluded.lastSentAt > lastSentAt`).run(sessionId, at);
  }

  /** Per task: the user's latest edit and message, and when waiting-for last changed. */
  function listMomentumSignals(): Map<string, MomentumSignals> {
    const signals = new Map<string, MomentumSignals>();
    const add = (taskId: unknown, patch: MomentumSignals) => {
      const id = String(taskId);
      signals.set(id, { ...signals.get(id), ...patch });
    };
    for (const row of db.prepare("SELECT taskId, MAX(at) AS at FROM task_momentum_events WHERE source = 'user' GROUP BY taskId").all()) {
      add(row.taskId, { userEditedAt: String(row.at) });
    }
    for (const row of db.prepare(`SELECT ts.taskId, MAX(m.lastSentAt) AS at FROM task_sessions ts
      JOIN session_user_messages m ON m.sessionId = ts.sessionId GROUP BY ts.taskId`).all()) {
      add(row.taskId, { lastMessageAt: String(row.at) });
    }
    for (const [taskId, stamp] of latestFieldStamps("nextAction")) add(taskId, { nextActionSet: stamp });
    for (const [taskId, stamp] of latestFieldStamps("waitingOn")) add(taskId, { waitingOnSet: stamp, waitingChangedAt: stamp.at });
    return signals;
  }

  /** Per task, the latest audit event that changed `field`, optionally for one task only. */
  function latestFieldStamps(field: "nextAction" | "waitingOn", taskId?: string): Map<string, MomentumFieldStamp> {
    // Changes are JSON, so a value containing this text is escaped and cannot match.
    const pattern = `%"field":"${field}"%`;
    const rows = db.prepare(`SELECT e.taskId, e.at, e.source, e.sessionId, e.scheduleId, e.scheduleName
      FROM task_momentum_events e JOIN (
        SELECT MAX(id) AS id FROM task_momentum_events
        WHERE changesJson LIKE ? ${taskId ? "AND taskId = ?" : ""} GROUP BY taskId
      ) latest ON latest.id = e.id`).all(...(taskId ? [pattern, taskId] : [pattern])) as Array<{
      taskId: string; at: string; source: string; sessionId: string | null; scheduleId: string | null; scheduleName: string | null;
    }>;
    return new Map(rows.map((row) => [String(row.taskId), {
      at: String(row.at), source: row.source as TaskChangeSource,
      ...(row.sessionId ? { sessionId: String(row.sessionId) } : {}),
      ...(row.scheduleId ? { scheduleId: String(row.scheduleId) } : {}),
      ...(row.scheduleName ? { scheduleName: String(row.scheduleName) } : {}),
    }]));
  }

  /** When the task's current next step and waiting-for were set; null when there is no record. */
  function getMomentumFieldStamps(taskId: string): { nextAction: MomentumFieldStamp | null; waitingOn: MomentumFieldStamp | null } {
    return {
      nextAction: latestFieldStamps("nextAction", taskId).get(taskId) ?? null,
      waitingOn: latestFieldStamps("waitingOn", taskId).get(taskId) ?? null,
    };
  }

  function getTask(id: string): Task | undefined {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  /** IDs of tasks whose ID starts with these 8 characters, the short form agents copy around. */
  function findTaskIdsByShortId(shortId: string): string[] {
    const rows = db.prepare("SELECT id FROM tasks WHERE substr(id, 1, 8) = ? ORDER BY id").all(shortId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  function createTask(
    title: string,
    groupId?: string | null,
    kind?: TaskKind,
    workItems: ReadonlyArray<{ workItemId: string; provider: ProviderName }> = [],
  ): Task {
    const normalizedKind = kind === undefined ? "task" : normalizeTaskKind(kind, { strict: true });
    const normalizedGroupId = normalizeTaskGroupId(groupId);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const cwd = defaultTaskCwd();

    // One unit: a failure must not leave the order bump or a task without its links.
    runTransaction(db, () => {
      assertTaskGroupExists(db, normalizedGroupId);
      // Bump order of all existing active tasks to make room at top
      db.prepare('UPDATE tasks SET "order" = "order" + 1 WHERE status = \'active\'').run();

      db.prepare(`
        INSERT INTO tasks (id, title, kind, status, notes, priority, "order", groupId, cwd, createdAt, updatedAt)
        VALUES (?, ?, ?, 'active', '', 0, 0, ?, ?, ?, ?)
      `).run(id, title, normalizedKind, normalizedGroupId ?? null, cwd ?? null, now, now);

      const link = db.prepare("INSERT OR IGNORE INTO task_work_items (taskId, itemId, provider) VALUES (?, ?, ?)");
      for (const item of workItems) link.run(id, normalizeWorkItemId(item.workItemId), item.provider);
    });

    const task = getTask(id)!;
    emitChange(id);
    return task;
  }

  function updateTask(id: string, updates: TaskUpdate, actor: TaskChangeActor = { source: "system" }): Task {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!row) throw new Error(`Task ${id} not found`);
    for (const field of ["notes", "instructions"] as const) {
      if (updates[field] !== undefined && typeof updates[field] !== "string") {
        throw new InvalidTaskUpdateError(`${field} must be a string`);
      }
    }

    const oldStatus = normalizeStoredTaskStatus(row.status);
    const oldCompletedAt = normalizeOptionalTimestamp(row.completedAt);
    const completionAction = normalizeCompletionAction(updates.completionAction);
    const priority = updates.priority !== undefined ? normalizeTaskPriority(updates.priority) : undefined;
    const groupId = normalizeTaskGroupId(updates.groupId);
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
    const completeAndArchiveRequested = completionAction === "complete-and-archive";
    if (nextKind === "ongoing" && completeAndArchiveRequested) {
      throw new InvalidTaskUpdateError("Ongoing tasks cannot be completed");
    }
    if (completeAndArchiveRequested && oldStatus === "archived") {
      throw new InvalidTaskUpdateError(ARCHIVED_TASK_RECOMPLETE_ERROR);
    }
    const switchingToOngoing = nextKind === "ongoing" && currentKind !== "ongoing";
    const requestedStatus = updates.status !== undefined
      ? normalizeUpdatedTaskStatus(updates.status)
      : undefined;
    const targetStatus = completeAndArchiveRequested
      ? "archived"
      : (requestedStatus
      ?? (switchingToOngoing && oldCompletedAt !== undefined
        ? "active"
        : oldStatus));
    if (updates.deferred !== undefined && typeof updates.deferred !== "boolean") {
      throw new InvalidTaskUpdateError("deferred must be a boolean");
    }
    if (updates.deferred === true && targetStatus !== "active") {
      throw new InvalidTaskUpdateError("Only active tasks can be deferred");
    }
    const shouldPersistStatus = completeAndArchiveRequested
      || requestedStatus !== undefined
      || (switchingToOngoing && oldCompletedAt !== undefined);
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
      doneWhen: nextDoneWhen,
    });
    const fields: string[] = ["updatedAt = ?"];
    const values: Array<string | number | null> = [now];

    if (updates.title !== undefined) { fields.push("title = ?"); values.push(updates.title); }
    if (updates.kind !== undefined) { fields.push("kind = ?"); values.push(nextKind); }
    if (updates.muted !== undefined) { fields.push("muted = ?"); values.push(normalizeTaskMutedUpdate(updates.muted) ? 1 : 0); }
    if (updates.deferred !== undefined || targetStatus !== "active") {
      fields.push("deferred = ?");
      values.push(targetStatus === "active" && updates.deferred ? 1 : 0);
    }
    if (shouldPersistStatus) { fields.push("status = ?"); values.push(targetStatus); }
    if (updates.notes !== undefined) { fields.push("notes = ?"); values.push(updates.notes); }
    if (updates.instructions !== undefined) { fields.push("instructions = ?"); values.push(updates.instructions); }
    if (updates.playbook !== undefined) {
      const playbook = typeof updates.playbook === "string" ? updates.playbook.trim() : updates.playbook;
      if (playbook !== null && playbook !== "" && !isPlaybookName(playbook)) {
        throw new InvalidTaskUpdateError("playbook must be a playbook name or null");
      }
      fields.push("playbook = ?");
      values.push(playbook || null);
    }
    if (priority !== undefined) { fields.push("priority = ?"); values.push(priority); }
    if (updates.cwd !== undefined) { fields.push("cwd = ?"); values.push(updates.cwd || null); }
    if (groupId !== undefined) { fields.push("groupId = ?"); values.push(groupId); }
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

    if (shouldPersistDoneWhen) { fields.push("doneWhen = ?"); values.push(doneWhen ?? null); }
    if (hasNextActionUpdate) { fields.push("nextAction = ?"); values.push(nextAction ?? null); }
    if (hasWaitingOnUpdate) { fields.push("waitingOn = ?"); values.push(waitingOn ?? null); }
    if (hasNextTouchAtUpdate) { fields.push("nextTouchAt = ?"); values.push(nextTouchAt ?? null); }

    if (targetStatus !== "active") {
      if (!hasNextActionUpdate) { fields.push("nextAction = ?"); values.push(null); }
      if (!hasWaitingOnUpdate) { fields.push("waitingOn = ?"); values.push(null); }
      if (!hasNextTouchAtUpdate) { fields.push("nextTouchAt = ?"); values.push(null); }
    }

    // When status changes, place task at top of new group
    const shouldBumpCohort = shouldPersistStatus && targetStatus !== oldStatus;
    if (shouldBumpCohort) {
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
    // One unit, so the cohort is never shifted without the moved task landing at 0.
    runTransaction(db, () => {
      assertTaskGroupExists(db, groupId);
      const momentumBefore = readMomentumSnapshot(db, id);
      if (shouldBumpCohort) {
        db.prepare(`UPDATE tasks SET "order" = "order" + 1 WHERE status = ? AND id != ?`).run(targetStatus, id);
      }
      db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      if (updates.title !== undefined) recordTitleChange(db, id, now, actor, String(row.title), updates.title);
      const momentumAfter = readMomentumSnapshot(db, id);
      if (momentumBefore && momentumAfter) {
        const changes = diffMomentumSnapshots(momentumBefore, momentumAfter);
        if (changes.length > 0) recordMomentumEvent(db, id, now, actor, changes);
      }
    });

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

  /** Delete-dialog counts; the client's filtered, unarchived session list would undercount. */
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

  /** Per-task session summaries for the browser. Pass a task ID to read just that task. */
  function listTaskSessionSummaries(taskId?: string): Map<string, TaskSessionSummary> {
    const forTask = taskId === undefined ? "" : "AND ts.taskId = ?";
    const args = taskId === undefined ? [] : [taskId];
    // ORDER BY sits inside group_concat because SQLite promises no other order for the hash.
    const tasks = db.prepare(`
      SELECT ts.taskId, count(*) AS total,
        group_concat(ts.sessionId, char(10) ORDER BY ts.linkedAt, ts.sessionId) AS sessionIds
      FROM task_sessions ts WHERE 1 ${forTask}
      GROUP BY ts.taskId
    `).all(...args) as Array<{ taskId: string; total: number; sessionIds: string }>;
    const summaries = new Map<string, TaskSessionSummary>(tasks.map((row) => [row.taskId, {
      activeSessionIds: [],
      sessionCount: Number(row.total),
      archivedSessionCount: Number(row.total),
      sessionLinksRevision: createHash("sha1").update(`${row.sessionIds}\n`).digest("hex").slice(0, 16),
    }]));
    // Only the links that are not archived come back as rows; the archived count is the rest.
    const active = db.prepare(`
      SELECT ts.taskId, ts.sessionId FROM task_sessions ts
      WHERE NOT EXISTS (SELECT 1 FROM bridge_session_state b WHERE b.sessionId = ts.sessionId AND b.archived = 1) ${forTask}
      ORDER BY ts.taskId, ts.linkedAt, ts.sessionId
    `).all(...args) as Array<{ taskId: string; sessionId: string }>;
    for (const row of active) {
      const summary = summaries.get(row.taskId);
      if (!summary) continue;
      summary.activeSessionIds.push(row.sessionId);
      summary.archivedSessionCount -= 1;
    }
    return summaries;
  }

  /** A page of archived sessions, newest activity (else link time) first, with the total. */
  function listArchivedSessionIdsForTask(
    taskId: string,
    page: { limit: number; offset: number },
  ): { sessionIds: string[]; total: number } {
    const total = db.prepare(`
      SELECT count(*) AS total FROM task_sessions ts
      JOIN bridge_session_state b ON b.sessionId = ts.sessionId
      WHERE ts.taskId = ? AND b.archived = 1
    `).get(taskId) as { total: number };
    const rows = db.prepare(`
      SELECT ts.sessionId FROM task_sessions ts
      JOIN bridge_session_state b ON b.sessionId = ts.sessionId
      WHERE ts.taskId = ? AND b.archived = 1
      ORDER BY COALESCE(
        max(b.lastVisibleActivityAt, COALESCE(b.lastAttentionAt, b.lastVisibleActivityAt)),
        b.lastAttentionAt,
        strftime('%Y-%m-%dT%H:%M:%fZ', ts.linkedAt)
      ) DESC, ts.sessionId ASC
      LIMIT ? OFFSET ?
    `).all(taskId, page.limit, page.offset) as Array<{ sessionId: string }>;
    return { sessionIds: rows.map((row) => row.sessionId), total: Number(total.total) };
  }

  /** Deleting a chat unlinks it from every task, so bulk deletes may only reach these. */
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

  /** This task's unarchived chats linked to no active task; hidden once the task is archived. */
  function listOpenSessionIdsWithoutActiveTask(id: string): string[] {
    return (db.prepare(`
      SELECT ts.sessionId FROM task_sessions ts
      LEFT JOIN bridge_session_state b ON b.sessionId = ts.sessionId
      WHERE ts.taskId = ? AND COALESCE(b.archived, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM task_sessions other JOIN tasks t ON t.id = other.taskId
          WHERE other.sessionId = ts.sessionId AND t.status = 'active'
        )
      ORDER BY ts.linkedAt ASC
    `).all(id) as Array<{ sessionId: string }>).map((row) => row.sessionId);
  }

  /** Caller holds the transaction: triggers/tags have no FK and SQLite can't nest transactions. */
  function cascadeWithinTransaction(id: string): string[] {
    const deletedTriggerIds = (db
      .prepare("SELECT id FROM triggers WHERE taskId = ?")
      .all(id) as Array<{ id: string }>).map((row) => row.id);
    for (const triggerId of deletedTriggerIds) {
      db.prepare("DELETE FROM trigger_runs WHERE triggerId = ?").run(triggerId);
      // Surviving chats keep the trigger's name but drop its now-dangling id.
      db.prepare(`
        UPDATE bridge_session_state
        SET scheduleId = NULL, updatedAt = ?
        WHERE scheduleId = ?
      `).run(new Date().toISOString(), triggerId);
    }
    db.prepare("DELETE FROM triggers WHERE taskId = ?").run(id);
    db.prepare("DELETE FROM entity_tags WHERE entityType = 'task' AND entityId = ?").run(id);
    db.prepare("DELETE FROM task_starters WHERE taskId = ?").run(id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return deletedTriggerIds;
  }

  /** Deletes a task with its triggers and their runs in one transaction; returns trigger ids. */
  function deleteTaskCascade(id: string): { deletedTriggerIds: string[] } {
    db.exec("BEGIN");
    let deletedTriggerIds: string[];
    try {
      deletedTriggerIds = cascadeWithinTransaction(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    emitChange(id);
    return { deletedTriggerIds };
  }

  /** Archiving is plain SQLite, so it commits atomically with the task's deletion. */
  function archiveSessionsAndDeleteTask(id: string): {
    deletedTriggerIds: string[];
    archivedSessionIds: string[];
  } {
    db.exec("BEGIN");
    let deletedTriggerIds: string[];
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
      deletedTriggerIds = cascadeWithinTransaction(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    emitChange(id);
    return { deletedTriggerIds, archivedSessionIds };
  }

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

  /** Every task-to-session link with the time it was made. */
  function listSessionLinks(): SessionLink[] {
    return db.prepare("SELECT taskId, sessionId, linkedAt FROM task_sessions").all() as SessionLink[];
  }

  /** Removes exactly these links (a relinked one has a new `linkedAt`); returns task ids. */
  function removeSessionLinks(links: readonly SessionLink[]): string[] {
    if (links.length === 0) return [];
    const affected = new Set<string>();
    const now = new Date().toISOString();
    runTransaction(db, () => {
      const remove = db.prepare("DELETE FROM task_sessions WHERE taskId = ? AND sessionId = ? AND linkedAt = ?");
      for (const link of links) {
        const result = remove.run(link.taskId, link.sessionId, link.linkedAt) as { changes?: number };
        if (result.changes) affected.add(link.taskId);
      }
      const touch = db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?");
      for (const taskId of affected) touch.run(now, taskId);
    });
    for (const taskId of affected) emitChange(taskId);
    return [...affected];
  }

  function reorderTasks(taskIds: string[]): Task[] {
    runTransaction(db, () => {
      const stmt = db.prepare('UPDATE tasks SET "order" = ? WHERE id = ?');
      for (let i = 0; i < taskIds.length; i++) {
        stmt.run(i, taskIds[i]);
      }
    });
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

  /** Normalizes numeric ids ("00123" → "123") and GitHub refs (URL → "owner/repo#123"). */
  function normalizeWorkItemId(id: string): string {
    return normalizeWorkItemIdValue(id);
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

  function unlinkWorkItem(taskId: string, workItemId: string, provider?: ProviderName): UnlinkWorkItemResult {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const normalizedId = normalizeWorkItemId(workItemId);
    const result = (provider
      ? db.prepare("DELETE FROM task_work_items WHERE taskId = ? AND itemId = ? AND provider = ?").run(taskId, normalizedId, provider)
      : db.prepare("DELETE FROM task_work_items WHERE taskId = ? AND itemId = ?").run(taskId, normalizedId)) as { changes?: number };
    const removed = (result.changes ?? 0) > 0;
    // A delete that matched nothing is not a successful unlink.
    if (!removed) return { task, removed: false };
    db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    emitChange(taskId);
    return { task: getTask(taskId)!, removed: true };
  }

  function findTaskBySessionId(sessionId: string): Task | undefined {
    const row = db.prepare("SELECT taskId FROM task_sessions WHERE sessionId = ?").get(sessionId) as { taskId: string } | undefined;
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

  function unlinkPR(taskId: string, repoIds: readonly string[], prId: number, provider?: ProviderName): Task {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    for (const repoId of [...new Set(repoIds.filter(Boolean))]) {
      if (provider) {
        db.prepare("DELETE FROM task_pull_requests WHERE taskId = ? AND repoId = ? AND prId = ? AND provider = ?").run(taskId, repoId, prId, provider);
      } else {
        db.prepare("DELETE FROM task_pull_requests WHERE taskId = ? AND repoId = ? AND prId = ?").run(taskId, repoId, prId);
      }
    }
    db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    emitChange(taskId);
    return getTask(taskId)!;
  }

  function listMomentumEvents(taskId: string, limit = 20): TaskMomentumEvent[] {
    const bounded = Math.max(1, Math.min(TASK_MOMENTUM_EVENTS_MAX_LIMIT, Math.floor(limit)));
    const rows = db.prepare(`
      SELECT id, taskId, at, source, sessionId, scheduleId, scheduleName, changesJson
      FROM task_momentum_events WHERE taskId = ? ORDER BY id DESC LIMIT ?
    `).all(taskId, bounded);
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.taskId),
      at: String(row.at),
      source: row.source as TaskChangeSource,
      ...(row.sessionId ? { sessionId: String(row.sessionId) } : {}),
      ...(row.scheduleId ? { scheduleId: String(row.scheduleId) } : {}),
      ...(row.scheduleName ? { scheduleName: String(row.scheduleName) } : {}),
      changes: parseMomentumChanges(row.changesJson, row.id),
    }));
  }

  /** Tags events a scheduled session wrote before its schedule metadata arrived. */
  function attributeMomentumEventsToSchedule(sessionId: string, scheduleId: string, scheduleName: string): number {
    const result = db.prepare(`
      UPDATE task_momentum_events SET scheduleId = ?, scheduleName = ?
      WHERE sessionId = ? AND source = 'agent' AND scheduleId IS NULL
    `).run(scheduleId, scheduleName, sessionId) as { changes?: number };
    return result.changes ?? 0;
  }

  return {
    listTasks, listTasksWithoutSessions, listTaskLinksBySession, listArchivedSessionIdsForTask, getTask, findTaskIdsByShortId, createTask, updateTask, deleteTask, deleteTaskCascade, reorderTasks,
    archiveSessionsAndDeleteTask, listSessionIdsForTask, listExclusiveSessionIdsForTask, listOpenSessionIdsWithoutActiveTask,
    getTaskSessionCounts, listTaskSessionSummaries,
    linkSession, unlinkSession, unlinkSessionFromAllTasks, listSessionLinks, removeSessionLinks, linkWorkItem, unlinkWorkItem,
    findTaskBySessionId, linkPR, unlinkPR, listMomentumEvents, attributeMomentumEventsToSchedule, recordUserMessage, listMomentumSignals,
    getMomentumFieldStamps,
  };
}

export type TaskStore = ReturnType<typeof createTaskStore>;

// A type alias, not an interface, so a node:sqlite row array casts to it.
export type SessionLink = { taskId: string; sessionId: string; linkedAt: string };

export interface MomentumSignals {
  userEditedAt?: string;
  lastMessageAt?: string;
  waitingChangedAt?: string;
  nextActionSet?: MomentumFieldStamp;
  waitingOnSet?: MomentumFieldStamp;
}
