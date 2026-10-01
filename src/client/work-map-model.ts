import type {
  EnrichedWorkItem,
  WorkMapData,
  WorkMapPullRequest,
  WorkMapRelation,
  WorkMapTask,
  WorkMapWorkItem,
} from "./api";
import { isClosedWorkItemState } from "../shared/work-map.js";
import { IDENTITY_COLORS, type IdentityColor } from "./design/identity";

/**
 * The work map's model: ADO work items placed in their ADO hierarchy, with the Bridge tasks that
 * link to them drawn as lanes beside the rows. Everything here is a pure function of the server's
 * answer and the reader's filters; components/WorkMapTree.tsx draws the result.
 */

/** One work item with everything the map knows about it. */
export interface WorkMapEntry {
  id: string;
  item: EnrichedWorkItem;
  /** The work item as it sits on the map; null for an ancestor or linked item shown as context. */
  mapItem: WorkMapWorkItem | null;
  parentId: string | null;
  /** Every child ADO reports, whether or not it is on the map. */
  childIds: string[];
  pullRequests: WorkMapPullRequest[];
  /** Bridge tasks linked to the work item directly or through one of its pull requests. */
  taskIds: string[];
  /** Links to other work items outside the parent/child hierarchy. */
  links: WorkMapRelation[];
  /** What is wrong with the item, in words for its row. */
  attention: string[];
  /** Open work on the map that no Bridge task tracks. Its row offers to create one. */
  needsTask: boolean;
  /** What the search box matches, in lower case. */
  searchText: string;
}

/** A pull request a Bridge task links that is not linked to any work item. */
export interface WorkMapOrphan {
  pullRequest: WorkMapPullRequest;
  tasks: WorkMapTask[];
  needsAttention: boolean;
  searchText: string;
}

export interface WorkMapModel {
  entries: Map<string, WorkMapEntry>;
  orphans: WorkMapOrphan[];
  taskById: Map<string, WorkMapTask>;
}

export interface WorkMapTreeNode extends WorkMapEntry {
  children: WorkMapTreeNode[];
  /** ADO children that exist but are not shown, because they are not on the map or are filtered out. */
  hiddenChildCount: number;
}

