import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────

export const GROUP_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate",
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export interface TaskGroup {
  id: string;
  name: string;
  color: GroupColor;
  order: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Factory ───────────────────────────────────────────────────────

export function createTaskGroupStore(dataDir: string) {
  const GROUPS_FILE = join(dataDir, "task-groups.json");

  function load(): TaskGroup[] {
    if (!existsSync(GROUPS_FILE)) return [];
    try {
      return JSON.parse(readFileSync(GROUPS_FILE, "utf-8"));
    } catch {
      return [];
    }
  }

  function save(groups: TaskGroup[]): void {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
  }

  function nextColor(groups: TaskGroup[]): GroupColor {
    const used = new Set(groups.map((g) => g.color));
    return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[0];
  }

  function listGroups(): TaskGroup[] {
    return load().sort((a, b) => a.order - b.order);
  }

  function getGroup(id: string): TaskGroup | undefined {
    return load().find((g) => g.id === id);
  }

  function createGroup(name: string, color?: GroupColor): TaskGroup {
    const groups = load();
    const group: TaskGroup = {
      id: crypto.randomUUID(),
      name,
      color: color && GROUP_COLORS.includes(color) ? color : nextColor(groups),
      order: groups.length,
      collapsed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    groups.push(group);
    save(groups);
    return group;
  }

  function updateGroup(
    id: string,
    updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed">>,
  ): TaskGroup {
    const groups = load();
    const group = groups.find((g) => g.id === id);
    if (!group) throw new Error(`Group ${id} not found`);
    if (updates.name !== undefined) group.name = updates.name;
    if (updates.color !== undefined && GROUP_COLORS.includes(updates.color))
      group.color = updates.color;
    if (updates.collapsed !== undefined) group.collapsed = updates.collapsed;
    group.updatedAt = new Date().toISOString();
    save(groups);
    return group;
  }

  function deleteGroup(id: string): void {
    const groups = load().filter((g) => g.id !== id);
    groups.sort((a, b) => a.order - b.order);
    groups.forEach((g, i) => { g.order = i; });
    save(groups);
  }

  function reorderGroups(groupIds: string[]): TaskGroup[] {
    const groups = load();
    for (let i = 0; i < groupIds.length; i++) {
      const g = groups.find((g) => g.id === groupIds[i]);
      if (g) g.order = i;
    }
    save(groups);
    return listGroups();
  }

  return { listGroups, getGroup, createGroup, updateGroup, deleteGroup, reorderGroups };
}

export type TaskGroupStore = ReturnType<typeof createTaskGroupStore>;

// ── Default instance (backward compat) ────────────────────────────

const _defaultDataDir = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const _default = createTaskGroupStore(_defaultDataDir);
export const listGroups = _default.listGroups;
export const getGroup = _default.getGroup;
export const createGroup = _default.createGroup;
export const updateGroup = _default.updateGroup;
export const deleteGroup = _default.deleteGroup;
export const reorderGroups = _default.reorderGroups;
