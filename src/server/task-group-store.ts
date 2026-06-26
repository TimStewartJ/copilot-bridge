import type { DatabaseSync } from "./db.js";
import { findUnknownFields, formatUnknownFieldsError } from "./schedule-validation.js";

// ── Types ─────────────────────────────────────────────────────────

export const GROUP_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate",
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export class TaskGroupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskGroupValidationError";
  }
}

export type TaskGroupUpdate = Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>;

const TASK_GROUP_UPDATE_FIELDS = ["name", "color", "collapsed", "notes"] as const;

function isGroupColor(value: unknown): value is GroupColor {
  return typeof value === "string" && (GROUP_COLORS as readonly string[]).includes(value);
}

function normalizeGroupUpdate(updates: unknown): TaskGroupUpdate {
  if (updates === null || typeof updates !== "object" || Array.isArray(updates)) {
    throw new TaskGroupValidationError("Request body must be an object");
  }
  const input = updates as Record<string, unknown>;

  const unknownFields = findUnknownFields(input, TASK_GROUP_UPDATE_FIELDS);
  if (unknownFields.length > 0) {
    throw new TaskGroupValidationError(formatUnknownFieldsError(unknownFields));
  }

  const normalized: TaskGroupUpdate = {};
  if (input.color !== undefined) {
    if (!isGroupColor(input.color)) {
      throw new TaskGroupValidationError(`color must be one of: ${GROUP_COLORS.join(", ")}`);
    }
    normalized.color = input.color;
  }
  if (input.name !== undefined) normalized.name = input.name as string;
  if (input.collapsed !== undefined) normalized.collapsed = input.collapsed as boolean;
  if (input.notes !== undefined) normalized.notes = input.notes as string;
  return normalized;
}

export interface TaskGroup {
  id: string;
  name: string;
  color: GroupColor;
  notes: string;
  order: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Factory ───────────────────────────────────────────────────────

export function createTaskGroupStore(db: DatabaseSync) {
  function hydrate(row: any): TaskGroup {
    return {
      id: row.id,
      name: row.name,
      color: row.color as GroupColor,
      notes: row.notes ?? "",
      order: row.order,
      collapsed: row.collapsed === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function nextColor(): GroupColor {
    const used = new Set(
      (db.prepare("SELECT color FROM task_groups").all() as any[]).map((r) => r.color),
    );
    return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[0];
  }

  function listGroups(): TaskGroup[] {
    return (db.prepare('SELECT * FROM task_groups ORDER BY "order"').all() as any[]).map(hydrate);
  }

  function getGroup(id: string): TaskGroup | undefined {
    const row = db.prepare("SELECT * FROM task_groups WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function createGroup(name: string, color?: GroupColor): TaskGroup {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM task_groups").get() as any).cnt;
    const resolvedColor = color && GROUP_COLORS.includes(color) ? color : nextColor();

    db.prepare(`
      INSERT INTO task_groups (id, name, color, "order", collapsed, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(id, name, resolvedColor, count, now, now);

    return getGroup(id)!;
  }

  function updateGroup(id: string, updates: unknown): TaskGroup {
    const normalized = normalizeGroupUpdate(updates);

    const row = db.prepare("SELECT * FROM task_groups WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Group ${id} not found`);

    const fields: string[] = ["updatedAt = ?"];
    const values: any[] = [new Date().toISOString()];

    if (normalized.name !== undefined) { fields.push("name = ?"); values.push(normalized.name); }
    if (normalized.color !== undefined) { fields.push("color = ?"); values.push(normalized.color); }
    if (normalized.collapsed !== undefined) { fields.push("collapsed = ?"); values.push(normalized.collapsed ? 1 : 0); }
    if (normalized.notes !== undefined) { fields.push("notes = ?"); values.push(normalized.notes); }

    values.push(id);
    db.prepare(`UPDATE task_groups SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return getGroup(id)!;
  }

  function deleteGroup(id: string): void {
    db.prepare("DELETE FROM task_groups WHERE id = ?").run(id);
    // Re-order remaining groups
    const remaining = db.prepare('SELECT id FROM task_groups ORDER BY "order"').all() as any[];
    const stmt = db.prepare('UPDATE task_groups SET "order" = ? WHERE id = ?');
    remaining.forEach((r, i) => stmt.run(i, r.id));
  }

  function reorderGroups(groupIds: string[]): TaskGroup[] {
    const stmt = db.prepare('UPDATE task_groups SET "order" = ? WHERE id = ?');
    for (let i = 0; i < groupIds.length; i++) {
      stmt.run(i, groupIds[i]);
    }
    return listGroups();
  }

  return { listGroups, getGroup, createGroup, updateGroup, deleteGroup, reorderGroups };
}

export type TaskGroupStore = ReturnType<typeof createTaskGroupStore>;
