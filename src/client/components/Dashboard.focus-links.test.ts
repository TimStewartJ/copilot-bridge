import { createElement, type ComponentProps } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusEpisodeRead, FocusHistoryEntry, FocusHistoryPage, FocusObject } from "../api";
import type { DashboardChecklistState } from "../hooks/useDashboardChecklist";
import { queryKeys } from "../queryClient";
import {
  FOCUS_TEST_NOW_MS, focusAlert, focusDecision, focusDetails, focusEpisode, focusEvent, focusSnapshot, focusTask,
} from "../test-focus-fixtures";
import { clickFocusButton, createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitTick } from "../test-react-harness";

const dashboardQueries = vi.hoisted(() => ({
  useDashboardQuery: vi.fn(),
  useFocusSnapshotQuery: vi.fn(),
  useFocusAlertPagesQuery: vi.fn(),
  useFocusDecisionPagesQuery: vi.fn(),
}));
const otherQueries = vi.hoisted(() => ({
  useSettingsQuery: vi.fn(), useWorkMapQuery: vi.fn(), useDashboardChecklist: vi.fn(),
}));
const apiMocks = vi.hoisted(() => ({
  fetchFocusEpisodePage: vi.fn<typeof import("../api")["fetchFocusEpisodePage"]>(),
  fetchFocusHistoryPage: vi.fn<typeof import("../api")["fetchFocusHistoryPage"]>(),
  fetchFocusLaunchReceipts: vi.fn<typeof import("../api")["fetchFocusLaunchReceipts"]>(),
  fetchFocusObject: vi.fn<typeof import("../api")["fetchFocusObject"]>(),
  transitionFocusObject: vi.fn<typeof import("../api")["transitionFocusObject"]>(),
  reactivateFocusObject: vi.fn<typeof import("../api")["reactivateFocusObject"]>(),
  promoteFocusObjectToAction: vi.fn<typeof import("../api")["promoteFocusObjectToAction"]>(),
  deleteFocusObject: vi.fn<typeof import("../api")["deleteFocusObject"]>(),
  linkFocusObjectSession: vi.fn<typeof import("../api")["linkFocusObjectSession"]>(),
  launchFocusSession: vi.fn<typeof import("../api")["launchFocusSession"]>(),
  prepareFocusSessionLaunch: vi.fn<typeof import("../api")["prepareFocusSessionLaunch"]>(),
  startFocusSessionLaunch: vi.fn<typeof import("../api")["startFocusSessionLaunch"]>(),
  markFocusDigestViewed: vi.fn<typeof import("../api")["markFocusDigestViewed"]>(),
}));

vi.mock("../hooks/queries/useDashboard", async () => ({
  ...await vi.importActual<typeof import("../hooks/queries/useDashboard")>("../hooks/queries/useDashboard"),
  ...dashboardQueries,
}));
vi.mock("../hooks/queries/useSettings", () => ({ useSettingsQuery: otherQueries.useSettingsQuery }));
vi.mock("../hooks/queries/useWorkMap", () => ({ useWorkMapQuery: otherQueries.useWorkMapQuery }));
vi.mock("../hooks/useDashboardChecklist", () => ({ useDashboardChecklist: otherQueries.useDashboardChecklist }));
vi.mock("../api", async () => ({
  ...await vi.importActual<typeof import("../api")>("../api"),
  ...apiMocks,
}));

import Dashboard from "./Dashboard";
import FocusDashboardRedirect from "./FocusDashboardRedirect";

const current = focusDecision({
  id: "off-page-decision", activationId: "latest-activation", title: "Today's replacement concern",
  body: "TODAY BODY IS NOT EARLIER EVIDENCE", details: focusDetails({ objectId: "off-page-decision" }),
});
const retained = focusEpisode({
  objectId: current.id, activationId: "earlier-activation", title: "Retained linked concern",
  body: "The original episode's retained body", lifecycle: "dismissed", outcome: "Previous release was withdrawn",
});

function earlierRead(overrides: Partial<FocusEpisodeRead> = {}): FocusEpisodeRead {
  return {
    objectId: current.id, activationId: retained.activationId, currentObject: current, isCurrentEpisode: false,
    previousEpisode: retained, transitions: [], transitionTotal: 0, nextOffset: null,
    deleted: false, quarantined: false, historyIncomplete: false, ...overrides,
  };
}

