import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkMapData } from "../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import DashboardWorkMap from "./DashboardWorkMap";
import { WORK_MAP_FILTERS_STORAGE_KEY } from "../work-map-filter-state";

const DATA: WorkMapData = {
  enabled: true,
  includeArchived: false,
  assignedToMe: false,
  currentUser: { displayName: "Tim Stewart" },
  org: "msazure",
  project: "One",
  generatedAt: "2026-08-31T20:00:00.000Z",
  tasks: [{
    id: "task-1",
    title: "Ship the work map",
    kind: "task",
    deferred: false,
    status: "active",
    priority: 0,
    nextAction: "Review the preview",
    waitingOn: null,
  }],
  workItems: [{
    id: "37655015",
    provider: "ado",
    title: "Review SDL bug",
    state: "Done",
    type: "Bug",
    assignedTo: "Tim Stewart",
    areaPath: "One\\AzureStack",
    url: "https://example.test/workitems/37655015",
    taskIds: ["task-1"],
    pullRequestKeys: ["repo-id:15509721"],
    assignedToCurrentUser: true,
  }],
  pullRequests: [{
    key: "repo-id:15509721",
    repoId: "repo-id",
    repoName: "AzureStack-ZTP-OOBE",
    prId: 15509721,
    provider: "ado",
    title: "Fix standalone pipeline PowerShell injection",
    status: "active",
    createdBy: "Tim Stewart",
    reviewerCount: 1,
    url: "https://example.test/pullrequests/15509721",
    taskIds: [],
    workItemIds: ["37655015"],
  }],
  warnings: [],
};

const NO_MODIFIERS = { ctrlKey: false, metaKey: false, shiftKey: false };

