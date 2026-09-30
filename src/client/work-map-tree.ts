import type {
  EnrichedWorkItem,
  WorkMapData,
  WorkMapPullRequest,
  WorkMapRelation,
  WorkMapRelationType,
  WorkMapWorkItem,
} from "./api";
import { IDENTITY_COLORS, type IdentityColor } from "./design/identity";

/**
 * The work map's tree view: ADO work items placed in their ADO hierarchy, with the Bridge tasks
 * that link to them drawn as lanes beside the rows. This module is the pure model; the component
 * in components/WorkMapTree.tsx draws it.
 */

const CLOSED_STATES = new Set(["closed", "completed", "done", "removed", "resolved"]);

export function isClosedState(state: string | null | undefined): boolean {
  return state ? CLOSED_STATES.has(state.toLowerCase()) : false;
}

export interface WorkMapTreeNode {
  id: string;
  item: EnrichedWorkItem;
  /** The work item as it sits on the map; null for an ancestor or linked item shown as context. */
  mapItem: WorkMapWorkItem | null;
  parentId: string | null;
  children: WorkMapTreeNode[];
  /** ADO children that exist but are not shown, because they are not on the map or are filtered out. */
  hiddenChildCount: number;
  pullRequests: WorkMapPullRequest[];
  /** Bridge tasks linked to the work item directly or through one of its pull requests. */
  taskIds: string[];
  /** Links to other work items outside the parent/child hierarchy. */
  links: WorkMapRelation[];
}

export interface WorkMapTreeSection {
  key: string;
  /** A root with descendants gets its own section; single items with no parent share one. */
  kind: "hierarchy" | "unparented";
  nodes: WorkMapTreeNode[];
  taskIds: string[];
}

export interface WorkMapTreeRow {
  node: WorkMapTreeNode;
  depth: number;
  ancestorIds: string[];
}

export interface WorkMapLaneCell {
  /** The task links this row directly. */
  mark: boolean;
  up: boolean;
  down: boolean;
}

export interface WorkMapLaneLayout {
  laneTaskIds: string[];
  /** One entry per row, one cell per lane; null where the lane is empty. */
  cells: Array<Array<WorkMapLaneCell | null>>;
  /** Tasks whose run starts on this row, which is where the task's name is shown. */
  runStarts: Map<number, string[]>;
}

const TYPE_RANK: Record<string, number> = {
  objective: 0,
  epic: 1,
  feature: 2,
  "user story": 3,
  "product backlog item": 3,
  requirement: 3,
  bug: 4,
  task: 5,
};

export const WORK_MAP_RELATION_LABELS: Record<Exclude<WorkMapRelationType, "parent" | "child">, string> = {
  related: "Related",
  predecessor: "Blocked by",
  successor: "Blocks",
  duplicate: "Duplicate",
  duplicateOf: "Duplicate of",
};

