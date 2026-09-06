import { Fragment, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import type { DashboardChecklistState } from "../hooks/useDashboardChecklist";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
vi.mock("./FocusHistorySection", () => ({
  default: () => createElement("div", null, "History"),
}));

import DashboardFocus from "./DashboardFocus";
import DashboardTabs from "./DashboardTabs";
import DashboardWorkMap from "./DashboardWorkMap";

function emptyChecklistState(): DashboardChecklistState {
  return {
    localOpenChecklistItems: [],
    localCompletedChecklistItems: [],
    showCompleted: false,
    setShowCompleted: vi.fn(),
    exitingIds: new Set(),
    newChecklistItemText: "",
    setNewChecklistItemText: vi.fn(),
    checklistSort: "deadline",
    collapsedGroups: new Set(),
    sortedOpenChecklistItems: [],
    visibleOpenChecklistItems: [],
    checklistIndicator: {
      state: "none",
      dueTodayCount: 0,
      overdueCount: 0,
      urgentCount: 0,
    },
    checklistIndicatorLabel: null,
    checklistGroups: [],
    handleSortChange: vi.fn(),
    toggleGroupCollapse: vi.fn(),
    handleAddChecklistItem: vi.fn(),
    moveOpenItemToCompleted: vi.fn(),
    updateOpenItem: vi.fn(),
    updateCompletedItem: vi.fn(),
    markOpenItemDone: vi.fn(),
    restoreCompletedItem: vi.fn(),
    removeOpenItem: vi.fn(),
    removeCompletedItem: vi.fn(),
  };
}

function selectedTab(root: any): any {
  const tab = findAllByTag(root, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.role === "tab"
      && getReactProps(candidate)?.["aria-selected"] === true,
  );
  if (!tab) throw new Error("Selected dashboard tab not found");
  return tab;
}

function controlledPanel(root: any, tab: any): any {
  const panelId = getReactProps(tab)?.["aria-controls"];
  const panel = findAllByTag(root, "SECTION").find(
    (candidate) => getReactProps(candidate)?.id === panelId,
  );
  if (!panel) throw new Error(`Dashboard panel not found: ${String(panelId)}`);
  return panel;
}

describe("DashboardTabs ARIA wiring", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("renders no tab bar when Focus is the only dashboard surface", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(DashboardTabs, {
      activeTab: "focus",
      onTabChange: vi.fn(),
      focusCount: 3,
      focusCountClass: "attention",
    }));

    expect(findAllByTag(harness.dom.container, "BUTTON")).toHaveLength(0);
  });

  it("connects Focus and the optional Work Map to their tabpanels", async () => {
    harness = await createReactDomHarness();
    await harness.render(
      createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) },
        createElement(DashboardTabs, {
          activeTab: "focus",
          onTabChange: vi.fn(),
          focusCount: 3,
          focusCountClass: "attention",
          showWorkMap: true,
        }),
        createElement(DashboardFocus, {
          active: true,
          tabbed: true,
          checklist: emptyChecklistState(),
          tasks: [],
          taskGroups: [],
          alerts: [],
          decisions: [],
          alertsLoading: false,
          alertsHasMore: false,
          alertsLoadingMore: false,
          decisionsLoading: false,
          decisionsHasMore: false,
          decisionsLoadingMore: false,
          focusLoading: false,
          alertTotal: 0,
          decisionTotal: 0,
          actionsLoading: false,
          actionsUpdatedAt: 0,
          alertsUpdatedAt: 0,
          decisionsUpdatedAt: 0,
          nowMs: Date.parse("2026-09-02T12:00:00.000Z"),
          onSelectTask: vi.fn(),
          onSelectSession: vi.fn(),
          onStartPromptSession: vi.fn(async () => "session-1"),
          onLoadMoreAlerts: vi.fn(),
          onLoadMoreDecisions: vi.fn(),
          onRetryFocus: vi.fn(),
          onRefresh: vi.fn(async () => undefined),
        }),
      ),
    );

    let tab = selectedTab(harness.dom.container);
    let panel = controlledPanel(harness.dom.container, tab);
    expect(tab.textContent).toBe("Focus3");
    expect(getReactProps(panel)).toMatchObject({
      role: "tabpanel",
      "aria-labelledby": getReactProps(tab)?.id,
      tabIndex: 0,
    });

    await harness.render(
      createElement(Fragment, null,
        createElement(DashboardTabs, {
          activeTab: "work-map",
          onTabChange: vi.fn(),
          focusCount: 0,
          focusCountClass: "",
          showWorkMap: true,
          workMapCount: 1,
        }),
        createElement(DashboardWorkMap, {
          active: true,
          data: {
            enabled: true,
            includeArchived: false,
            assignedToMe: false,
            currentUser: { displayName: "Tim Stewart" },
            org: "msazure",
            project: "One",
            generatedAt: "2026-08-31T20:00:00.000Z",
            tasks: [],
            workItems: [],
            pullRequests: [],
            warnings: [],
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
          onCreateTaskForWorkItem: vi.fn(async () => undefined),
        }),
      ),
    );

    tab = selectedTab(harness.dom.container);
    panel = controlledPanel(harness.dom.container, tab);
    expect(tab.textContent).toBe("Work map1");
    expect(getReactProps(panel)).toMatchObject({
      role: "tabpanel",
      "aria-labelledby": getReactProps(tab)?.id,
      tabIndex: 0,
    });
  });
});
