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

const DATA: WorkMapData = {
  enabled: true,
  includeArchived: false,
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

describe("DashboardWorkMap", () => {
  let harness: ReactDomHarness;

  beforeEach(async () => {
    harness = await createReactDomHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
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
      onSelectTask,
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
      onSelectTask: vi.fn(),
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
        },
      ],
    };
    await harness.render(createElement(DashboardWorkMap, {
      active: true,
      data,
      isLoading: false,
      error: null,
      isRefreshing: false,
      onRefresh: vi.fn(async () => undefined),
      includeArchived: false,
      onIncludeArchivedChange: vi.fn(),
      onSelectTask: vi.fn(),
    }));

    await harness.act(async () => {
      getReactProps(buttonWithText(harness, "Assigned to me"))?.onClick();
    });

    expect(harness.dom.container.textContent).toContain("Review SDL bug");
    expect(harness.dom.container.textContent).not.toContain("Someone else's work");
    expect(metricValue(harness, "ADO work items")).toBe("1");
    expect(metricValue(harness, "Related PRs")).toBe("1");
    expect(metricValue(harness, "Bridge tasks")).toBe("1");
    expect(metricValue(harness, "Needs attention")).toBe("1");
  });
});
