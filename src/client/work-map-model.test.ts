import { describe, expect, it } from "vitest";
import type { WorkMapData, WorkMapPullRequest, WorkMapWorkItem } from "./api";
import { IDENTITY_COLORS } from "./design/identity";
import {
  assignTaskColors,
  buildWorkMapModel,
  buildWorkMapTree,
  countTaskPlacements,
  filterWorkMap,
  flattenWorkMapTree,
  layoutWorkMapLanes,
  NO_SELECTION,
  rowClickSelects,
  selectRow,
  summarizeWorkMap,
  type WorkMapTreeRow,
  type WorkMapTreeSection,
} from "./work-map-model";

function item(
  id: string,
  type: string,
  state: string,
  relations: WorkMapWorkItem["relations"] = [],
  taskIds: string[] = [],
  extra: Partial<WorkMapWorkItem> = {},
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
    ...extra,
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

function pullRequest(prId: number, status: WorkMapPullRequest["status"], extra: Partial<WorkMapPullRequest> = {}): WorkMapPullRequest {
  return {
    key: `repo:${prId}`,
    repoId: "repo",
    repoName: "bridge",
    prId,
    provider: "ado",
    title: `PR ${prId}`,
    status,
    createdBy: null,
    reviewerCount: 0,
    url: `https://example.test/pr/${prId}`,
    taskIds: [],
    workItemIds: [],
    ...extra,
  };
}

const task = (id: string, title: string, status: "active" | "archived" = "active") =>
  ({ id, title, kind: "task" as const, status, deferred: false, priority: 0, nextAction: null, waitingOn: null });

// Mirrors a real shape: an epic with a feature whose tasks are tracked by one Bridge task, a bug
// in a second branch tracked by the same task, and an unparented bug.
const DATA: WorkMapData = {
  enabled: true,
  currentUser: null,
  org: "msazure",
  project: "One",
  tasks: [task("scrub", "Scrub strings"), task("e2e", "Fix E2E")],
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

const MODEL = buildWorkMapModel(DATA);
const ALL_IDS = new Set(DATA.workItems.map((workItem) => workItem.id));
const EVERYTHING = { search: "", assignedToMeOnly: false, openAdoOnly: false, gapsOnly: false };

function rowIds(rows: WorkMapTreeRow[]): string[] {
  return rows.map((row) => row.node.id);
}

describe("work map tree", () => {
  it("places map items under their ADO ancestors and keeps unparented items together", () => {
    const sections = buildWorkMapTree(MODEL, ALL_IDS);

    expect(sections.map((section) => section.key)).toEqual(["0", "unparented"]);
    expect(rowIds(flattenWorkMapTree(sections[0].nodes, new Set()))).toEqual([
      "0", "1", "20", "21", "22", "30", "40", "31", "41",
    ]);
    expect(sections[0].nodes[0].children[0].children[0].hiddenChildCount).toBe(1);
    expect(sections[0].nodes[0].mapItem).toBeNull();
    expect(sections[1].nodes.map((node) => node.id)).toEqual(["50"]);
  });

  it("keeps filtered-out ancestors as context and counts hidden children", () => {
    const sections = buildWorkMapTree(MODEL, new Set(["21"]));
    const rows = flattenWorkMapTree(sections[0].nodes, new Set());

    expect(rowIds(rows)).toEqual(["0", "1", "20", "21"]);
    expect(rows.map((row) => row.node.hiddenChildCount)).toEqual([2, 0, 2, 0]);
  });

  it("draws one run per branch in a task's lane and names the task where each run starts", () => {
    const sections = buildWorkMapTree(MODEL, ALL_IDS);
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
    const sections = buildWorkMapTree(MODEL, ALL_IDS);
    const collapsed = new Set(["1"]);
    const rows = flattenWorkMapTree(sections[0].nodes, collapsed);
    const lanes = layoutWorkMapLanes(rows, collapsed, 6);

    expect(rowIds(rows)).toEqual(["0", "1", "30", "40", "31", "41"]);
    expect(lanes.cells[1][0]).toEqual({ mark: true, up: false, down: false });
  });

  it("names tasks beyond the lane limit on their rows", () => {
    const sections = buildWorkMapTree(MODEL, ALL_IDS);
    const rows = flattenWorkMapTree(sections[1].nodes, new Set());
    const lanes = layoutWorkMapLanes(rows, new Set(), 0);

    expect(lanes.laneTaskIds).toEqual([]);
    expect(lanes.runStarts.get(0)).toEqual(["e2e"]);
  });

  it("does not loop on a parent cycle", () => {
    const cyclic = buildWorkMapModel({
      ...DATA,
      workItems: [
        item("1", "Feature", "Active", [{ type: "parent", workItemId: "2" }]),
        item("2", "Feature", "Active", [{ type: "parent", workItemId: "1" }]),
      ],
      contextWorkItems: [],
    });
    const sections = buildWorkMapTree(cyclic, new Set(["1", "2"]));
    const ids = sections.flatMap((section) => rowIds(flattenWorkMapTree(section.nodes, new Set())));
    expect(ids.sort()).toEqual(["1", "2"]);
  });
});

describe("work map task colours", () => {
  const section = (key: string, taskIds: string[]): WorkMapTreeSection => ({ key, kind: "hierarchy", nodes: [], taskIds });

  it("gives each task one colour, in order of first appearance", () => {
    const colors = assignTaskColors(buildWorkMapTree(MODEL, ALL_IDS), 6);

    expect(colors.get("scrub")).toBe("blue");
    expect(colors.get("e2e")).toBe("purple");
  });

  it("never draws two lanes of a section in one colour, even with more tasks than colours", () => {
    // Ten tasks use every colour once. The eleventh would be blue again, beside the task that is blue.
    const first = Array.from({ length: IDENTITY_COLORS.length }, (_, index) => `first-${index}`);
    const sections = [section("a", first), section("b", ["first-0", "late", "later"])];

    const colors = assignTaskColors(sections, 6);

    expect(new Set(first.map((taskId) => colors.get(taskId))).size).toBe(IDENTITY_COLORS.length);
    expect(colors.get("first-0")).toBe("blue");
    expect(new Set(["first-0", "late", "later"].map((taskId) => colors.get(taskId))).size).toBe(3);
  });
});

describe("work map attention", () => {
  const data: WorkMapData = {
    ...DATA,
    tasks: [task("live", "Live task"), task("old", "Old task", "archived")],
    workItems: [
      item("20", "Feature", "Active", [{ type: "parent", workItemId: "31" }], ["live"]),
      item("21", "Task", "To Do", [{ type: "predecessor", workItemId: "20" }, { type: "predecessor", workItemId: "60" }], ["live"]),
      item("22", "Bug", "Done", [], ["live"], { pullRequestKeys: ["repo:7"] }),
      item("23", "Bug", "New"),
      item("24", "Bug", "Done"),
      item("25", "Bug", "Active", [], ["old"]),
      item("26", "Task", "New", [], ["live"], { title: null, state: null }),
      item("27", "Task", "Active", [], ["live"]),
    ],
    contextWorkItems: [context("31", "Feature", "Done"), context("60", "Task", "Closed")],
    pullRequests: [
      pullRequest(7, "active", { workItemIds: ["22"] }),
      pullRequest(8, "active", { taskIds: ["live"] }),
      pullRequest(9, "completed", { taskIds: ["live"] }),
      pullRequest(10, null, { title: null, taskIds: ["live"] }),
    ],
  };
  const model = buildWorkMapModel(data);
  const entry = (id: string) => model.entries.get(id)!;

  it("warns once per problem, in the words the row shows", () => {
    expect(entry("20").attention).toEqual(["Open under a done parent"]);
    expect(entry("21").attention).toEqual(["Blocked by open #20"]);
    expect(entry("22").attention).toEqual(["Closed while a PR is active"]);
    expect(entry("25").attention).toEqual(["Tracked only by archived Bridge tasks"]);
    expect(entry("26").attention).toEqual(["Could not be read from ADO"]);
    expect(entry("27").attention).toEqual([]);
  });

  it("asks for a task only on open work that has none", () => {
    expect(entry("23").needsTask).toBe(true);
    expect(entry("24").needsTask).toBe(false);
    expect(entry("24").attention).toEqual([]);
    expect(entry("27").needsTask).toBe(false);
    expect(entry("31").needsTask).toBe(false);
  });

  it("counts and filters with the same rule the rows use", () => {
    const everything = filterWorkMap(model, EVERYTHING);
    const gaps = filterWorkMap(model, { ...EVERYTHING, gapsOnly: true });

    expect(summarizeWorkMap(model, everything)).toEqual({ workItems: 8, pullRequests: 4, tasks: 2, attention: 8 });
    expect([...gaps.workItemIds]).toEqual(["20", "21", "22", "23", "25", "26"]);
    // A finished pull request with no work item is not a gap; an active or unreadable one is.
    expect(gaps.orphans.map((orphan) => orphan.pullRequest.prId)).toEqual([8, 10]);
    expect(summarizeWorkMap(model, gaps).attention).toBe(8);
  });

  it("filters by assignment, open state and search text", () => {
    const mine = buildWorkMapModel({
      ...data,
      workItems: data.workItems.map((workItem) => ({ ...workItem, assignedToCurrentUser: workItem.id === "23" })),
    });

    const assigned = filterWorkMap(mine, { ...EVERYTHING, assignedToMeOnly: true });
    expect([...assigned.workItemIds]).toEqual(["23"]);
    expect(assigned.orphans).toEqual([]);

    const open = filterWorkMap(model, { ...EVERYTHING, openAdoOnly: true });
    // A closed item stays while one of its pull requests is still active.
    expect([...open.workItemIds]).toEqual(["20", "21", "22", "23", "25", "26", "27"]);
    expect(open.orphans.map((orphan) => orphan.pullRequest.prId)).toEqual([8]);

    expect([...filterWorkMap(model, { ...EVERYTHING, search: "  OLD task " }).workItemIds]).toEqual(["25"]);
    expect([...filterWorkMap(model, { ...EVERYTHING, search: "pr 7" }).workItemIds]).toEqual(["22"]);
    expect(filterWorkMap(model, { ...EVERYTHING, search: "pr 9" }).orphans.map((orphan) => orphan.pullRequest.prId)).toEqual([9]);
  });
});

describe("work map selection", () => {
  const rows = ["a", "b", "c", "d"];

  it("toggles a row and remembers it as the anchor", () => {
    const one = selectRow(NO_SELECTION, rows, "b", false);
    expect([...one.ids]).toEqual(["b"]);
    expect(one.anchorId).toBe("b");

    const none = selectRow(one, rows, "b", false);
    expect([...none.ids]).toEqual([]);
  });

  it("adds every row between the anchor and a range click, in either direction", () => {
    const anchored = selectRow(NO_SELECTION, rows, "c", false);

    expect([...selectRow(anchored, rows, "a", true).ids].sort()).toEqual(["a", "b", "c"]);
    const down = selectRow(anchored, rows, "d", true);
    expect([...down.ids].sort()).toEqual(["c", "d"]);
    expect(down.anchorId).toBe("c");
  });

  it("treats a range click with no anchor on screen as a plain toggle", () => {
    expect([...selectRow(NO_SELECTION, rows, "c", true).ids]).toEqual(["c"]);
    const offScreen = selectRow({ ids: new Set(["gone"]), anchorId: "gone" }, rows, "c", true);
    expect([...offScreen.ids].sort()).toEqual(["c", "gone"]);
  });

  it("decides what a click inside a row selects", () => {
    const plain = { ctrlKey: false, metaKey: false, shiftKey: false };
    const ctrl = { ...plain, ctrlKey: true };
    const meta = { ...plain, metaKey: true };
    const shift = { ...plain, shiftKey: true };

    // A link, checkbox or button acts on its own, whatever is held.
    expect(rowClickSelects("control", ctrl, true)).toBeNull();
    expect(rowClickSelects("control", plain, true)).toBeNull();
    // Ctrl, Cmd and Shift select from the title and from the rest of the row.
    expect(rowClickSelects("title", ctrl, false)).toEqual({ range: false });
    expect(rowClickSelects("row", meta, false)).toEqual({ range: false });
    expect(rowClickSelects("title", shift, false)).toEqual({ range: true });
    // A plain click on the title opens the row. Beside it, it toggles only once rows are selected.
    expect(rowClickSelects("title", plain, true)).toBeNull();
    expect(rowClickSelects("row", plain, false)).toBeNull();
    expect(rowClickSelects("row", plain, true)).toEqual({ range: false });
  });
});
