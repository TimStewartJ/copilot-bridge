import { describe, expect, it } from "vitest";
import type { WorkMapData, WorkMapWorkItem } from "./api";
import {
  assignTaskColors,
  buildWorkItemLookup,
  buildWorkMapTree,
  countTaskPlacements,
  flattenWorkMapTree,
  layoutWorkMapLanes,
  treeNodeAttention,
  type WorkMapTreeRow,
} from "./work-map-tree";

function item(
  id: string,
  type: string,
  state: string,
  relations: WorkMapWorkItem["relations"] = [],
  taskIds: string[] = [],
): WorkMapWorkItem {
  return {
    id,
    provider: "ado",
    title: `${type} ${id}`,
    state,
    type,
    assignedTo: null,
    areaPath: null,
    url: `https://example.test/${id}`,
    taskIds,
    pullRequestKeys: [],
    assignedToCurrentUser: true,
    relations,
  };
}

function context(id: string, type: string, state: string, parentId?: string) {
  return {
    id,
    provider: "ado" as const,
    title: `${type} ${id}`,
    state,
    type,
    assignedTo: null,
    areaPath: null,
    url: `https://example.test/${id}`,
    relations: parentId ? [{ type: "parent" as const, workItemId: parentId }] : [],
  };
}

// Mirrors a real shape: an epic with a feature whose tasks are tracked by one Bridge task, a bug
// in a second branch tracked by the same task, and an unparented bug.
const DATA: WorkMapData = {
  enabled: true,
  includeArchived: false,
  assignedToMe: false,
  currentUser: null,
  org: "msazure",
  project: "One",
  generatedAt: "2026-09-28T00:00:00.000Z",
  tasks: [
    { id: "scrub", title: "Scrub strings", kind: "task", status: "active", deferred: false, priority: 0, nextAction: null, waitingOn: null },
    { id: "e2e", title: "Fix E2E", kind: "task", status: "active", deferred: false, priority: 0, nextAction: null, waitingOn: null },
  ],
  workItems: [
    item("20", "Feature", "Active", [
      { type: "parent", workItemId: "1" },
      { type: "child", workItemId: "21" },
      { type: "child", workItemId: "22" },
      { type: "child", workItemId: "23" },
    ], ["scrub"]),
    item("21", "Task", "In Progress", [{ type: "parent", workItemId: "20" }], ["scrub"]),
    item("22", "Task", "To Do", [
      { type: "parent", workItemId: "20" },
      { type: "predecessor", workItemId: "21" },
    ], ["scrub"]),
    item("40", "Bug", "Active", [{ type: "parent", workItemId: "30" }], ["scrub"]),
    item("50", "Bug", "New", [{ type: "duplicate", workItemId: "51" }], ["e2e"]),
    item("41", "Bug", "New", [{ type: "parent", workItemId: "31" }]),
  ],
  contextWorkItems: [
    context("1", "Epic", "New", "0"),
    context("0", "Objective", "Committed"),
    context("30", "Feature", "Active", "0"),
    context("31", "Feature", "Done", "0"),
  ],
  pullRequests: [],
  warnings: [],
};

const ALL_IDS = new Set(DATA.workItems.map((workItem) => workItem.id));

function rowIds(rows: WorkMapTreeRow[]): string[] {
  return rows.map((row) => row.node.id);
}

