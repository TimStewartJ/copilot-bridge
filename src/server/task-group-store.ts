import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const GROUPS_FILE = join(DATA_DIR, "task-groups.json");

// ── Types ─────────────────────────────────────────────────────────

export const GROUP_COLORS = [
  "blue", "purple", "green", "amber", "rose", "cyan", "orange", "slate",
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

// ── Persistence ───────────────────────────────────────────────────

function load(): TaskGroup[] {
  if (!existsSync(GROUPS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(GROUPS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function save(groups: TaskGroup[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────

function nextColor(groups: TaskGroup[]): GroupColor {
  const used = new Set(groups.map((g) => g.color));
  return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[0];
}

// ── CRUD ──────────────────────────────────────────────────────────

export function listGroups(): TaskGroup[] {
  return load().sort((a, b) => a.order - b.order);
}

export function getGroup(id: string): TaskGroup | undefined {
  return load().find((g) => g.id === id);
}

export function createGroup(name: string, color?: GroupColor): TaskGroup {
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

export function updateGroup(
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

export function deleteGroup(id: string): void {
  const groups = load().filter((g) => g.id !== id);
  // Re-number order to keep it dense
  groups.sort((a, b) => a.order - b.order);
  groups.forEach((g, i) => { g.order = i; });
  save(groups);
}

export function reorderGroups(groupIds: string[]): TaskGroup[] {
  const groups = load();
  for (let i = 0; i < groupIds.length; i++) {
    const g = groups.find((g) => g.id === groupIds[i]);
    if (g) g.order = i;
  }
  save(groups);
  return listGroups();
}
