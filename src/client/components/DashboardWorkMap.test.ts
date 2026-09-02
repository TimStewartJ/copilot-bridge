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
    stubLocalStorage();
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
      onCreateTaskForWorkItem: vi.fn(async () => undefined),
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
      onCreateTaskForWorkItem: vi.fn(async () => undefined),
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
      onCreateTaskForWorkItem: vi.fn(async () => undefined),
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
      onCreateTaskForWorkItem: vi.fn(async () => undefined),
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
      onCreateTaskForWorkItem: vi.fn(async () => undefined),
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
    const onCreateTaskForWorkItem = vi.fn(async () => undefined);
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
      onCreateTaskForWorkItem,
    }));

    await harness.act(async () => {
      getReactProps(buttonWithText(harness, "No Bridge task - create one"))?.onClick();
    });

    expect(onCreateTaskForWorkItem).toHaveBeenCalledWith(untrackedItem);
  });
});
