// Checklist store — per-task checklists for human tracking

import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";
import { isRecord } from "../shared/is-record.js";
import { runImmediateTransaction, runTransaction } from "./db-transaction.js";
import { listActionSources, type FocusActionSource } from "./focus-action-links.js";
import { createFocusAttentionStore, createFocusTransitionStore } from "./focus-attention-store.js";
import type { FocusActor } from "./focus-details-store.js";

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
  stableKey?: string;
  sourceUrl?: string;
  sources?: FocusActionSource[];
  originalTaskId?: string;
  originalTaskTitle?: string;
  orphanedAt?: string;
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
    const details = db.prepare("SELECT * FROM focus_action_details WHERE actionId = ?").get(row.id);
    return {
      id: row.id,
      taskId: row.taskId ?? null,
      text: row.text,
      done: row.done === 1,
      order: row.order,
      createdAt: row.createdAt,
      completedAt: row.completedAt ?? undefined,
      deadline: row.deadline ?? undefined,
      sources: listActionSources(db, row.id),
      ...(typeof details?.stableKey === "string" ? { stableKey: details.stableKey } : {}),
      ...(typeof details?.sourceUrl === "string" ? { sourceUrl: details.sourceUrl } : {}),
      ...(typeof details?.originalTaskId === "string" ? { originalTaskId: details.originalTaskId } : {}),
      ...(typeof details?.originalTaskTitle === "string" ? { originalTaskTitle: details.originalTaskTitle } : {}),
      ...(typeof details?.orphanedAt === "string" ? { orphanedAt: details.orphanedAt } : {}),
    };
  }

  function emitChange(taskId: string | null): void {
    bus.emit({ type: "task:changed", taskId: taskId ?? undefined });
  }

  function listChecklistItems(taskId: string | null): ChecklistItem[] {
    const rows = taskId === null
      ? db.prepare('SELECT * FROM checklist_items WHERE taskId IS NULL ORDER BY "order"').all()
      : db.prepare('SELECT * FROM checklist_items WHERE taskId = ? ORDER BY "order"').all(taskId);
    return (rows as any[]).map(hydrate);
  }

  function getChecklistItem(id: string): ChecklistItem | undefined {
    const row = db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function createChecklistItem(taskId: string | null, text: string, deadline?: string | null, options: {
    key?: unknown; sourceUrl?: unknown; actor?: FocusActor;
  } = {}): ChecklistItem {
    const input = normalizeChecklistItemCreate(deadline === undefined ? { text } : { text, deadline });
    const actor = options.actor ?? "user";
    if (options.key !== undefined && (typeof options.key !== "string" || !options.key.trim() || options.key.length > 512)) {
      throw new ChecklistValidationError("key must be a non-empty string of at most 512 characters");
    }
    if (options.sourceUrl !== undefined && (typeof options.sourceUrl !== "string" || !/^https?:\/\//i.test(options.sourceUrl))) {
      throw new ChecklistValidationError("sourceUrl must be an http(s) URL");
    }
    const stableKey = typeof options.key === "string" ? options.key.trim() : null;
    const sourceUrl = typeof options.sourceUrl === "string" ? options.sourceUrl : null;
    const result = runImmediateTransaction(db, () => {
      if (stableKey) {
        const keyed = db.prepare("SELECT actionId FROM focus_action_details WHERE stableKey = ?").get(stableKey);
        if (keyed) {
          const existing = getChecklistItem(String(keyed.actionId))!;
          if (existing.taskId !== taskId) throw new ChecklistValidationError("key belongs to an Action in a different task");
          createFocusAttentionStore(db).record({ eventType: "no_op", objectId: existing.id, objectType: "action", activationId: existing.id, actor });
          return { item: existing, created: false };
        }
      }

      if (taskId !== null) {
        const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
        if (!task) throw new ChecklistNotFoundError(`Task ${taskId} not found`);
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const maxOrder = Number(db.prepare('SELECT MAX("order") as mx FROM checklist_items WHERE taskId IS ?').get(taskId)?.mx ?? -1);

      db.prepare(`
        INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, deadline)
        VALUES (?, ?, ?, 0, ?, ?, ?)
      `).run(id, taskId, input.text, maxOrder + 1, now, input.deadline ?? null);
      db.prepare(`INSERT INTO focus_action_details (actionId, stableKey, sourceUrl, originalTaskId, originalTaskTitle)
        VALUES (?, ?, ?, ?, (SELECT title FROM tasks WHERE id=?))`).run(id, stableKey, sourceUrl, taskId, taskId);
      createFocusTransitionStore(db).append({
        objectId: id, objectType: "action", title: input.text, activationId: id,
        fromLifecycle: null, toLifecycle: "active", reason: "created", actor, details: { taskId },
      });
      createFocusAttentionStore(db).record({ eventType: "create", objectId: id, objectType: "action", activationId: id, actor });
      return { item: getChecklistItem(id)!, created: true };
    });
    if (result.created) emitChange(taskId);
    return result.item;
  }

  function updateChecklistItemInTransaction(id: string, updates: ChecklistItemUpdate, actor: FocusActor): { item: ChecklistItem; changed: boolean } {
    const normalizedUpdates = normalizeChecklistItemUpdate(updates);
    const checklistItem = getChecklistItem(id);
    if (!checklistItem) throw new ChecklistNotFoundError(`Checklist item ${id} not found`);
    const changed = (normalizedUpdates.text !== undefined && normalizedUpdates.text !== checklistItem.text)
      || (normalizedUpdates.done !== undefined && normalizedUpdates.done !== checklistItem.done)
      || ("deadline" in normalizedUpdates && (normalizedUpdates.deadline ?? undefined) !== checklistItem.deadline);
    if (!changed) {
      createFocusAttentionStore(db).record({ eventType: "no_op", objectId: id, objectType: "action", activationId: id, actor });
      return { item: checklistItem, changed: false };
    }

    const fields: string[] = [];
    const values: Array<string | number | null> = [];

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

    const updated = getChecklistItem(id)!;
    const transition = createFocusTransitionStore(db).append({
      objectId: id, objectType: "action", title: updated.text, activationId: id,
      fromLifecycle: checklistItem.done ? "resolved" : "active", toLifecycle: updated.done ? "resolved" : "active",
      reason: updated.done !== checklistItem.done ? "action-completion-changed" : "meaningful-update", actor,
      details: { taskId: updated.taskId },
    });
    createFocusAttentionStore(db).record({
      eventType: updated.done !== checklistItem.done ? "lifecycle_transition" : "meaningful_update",
      objectId: id, objectType: "action", activationId: id, transitionId: transition.id, actor,
    });
    return { item: updated, changed: true };
  }
  function updateChecklistItem(id: string, updates: ChecklistItemUpdate, actor: FocusActor = "user"): ChecklistItem {
    const result = runImmediateTransaction(db, () => updateChecklistItemInTransaction(id, updates, actor));
    if (result.changed) emitChange(result.item.taskId);
    return result.item;
  }

  function deleteChecklistItem(id: string): void {
    const checklistItem = getChecklistItem(id);
    if (!checklistItem) throw new ChecklistNotFoundError(`Checklist item ${id} not found`);
    runTransaction(db, () => {
      db.prepare("DELETE FROM feed_card_checklist_promotions WHERE checklistItemId = ?").run(id);
      db.prepare("DELETE FROM checklist_items WHERE id = ?").run(id);
    });
    emitChange(checklistItem.taskId);
  }

  function reorderChecklistItems(taskId: string, checklistItemIds: string[]): ChecklistItem[] {
    runTransaction(db, () => {
      const stmt = db.prepare('UPDATE checklist_items SET "order" = ? WHERE id = ? AND taskId = ?');
      for (let i = 0; i < checklistItemIds.length; i++) {
        stmt.run(i, checklistItemIds[i], taskId);
      }
    });
    emitChange(taskId);
    return listChecklistItems(taskId);
  }

  /** Get all unchecked checklist items across all active tasks and global (unparented) checklist items */
  function listAllOpenChecklistItems(): ChecklistItem[] {
    return (db.prepare(`
      SELECT checklist_items.* FROM checklist_items
      LEFT JOIN tasks ON checklist_items.taskId = tasks.id
      LEFT JOIN focus_action_details details ON details.actionId = checklist_items.id
      WHERE checklist_items.done = 0 AND (
        (checklist_items.taskId IS NULL AND details.orphanedAt IS NULL)
        OR (tasks.status = 'active' AND tasks.muted = 0))
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
