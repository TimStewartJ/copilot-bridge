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

export class ChecklistValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecklistValidationError";
  }
}

export class ChecklistNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecklistNotFoundError";
  }
}

export interface ChecklistItemCreateInput {
  text: string;
  deadline?: string | null;
}

export type ChecklistItemUpdate = Partial<Pick<ChecklistItem, "text" | "done">> & {
  deadline?: string | null;
};

const CHECKLIST_CREATE_FIELDS = ["text", "deadline"] as const;
const CHECKLIST_UPDATE_FIELDS = ["text", "done", "deadline"] as const;
const CHECKLIST_DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findUnknownFields(input: Record<string, unknown>, allowedFields: readonly string[]): string[] {
  const allowed = new Set(allowedFields);
  return Object.keys(input).filter((key) => !allowed.has(key)).sort();
}

function formatUnknownFieldsError(fields: readonly string[]): string {
  return fields.length === 1
    ? `Unknown field: "${fields[0]}"`
    : `Unknown fields: ${fields.map((field) => `"${field}"`).join(", ")}`;
}

function parseChecklistMutationBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ChecklistValidationError("Request body must be an object");
  return body;
}

function normalizeChecklistText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ChecklistValidationError("text must be a non-empty string");
  }
  return value;
}

function isValidChecklistDeadline(value: string): boolean {
  if (!CHECKLIST_DEADLINE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeChecklistDeadline(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isValidChecklistDeadline(value)) {
    throw new ChecklistValidationError("deadline must be null or a YYYY-MM-DD date");
  }
  return value;
}

export function normalizeChecklistItemCreate(body: unknown): ChecklistItemCreateInput {
  const input = parseChecklistMutationBody(body);
  const unknownFields = findUnknownFields(input, CHECKLIST_CREATE_FIELDS);
  if (unknownFields.length > 0) throw new ChecklistValidationError(formatUnknownFieldsError(unknownFields));

  const normalized: ChecklistItemCreateInput = {
    text: normalizeChecklistText(input.text),
  };
  if ("deadline" in input) normalized.deadline = normalizeChecklistDeadline(input.deadline);
  return normalized;
}

export function normalizeChecklistItemUpdate(body: unknown): ChecklistItemUpdate {
  const input = parseChecklistMutationBody(body);
  const unknownFields = findUnknownFields(input, CHECKLIST_UPDATE_FIELDS);
  if (unknownFields.length > 0) throw new ChecklistValidationError(formatUnknownFieldsError(unknownFields));

  const normalized: ChecklistItemUpdate = {};
  if ("text" in input) normalized.text = normalizeChecklistText(input.text);
  if ("done" in input) {
    if (typeof input.done !== "boolean") throw new ChecklistValidationError("done must be boolean");
    normalized.done = input.done;
  }
  if ("deadline" in input) normalized.deadline = normalizeChecklistDeadline(input.deadline);
  return normalized;
}

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

  function createChecklistItem(taskId: string | null, text: string, deadline?: string | null): ChecklistItem {
    const input = normalizeChecklistItemCreate(deadline === undefined ? { text } : { text, deadline });

    if (taskId !== null) {
      const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as any;
      if (!task) throw new ChecklistNotFoundError(`Task ${taskId} not found`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxOrder = taskId !== null
      ? (db.prepare('SELECT MAX("order") as mx FROM checklist_items WHERE taskId = ?').get(taskId) as any).mx ?? -1
      : (db.prepare('SELECT MAX("order") as mx FROM checklist_items WHERE taskId IS NULL').get() as any).mx ?? -1;

    db.prepare(`
      INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, deadline)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(id, taskId, input.text, maxOrder + 1, now, input.deadline ?? null);

    emitChange(taskId);
    return getChecklistItem(id)!;
  }

  function updateChecklistItem(id: string, updates: ChecklistItemUpdate): ChecklistItem {
    const normalizedUpdates = normalizeChecklistItemUpdate(updates);
    const checklistItem = getChecklistItem(id);
    if (!checklistItem) throw new ChecklistNotFoundError(`Checklist item ${id} not found`);

    const fields: string[] = [];
    const values: any[] = [];

    if (normalizedUpdates.text !== undefined) { fields.push("text = ?"); values.push(normalizedUpdates.text); }
    if (normalizedUpdates.done !== undefined) {
      fields.push("done = ?");
      values.push(normalizedUpdates.done ? 1 : 0);
      if (normalizedUpdates.done && !checklistItem.done) {
        fields.push("completedAt = ?");
        values.push(new Date().toISOString());
      } else if (!normalizedUpdates.done) {
        fields.push("completedAt = ?");
        values.push(null);
      }
    }
    if ("deadline" in normalizedUpdates) {
      fields.push("deadline = ?");
      values.push(normalizedUpdates.deadline ?? null);
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
    if (!checklistItem) throw new ChecklistNotFoundError(`Checklist item ${id} not found`);
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