function compareNodes(a: WorkMapTreeNode, b: WorkMapTreeNode): number {
  const closed = Number(isClosedState(a.item.state)) - Number(isClosedState(b.item.state));
  if (closed !== 0) return closed;
  const rank = (TYPE_RANK[a.item.type?.toLowerCase() ?? ""] ?? 9) - (TYPE_RANK[b.item.type?.toLowerCase() ?? ""] ?? 9);
  if (rank !== 0) return rank;
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function collectTaskIds(nodes: WorkMapTreeNode[], out = new Set<string>()): Set<string> {
  for (const node of nodes) {
    for (const taskId of node.taskIds) out.add(taskId);
    collectTaskIds(node.children, out);
  }
  return out;
}

function countNodes(nodes: WorkMapTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

/**
 * Places the visible map items in the hierarchy. Ancestors of a visible item are included as
 * context even when they are filtered out or not on the map.
 */
export function buildWorkMapTree(data: WorkMapData, visibleWorkItemIds: ReadonlySet<string>): WorkMapTreeSection[] {
  const pullRequestByKey = new Map(data.pullRequests.map((pr) => [pr.key, pr]));
  const entries = new Map<string, { item: EnrichedWorkItem; mapItem: WorkMapWorkItem | null; relations: WorkMapRelation[] }>();
  for (const item of data.contextWorkItems ?? []) {
    entries.set(item.id, { item, mapItem: null, relations: item.relations ?? [] });
  }
  for (const item of data.workItems) {
    entries.set(item.id, { item, mapItem: item, relations: item.relations ?? [] });
  }

  const parentOf = new Map<string, string>();
  const childIdsOf = new Map<string, Set<string>>();
  const addChild = (parentId: string, childId: string) => {
    const children = childIdsOf.get(parentId) ?? new Set<string>();
    children.add(childId);
    childIdsOf.set(parentId, children);
  };
  for (const [id, entry] of entries) {
    for (const relation of entry.relations) {
      if (relation.type === "parent") {
        if (!parentOf.has(id) && entries.has(relation.workItemId)) parentOf.set(id, relation.workItemId);
        addChild(relation.workItemId, id);
      } else if (relation.type === "child") {
        addChild(id, relation.workItemId);
        if (!parentOf.has(relation.workItemId) && entries.has(relation.workItemId)) {
          parentOf.set(relation.workItemId, id);
        }
      }
    }
  }

  const included = new Set<string>();
  for (const id of visibleWorkItemIds) {
    if (!entries.has(id)) continue;
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      included.add(current);
      current = parentOf.get(current);
    }
  }

  const nodes = new Map<string, WorkMapTreeNode>();
  for (const id of included) {
    const entry = entries.get(id)!;
    const pullRequests = (entry.mapItem?.pullRequestKeys ?? [])
      .map((key) => pullRequestByKey.get(key))
      .filter((pr): pr is WorkMapPullRequest => Boolean(pr));
    const taskIds = [...new Set([
      ...(entry.mapItem?.taskIds ?? []),
      ...pullRequests.flatMap((pr) => pr.taskIds),
    ])];
    nodes.set(id, {
      id,
      item: entry.item,
      mapItem: entry.mapItem,
      parentId: null,
      children: [],
      hiddenChildCount: 0,
      pullRequests,
      taskIds,
      links: entry.relations.filter((relation) => relation.type !== "parent" && relation.type !== "child"),
    });
  }

  const roots: WorkMapTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = parentOf.get(node.id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    // A cycle in ADO links would otherwise hide both items.
    if (parent && !isAncestor(node.id, parent.id, parentOf)) {
      node.parentId = parent.id;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const node of nodes.values()) {
    node.children.sort(compareNodes);
    node.hiddenChildCount = [...(childIdsOf.get(node.id) ?? [])].filter((id) => !nodes.has(id)).length;
  }
  roots.sort(compareNodes);

  const sections: WorkMapTreeSection[] = [];
  const unparented: WorkMapTreeNode[] = [];
  for (const root of roots) {
    if (root.children.length === 0) {
      unparented.push(root);
      continue;
    }
    sections.push({ key: root.id, kind: "hierarchy", nodes: [root], taskIds: [...collectTaskIds([root])] });
  }
  sections.sort((a, b) =>
    (b.taskIds.length - a.taskIds.length)
    || (countNodes(b.nodes) - countNodes(a.nodes))
    || compareNodes(a.nodes[0], b.nodes[0]));
  if (unparented.length > 0) {
    sections.push({
      key: "unparented",
      kind: "unparented",
      nodes: unparented,
      taskIds: [...collectTaskIds(unparented)],
    });
  }
  return sections;
}

function isAncestor(candidate: string, of: string, parentOf: Map<string, string>): boolean {
  let current: string | undefined = of;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === candidate) return true;
    seen.add(current);
    current = parentOf.get(current);
  }
  return false;
}

export function flattenWorkMapTree(
  nodes: WorkMapTreeNode[],
  collapsed: ReadonlySet<string>,
): WorkMapTreeRow[] {
  const rows: WorkMapTreeRow[] = [];
  const visit = (node: WorkMapTreeNode, depth: number, ancestorIds: string[]) => {
    rows.push({ node, depth, ancestorIds });
    if (collapsed.has(node.id)) return;
    const childAncestors = [...ancestorIds, node.id];
    for (const child of node.children) visit(child, depth + 1, childAncestors);
  };
  for (const node of nodes) visit(node, 0, []);
  return rows;
}

/** Descendant rows under a collapsed node still count, so a collapsed run reads as linked there. */
function rowTaskIds(row: WorkMapTreeRow, collapsed: ReadonlySet<string>): string[] {
  if (!collapsed.has(row.node.id)) return row.node.taskIds;
  return [...collectTaskIds([row.node])];
}

/**
 * Lays out one lane per Bridge task. A run joins a linked row to the linked rows beneath it in
 * the same branch; a task that appears in two branches gets two runs in the same lane.
 */