describe("work map tree", () => {
  it("places map items under their ADO ancestors and keeps unparented items together", () => {
    const sections = buildWorkMapTree(DATA, ALL_IDS);

    expect(sections.map((section) => section.key)).toEqual(["0", "unparented"]);
    expect(rowIds(flattenWorkMapTree(sections[0].nodes, new Set()))).toEqual([
      "0", "1", "20", "21", "22", "30", "40", "31", "41",
    ]);
    expect(sections[0].nodes[0].children[0].children[0].hiddenChildCount).toBe(1);
    expect(sections[0].nodes[0].mapItem).toBeNull();
    expect(sections[1].nodes.map((node) => node.id)).toEqual(["50"]);
  });

  it("keeps filtered-out ancestors as context and counts hidden children", () => {
    const sections = buildWorkMapTree(DATA, new Set(["21"]));
    const rows = flattenWorkMapTree(sections[0].nodes, new Set());

    expect(rowIds(rows)).toEqual(["0", "1", "20", "21"]);
    expect(rows.map((row) => row.node.hiddenChildCount)).toEqual([2, 0, 2, 0]);
  });

  it("draws one run per branch in a task's lane and names the task where each run starts", () => {
    const sections = buildWorkMapTree(DATA, ALL_IDS);
    const rows = flattenWorkMapTree(sections[0].nodes, new Set());
    const lanes = layoutWorkMapLanes(rows, new Set(), 6);
    const index = (id: string) => rowIds(rows).indexOf(id);

    expect(lanes.laneTaskIds).toEqual(["scrub"]);
    expect(lanes.cells[index("20")][0]).toEqual({ mark: true, up: false, down: true });
    expect(lanes.cells[index("21")][0]).toEqual({ mark: true, up: true, down: true });
    expect(lanes.cells[index("22")][0]).toEqual({ mark: true, up: true, down: false });
    expect(lanes.cells[index("40")][0]).toEqual({ mark: true, up: false, down: false });
    expect(lanes.cells[index("30")][0]).toBeNull();
    expect(lanes.runStarts.get(index("20"))).toEqual(["scrub"]);
    expect(lanes.runStarts.get(index("40"))).toEqual(["scrub"]);
    expect(lanes.runStarts.has(index("21"))).toBe(false);
    expect(countTaskPlacements(sections).get("scrub")).toBe(2);
  });

  it("marks a collapsed node with the tasks linked beneath it", () => {
    const sections = buildWorkMapTree(DATA, ALL_IDS);
    const collapsed = new Set(["1"]);
    const rows = flattenWorkMapTree(sections[0].nodes, collapsed);
    const lanes = layoutWorkMapLanes(rows, collapsed, 6);

    expect(rowIds(rows)).toEqual(["0", "1", "30", "40", "31", "41"]);
    expect(lanes.cells[1][0]).toEqual({ mark: true, up: false, down: false });
  });

  it("names tasks beyond the lane limit on their rows", () => {
    const sections = buildWorkMapTree(DATA, ALL_IDS);
    const rows = flattenWorkMapTree(sections[1].nodes, new Set());
    const lanes = layoutWorkMapLanes(rows, new Set(), 0);

    expect(lanes.laneTaskIds).toEqual([]);
    expect(lanes.runStarts.get(0)).toEqual(["e2e"]);
  });

  it("gives each task one colour and flags hierarchy problems", () => {
    const sections = buildWorkMapTree(DATA, ALL_IDS);
    const colors = assignTaskColors(sections);
    expect(colors.get("scrub")).toBe("blue");
    expect(colors.get("e2e")).toBe("purple");

    const lookup = buildWorkItemLookup(DATA);
    const nodes = new Map<string, (typeof sections)[number]["nodes"][number]>();
    const visit = (node: (typeof sections)[number]["nodes"][number]) => {
      nodes.set(node.id, node);
      node.children.forEach(visit);
    };
    sections.forEach((section) => section.nodes.forEach(visit));

    expect(treeNodeAttention(nodes.get("41")!, nodes.get("31"), lookup)).toEqual(["Open under a done parent"]);
    expect(treeNodeAttention(nodes.get("22")!, nodes.get("20"), lookup)).toEqual(["Blocked by open #21"]);
    expect(treeNodeAttention(nodes.get("21")!, nodes.get("20"), lookup)).toEqual([]);
  });

  it("does not loop on a parent cycle", () => {
    const cyclic: WorkMapData = {
      ...DATA,
      workItems: [
        item("1", "Feature", "Active", [{ type: "parent", workItemId: "2" }]),
        item("2", "Feature", "Active", [{ type: "parent", workItemId: "1" }]),
      ],
      contextWorkItems: [],
    };
    const sections = buildWorkMapTree(cyclic, new Set(["1", "2"]));
    const ids = sections.flatMap((section) => rowIds(flattenWorkMapTree(section.nodes, new Set())));
    expect(ids.sort()).toEqual(["1", "2"]);
  });
});
