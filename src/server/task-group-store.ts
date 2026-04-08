import type { DatabaseSync } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────

export const GROUP_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate",
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

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

  function updateGroup(
    id: string,
    updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>,
  ): TaskGroup {
    const row = db.prepare("SELECT * FROM task_groups WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Group ${id} not found`);

    const fields: string[] = ["updatedAt = ?"];
    const values: any[] = [new Date().toISOString()];

    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.color !== undefined && GROUP_COLORS.includes(updates.color)) {
      fields.push("color = ?"); values.push(updates.color);
    }
    if (updates.collapsed !== undefined) { fields.push("collapsed = ?"); values.push(updates.collapsed ? 1 : 0); }
    if (updates.notes !== undefined) { fields.push("notes = ?"); values.push(updates.notes); }

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