export function layoutWorkMapLanes(
  rows: WorkMapTreeRow[],
  collapsed: ReadonlySet<string>,
  maxLanes: number,
): WorkMapLaneLayout {
  const laneTaskIds: string[] = [];
  const taskIdsByRow = rows.map((row) => rowTaskIds(row, collapsed));
  for (const taskIds of taskIdsByRow) {
    for (const taskId of taskIds) {
      if (!laneTaskIds.includes(taskId) && laneTaskIds.length < maxLanes) laneTaskIds.push(taskId);
    }
  }
  const rowIndexById = new Map<string, number>();
  rows.forEach((row, index) => {
    rowIndexById.set(row.node.id, index);
  });

  const cells: Array<Array<WorkMapLaneCell | null>> = rows.map(() => laneTaskIds.map(() => null));
  const runStarts = new Map<number, string[]>();
  laneTaskIds.forEach((taskId, lane) => {
    const runs = new Map<number, number[]>();
    taskIdsByRow.forEach((taskIds, index) => {
      if (!taskIds.includes(taskId)) return;
      const row = rows[index];
      const top = row.ancestorIds
        .map((id) => rowIndexById.get(id))
        .find((ancestorIndex) => ancestorIndex !== undefined && taskIdsByRow[ancestorIndex].includes(taskId));
      const start = top ?? index;
      runs.set(start, [...(runs.get(start) ?? []), index]);
    });
    for (const [start, members] of runs) {
      const end = Math.max(...members);
      for (let index = start; index <= end; index++) {
        cells[index][lane] = { mark: members.includes(index), up: index > start, down: index < end };
      }
      runStarts.set(start, [...(runStarts.get(start) ?? []), taskId]);
    }
  });
  // Tasks beyond the lane limit still need their name on the rows they link.
  taskIdsByRow.forEach((taskIds, index) => {
    const extra = taskIds.filter((taskId) => !laneTaskIds.includes(taskId));
    if (extra.length > 0) runStarts.set(index, [...(runStarts.get(index) ?? []), ...extra]);
  });
  return { laneTaskIds, cells, runStarts };
}

/** Each task keeps one colour everywhere on the map, in order of first appearance. */
export function assignTaskColors(sections: WorkMapTreeSection[]): Map<string, IdentityColor> {
  const colors = new Map<string, IdentityColor>();
  for (const section of sections) {
    for (const taskId of section.taskIds) {
      if (!colors.has(taskId)) colors.set(taskId, IDENTITY_COLORS[colors.size % IDENTITY_COLORS.length]);
    }
  }
  return colors;
}

/** Counts the separate places each task appears, so a name can say it is linked elsewhere too. */
export function countTaskPlacements(sections: WorkMapTreeSection[]): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: WorkMapTreeNode, inheritedTaskIds: ReadonlySet<string>) => {
    for (const taskId of node.taskIds) {
      if (!inheritedTaskIds.has(taskId)) counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
    }
    const next = new Set([...inheritedTaskIds, ...node.taskIds]);
    for (const child of node.children) visit(child, next);
  };
  for (const section of sections) {
    for (const node of section.nodes) visit(node, new Set());
  }
  return counts;
}

export interface WorkMapItemLookup {
  get(id: string): EnrichedWorkItem | undefined;
}

export function buildWorkItemLookup(data: WorkMapData): WorkMapItemLookup {
  const items = new Map<string, EnrichedWorkItem>();
  for (const item of data.contextWorkItems ?? []) items.set(item.id, item);
  for (const item of data.workItems) items.set(item.id, item);
  return items;
}

/** Attention that only the hierarchy can show. */
export function treeNodeAttention(
  node: WorkMapTreeNode,
  parent: WorkMapTreeNode | undefined,
  lookup: WorkMapItemLookup,
): string[] {
  const attention: string[] = [];
  const closed = isClosedState(node.item.state);
  if (closed && node.pullRequests.some((pr) => pr.status === "active")) {
    attention.push("Closed while a PR is active");
  }
  if (!closed && parent && isClosedState(parent.item.state)) {
    attention.push(`Open under a ${parent.item.state?.toLowerCase() ?? "closed"} parent`);
  }
  if (!closed) {
    const blockers = node.links
      .filter((link) => link.type === "predecessor")
      .map((link) => lookup.get(link.workItemId))
      .filter((item): item is EnrichedWorkItem => Boolean(item) && !isClosedState(item?.state));
    if (blockers.length > 0) attention.push(`Blocked by open ${blockers.map((item) => `#${item.id}`).join(", ")}`);
  }
  return attention;
}