function entry(object: FocusObject): FocusHistoryEntry {
  return {
    id: object.id, objectType: object.objectType, title: object.title, updatedAt: object.updatedAt, object,
    deleted: false, quarantined: false, transitions: [], transitionTotal: 0,
    matchSource: "current", matchedEpisode: null, matchedTransition: null,
  };
}

function historyPage(objects: FocusHistoryEntry[], overrides: Partial<FocusHistoryPage> = {}): FocusHistoryPage {
  return { objects, total: objects.length, nextOffset: null, ...overrides };
}

function emptyChecklist(): DashboardChecklistState {
  return {
    localOpenChecklistItems: [], localCompletedChecklistItems: [], showCompleted: false, setShowCompleted: vi.fn(),
    exitingIds: new Set(), newChecklistItemText: "", setNewChecklistItemText: vi.fn(), checklistSort: "deadline", collapsedGroups: new Set(),
    sortedOpenChecklistItems: [], visibleOpenChecklistItems: [],
    checklistIndicator: { state: "none", urgentCount: 0, dueTodayCount: 0, overdueCount: 0 },
    checklistIndicatorLabel: null, checklistGroups: [], handleSortChange: vi.fn(), toggleGroupCollapse: vi.fn(), handleAddChecklistItem: vi.fn(),
    moveOpenItemToCompleted: vi.fn(), updateOpenItem: vi.fn(), updateCompletedItem: vi.fn(), markOpenItemDone: vi.fn(),
    restoreCompletedItem: vi.fn(), removeOpenItem: vi.fn(), removeCompletedItem: vi.fn(),
  };
}