function buttonWithText(harness: ReactDomHarness, text: string) {
  const button = findAllByTag(harness.dom.container, "BUTTON")
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function metricValue(harness: ReactDomHarness, label: string): string {
  const metric = findAllByTag(harness.dom.container, "DIV").find((candidate) =>
    String(getReactProps(candidate)?.["aria-label"] ?? "").startsWith(`${label}: `));
  if (!metric) throw new Error(`Metric not found: ${label}`);
  return String(getReactProps(metric)?.["aria-label"]).slice(label.length + 2);
}

function stubLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, String(value))),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() {
      return values.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

describe("DashboardWorkMap", () => {
  let harness: ReactDomHarness;

  beforeEach(async () => {
    stubLocalStorage({ [WORK_MAP_FILTERS_STORAGE_KEY]: JSON.stringify({ view: "clusters" }) });
    harness = await createReactDomHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.unstubAllGlobals();
  });

  it("renders ADO relationships, attention signals, and opens Bridge tasks", async () => {
    const onSelectTask = vi.fn();
    const onIncludeArchivedChange = vi.fn();
    await harness.render(createElement(DashboardWorkMap, {
      active: true,
      data: DATA,
      isLoading: false,
      error: null,
      isRefreshing: false,
      onRefresh: vi.fn(async () => undefined),
      includeArchived: false,
      onIncludeArchivedChange,
      assignedToMeOnly: false,
      onAssignedToMeChange: vi.fn(),
      onSelectTask,
      onCreateTaskForWorkItems: vi.fn(async () => undefined),
    }));

    expect(harness.dom.container.textContent).toContain("Review SDL bug");
    expect(harness.dom.container.textContent).toContain("Fix standalone pipeline PowerShell injection");
    expect(harness.dom.container.textContent).toContain("Ship the work map");
    expect(harness.dom.container.textContent).toContain("Work item is closed while a related PR is active");

    await harness.act(async () => {
      getReactProps(buttonWithText(harness, "Ship the work map"))?.onClick();
    });
    expect(onSelectTask).toHaveBeenCalledWith("task-1");

    await harness.act(async () => {
      getReactProps(buttonWithText(harness, "Archived tasks"))?.onClick();
    });
    expect(onIncludeArchivedChange).toHaveBeenCalledWith(true);
  });

  it("filters the relationship cards by search text", async () => {
    await harness.render(createElement(DashboardWorkMap, {
      active: true,
      data: DATA,
      isLoading: false,
      error: null,
      isRefreshing: false,
      onRefresh: vi.fn(async () => undefined),
      includeArchived: false,
      onIncludeArchivedChange: vi.fn(),
      assignedToMeOnly: false,
      onAssignedToMeChange: vi.fn(),
      onSelectTask: vi.fn(),
      onCreateTaskForWorkItems: vi.fn(async () => undefined),
    }));
    const input = findAllByTag(harness.dom.container, "INPUT")[0];
    if (!input) throw new Error("Search input not found");

    await harness.act(async () => {
      getReactProps(input)?.onChange({ target: { value: "not present" } });
    });

    expect(harness.dom.container.textContent).toContain("No relationships match these filters");
    expect(harness.dom.container.textContent).not.toContain("Review SDL bug");
  });

  it("filters work items to the authenticated ADO user", async () => {
    const data: WorkMapData = {
      ...DATA,
      workItems: [
        ...DATA.workItems,
        {
          ...DATA.workItems[0],
          id: "99",
          title: "Someone else's work",
          assignedTo: "Another Person",
          pullRequestKeys: [],
          assignedToCurrentUser: false,
        },
      ],
    };
    const onAssignedToMeChange = vi.fn();
    await harness.render(createElement(DashboardWorkMap, {
      active: true,
      data,
      isLoading: false,
      error: null,
      isRefreshing: false,
      onRefresh: vi.fn(async () => undefined),
      includeArchived: false,
      onIncludeArchivedChange: vi.fn(),
      assignedToMeOnly: false,
      onAssignedToMeChange,
      onSelectTask: vi.fn(),
      onCreateTaskForWorkItems: vi.fn(async () => undefined),
    }));

    await harness.act(async () => {
      getReactProps(buttonWithText(harness, "Assigned to me"))?.onClick();
    });

    expect(onAssignedToMeChange).toHaveBeenCalledWith(true);
    await harness.render(createElement(DashboardWorkMap, {
      active: true,
      data,
      isLoading: false,
      error: null,
      isRefreshing: false,
      onRefresh: vi.fn(async () => undefined),
      includeArchived: false,
      onIncludeArchivedChange: vi.fn(),
      assignedToMeOnly: true,
      onAssignedToMeChange,
      onSelectTask: vi.fn(),
      onCreateTaskForWorkItems: vi.fn(async () => undefined),
    }));

    expect(harness.dom.container.textContent).toContain("Review SDL bug");
    expect(harness.dom.container.textContent).not.toContain("Someone else's work");
    expect(metricValue(harness, "ADO work items")).toBe("1");
    expect(metricValue(harness, "Related PRs")).toBe("1");
    expect(metricValue(harness, "Bridge tasks")).toBe("1");
    expect(metricValue(harness, "Needs attention")).toBe("1");
  });

  it("restores previously selected filters and search text", async () => {
    vi.unstubAllGlobals();
    stubLocalStorage({
      [WORK_MAP_FILTERS_STORAGE_KEY]: JSON.stringify({
        search: "SDL",
        assignedToMeOnly: true,
        openAdoOnly: true,
        gapsOnly: false,
        includeArchived: false,
      }),
    });
    await harness.render(createElement(DashboardWorkMap, {
      active: true,
      data: DATA,
      isLoading: false,
      error: null,
      isRefreshing: false,
      onRefresh: vi.fn(async () => undefined),
      includeArchived: false,
      onIncludeArchivedChange: vi.fn(),
      assignedToMeOnly: true,
      onAssignedToMeChange: vi.fn(),
      onSelectTask: vi.fn(),
      onCreateTaskForWorkItems: vi.fn(async () => undefined),
    }));

    const input = findAllByTag(harness.dom.container, "INPUT")[0];
    expect(getReactProps(input)?.value).toBe("SDL");
    expect(getReactProps(buttonWithText(harness, "Assigned to me"))?.["aria-pressed"]).toBe(true);
    expect(getReactProps(buttonWithText(harness, "Open ADO"))?.["aria-pressed"]).toBe(true);
    expect(harness.dom.container.textContent).toContain("Reset");
  });

  it("creates a linked task from an untracked work item", async () => {
    const untrackedItem = {
      ...DATA.workItems[0],
      taskIds: [],
      pullRequestKeys: [],
    };
    const onCreateTaskForWorkItems = vi.fn(async () => undefined);
    await harness.render(createElement(DashboardWorkMap, {
      active: true,
      data: {
        ...DATA,
        tasks: [],
        workItems: [untrackedItem],
        pullRequests: [],
      },
      isLoading: false,
      error: null,
      isRefreshing: false,
      onRefresh: vi.fn(async () => undefined),
      includeArchived: false,
      onIncludeArchivedChange: vi.fn(),
      assignedToMeOnly: false,
      onAssignedToMeChange: vi.fn(),
      onSelectTask: vi.fn(),
      onCreateTaskForWorkItems,
    }));

    await harness.act(async () => {
      getReactProps(buttonWithText(harness, "No Bridge task - create one"))?.onClick();
    });

    expect(onCreateTaskForWorkItems).toHaveBeenCalledWith([untrackedItem]);
  });

  describe("tree view", () => {
    const TREE_DATA: WorkMapData = {
      ...DATA,
      tasks: [
        ...DATA.tasks,
        {
          id: "task-2",
          title: "Tidy the epic",
          kind: "task",
          deferred: false,
          status: "active",
          priority: 0,
          nextAction: null,
          waitingOn: null,
        },
      ],
      workItems: [
        {
          ...DATA.workItems[0],
          relations: [{ type: "parent", workItemId: "500" }],
        },
        {
          ...DATA.workItems[0],
          id: "37655016",
          title: "Untracked follow-up",
          state: "New",
          taskIds: [],
          pullRequestKeys: [],
          relations: [
            { type: "parent", workItemId: "500" },
            { type: "predecessor", workItemId: "37655015" },
          ],
        },
        {
          ...DATA.workItems[0],
          id: "600",
          title: "Epic tracked elsewhere",
          state: "Active",
          type: "Epic",
          taskIds: ["task-2"],
          pullRequestKeys: [],
          relations: [],
        },
      ],
      contextWorkItems: [{
        id: "500",
        provider: "ado",
        title: "Parent feature",
        state: "Active",
        type: "Feature",
        assignedTo: null,
        areaPath: null,
        url: "https://example.test/workitems/500",
        relations: [{ type: "child", workItemId: "37655017" }],
      }],
    };

    function renderTree(onSelectTask = vi.fn(), onCreateTaskForWorkItems = vi.fn(async () => undefined)) {
      vi.unstubAllGlobals();
      stubLocalStorage();
      return harness.render(createElement(DashboardWorkMap, {
        active: true,
        data: TREE_DATA,
        isLoading: false,
        error: null,
        isRefreshing: false,
        onRefresh: vi.fn(async () => undefined),
        includeArchived: false,
        onIncludeArchivedChange: vi.fn(),
        assignedToMeOnly: false,
        onAssignedToMeChange: vi.fn(),
        onSelectTask,
        onCreateTaskForWorkItems,
      }));
    }

    function rowOrder(): string[] {
      return findAllByTag(harness.dom.container, "DIV")
        .map((element) => element.getAttribute("data-work-map-row"))
        .filter((id): id is string => Boolean(id));
    }

    it("is the default and nests work items under their ADO parent", async () => {
      await renderTree();

      expect(getReactProps(buttonWithText(harness, "Tree"))?.["aria-pressed"]).toBe(true);
      expect(rowOrder()).toEqual(["500", "37655016", "37655015", "600"]);
      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("Parent feature");
      expect(text).toContain("+1 in ADO");
      expect(text).toContain("Blocked by #37655015");
      expect(text).toContain("Closed while a PR is active");
      expect(text).toContain("Not under a parent in ADO");
    });

    it("opens a Bridge task from its lane name and creates tasks for untracked items", async () => {
      const onSelectTask = vi.fn();
      const onCreateTaskForWorkItems = vi.fn(async () => undefined);
      await renderTree(onSelectTask, onCreateTaskForWorkItems);

      await harness.act(async () => {
        getReactProps(buttonWithText(harness, "Ship the work map"))?.onClick();
      });
      expect(onSelectTask).toHaveBeenCalledWith("task-1");

      const create = findAllByTag(harness.dom.container, "BUTTON")
        .find((button) => button.getAttribute("aria-label") === "Create Bridge task for work item 37655016");
      if (!create) throw new Error("Create button not found");
      await harness.act(async () => {
        getReactProps(create)?.onClick();
      });
      expect(onCreateTaskForWorkItems).toHaveBeenCalledWith([TREE_DATA.workItems[1]]);
    });

    it("collapses a parent and expands a row into its pull requests and tasks", async () => {
      await renderTree();

      const collapse = findAllByTag(harness.dom.container, "BUTTON")
        .find((button) => button.getAttribute("aria-label") === "Collapse children of work item 500");
      if (!collapse) throw new Error("Collapse button not found");
      await harness.act(async () => {
        getReactProps(collapse)?.onClick();
      });
      expect(rowOrder()).toEqual(["500", "600"]);

      await harness.act(async () => {
        getReactProps(collapse)?.onClick();
      });
      await harness.act(async () => {
        getReactProps(buttonWithText(harness, "Review SDL bug"))?.onClick(NO_MODIFIERS);
      });
      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("Fix standalone pipeline PowerShell injection");
      expect(text).toContain("Next: Review the preview");
    });

    it("offers a task on a parent feature that is only context on the map", async () => {
      const onCreateTaskForWorkItems = vi.fn(async () => undefined);
      await renderTree(vi.fn(), onCreateTaskForWorkItems);

      const create = findAllByTag(harness.dom.container, "BUTTON")
        .find((button) => button.getAttribute("aria-label") === "Create Bridge task for work item 500");
      if (!create) throw new Error("Feature create button not found");
      await harness.act(async () => {
        getReactProps(create)?.onClick();
      });
      expect(onCreateTaskForWorkItems).toHaveBeenCalledWith([TREE_DATA.contextWorkItems![0]]);
    });

    it("selects rows with Ctrl and Shift clicks and creates one task linked to all of them", async () => {
      const onCreateTaskForWorkItems = vi.fn(async () => undefined);
      await renderTree(vi.fn(), onCreateTaskForWorkItems);
      const row = (id: string) => findAllByTag(harness.dom.container, "DIV")
        .find((element) => element.getAttribute("data-work-map-row") === id);
      const click = async (id: string, modifiers: Partial<typeof NO_MODIFIERS>) => {
        const element = row(id);
        await harness.act(async () => {
          getReactProps(element)?.onClick({
            ...NO_MODIFIERS,
            ...modifiers,
            target: { closest: () => null },
            preventDefault: vi.fn(),
          });
        });
      };

      await click("37655016", { ctrlKey: true });
      expect(harness.dom.container.textContent).toContain("1 work item selected");
      await click("600", { shiftKey: true });
      expect(harness.dom.container.textContent).toContain("3 work items selected");
      expect(row("600")?.getAttribute("data-selected")).toBe("");
      expect(row("500")?.getAttribute("data-selected")).toBeNull();

      // Once something is selected, a plain click toggles a row.
      await click("37655015", {});
      expect(harness.dom.container.textContent).toContain("2 work items selected");
      await click("37655015", {});

      await harness.act(async () => {
        getReactProps(buttonWithText(harness, "Create Bridge task"))?.onClick();
      });
      expect(onCreateTaskForWorkItems).toHaveBeenCalledWith([
        TREE_DATA.workItems[1],
        TREE_DATA.workItems[0],
        TREE_DATA.workItems[2],
      ]);
      expect(harness.dom.container.textContent).not.toContain("work items selected");
    });
  });
});