export interface WorkMapTreeSection {
  key: string;
  /** A root with descendants gets its own section; single items with no parent share one. */
  kind: "hierarchy" | "unparented";
  nodes: WorkMapTreeNode[];
  /** In the order their first row appears. The first few are drawn as lanes. */
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

export const UNREADABLE = "Could not be read from ADO";

export const WORK_MAP_RELATION_LABELS: Record<Exclude<WorkMapRelation["type"], "parent" | "child">, string> = {
  related: "Related",
  predecessor: "Blocked by",
  successor: "Blocks",
  duplicate: "Duplicate",
  duplicateOf: "Duplicate of",
};

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

const lowerCased = (values: Array<string | number | null | undefined>) =>
  values.filter((value) => value !== null && value !== undefined).join("\n").toLowerCase();
const pullRequestWords = (pr: WorkMapPullRequest) => [pr.prId, pr.title, pr.repoName, pr.status];
const taskWords = (task: WorkMapTask) => [task.title, task.nextAction, task.waitingOn];

/**
 * The one definition of what needs attention on the map. An item with a warning here, or open
 * work with no Bridge task, is what "Needs attention" counts and what "Gaps only" keeps.
 */
function attentionFor(entry: WorkMapEntry, model: Pick<WorkMapModel, "entries" | "taskById">): string[] {
  const { item } = entry;
  if (item.title === null) return [UNREADABLE];
  if (isClosedWorkItemState(item.state)) {
    return entry.pullRequests.some((pr) => pr.status === "active") ? ["Closed while a PR is active"] : [];
  }
  const attention: string[] = [];
  const parent = entry.parentId ? model.entries.get(entry.parentId)?.item : undefined;
  if (parent && isClosedWorkItemState(parent.state)) {
    attention.push(`Open under a ${parent.state?.toLowerCase()} parent`);
  }
  const blockers = entry.links
    .filter((link) => link.type === "predecessor")
    .flatMap((link) => model.entries.get(link.workItemId)?.item ?? [])
    .filter((blocker) => blocker.state !== null && !isClosedWorkItemState(blocker.state));
  if (blockers.length > 0) attention.push(`Blocked by open ${blockers.map((blocker) => `#${blocker.id}`).join(", ")}`);
  if (entry.taskIds.length > 0 && entry.taskIds.every((taskId) => model.taskById.get(taskId)?.status === "archived")) {
    attention.push("Tracked only by archived Bridge tasks");
  }
  return attention;
}

export function needsAttention(entry: WorkMapEntry): boolean {
  return entry.needsTask || entry.attention.length > 0;
}

/** Indexes the server's answer: every work item with its place in the hierarchy, its pull requests and its tasks. */
export function buildWorkMapModel(data: WorkMapData): WorkMapModel {
  const taskById = new Map(data.tasks.map((task) => [task.id, task]));
  const pullRequestByKey = new Map(data.pullRequests.map((pr) => [pr.key, pr]));
  const tasksOf = (taskIds: string[]) => taskIds.flatMap((taskId) => taskById.get(taskId) ?? []);

  const sources = new Map<string, { item: EnrichedWorkItem; mapItem: WorkMapWorkItem | null; relations: WorkMapRelation[] }>();
  for (const item of data.contextWorkItems) sources.set(item.id, { item, mapItem: null, relations: item.relations });
  for (const item of data.workItems) sources.set(item.id, { item, mapItem: item, relations: item.relations });

  const parentOf = new Map<string, string>();
  const childIdsOf = new Map<string, Set<string>>();
  const link = (parentId: string, childId: string) => {
    if (!parentOf.has(childId) && sources.has(parentId) && sources.has(childId)) parentOf.set(childId, parentId);
    const children = childIdsOf.get(parentId) ?? new Set<string>();
    children.add(childId);
    childIdsOf.set(parentId, children);
  };
  for (const [id, source] of sources) {
    for (const relation of source.relations) {
      if (relation.type === "parent") link(relation.workItemId, id);
      else if (relation.type === "child") link(id, relation.workItemId);
    }
  }

  const entries = new Map<string, WorkMapEntry>();
  for (const [id, { item, mapItem, relations }] of sources) {
    const pullRequests = (mapItem?.pullRequestKeys ?? []).flatMap((key) => pullRequestByKey.get(key) ?? []);
    const tasks = tasksOf([...new Set([...(mapItem?.taskIds ?? []), ...pullRequests.flatMap((pr) => pr.taskIds)])]);
    entries.set(id, {
      id,
      item,
      mapItem,
      parentId: parentOf.get(id) ?? null,
      childIds: [...(childIdsOf.get(id) ?? [])],
      pullRequests,
      taskIds: tasks.map((task) => task.id),
      links: relations.filter((relation) => relation.type !== "parent" && relation.type !== "child"),
      attention: [],
      needsTask: mapItem !== null && tasks.length === 0 && item.title !== null && !isClosedWorkItemState(item.state),
      searchText: lowerCased([
        item.id, item.title, item.state, item.type, item.assignedTo, item.areaPath,
        ...pullRequests.flatMap(pullRequestWords),
        ...tasks.flatMap(taskWords),
      ]),
    });
  }
  // A warning can depend on another item's state, so it is worked out once every item is indexed.
  for (const entry of entries.values()) entry.attention = attentionFor(entry, { entries, taskById });

  const orphans = data.pullRequests.filter((pr) => pr.workItemIds.length === 0).map((pullRequest) => {
    const tasks = tasksOf(pullRequest.taskIds);
    return {
      pullRequest,
      tasks,
      needsAttention: pullRequest.title === null || pullRequest.status === "active",
      searchText: lowerCased([...pullRequestWords(pullRequest), ...tasks.flatMap(taskWords)]),
    };
  });
  return { entries, orphans, taskById };
}

export interface WorkMapVisibility {
  search: string;
  assignedToMeOnly: boolean;
  openAdoOnly: boolean;
  gapsOnly: boolean;
}

/** The map items and orphan pull requests the filters leave on screen. */
export function filterWorkMap(
  model: WorkMapModel,
  filters: WorkMapVisibility,
): { workItemIds: Set<string>; orphans: WorkMapOrphan[] } {
  const query = filters.search.trim().toLowerCase();
  const workItemIds = new Set<string>();
  for (const entry of model.entries.values()) {
    if (!entry.mapItem) continue;
    if (filters.assignedToMeOnly && !entry.mapItem.assignedToCurrentUser) continue;
    if (filters.openAdoOnly && isClosedWorkItemState(entry.item.state)
      && !entry.pullRequests.some((pr) => pr.status === "active")) continue;
    if (filters.gapsOnly && !needsAttention(entry)) continue;
    if (entry.searchText.includes(query)) workItemIds.add(entry.id);
  }
  // A pull request is not assigned work, so none is shown beside the reader's own work items.
  const orphans = filters.assignedToMeOnly ? [] : model.orphans.filter((orphan) =>
    (!filters.openAdoOnly || orphan.pullRequest.status === "active")
    && (!filters.gapsOnly || orphan.needsAttention)
    && orphan.searchText.includes(query));
  return { workItemIds, orphans };
}

/** The headline figures for what is on screen. */
export function summarizeWorkMap(model: WorkMapModel, visible: ReturnType<typeof filterWorkMap>) {
  const pullRequestKeys = new Set(visible.orphans.map((orphan) => orphan.pullRequest.key));
  const taskIds = new Set(visible.orphans.flatMap((orphan) => orphan.tasks.map((task) => task.id)));
  let attention = visible.orphans.filter((orphan) => orphan.needsAttention).length;
  for (const id of visible.workItemIds) {
    const entry = model.entries.get(id)!;
    for (const pr of entry.pullRequests) pullRequestKeys.add(pr.key);
    for (const taskId of entry.taskIds) taskIds.add(taskId);
    if (needsAttention(entry)) attention++;
  }
  return { workItems: visible.workItemIds.size, pullRequests: pullRequestKeys.size, tasks: taskIds.size, attention };
}

function compareNodes(a: WorkMapTreeNode, b: WorkMapTreeNode): number {
  const closed = Number(isClosedWorkItemState(a.item.state)) - Number(isClosedWorkItemState(b.item.state));
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

function isAncestor(candidate: string, of: string, entries: WorkMapModel["entries"]): boolean {
  const seen = new Set<string>();
  for (let current: string | null = of; current && !seen.has(current); current = entries.get(current)?.parentId ?? null) {
    if (current === candidate) return true;
    seen.add(current);
  }
  return false;
}

/**
 * Places the visible map items in the hierarchy. Ancestors of a visible item are included as
 * context even when they are filtered out or not on the map.
 */
export function buildWorkMapTree(model: WorkMapModel, visibleWorkItemIds: ReadonlySet<string>): WorkMapTreeSection[] {
  const nodes = new Map<string, WorkMapTreeNode>();
  for (const id of visibleWorkItemIds) {
    // Stopping at a node that is already placed also ends the walk on a cycle in ADO's links.
    for (let entry = model.entries.get(id); entry && !nodes.has(entry.id); entry = model.entries.get(entry.parentId ?? "")) {
      nodes.set(entry.id, { ...entry, children: [], hiddenChildCount: 0 });
    }
  }

  const roots: WorkMapTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    // Hanging a node under its own descendant would hide both.
    if (parent && !isAncestor(node.id, parent.id, model.entries)) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) {
    node.children.sort(compareNodes);
    node.hiddenChildCount = node.childIds.filter((id) => !nodes.has(id)).length;
  }
  roots.sort(compareNodes);

  const hierarchies = roots.filter((root) => root.children.length > 0);
  const unparented = roots.filter((root) => root.children.length === 0);
  const sections: WorkMapTreeSection[] = hierarchies
    .map((root) => ({ key: root.id, kind: "hierarchy" as const, nodes: [root], taskIds: [...collectTaskIds([root])] }))
    .sort((a, b) =>
      (b.taskIds.length - a.taskIds.length)
      || (countNodes(b.nodes) - countNodes(a.nodes))
      || compareNodes(a.nodes[0], b.nodes[0]));
  if (unparented.length > 0) {
    sections.push({ key: "unparented", kind: "unparented", nodes: unparented, taskIds: [...collectTaskIds(unparented)] });
  }
  return sections;
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

/**
 * Each task keeps one colour everywhere on the map. Colours are handed out in order of first
 * appearance, skipping any colour already drawn as a lane in a section the task shares, so two
 * lanes side by side never look like the same task while there are colours left.
 */
export function assignTaskColors(sections: WorkMapTreeSection[], maxLanes: number): Map<string, IdentityColor> {
  const laneMates = new Map<string, Set<string>>();
  for (const section of sections) {
    const lanes = section.taskIds.slice(0, maxLanes);
    for (const taskId of lanes) {
      const mates = laneMates.get(taskId) ?? new Set<string>();
      for (const other of lanes) mates.add(other);
      laneMates.set(taskId, mates);
    }
  }
  const colors = new Map<string, IdentityColor>();
  for (const taskId of sections.flatMap((section) => section.taskIds)) {
    if (colors.has(taskId)) continue;
    const taken = new Set([...(laneMates.get(taskId) ?? [])].map((other) => colors.get(other)));
    const inTurn = IDENTITY_COLORS.map((_, index) => IDENTITY_COLORS[(colors.size + index) % IDENTITY_COLORS.length]);
    colors.set(taskId, inTurn.find((color) => !taken.has(color)) ?? inTurn[0]);
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

export interface WorkMapSelection {
  ids: ReadonlySet<string>;
  /** The row a Shift-click extends the selection from. */
  anchorId: string | null;
}

export const NO_SELECTION: WorkMapSelection = { ids: new Set(), anchorId: null };

/**
 * Toggles a row in the selection. With `range`, every row between the last clicked row and this
 * one is added instead. `rowOrder` is the rows as they are on screen.
 */
export function selectRow(
  selection: WorkMapSelection,
  rowOrder: readonly string[],
  id: string,
  range: boolean,
): WorkMapSelection {
  const from = selection.anchorId ? rowOrder.indexOf(selection.anchorId) : -1;
  const to = rowOrder.indexOf(id);
  if (range && from >= 0 && to >= 0) {
    const between = rowOrder.slice(Math.min(from, to), Math.max(from, to) + 1);
    return { ids: new Set([...selection.ids, ...between]), anchorId: selection.anchorId };
  }
  const ids = new Set(selection.ids);
  if (!ids.delete(id)) ids.add(id);
  return { ids, anchorId: id };
}

/**
 * What a click inside a row does to the selection. A link, checkbox or button acts on its own. Ctrl,
 * Cmd or Shift selects from anywhere else on the row, and once rows are selected a plain click
 * beside the title toggles the row. Returns whether to select a range, or null to leave it alone.
 */
export function rowClickSelects(
  clicked: "control" | "title" | "row",
  modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  hasSelection: boolean,
): { range: boolean } | null {
  if (clicked === "control") return null;
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey) return { range: modifiers.shiftKey };
  return hasSelection && clicked === "row" ? { range: false } : null;
}