describe("routed Dashboard Focus subject links", () => {
  let harness: FocusTestHarness;
  let router: ReturnType<typeof createMemoryRouter> | undefined;
  let props: ComponentProps<typeof Dashboard>;
  let loadMoreAlerts: ReturnType<typeof vi.fn>;
  let loadMoreDecisions: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    router = undefined;
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    Object.assign(window, { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
    loadMoreAlerts = vi.fn();
    loadMoreDecisions = vi.fn();
    const queryState = { isLoading: false, error: null, dataUpdatedAt: FOCUS_TEST_NOW_MS, refetch: vi.fn(async () => undefined) };
    dashboardQueries.useDashboardQuery.mockReturnValue({
      ...queryState, data: { openChecklistItems: [], completedChecklistItems: [] },
    });
    dashboardQueries.useFocusSnapshotQuery.mockReturnValue({
      ...queryState, data: focusSnapshot({ alertTotal: 125, decisionTotal: 100, attentionTotal: 225, allClear: false }),
    });
    dashboardQueries.useFocusAlertPagesQuery.mockReturnValue({
      ...queryState, isFetchingNextPage: false, hasNextPage: true, fetchNextPage: loadMoreAlerts,
      data: { pageParams: [0], pages: [{
        objects: Array.from({ length: 20 }, (_, index) => focusAlert({ id: `first-alert-${index}`, title: `First-page alert ${index}` })),
        total: 125, nextOffset: 20,
      }] },
    });
    dashboardQueries.useFocusDecisionPagesQuery.mockReturnValue({
      ...queryState, isFetchingNextPage: false, hasNextPage: true, fetchNextPage: loadMoreDecisions,
      data: { pageParams: [0], pages: [{
        objects: Array.from({ length: 20 }, (_, index) => focusDecision({ id: `first-decision-${index}`, title: `First-page decision ${index}` })),
        total: 100, nextOffset: 20,
      }] },
    });
    otherQueries.useDashboardChecklist.mockReturnValue(emptyChecklist());
    otherQueries.useSettingsQuery.mockReturnValue({ data: { providers: {} }, isLoading: false });
    otherQueries.useWorkMapQuery.mockReturnValue({
      data: undefined, isLoading: false, error: null, isRefreshing: false, refetch: vi.fn(), refresh: vi.fn(),
    });
    apiMocks.fetchFocusEpisodePage.mockResolvedValue(earlierRead());
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(historyPage([]));
    apiMocks.fetchFocusLaunchReceipts.mockResolvedValue([]);
    harness.queryClient.setQueryData(queryKeys.focusHistory(), {
      pageParams: [0], pages: [historyPage(
        Array.from({ length: 20 }, (_, index) => entry(focusEvent({ id: `first-history-${index}` }))),
        { total: 500, nextOffset: 20 },
      )],
    });
    props = {
      tasks: [focusTask()], taskGroups: [], onSelectTask: vi.fn(), onSelectSession: vi.fn(),
      onCreateTaskForWorkItem: vi.fn(async () => undefined), onStartPromptSession: vi.fn(async () => "must-not-start"),
    };
  });

  afterEach(async () => {
    try {
      for (const name of [
        "transitionFocusObject", "reactivateFocusObject", "promoteFocusObjectToAction", "deleteFocusObject",
        "linkFocusObjectSession", "launchFocusSession", "prepareFocusSessionLaunch", "startFocusSessionLaunch", "markFocusDigestViewed",
      ] as const) expect(apiMocks[name], name).not.toHaveBeenCalled();
      expect(props.onStartPromptSession).not.toHaveBeenCalled();
      expect(props.onCreateTaskForWorkItem).not.toHaveBeenCalled();
      expect(props.onSelectTask).not.toHaveBeenCalled();
      expect(props.onSelectSession).not.toHaveBeenCalled();
    } finally {
      await harness?.cleanup();
      router?.dispose();
      vi.useRealTimers();
    }
  });

  async function renderRoute(url: string, basename = "/") {
    const prefix = basename === "/" ? "" : basename;
    router = createMemoryRouter(
      [
        { path: "/", element: createElement(Dashboard, props) },
        { path: "/dashboard", element: createElement(FocusDashboardRedirect) },
        { path: "/dashboard/checklist", element: createElement(FocusDashboardRedirect) },
        { path: "/dashboard/feed", element: createElement(FocusDashboardRedirect) },
        { path: "/dashboard/focus", element: createElement(Dashboard, props) },
        { path: "*", element: createElement("div", null, "Other route") },
      ],
      { basename, initialEntries: [`${prefix}/before-dashboard`, url], initialIndex: 1 },
    );
    await harness.render(createElement(RouterProvider, { router }));
  }

  it.each(["/dashboard", "/dashboard/checklist", "/dashboard/feed"].flatMap((path) =>
    ["/", "/staging/f5035ff0"].map((basename) => ({ path, basename })),
  ))("preserves an episode deep link through the actual $path redirect under $basename", async ({ path, basename }) => {
    const prefix = basename === "/" ? "" : basename;
    await renderRoute(`${prefix}${path}?focus=${current.id}&episode=${retained.activationId}&keep=owned-by-other-feature#bookmark`, basename);
    await advanceTimersByTimeAct(harness.act, 1);
    expect(router!.state.location.pathname).toBe(`${prefix}/dashboard/focus`);
    expect(new URLSearchParams(router!.state.location.search).get("focus")).toBe(current.id);
    expect(new URLSearchParams(router!.state.location.search).get("episode")).toBe(retained.activationId);
    expect(new URLSearchParams(router!.state.location.search).get("keep")).toBe("owned-by-other-feature");
    expect(router!.state.location.hash).toBe("#bookmark");
    expect(apiMocks.fetchFocusEpisodePage).toHaveBeenCalledWith(current.id, retained.activationId, 0);
    expect(harness.dom.container.textContent).toContain(retained.title);
    expect(harness.dom.container.textContent).toContain(retained.outcome);
  });

  function dialogs() {
    return findAllByTag(harness.dom.container, "DIV").filter((node) => getReactProps(node)?.role === "dialog");
  }

  function subject() {
    const result = dialogs();
    expect(result).toHaveLength(1);
    return result[0];
  }

  it.each(["/", "/staging/f5035ff0"])(
    "consumes an off-page episode link and closes without losing pathname, unrelated query, hash, or basename %s",
    async (basename) => {
      const prefix = basename === "/" ? "" : basename;
      const pathname = `${prefix}/dashboard/feed/`;
      await renderRoute(`${pathname}?tag=one&focus=${current.id}&tag=two&episode=${retained.activationId}&mode=inspect#retained-evidence`, basename);

      expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([[current.id, retained.activationId, 0]]);
      expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
      expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
      expect(loadMoreAlerts).not.toHaveBeenCalled();
      expect(loadMoreDecisions).not.toHaveBeenCalled();
      expect(subject().textContent).toContain(retained.title);
      expect(subject().textContent).toContain(retained.body);
      expect(subject().textContent).not.toContain(current.body);
      expect(findAllByTag(subject(), "ARTICLE")).toHaveLength(0);
      expect(findAllByTag(subject(), "BUTTON").map((node) => node.textContent)).not.toContain("Acknowledge");

      await clickFocusButton(harness, "Close dialog");
      expect(dialogs()).toHaveLength(0);
      expect(router!.state.location).toMatchObject({
        pathname: `${prefix}/dashboard/focus`, search: "?tag=one&tag=two&mode=inspect", hash: "#retained-evidence",
      });
      expect(router!.state.historyAction).toBe("REPLACE");
      await harness.act(async () => { await router!.navigate(-1); });
      expect(router!.state.location.pathname).toBe(`${prefix}/before-dashboard`);
      expect(apiMocks.fetchFocusEpisodePage).toHaveBeenCalledOnce();
    },
  );

  it("inspects the current activation only after explicit navigation and preserves the staging route", async () => {
    const basename = "/staging/f5035ff0";
    const pathname = `${basename}/dashboard/focus`;
    apiMocks.fetchFocusEpisodePage.mockImplementation(async (_objectId, activationId) => activationId === retained.activationId
      ? earlierRead()
      : earlierRead({ activationId: current.activationId, isCurrentEpisode: true, previousEpisode: null }));
    await renderRoute(`${pathname}?tag=one&focus=${current.id}&episode=${retained.activationId}&tag=two#source`, basename);
    expect(subject().textContent).not.toContain(current.body);

    await clickFocusButton(harness, "Inspect current episode");
    expect(router!.state.location).toMatchObject({ pathname, hash: "#source" });
    expect([...new URLSearchParams(router!.state.location.search)]).toEqual([
      ["tag", "one"], ["tag", "two"], ["focus", current.id], ["episode", current.activationId],
    ]);
    expect(router!.state.historyAction).toBe("PUSH");
    expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([
      [current.id, retained.activationId, 0], [current.id, current.activationId, 0],
    ]);
    expect(subject().textContent).toContain(current.body);
    expect(subject().textContent).not.toContain(retained.body);
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Close dialog");
    expect(router!.state.location).toMatchObject({ pathname, search: "?tag=one&tag=two", hash: "#source" });
  });

  it("consumes an object-only deep link using an exact History filter, not the cached first 20 records", async () => {
    const object = focusEvent({ id: "event-beyond-history-page", title: "Old quiet observation", body: "Exact old observation evidence" });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(historyPage([entry(object)]));
    await renderRoute(`/dashboard/focus?view=quiet&focus=${object.id}#history`);

    expect(apiMocks.fetchFocusHistoryPage.mock.calls).toEqual([[0, 20, { objectId: object.id }]]);
    expect(apiMocks.fetchFocusEpisodePage).not.toHaveBeenCalled();
    expect(subject().textContent).toContain(object.body);
    expect(loadMoreAlerts).not.toHaveBeenCalled();
    expect(loadMoreDecisions).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Close dialog");
    expect(router!.state.location).toMatchObject({ pathname: "/dashboard/focus", search: "?view=quiet", hash: "#history" });
  });

  it("opens an off-page intervention through routed object-only History without dropping unrelated URL state", async () => {
    const basename = "/staging/f5035ff0";
    const pathname = `${basename}/dashboard/focus`;
    dashboardQueries.useFocusSnapshotQuery.mockReturnValue({
      isLoading: false, error: null, dataUpdatedAt: FOCUS_TEST_NOW_MS, refetch: vi.fn(),
      data: focusSnapshot({
        alertTotal: 125, decisionTotal: 100, attentionTotal: 225, allClear: false,
        upcomingInterventions: [{
          objectId: current.id, objectType: "decision", title: current.title,
          interventionBy: "2026-09-05T20:00:00.000Z", lifecycle: "active",
        }],
      }),
    });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(historyPage([entry(current)]));
    await renderRoute(`${pathname}?view=quiet&tag=one&tag=two#intervention`, basename);
    expect(dialogs()).toHaveLength(0);
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();

    await clickFocusButton(harness, "Review intervention");
    expect(router!.state.location).toMatchObject({ pathname, hash: "#intervention" });
    expect([...new URLSearchParams(router!.state.location.search)]).toEqual([
      ["view", "quiet"], ["tag", "one"], ["tag", "two"], ["focus", current.id],
    ]);
    expect(apiMocks.fetchFocusHistoryPage.mock.calls).toEqual([[0, 20, { objectId: current.id }]]);
    expect(apiMocks.fetchFocusEpisodePage).not.toHaveBeenCalled();
    expect(subject().textContent).toContain(current.body);
  });

  it.each([
    "focus=one&focus=two&episode=old",
    "focus=one&episode=old&episode=other",
    "episode=orphan",
    "focus=one&episode=",
  ])("shows an invalid link notice without querying any subject: %s", async (invalid) => {
    await renderRoute(`/dashboard/focus?tag=one&${invalid}&tag=two#keep`);

    expect(subject().textContent).toContain("Invalid Focus link");
    expect(subject().textContent).toContain("No record was changed");
    expect(apiMocks.fetchFocusEpisodePage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Close dialog");
    expect(router!.state.location).toMatchObject({ pathname: "/dashboard/focus", search: "?tag=one&tag=two", hash: "#keep" });
    expect(dialogs()).toHaveLength(0);
  });

  it("opens the exact subject even while all first-page dashboard queries are still loading", async () => {
    const loading = { data: undefined, isLoading: true, error: null, dataUpdatedAt: 0, refetch: vi.fn() };
    dashboardQueries.useDashboardQuery.mockReturnValue(loading);
    dashboardQueries.useFocusSnapshotQuery.mockReturnValue(loading);
    dashboardQueries.useFocusAlertPagesQuery.mockReturnValue({ ...loading, fetchNextPage: loadMoreAlerts });
    dashboardQueries.useFocusDecisionPagesQuery.mockReturnValue({ ...loading, fetchNextPage: loadMoreDecisions });
    let resolveEpisode!: (value: FocusEpisodeRead) => void;
    apiMocks.fetchFocusEpisodePage.mockImplementationOnce(() => new Promise((resolve) => { resolveEpisode = resolve; }));
    await renderRoute(`/dashboard/focus?focus=${current.id}&episode=${retained.activationId}`);

    expect(subject().textContent).toContain("Loading the exact Focus subject");
    expect(subject().textContent).not.toContain(current.body);
    expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([[current.id, retained.activationId, 0]]);
    await harness.act(async () => { resolveEpisode(earlierRead()); await waitTick(); });
    await advanceTimersByTimeAct(harness.act, 1);
    expect(subject().textContent).toContain(retained.body);
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
  });

  it("keeps an unknown activation error inside the subject dialog instead of substituting a loaded current card", async () => {
    dashboardQueries.useFocusDecisionPagesQuery.mockReturnValue({
      data: { pages: [{ objects: [current], total: 1, nextOffset: null }], pageParams: [0] },
      isLoading: false, error: null, dataUpdatedAt: FOCUS_TEST_NOW_MS, refetch: vi.fn(), fetchNextPage: loadMoreDecisions,
    });
    harness.queryClient.setQueryData(queryKeys.focusHistory({ objectId: current.id }), {
      pageParams: [0], pages: [historyPage([entry(current)])],
    });
    apiMocks.fetchFocusEpisodePage.mockRejectedValue(new Error("Requested activation does not exist"));
    await renderRoute(`/dashboard/focus?focus=${current.id}&episode=unknown-activation`);

    expect(subject().textContent).toContain("Could not retrieve this exact subject");
    expect(subject().textContent).toContain("Requested activation does not exist");
    expect(subject().textContent).not.toContain(current.title);
    expect(subject().textContent).not.toContain(current.body);
    expect(findAllByTag(subject(), "ARTICLE")).toHaveLength(0);
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
  });

  it("does not perform a subject lookup for an ordinary dashboard URL", async () => {
    await renderRoute("/dashboard/focus?view=quiet#history");
    expect(harness.dom.container.textContent).toContain("First-page alert 0");
    expect(dialogs()).toHaveLength(0);
    expect(apiMocks.fetchFocusEpisodePage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
  });
});
