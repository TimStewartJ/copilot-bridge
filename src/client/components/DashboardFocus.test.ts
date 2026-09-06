import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardChecklistItem, FocusDomain } from "../api";
import type { DashboardChecklistState } from "../hooks/useDashboardChecklist";
import { focusAction, focusAlert, focusDecision, focusDigest, focusOverdueHandoff, focusQuietConcern, focusSnapshot, focusTask, FOCUS_TEST_NOW_MS } from "../test-focus-fixtures";
import { clickFocusButton, createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import { findAllByTag, getReactProps } from "../test-react-harness";

const markViewed = vi.hoisted(() => vi.fn());
vi.mock("../api", async () => ({
  ...await vi.importActual<typeof import("../api")>("../api"), markFocusDigestViewed: markViewed,
  fetchFocusQuietConcernPage: vi.fn(async () => ({ objects: [], total: 0, nextOffset: null })),
}));
import DashboardFocus, { FOCUS_WIDE_PREVIEW_QUERY, getDashboardFocusCount, getDueFollowUpTasks } from "./DashboardFocus";

function checklistState(urgentCount = 0, items: DashboardChecklistItem[] = []): DashboardChecklistState {
  return {
    localOpenChecklistItems: items, localCompletedChecklistItems: [], showCompleted: false, setShowCompleted: vi.fn(),
    exitingIds: new Set(), newChecklistItemText: "", setNewChecklistItemText: vi.fn(), checklistSort: "deadline", collapsedGroups: new Set(),
    sortedOpenChecklistItems: items, visibleOpenChecklistItems: items,
    checklistIndicator: { state: urgentCount ? "due-today" : "none", urgentCount, dueTodayCount: urgentCount, overdueCount: 0 },
    checklistIndicatorLabel: null, checklistGroups: [], handleSortChange: vi.fn(), toggleGroupCollapse: vi.fn(), handleAddChecklistItem: vi.fn(),
    moveOpenItemToCompleted: vi.fn(), updateOpenItem: vi.fn(), updateCompletedItem: vi.fn(), markOpenItemDone: vi.fn(),
    restoreCompletedItem: vi.fn(), removeOpenItem: vi.fn(), removeCompletedItem: vi.fn(),
  };
}

function props(overrides: Partial<ComponentProps<typeof DashboardFocus>> = {}): ComponentProps<typeof DashboardFocus> {
  return {
    active: true, tabbed: false, checklist: checklistState(), tasks: [focusTask()], taskGroups: [],
    focusSnapshot: focusSnapshot({ alertTotal: 1, decisionTotal: 1, attentionTotal: 2, allClear: false }),
    alertTotal: 1, decisionTotal: 1, alerts: [focusAlert()], decisions: [focusDecision()],
    alertsLoading: false, alertsHasMore: false, alertsLoadingMore: false, decisionsLoading: false, decisionsHasMore: false, decisionsLoadingMore: false,
    focusLoading: false, actionsLoading: false, actionsUpdatedAt: FOCUS_TEST_NOW_MS, alertsUpdatedAt: FOCUS_TEST_NOW_MS, decisionsUpdatedAt: FOCUS_TEST_NOW_MS, nowMs: FOCUS_TEST_NOW_MS,
    onSelectTask: vi.fn(), onSelectSession: vi.fn(), onStartPromptSession: vi.fn(async () => "session-1"),
    onLoadMoreAlerts: vi.fn(), onLoadMoreDecisions: vi.fn(), onRetryFocus: vi.fn(), onRefresh: vi.fn(async () => undefined), ...overrides,
  };
}

describe("Truthful Focus dashboard", () => {
  let harness: FocusTestHarness;
  beforeEach(async () => {
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    markViewed.mockReset();
  });
  afterEach(async () => { await harness.cleanup(); });
  const render = (overrides: Partial<ComponentProps<typeof DashboardFocus>> = {}) => harness.render(createElement(DashboardFocus, props(overrides)));
  const panel = (name: string) => findAllByTag(harness.dom.container, "SECTION").find((node) => getReactProps(node)?.["data-dashboard-panel"] === name);
  const overviewState = () => getReactProps(panel("overview"))?.["data-focus-completeness"];
  const empty = () => ({ alerts: [], decisions: [], alertTotal: 0, decisionTotal: 0, focusSnapshot: focusSnapshot() });
  const viewport = (initialWidth: number) => {
    let width = initialWidth;
    const listeners = new Set<(event: { matches: boolean }) => void>();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({
      get matches() { return query === FOCUS_WIDE_PREVIEW_QUERY && width >= 1280; },
      addEventListener(_type: string, listener: (event: { matches: boolean }) => void) { listeners.add(listener); },
      removeEventListener(_type: string, listener: (event: { matches: boolean }) => void) { listeners.delete(listener); },
    }) });
    return async (nextWidth: number) => harness.act(async () => {
      width = nextWidth;
      for (const listener of listeners) listener({ matches: width >= 1280 });
    });
  };

  it("derives attention from due Actions, first-class concerns and due follow-ups", () => {
    const due = focusTask({ nextTouchAt: "2026-09-05T17:59:00Z" });
    const muted = focusTask({ id: "muted", muted: true, nextTouchAt: "2026-09-05T17:59:00Z" });
    const future = focusTask({ id: "future", nextTouchAt: "2026-09-06T17:59:00Z" });
    expect(getDueFollowUpTasks([future, muted, due], new Date(FOCUS_TEST_NOW_MS))).toEqual([due]);
    expect(getDashboardFocusCount(checklistState(2), 3, 1)).toBe(6);
  });

  it("replaces Signal Pulse with coverage and quiet History, not activity success metrics", async () => {
    await render();
    expect(panel("coverage").textContent).toContain("Autonomy coverage");
    expect(panel("history").textContent).toContain("Quiet retrieval, not an inbox");
    expect(harness.dom.container.textContent).not.toContain("Signal pulse");
    expect(harness.dom.container.textContent).not.toContain("High-priority share");
    expect(harness.dom.container.textContent).not.toContain("Verified signals");
    expect(overviewState()).toBe("complete");
    expect(panel("alerts").textContent).toContain("Release health check failed");
    expect(panel("decisions").textContent).toContain("Should we roll back the release?");
  });

  it("shows a bounded clear state only for healthy, current, completely covered sources", async () => {
    await render(empty());
    expect(overviewState()).toBe("clear");
    expect(panel("overview").textContent).toContain("No intervention found in the checked sources");
    expect(panel("overview").textContent).toContain("not an assurance beyond the stated coverage");
  });

  it.each<FocusDomain>(["actions", "alerts", "decisions", "overdueHandoffs", "quietConcerns", "digests", "coverage", "authority", "audits", "compatibility", "telemetry"])("never claims all-clear when the %s domain is unknown", async (domain) => {
    const snapshot = focusSnapshot();
    snapshot.domainHealth[domain] = { status: "unknown", error: `${domain} source could not be checked` };
    await render({ ...empty(), focusSnapshot: snapshot });
    expect(overviewState()).toBe("partial");
    expect(panel("overview").textContent).toContain("Partial / unknown");
    expect(panel("overview").textContent).not.toContain("No intervention found in the checked sources");
  });

  it.each(["actionsError", "alertsError", "decisionsError", "focusError"] as const)("keeps cached sections usable without false all-clear after %s", async (key) => {
    await render({ [key]: new Error("network unavailable") });
    expect(overviewState()).toBe("partial");
    expect(panel("alerts").textContent).toContain("Release health check failed");
    expect(panel("decisions").textContent).toContain("Should we roll back the release?");
    expect(panel("overview").textContent).toContain("Partial / unknown");
  });

  it("distinguishes missing, stale, and empty query data", async () => {
    await render({ ...empty(), actionsUpdatedAt: 0 });
    expect(overviewState()).toBe("partial");
    expect(panel("overview").textContent).toContain("Actions not yet checked");
    await render({ ...empty(), nowMs: FOCUS_TEST_NOW_MS + 60_000 });
    expect(overviewState()).toBe("partial");
    expect(panel("overview").textContent).toContain("stale");
    await render({ focusSnapshot: undefined, focusLoading: true, actionsError: new Error("unavailable") });
    expect(overviewState()).toBe("partial");
    expect(panel("alerts").textContent).toContain("Release health check failed");
    expect(panel("actions").textContent).toContain("Action state is unavailable, not empty");
  });

  it("shows unknown totals as unknown rather than empty success", async () => {
    await render({ ...empty(), alertTotal: null, alertsUpdatedAt: 0, focusSnapshot: focusSnapshot({ alertTotal: null, attentionTotal: null }) });
    expect(overviewState()).toBe("partial");
    const metric = findAllByTag(harness.dom.container, "A").find((node) => getReactProps(node)?.["data-focus-metric"] === "alerts");
    expect(metric.textContent).toContain("Unknown");
  });

  it("does not claim clear when no coverage assertions exist, even if allClear is incorrectly true", async () => {
    await render({ ...empty(), focusSnapshot: focusSnapshot({ coverage: { assertions: [], summary: { total: 0, counts: { valid: 0, "at-risk": 0, expired: 0, broken: 0, unknown: 0 }, observationGaps: [], upcomingInterventions: [], constrainedAutonomy: [] } } }) });
    expect(overviewState()).toBe("partial");
    expect(panel("overview").textContent).toContain("silence is not assurance");
  });

  it("bounds priority previews at 390px while placing judgment before routine Actions with a quick Action link", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const alerts = Array.from({ length: 4 }, (_, index) => focusAlert({ id: `alert-${index}`, title: `Condition ${index}` }));
    await render({ alerts, alertTotal: 4 });
    expect(findAllByTag(panel("alerts"), "ARTICLE")).toHaveLength(1);
    expect(panel("alerts").textContent).toContain("Showing 1 of 4");
    expect(panel("alerts").textContent).not.toContain("Condition 3");
    expect(getReactProps(panel("alerts"))?.["data-focus-preview"]).toBe("bounded");
    const panels = findAllByTag(harness.dom.container, "SECTION").map((node) => getReactProps(node)?.["data-dashboard-panel"]);
    expect(panels.indexOf("alerts")).toBeLessThan(panels.indexOf("actions"));
    expect(panels.indexOf("decisions")).toBeLessThan(panels.indexOf("actions"));
    expect(panels.indexOf("next-intervention")).toBeLessThan(panels.indexOf("actions"));
    const quickAction = findAllByTag(panel("overview"), "A").find((node) => node.textContent === "Quick Action access");
    expect(getReactProps(quickAction)?.href).toBe("#focus-actions");
    expect(findAllByTag(panel("overview"), "DL")).toHaveLength(0);
    expect(getReactProps(panel("alerts"))?.["data-priority-preview-limit"]).toBe(1);
    await clickFocusButton(harness, "Show all 4 loaded alerts");
    expect(findAllByTag(panel("alerts"), "ARTICLE")).toHaveLength(4);
    expect(panel("alerts").textContent).toContain("Condition 3");
    await clickFocusButton(harness, "Show fewer alerts");
    expect(findAllByTag(panel("alerts"), "ARTICLE")).toHaveLength(1);
    Reflect.deleteProperty(window, "innerWidth");
  });

  it.each([
    { width: 390, limit: 1 }, { width: 767, limit: 1 }, { width: 768, limit: 1 },
    { width: 1279, limit: 1 }, { width: 1280, limit: 3 }, { width: 1600, limit: 3 },
  ])("renders $limit bounded comparison previews per category at $width px", async ({ width, limit }) => {
    viewport(width);
    const alerts = Array.from({ length: 6 }, (_, index) => focusAlert({ id: `alert-${index}`, title: `Alert choice ${index}` }));
    const decisions = Array.from({ length: 6 }, (_, index) => focusDecision({ id: `decision-${index}`, title: `Decision choice ${index}` }));
    await render({ alerts, decisions, alertTotal: 6, decisionTotal: 6 });
    for (const category of ["alerts", "decisions"]) {
      const section = panel(category);
      expect(findAllByTag(section, "ARTICLE")).toHaveLength(limit);
      expect(getReactProps(section)?.["data-priority-preview-limit"]).toBe(limit);
      const list = findAllByTag(section, "OL").find((node) => getReactProps(node)?.["aria-label"] === `${category === "alerts" ? "Alerts" : "Decisions"} priority previews`);
      expect(list).toBeDefined();
      expect(findAllByTag(list, "LI")).toHaveLength(limit);
      expect(section.textContent).toContain(`Showing ${limit} of 6`);
    }
    expect(panel("alerts").textContent).not.toContain("Alert choice 5");
    expect(panel("decisions").textContent).not.toContain("Decision choice 5");
  });

  it("updates bounded previews at the wide breakpoint while retaining deliberate expansion", async () => {
    const resize = viewport(1280);
    const alerts = Array.from({ length: 5 }, (_, index) => focusAlert({ id: `responsive-${index}` }));
    await render({ alerts, alertTotal: 5 });
    expect(findAllByTag(panel("alerts"), "ARTICLE")).toHaveLength(3);
    await clickFocusButton(harness, "Show all 5 loaded alerts");
    await resize(390);
    expect(findAllByTag(panel("alerts"), "ARTICLE")).toHaveLength(5);
    await clickFocusButton(harness, "Show fewer alerts");
    expect(findAllByTag(panel("alerts"), "ARTICLE")).toHaveLength(1);
    await resize(1600);
    expect(findAllByTag(panel("alerts"), "ARTICLE")).toHaveLength(3);
  });

  it("bounds Actions too, and preserves linked source state rather than implying resolution", async () => {
    const items: DashboardChecklistItem[] = Array.from({ length: 8 }, (_, index) => ({
      ...focusAction({ id: `action-${index}`, text: `Executable step ${index}` }), taskTitle: "Bridge task", taskGroupColor: null,
      taskOrder: 0, taskStatus: "active", taskGroupId: null, taskGroupOrder: null,
    }));
    await render({ checklist: checklistState(0, items) });
    expect(panel("actions").textContent).not.toContain("Executable step 7");
    expect(panel("actions").textContent).toContain("Handed off (still open)");
    await clickFocusButton(harness, "Show all 8 Actions");
    expect(panel("actions").textContent).toContain("Executable step 7");
  });

  it("shows one next known intervention before secondary content", async () => {
    await render({ ...empty(), focusSnapshot: focusSnapshot({ upcomingInterventions: [
      { objectId: "later", objectType: "alert", title: "Later window", interventionBy: "2026-09-05T21:00:00Z", lifecycle: "active" },
      { objectId: "earlier", objectType: "decision", title: "Window closing first", interventionBy: "2026-09-05T19:00:00Z", lifecycle: "active" },
    ] }) });
    expect(panel("next-intervention").textContent).toContain("Window closing first");
    expect(panel("next-intervention").textContent).not.toContain("Later window");
    expect(panel("next-intervention").textContent).toContain("1 further known windows");
  });

  it("separates collapsed quiet sources and never marks a digest viewed just by showing its group", async () => {
    await render({ focusSnapshot: focusSnapshot({ digests: [focusDigest()], quietDigests: [focusDigest({ id: "quiet", family: "quiet-observer", quiet: true, newCount: 2 })] }) });
    expect(panel("digests").textContent).toContain("Release Watch");
    expect(panel("quiet-sources").textContent).not.toContain("Quiet Observer");
    expect(markViewed).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Quiet sources");
    expect(panel("quiet-sources").textContent).toContain("Quiet Observer");
    expect(panel("quiet-sources").textContent).toContain("2 new");
    expect(markViewed).not.toHaveBeenCalled();
  });

  it("loads Alerts and Decisions independently and offers recovery for each domain", async () => {
    const onLoadMoreAlerts = vi.fn();
    const onLoadMoreDecisions = vi.fn();
    const onRetryFocus = vi.fn();
    await render({ alertsHasMore: true, decisionsHasMore: true, alertsError: new Error("page failed"), onLoadMoreAlerts, onLoadMoreDecisions, onRetryFocus });
    await clickFocusButton(harness, "Load more alerts");
    await clickFocusButton(harness, "Load more decisions");
    await clickFocusButton(harness, "Retry Alerts");
    expect(onLoadMoreAlerts).toHaveBeenCalledOnce();
    expect(onLoadMoreDecisions).toHaveBeenCalledOnce();
    expect(onRetryFocus).toHaveBeenCalledOnce();
  });

  it("updates due follow-ups with the shared clock and avoids a clear claim when one is due", async () => {
    const task = focusTask({ nextTouchAt: "2026-09-05T18:00:30Z" });
    await render({ ...empty(), tasks: [task] });
    expect(panel("follow-ups").textContent).toContain("No follow-ups due");
    await render({ ...empty(), tasks: [task], nowMs: FOCUS_TEST_NOW_MS + 31_000 });
    expect(panel("follow-ups").textContent).toContain("Bridge task");
    expect(overviewState()).toBe("complete");
  });

  it("blocks clear for an overdue handed-off concern independently of completed Actions and direct attention totals", async () => {
    const overdue = focusOverdueHandoff({ taskState: "orphaned", taskId: null, taskTitle: "Former task", originalTaskId: "deleted-task" });
    const onInspectSubject = vi.fn();
    await render({ ...empty(), onInspectSubject, focusSnapshot: focusSnapshot({
      allClear: true, actionTotal: 0, attentionTotal: 0, handedOffTotal: 1, overdueHandoffTotal: 1, overdueHandoffs: [overdue],
    }) });
    expect(overviewState()).toBe("complete");
    expect(panel("overview").textContent).not.toContain("No intervention found in the checked sources");
    expect(panel("next-intervention").textContent).toContain("Overdue handoff");
    expect(panel("next-intervention").textContent).toContain("even if its Action has completed");
    expect(panel("next-intervention").textContent).toContain("Former task · orphaned");
    await clickFocusButton(harness, "Review intervention");
    expect(onInspectSubject).toHaveBeenCalledWith({ objectId: overdue.objectId, activationId: overdue.activationId });
  });

  it("uses uncapped overdue totals and treats an unknown overdue count as partial", async () => {
    await render({ ...empty(), focusSnapshot: focusSnapshot({ overdueHandoffTotal: 101, overdueHandoffs: [focusOverdueHandoff()] }) });
    expect(panel("next-intervention").textContent).toContain("101 handed-off concerns");
    expect(overviewState()).not.toBe("clear");
    await render({ ...empty(), focusSnapshot: focusSnapshot({ overdueHandoffTotal: null }) });
    expect(overviewState()).toBe("partial");
  });

  it("keeps healthy future handoffs under review without making them urgent or falsely clear", async () => {
    await render({ ...empty(), focusSnapshot: focusSnapshot({
      handedOffTotal: 2, overdueHandoffTotal: 0,
      upcomingInterventions: [{ objectId: "healthy", objectType: "decision", lifecycle: "handed_off", title: "Healthy autonomous work", interventionBy: "2026-09-06T18:00:00Z" }],
      quietConcernTotal: 1, quietConcerns: [focusQuietConcern({ lifecycle: "handed_off", title: "Muted healthy work", interventionBy: "2026-09-06T18:00:00Z" })],
    }) });
    expect(overviewState()).toBe("complete");
    expect(panel("overview").textContent).toContain("Open handoffs remain under review");
    const underReview = findAllByTag(panel("overview"), "BUTTON").find((node) => getReactProps(node)?.["data-focus-metric"] === "under-review");
    expect(underReview.textContent).toBe("Under review2");
    expect(panel("next-intervention").textContent).not.toContain("Healthy autonomous work");
    expect(panel("next-intervention").textContent).not.toContain("Muted healthy work");
    expect(panel("quiet-sources").textContent).not.toContain("Muted healthy work");
  });

  it("treats unknown open-handoff inventory as unknown, not clear", async () => {
    await render({ ...empty(), focusSnapshot: focusSnapshot({ handedOffTotal: null }) });
    expect(overviewState()).toBe("partial");
    expect(panel("overview").textContent).toContain("Under reviewUnknown");
  });

  it("blocks clear when a known handoff deadline elapses between snapshots", async () => {
    const snapshot = focusSnapshot({
      handedOffTotal: 1, overdueHandoffTotal: 0,
      upcomingInterventions: [{ objectId: "handoff", objectType: "alert", lifecycle: "handed_off", title: "Review due soon", interventionBy: "2026-09-05T18:00:30Z" }],
    });
    await render({ ...empty(), focusSnapshot: snapshot });
    expect(overviewState()).toBe("complete");
    await render({ ...empty(), focusSnapshot: snapshot, nowMs: FOCUS_TEST_NOW_MS + 31_000 });
    expect(overviewState()).not.toBe("clear");
    expect(panel("next-intervention").textContent).toContain("Review due soon");
    expect(panel("next-intervention").textContent).toContain("Overdue handoff");
  });
});
