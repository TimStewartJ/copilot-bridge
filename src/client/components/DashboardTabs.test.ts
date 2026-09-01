import { Fragment, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import type { DashboardChecklistState } from "../hooks/useDashboardChecklist";
import DashboardChecklist from "./DashboardChecklist";
import DashboardFeed from "./DashboardFeed";
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

  it("connects each active tab to its conditionally rendered tabpanel", async () => {
    harness = await createReactDomHarness();
    await harness.render(
      createElement(Fragment, null,
        createElement(DashboardTabs, {
          activeTab: "checklist",
          onTabChange: vi.fn(),
          checklistCount: 0,
          checklistCountClass: "",
          feedCount: 0,
        }),
        createElement(DashboardChecklist, {
          active: true,
          checklist: emptyChecklistState(),
          onSelectTask: vi.fn(),
        }),
      ),
    );

    let tab = selectedTab(harness.dom.container);
    let panel = controlledPanel(harness.dom.container, tab);
    expect(getReactProps(panel)).toMatchObject({
      role: "tabpanel",
      "aria-labelledby": getReactProps(tab)?.id,
      tabIndex: 0,
    });

    await harness.render(
      createElement(Fragment, null,
        createElement(DashboardTabs, {
          activeTab: "feed",
          onTabChange: vi.fn(),
          checklistCount: 0,
          checklistCountClass: "",
          feedCount: 0,
        }),
        createElement(DashboardFeed, {
          active: true,
          feedCards: [],
          feedLoading: false,
          showResolvedFeed: false,
          onToggleResolvedFeed: vi.fn(),
          onSelectTask: vi.fn(),
          onSelectSession: vi.fn(),
          onStartPromptSession: vi.fn(async () => "session-1"),
          onRefetchFeed: vi.fn(async () => undefined),
        }),
      ),
    );

    tab = selectedTab(harness.dom.container);
    panel = controlledPanel(harness.dom.container, tab);
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
          checklistCount: 0,
          checklistCountClass: "",
          feedCount: 0,
          showWorkMap: true,
          workMapCount: 1,
        }),
        createElement(DashboardWorkMap, {
          active: true,
          data: {
            enabled: true,
            includeArchived: false,
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
          onSelectTask: vi.fn(),
        }),
      ),
    );

    tab = selectedTab(harness.dom.container);
    panel = controlledPanel(harness.dom.container, tab);
    expect(getReactProps(panel)).toMatchObject({
      role: "tabpanel",
      "aria-labelledby": getReactProps(tab)?.id,
      tabIndex: 0,
    });
  });
});
