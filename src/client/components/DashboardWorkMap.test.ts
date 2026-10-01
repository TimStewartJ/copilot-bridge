import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichedWorkItem, WorkMapData } from "../api";
import type { WorkMapQuery } from "../hooks/queries/useWorkMap";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { DEFAULT_WORK_MAP_FILTERS, type WorkMapFilters } from "../work-map-filter-state";
import DashboardWorkMap from "./DashboardWorkMap";

const TRACKED: WorkMapData["workItems"][number] = {
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
  relations: [{ type: "parent", workItemId: "500" }],
};

// A feature that is only context, with a tracked closed bug whose PR is still active, an untracked
// bug blocked by it, and an epic with no parent that another task tracks.
const DATA: WorkMapData = {
  enabled: true,
  currentUser: { displayName: "Tim Stewart" },
  org: "msazure",
  project: "One",
  tasks: [
    { id: "task-1", title: "Ship the work map", kind: "task", deferred: false, status: "active", priority: 0, nextAction: "Review the preview", waitingOn: null },
    { id: "task-2", title: "Tidy the epic", kind: "task", deferred: false, status: "active", priority: 0, nextAction: null, waitingOn: null },
  ],
  workItems: [
    TRACKED,
    {
      ...TRACKED,
      id: "37655016",
      title: "Untracked follow-up",
      state: "New",
      taskIds: [],
      pullRequestKeys: [],
      assignedToCurrentUser: false,
      relations: [
        { type: "parent", workItemId: "500" },
        { type: "predecessor", workItemId: "37655015" },
        { type: "duplicateOf", workItemId: "900" },
      ],
    },
    {
      ...TRACKED,
      id: "600",
      title: "Epic tracked elsewhere",
      state: "Active",
      type: "Epic",
      taskIds: ["task-2"],
      pullRequestKeys: [],
      assignedToCurrentUser: false,
      relations: [],
    },
  ],
  contextWorkItems: [
    {
      id: "500",
      provider: "ado",
      title: "Parent feature",
      state: "Active",
      type: "Feature",
      assignedTo: null,
      areaPath: null,
      url: "https://example.test/workitems/500",
      relations: [{ type: "child", workItemId: "37655017" }],
    },
    {
      id: "900",
      provider: "ado",
      title: "Original report",
      state: "Active",
      type: "Bug",
      assignedTo: null,
      areaPath: null,
      url: "https://example.test/workitems/900",
      relations: [],
    },
  ],
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

describe("DashboardWorkMap", () => {
  let harness: ReactDomHarness;

  beforeEach(async () => {
    harness = await createReactDomHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function render(options: {
    map?: Partial<WorkMapQuery>;
    filters?: Partial<WorkMapFilters>;
    onFiltersChange?: (change: Partial<WorkMapFilters>) => void;
    onSelectTask?: (taskId: string) => void;
    onCreateTaskForWorkItems?: (workItems: EnrichedWorkItem[]) => Promise<void>;
  } = {}) {
    return harness.render(createElement(DashboardWorkMap, {
      map: {
        data: DATA,
        error: null,
        isFetching: false,
        progress: null,
        refreshedAt: Date.now(),
        refresh: vi.fn(),
        ...options.map,
      },
      filters: { ...DEFAULT_WORK_MAP_FILTERS, ...options.filters },
      onFiltersChange: options.onFiltersChange ?? vi.fn(),
      onSelectTask: options.onSelectTask ?? vi.fn(),
      onCreateTaskForWorkItems: options.onCreateTaskForWorkItems ?? vi.fn(async () => undefined),
    }));
  }

  const text = () => harness.dom.container.textContent ?? "";

  function button(label: string) {
    const found = findAllByTag(harness.dom.container, "BUTTON").find((candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.includes(label));
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
  }

  function stat(label: string): string {
    const term = findAllByTag(harness.dom.container, "DT").find((candidate) => candidate.textContent === label);
    const value = term?.parentNode?.childNodes.find((sibling: any) => sibling.tagName === "DD");
    if (!value) throw new Error(`Figure not found: ${label}`);
    return value.textContent ?? "";
  }

  function row(id: string) {
    const found = findAllByTag(harness.dom.container, "DIV")
      .find((element) => element.getAttribute("data-work-map-row") === id);
    if (!found) throw new Error(`Row not found: ${id}`);
    return found;
  }

  function rowOrder(): string[] {
    return findAllByTag(harness.dom.container, "DIV")
      .map((element) => element.getAttribute("data-work-map-row"))
      .filter((id): id is string => Boolean(id));
  }

  /** Clicks a row the way a browser reports it: `on` says which part of the row was hit. */
  async function clickRow(id: string, on: "row" | "title" | "control", modifiers: Partial<typeof NO_MODIFIERS> = {}) {
    await harness.act(async () => {
      getReactProps(row(id))?.onClick({
        ...NO_MODIFIERS,
        ...modifiers,
        target: {
          closest: (selector: string) => {
            if (selector === "[data-row-title]") return on === "title" ? {} : null;
            return on === "control" ? {} : null;
          },
        },
        preventDefault: vi.fn(),
      });
    });
  }

  it("draws the hierarchy with its warnings and figures, and opens Bridge tasks", async () => {
    const onSelectTask = vi.fn();
    await render({ onSelectTask });

    expect(rowOrder()).toEqual(["500", "37655016", "37655015", "600"]);
    expect(text()).toContain("Parent feature");
    expect(text()).toContain("+1 in ADO");
    expect(text()).toContain("Blocked by #37655015");
    expect(text()).toContain("Closed while a PR is active");
    expect(text()).toContain("Not under a parent in ADO");
    expect(text()).toContain("2 work items · 1 Bridge task");
    // A section names its root's type once, in words.
    expect(text()).toContain("Feature 500");
    expect(text()).not.toContain("FeatureFeature 500");
    expect(stat("ADO work items")).toBe("3");
    expect(stat("Related PRs")).toBe("1");
    expect(stat("Bridge tasks")).toBe("2");
    // The closed bug with an active PR, and the open bug nobody tracks.
    expect(stat("Needs attention")).toBe("2");

    await harness.act(async () => {
      getReactProps(button("Ship the work map"))?.onClick();
    });
    expect(onSelectTask).toHaveBeenCalledWith("task-1");
  });

  it("applies the filters it is given and reports the ones the reader changes", async () => {
    const onFiltersChange = vi.fn();
    await render({ onFiltersChange, filters: { assignedToMeOnly: true, search: "sdl" } });

    expect(rowOrder()).toEqual(["500", "37655015"]);
    expect(stat("ADO work items")).toBe("1");
    expect(getReactProps(button("Assigned to me"))?.["aria-pressed"]).toBe(true);
    expect(getReactProps(button("Open ADO"))?.["aria-pressed"]).toBe(false);
    expect(getReactProps(findAllByTag(harness.dom.container, "INPUT")[0])?.value).toBe("sdl");

    await harness.act(async () => {
      getReactProps(button("Archived tasks"))?.onClick();
      getReactProps(button("Assigned to me"))?.onClick();
      getReactProps(findAllByTag(harness.dom.container, "INPUT")[0])?.onChange({ target: { value: "epic" } });
      getReactProps(button("Reset"))?.onClick();
    });

    expect(onFiltersChange.mock.calls.map(([change]) => change)).toEqual([
      { includeArchived: true },
      { assignedToMeOnly: false },
      { search: "epic" },
      DEFAULT_WORK_MAP_FILTERS,
    ]);
  });

  it("says so when the filters leave nothing", async () => {
    await render({ filters: { search: "not present" } });

    expect(text()).toContain("No work matches these filters");
    expect(text()).not.toContain("Review SDL bug");
    expect(stat("ADO work items")).toBe("0");
  });

  it("creates a task from an untracked item, and from a parent that is only context", async () => {
    const onCreateTaskForWorkItems = vi.fn(async () => undefined);
    await render({ onCreateTaskForWorkItems });

    await harness.act(async () => {
      getReactProps(button("Create Bridge task for work item 37655016"))?.onClick();
    });
    await harness.act(async () => {
      getReactProps(button("Create Bridge task for work item 500"))?.onClick();
    });

    expect(onCreateTaskForWorkItems.mock.calls).toEqual([[[DATA.workItems[1]]], [[DATA.contextWorkItems[0]]]]);
  });

  it("shows why a task could not be created", async () => {
    await render({ onCreateTaskForWorkItems: vi.fn(async () => { throw new Error("link failed"); }) });

    await harness.act(async () => {
      getReactProps(button("Create Bridge task for work item 37655016"))?.onClick();
    });

    expect(text()).toContain("Could not create the Bridge task");
    expect(text()).toContain("link failed");
  });

  it("collapses a parent and expands a row into its pull requests, tasks and links", async () => {
    await render();

    await harness.act(async () => {
      getReactProps(button("Collapse children of work item 500"))?.onClick();
    });
    expect(rowOrder()).toEqual(["500", "600"]);

    await harness.act(async () => {
      getReactProps(button("Expand children of work item 500"))?.onClick();
    });
    await harness.act(async () => {
      getReactProps(button("Review SDL bug"))?.onClick(NO_MODIFIERS);
    });
    expect(text()).toContain("Fix standalone pipeline PowerShell injection");
    expect(text()).toContain("Next: Review the preview");

    await harness.act(async () => {
      getReactProps(button("Untracked follow-up"))?.onClick(NO_MODIFIERS);
    });
    expect(text()).toContain("Original report");
  });

  it("selects rows with Ctrl and Shift clicks and creates one task linked to all of them", async () => {
    const onCreateTaskForWorkItems = vi.fn(async () => undefined);
    await render({ onCreateTaskForWorkItems });

    await clickRow("37655016", "row", { ctrlKey: true });
    expect(text()).toContain("1 work item selected");
    await clickRow("600", "title", { shiftKey: true });
    expect(text()).toContain("3 work items selected");
    expect(row("600").getAttribute("data-selected")).toBe("");
    expect(row("500").getAttribute("data-selected")).toBeNull();

    // Once something is selected, a plain click beside the title toggles a row.
    await clickRow("37655015", "row");
    expect(text()).toContain("2 work items selected");
    await clickRow("37655015", "row");

    await harness.act(async () => {
      getReactProps(button("Create Bridge task"))?.onClick();
    });
    expect(onCreateTaskForWorkItems).toHaveBeenCalledWith([DATA.workItems[1], DATA.workItems[0], DATA.workItems[2]]);
    expect(text()).not.toContain("work items selected");
  });

  it("leaves the selection alone when a click lands on a link, a button or the title", async () => {
    await render();
    await clickRow("37655016", "row", { ctrlKey: true });

    await clickRow("37655015", "control");
    await clickRow("37655015", "control", { ctrlKey: true });
    await clickRow("37655015", "title");

    expect(text()).toContain("1 work item selected");
    expect(row("37655015").getAttribute("data-selected")).toBeNull();
  });

  it("scrolls to a linked row that is on screen and lets any other link open ADO", async () => {
    await render();
    const links = findAllByTag(harness.dom.container, "A");
    const blockedBy = links.find((link) => link.textContent === "Blocked by #37655015");
    const duplicateOf = links.find((link) => link.textContent === "Duplicate of #900");
    const scrollIntoView = vi.fn();
    (globalThis.document as any).getElementById = (id: string) =>
      (id === "work-map-row-37655015" ? { scrollIntoView } : null);

    expect(blockedBy?.getAttribute("href")).toBe("https://example.test/workitems/37655015");
    const onScreen = { ...NO_MODIFIERS, preventDefault: vi.fn() };
    getReactProps(blockedBy)?.onClick(onScreen);
    expect(onScreen.preventDefault).toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // The duplicate is not a row on the map, so the click is left to open its ADO page.
    expect(duplicateOf?.getAttribute("href")).toBe("https://example.test/workitems/900");
    const offScreen = { ...NO_MODIFIERS, preventDefault: vi.fn() };
    getReactProps(duplicateOf)?.onClick(offScreen);
    expect(offScreen.preventDefault).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("shows the server's progress while there is nothing to show yet", async () => {
    await render({ map: { data: undefined, isFetching: true } });
    expect(text()).toContain("Loading the work map");
    // The filters stay usable, so a slow load can be changed or undone.
    expect(getReactProps(button("Archived tasks"))?.["aria-pressed"]).toBe(false);
    expect(getReactProps(button("Loading..."))?.disabled).toBe(true);

    await render({
      map: { data: undefined, isFetching: true, progress: { label: "Reading work items and their links", step: 2, steps: 4, done: 120, total: 480 } },
    });
    expect(text()).toContain("Reading work items and their links");
    expect(text()).toContain("Step 2 of 4 · 120 of 480");
    // One bar for the whole build: a quarter of the second of four steps.
    const fill = findAllByTag(harness.dom.container, "DIV").find((element) => element.style?.width === "31%");
    expect(fill).toBeDefined();

    await render({ map: { data: undefined, isFetching: true, progress: { label: "Following parent links", step: 3, steps: 4, done: 0, total: 0 } } });
    expect(text()).toContain("Following parent links");
    expect(text()).toContain("Step 3 of 4");
    expect(text()).not.toContain(" · 0 of 0");
  });

  it("keeps the map on screen while it is refreshed", async () => {
    await render({ map: { isFetching: true, progress: { label: "Following parent links", step: 3, steps: 4, done: 0, total: 0 } } });

    expect(getReactProps(button("Refreshing..."))?.disabled).toBe(true);
    expect(rowOrder()).toEqual(["500", "37655016", "37655015", "600"]);
    expect(text()).not.toContain("Following parent links");
  });

  it("offers a retry when the map cannot be loaded, and keeps the last map when a refresh fails", async () => {
    const refresh = vi.fn();
    await render({ map: { data: undefined, error: new Error("ADO is unreachable"), refresh } });

    expect(text()).toContain("Work map could not be loaded");
    expect(text()).toContain("ADO is unreachable");
    await harness.act(async () => {
      getReactProps(button("Try again"))?.onClick();
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await render({ map: { error: new Error("ADO is unreachable"), refresh } });
    expect(text()).toContain("The work map could not be refreshed");
    expect(text()).toContain("ADO is unreachable");
    expect(text()).toContain("Showing what was loaded");
    expect(text()).toContain("Review SDL bug");
  });

  it("shows ADO's warnings and says when Azure DevOps is not configured", async () => {
    await render({ map: { data: { ...DATA, warnings: ["Some ADO pull requests could not be refreshed."] } } });
    expect(text()).toContain("Some ADO pull requests could not be refreshed.");

    await render({ map: { data: { ...DATA, enabled: false, org: null, project: null, tasks: [], workItems: [], contextWorkItems: [], pullRequests: [] } } });
    expect(text()).toContain("Azure DevOps is not configured");
    expect(findAllByTag(harness.dom.container, "INPUT")).toEqual([]);
  });

  it("marks a pull request that ADO could not return", async () => {
    // A link saved from another organization: ADO here has no such pull request, and the saved
    // repository name is that repository's URL.
    const repository = "https://dev.azure.com/1esgitops/agency/_git/agency";
    await render({
      map: {
        data: {
          ...DATA,
          pullRequests: [
            ...DATA.pullRequests,
            { ...DATA.pullRequests[0], key: "other:29903", prId: 29903, repoName: repository, title: null, status: null, taskIds: ["task-1"], workItemIds: [] },
          ],
        },
      },
    });

    expect(text()).toContain("Pull requests without a work item");
    expect(text()).toContain("PR 29903 Could not be read from ADO");
    expect(stat("Needs attention")).toBe("3");
    const named = findAllByTag(harness.dom.container, "SPAN").find((element) => element.getAttribute("title") === repository);
    expect(named?.textContent).toBe("agency");
  });
});
