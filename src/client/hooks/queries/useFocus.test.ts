import { createElement } from "react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FocusEpisodeRead, FocusHistoryEntry, FocusHistoryFilter, FocusLaunchIdentity,
  FocusQuietConcern, FocusQuietConcernFilter, FocusSessionLaunch, FocusTransition,
} from "../../api";
import { queryKeys } from "../../queryClient";
import {
  FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS, focusAudit, focusCoverage, focusDecision, focusDigest,
  focusDetails, focusEpisode, focusEvent, focusGrant, focusLaunchReceipt, focusSnapshot,
} from "../../test-focus-fixtures";
import {
  advanceTimersByTimeAct, createReactDomHarness, type ReactDomHarness,
} from "../../test-react-harness";
import { useDashboardDigestPagesQuery } from "./useDashboard";
import {
  rememberFocusLaunchReceipt, useFocusAttentionEventsQuery, useFocusAttentionMetricsQuery,
  useFocusAuditPagesQuery, useFocusAuthorityPagesQuery, useFocusCoveragePagesQuery, useFocusEpisodePagesQuery,
  useFocusHistoryPagesQuery, useFocusLaunchReceiptQuery, useFocusLaunchReceiptsQuery,
  useFocusMutation, useFocusNotificationDeliveriesQuery, useFocusObjectQuery,
  useFocusQuietConcernPagesQuery, useFocusTransitionPagesQuery, useMarkFocusDigestViewedMutation,
} from "./useFocus";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  // Query captures browser/server mode at import, before the per-test DOM setup.
  const { createReactDomHarness } = await import("../../test-react-harness");
  const harness = await createReactDomHarness();
  try {
    return await importOriginal<typeof import("@tanstack/react-query")>();
  } finally {
    await harness.cleanup();
  }
});

const apiMocks = vi.hoisted(() => ({
  fetchDashboard: vi.fn(),
  fetchFocusSnapshot: vi.fn(),
  fetchFocusAlertPage: vi.fn(),
  fetchFocusDecisionPage: vi.fn(),
  fetchFocusClearedPage: vi.fn(),
  fetchFocusEventDigestPage: vi.fn<typeof import("../../api").fetchFocusEventDigestPage>(),
  fetchFocusHistoryPage: vi.fn<typeof import("../../api").fetchFocusHistoryPage>(),
  fetchFocusEpisodePage: vi.fn<typeof import("../../api").fetchFocusEpisodePage>(),
  fetchFocusQuietConcernPage: vi.fn<typeof import("../../api").fetchFocusQuietConcernPage>(),
  fetchFocusLaunchReceipt: vi.fn<typeof import("../../api").fetchFocusLaunchReceipt>(),
  fetchFocusLaunchReceipts: vi.fn<typeof import("../../api").fetchFocusLaunchReceipts>(),
  launchFocusSession: vi.fn<typeof import("../../api").launchFocusSession>(),
  prepareFocusSessionLaunch: vi.fn<typeof import("../../api").prepareFocusSessionLaunch>(),
  startFocusSessionLaunch: vi.fn<typeof import("../../api").startFocusSessionLaunch>(),
  fetchFocusTransitionPage: vi.fn<typeof import("../../api").fetchFocusTransitionPage>(),
  fetchFocusAuthorityPage: vi.fn<typeof import("../../api").fetchFocusAuthorityPage>(),
  fetchFocusCoveragePage: vi.fn<typeof import("../../api").fetchFocusCoveragePage>(),
  fetchFocusAuditPage: vi.fn<typeof import("../../api").fetchFocusAuditPage>(),
  fetchFocusAttentionMetrics: vi.fn<typeof import("../../api").fetchFocusAttentionMetrics>(),
  fetchFocusAttentionEvents: vi.fn<typeof import("../../api").fetchFocusAttentionEvents>(),
  fetchFocusNotificationDeliveries: vi.fn<typeof import("../../api").fetchFocusNotificationDeliveries>(),
  fetchFocusObject: vi.fn<typeof import("../../api").fetchFocusObject>(),
  markFocusDigestViewed: vi.fn<typeof import("../../api").markFocusDigestViewed>(),
}));

vi.mock("../../api", () => apiMocks);

const mounted: Array<{ harness: ReactDomHarness; client: QueryClient }> = [];

async function mountHook<T>(useHook: () => T, providedClient?: QueryClient) {
  const harness = await createReactDomHarness();
  const client = providedClient ?? new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: 2 },
    },
  });
  mounted.push({ harness, client });
  let current!: T;
  function Probe() {
    current = useHook();
    return null;
  }
  const rerender = () => harness.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  await rerender();
  await advanceTimersByTimeAct(harness.act, 10);
  return { harness, client, current: () => current, rerender };
}

function historyEntry(id: string): FocusHistoryEntry {
  const object = focusDecision({ id });
  return {
    id, objectType: object.objectType, title: object.title, updatedAt: FOCUS_TEST_NOW,
    object, deleted: false, quarantined: false, transitions: [], transitionTotal: 0,
    matchSource: "current", matchedEpisode: null, matchedTransition: null,
  };
}

function transition(id: string, overrides: Partial<FocusTransition> = {}): FocusTransition {
  return {
    id, objectId: "decision-1", objectType: "decision", title: "Concern",
    activationId: "activation-1", fromLifecycle: null, toLifecycle: "active",
    reason: "Admitted with evidence", actor: "agent", relatedActionId: null, sessionId: null,
    details: {}, createdAt: FOCUS_TEST_NOW, ...overrides,
  };
}

function episodePage(objectId = "decision-1", activationId = "activation-1"): FocusEpisodeRead {
  const previousEpisode = focusEpisode({
    objectId, activationId, lifecycle: "resolved", outcome: "The prior release was restored.",
    sessionId: "prior-session", sessionIds: ["prior-session"], linkedActionIds: ["prior-action"],
    linkedActions: [{ sourceId: objectId, sourceType: "decision", activationId, actionId: "prior-action", createdAt: FOCUS_TEST_NOW }],
  });
  const currentObject = focusDecision({
    id: objectId, activationId: `${activationId}-next`, details: focusDetails({ objectId }),
  });
  return {
    objectId, activationId, currentObject, isCurrentEpisode: false, previousEpisode,
    transitions: [transition("reactivation", {
      objectId, activationId: currentObject.activationId, fromLifecycle: "resolved",
      details: { previousEpisode },
    })],
    transitionTotal: 1, nextOffset: null, deleted: false, quarantined: false, historyIncomplete: false,
  };
}

function quietConcern(id: string): FocusQuietConcern {
  return {
    ...focusDecision({ id, taskState: "muted", details: focusDetails({ objectId: id }) }),
    attentionVisible: false, suppressionReason: "muted",
  };
}

function expectNoLaunchWrites() {
  expect(apiMocks.launchFocusSession).not.toHaveBeenCalled();
  expect(apiMocks.prepareFocusSessionLaunch).not.toHaveBeenCalled();
  expect(apiMocks.startFocusSessionLaunch).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FOCUS_TEST_NOW_MS);
});

afterEach(async () => {
  for (const { harness, client } of mounted.splice(0)) {
    await harness.cleanup();
    client.clear();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Focus History and digest queries", () => {
  it("does not fetch disabled History or digests, including after invalidation", async () => {
    apiMocks.fetchFocusHistoryPage.mockResolvedValue({ objects: [], total: 0, nextOffset: null });
    apiMocks.fetchFocusEventDigestPage.mockResolvedValue({ objects: [], total: 0, nextOffset: null });
    let historyEnabled = false;
    const result = await mountHook(() => ({
      history: useFocusHistoryPagesQuery({ objectType: "action" }, historyEnabled),
      digest: useDashboardDigestPagesQuery(focusDigest(), false),
    }));
    await result.harness.act(async () => {
      await result.client.invalidateQueries({ queryKey: queryKeys.focusRoot });
    });
    await advanceTimersByTimeAct(result.harness.act, 30_000);
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusEventDigestPage).not.toHaveBeenCalled();
    expect(result.current().history.fetchStatus).toBe("idle");
    expect(result.current().digest.fetchStatus).toBe("idle");

    historyEnabled = true;
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledExactlyOnceWith(0, 20, { objectType: "action" });
    expect(apiMocks.fetchFocusEventDigestPage).not.toHaveBeenCalled();
    expect(result.current().history.isSuccess).toBe(true);
  });

  it("uses History nextOffset and isolates filters instead of appending another domain", async () => {
    const originalFilter: FocusHistoryFilter = {
      objectType: "decision", query: " release ", taskId: "task-1", originalTaskId: "task-1",
      lifecycle: "active", sourceFamily: "release-watch", activationId: "activation-1",
    };
    let filter = originalFilter;
    const first = { objects: Array.from({ length: 20 }, (_, index) => historyEntry(`decision-${index}`)), total: 21, nextOffset: 20 };
    const last = { objects: [historyEntry("decision-last")], total: 21, nextOffset: null };
    apiMocks.fetchFocusHistoryPage
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(last)
      .mockResolvedValueOnce({ objects: [], total: 0, nextOffset: null });
    const result = await mountHook(() => useFocusHistoryPagesQuery(filter, true));
    expect(result.current().hasNextPage).toBe(true);

    await result.harness.act(async () => { await result.current().fetchNextPage(); });
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusHistoryPage.mock.calls).toEqual([
      [0, 20, originalFilter], [20, 20, originalFilter],
    ]);
    expect(result.current().data?.pages).toEqual([first, last]);
    expect(result.current().data?.pageParams).toEqual([0, 20]);
    expect(result.current().hasNextPage).toBe(false);

    filter = { objectType: "event" };
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { objectType: "event" });
    expect(result.current().data?.pages).toEqual([{ objects: [], total: 0, nextOffset: null }]);
    expect(result.client.getQueryData(queryKeys.focusHistory(originalFilter))).toEqual({
      pages: [first, last], pageParams: [0, 20],
    });
  });

  describe("Focus episode and quiet-concern queries", () => {
    it("does not fetch disabled episode or quiet-concern pages, even after invalidation", async () => {
      let enabled = false;
      const filter: FocusQuietConcernFilter = { taskId: "task-1", sourceFamily: "release-watch", activationId: "activation-1" };
      apiMocks.fetchFocusEpisodePage.mockResolvedValue(episodePage());
      apiMocks.fetchFocusQuietConcernPage.mockResolvedValue({ objects: [], total: 0, nextOffset: null });
      const result = await mountHook(() => ({
        episode: useFocusEpisodePagesQuery("decision-1", "activation-1", enabled),
        quiet: useFocusQuietConcernPagesQuery(filter, enabled),
      }));
      await result.harness.act(async () => {
        await result.client.invalidateQueries({ queryKey: queryKeys.focusRoot });
      });
      await advanceTimersByTimeAct(result.harness.act, 30_000);
      expect(apiMocks.fetchFocusEpisodePage).not.toHaveBeenCalled();
      expect(apiMocks.fetchFocusQuietConcernPage).not.toHaveBeenCalled();
      expect(result.current().episode.fetchStatus).toBe("idle");
      expect(result.current().quiet.fetchStatus).toBe("idle");

      enabled = true;
      await result.rerender();
      await advanceTimersByTimeAct(result.harness.act, 10);
      expect(apiMocks.fetchFocusEpisodePage).toHaveBeenCalledExactlyOnceWith("decision-1", "activation-1", 0);
      expect(apiMocks.fetchFocusQuietConcernPage).toHaveBeenCalledExactlyOnceWith(0, 20, filter);
      expect(result.current().episode.isSuccess).toBe(true);
      expect(result.current().quiet.isSuccess).toBe(true);

      enabled = false;
      await result.rerender();
      await result.harness.act(async () => {
        await result.client.invalidateQueries({ queryKey: queryKeys.focusRoot });
      });
      await advanceTimersByTimeAct(result.harness.act, 30_000);
      expect(apiMocks.fetchFocusEpisodePage).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchFocusQuietConcernPage).toHaveBeenCalledTimes(1);
    });

    it.each(["objectId", "activationId"] as const)("paginates retained episodes and isolates a changed %s", async (field) => {
      const original = { objectId: "decision-1", activationId: "activation-1" };
      let selection = original;
      const first = { ...episodePage(), transitionTotal: 2, nextOffset: 1 };
      const last = {
        ...first, transitions: [transition("prior-resolution", { fromLifecycle: "handed_off", toLifecycle: "resolved" })],
        nextOffset: null,
      };
      const changed = { ...original, [field]: "other /?#" };
      const otherPage = episodePage(changed.objectId, changed.activationId);
      apiMocks.fetchFocusEpisodePage.mockResolvedValueOnce(first).mockResolvedValueOnce(last).mockResolvedValueOnce(otherPage);
      const result = await mountHook(() => useFocusEpisodePagesQuery(selection.objectId, selection.activationId, true));
      expect(result.current().data?.pages).toEqual([first]);
      expect(result.current().hasNextPage).toBe(true);
      await result.harness.act(async () => { await result.current().fetchNextPage(); });
      await advanceTimersByTimeAct(result.harness.act, 10);
      expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([
        ["decision-1", "activation-1", 0], ["decision-1", "activation-1", 1],
      ]);
      expect(result.current().data).toEqual({ pages: [first, last], pageParams: [0, 1] });
      expect(result.current().hasNextPage).toBe(false);

      selection = changed;
      await result.rerender();
      await advanceTimersByTimeAct(result.harness.act, 10);
      expect(apiMocks.fetchFocusEpisodePage).toHaveBeenLastCalledWith(changed.objectId, changed.activationId, 0);
      expect(result.current().data).toEqual({ pages: [otherPage], pageParams: [0] });
      expect(result.client.getQueryData(queryKeys.focusEpisode(original.objectId, original.activationId))).toEqual({
        pages: [first, last], pageParams: [0, 1],
      });
    });

    it("paginates quiet concerns with the complete exact filter and server-provided nextOffset", async () => {
      const filter: FocusQuietConcernFilter = {
        objectType: "decision", query: " release ", taskId: "task-1", originalTaskId: "task-1",
        lifecycle: "active", sourceFamily: "release-watch", activationId: "activation-1",
      };
      const first = { objects: [quietConcern("muted-decision-1")], total: 2, nextOffset: 1 };
      const last = { objects: [quietConcern("muted-decision-2")], total: 2, nextOffset: null };
      apiMocks.fetchFocusQuietConcernPage.mockResolvedValueOnce(first).mockResolvedValueOnce(last);
      const result = await mountHook(() => useFocusQuietConcernPagesQuery(filter, true));
      expect(result.current().hasNextPage).toBe(true);
      await result.harness.act(async () => { await result.current().fetchNextPage(); });
      await advanceTimersByTimeAct(result.harness.act, 10);
      expect(apiMocks.fetchFocusQuietConcernPage.mock.calls).toEqual([[0, 20, filter], [1, 20, filter]]);
      expect(result.current().data).toEqual({ pages: [first, last], pageParams: [0, 1] });
      expect(result.current().hasNextPage).toBe(false);
      expect(result.client.getQueryData(queryKeys.focusQuietConcerns(filter))).toEqual(result.current().data);
    });

    it.each([
      { field: "query", update: { query: "other evidence" } },
      { field: "taskId", update: { taskId: "other-task" } },
      { field: "originalTaskId", update: { originalTaskId: "deleted-task" } },
      { field: "lifecycle", update: { lifecycle: "acknowledged" } },
      { field: "sourceFamily", update: { sourceFamily: "other-family" } },
      { field: "activationId", update: { activationId: "activation-2" } },
    ] satisfies Array<{ field: string; update: FocusQuietConcernFilter }>)("isolates History and quiet-concern caches when only $field changes", async ({ update }) => {
      const original: FocusQuietConcernFilter = {
        objectType: "decision", query: "release", taskId: "task-1", originalTaskId: "task-1",
        lifecycle: "active", sourceFamily: "release-watch", activationId: "activation-1",
      };
      let filter = original;
      const history = { objects: [historyEntry("decision-1")], total: 1, nextOffset: null };
      const quiet = { objects: [quietConcern("decision-1")], total: 1, nextOffset: null };
      const empty = { objects: [], total: 0, nextOffset: null };
      apiMocks.fetchFocusHistoryPage.mockResolvedValueOnce(history).mockResolvedValueOnce(empty);
      apiMocks.fetchFocusQuietConcernPage.mockResolvedValueOnce(quiet).mockResolvedValueOnce(empty);
      const result = await mountHook(() => ({
        history: useFocusHistoryPagesQuery(filter, true),
        quiet: useFocusQuietConcernPagesQuery(filter, true),
      }));
      filter = { ...original, ...update };
      await result.rerender();
      await advanceTimersByTimeAct(result.harness.act, 10);
      expect(apiMocks.fetchFocusHistoryPage.mock.calls).toEqual([[0, 20, original], [0, 20, filter]]);
      expect(apiMocks.fetchFocusQuietConcernPage.mock.calls).toEqual([[0, 20, original], [0, 20, filter]]);
      expect(result.current().history.data).toEqual({ pages: [empty], pageParams: [0] });
      expect(result.current().quiet.data).toEqual({ pages: [empty], pageParams: [0] });
      expect(result.client.getQueryData(queryKeys.focusHistory(original))).toEqual({ pages: [history], pageParams: [0] });
      expect(result.client.getQueryData(queryKeys.focusQuietConcerns(original))).toEqual({ pages: [quiet], pageParams: [0] });
    });

    it("surfaces a missing episode without falling back to current-object or unfiltered History reads", async () => {
      apiMocks.fetchFocusEpisodePage.mockRejectedValue(new Error("Focus episode not found"));
      const result = await mountHook(() => useFocusEpisodePagesQuery("decision-1", "prior-activation", true));
      expect(result.current().isError).toBe(true);
      expect(result.current().error?.message).toBe("Focus episode not found");
      expect(result.current().data).toBeUndefined();
      expect(apiMocks.fetchFocusEpisodePage).toHaveBeenCalledExactlyOnceWith("decision-1", "prior-activation", 0);
      expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
      expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    });
  });

  it.each([
    { scope: "task", digest: focusDigest(), orphanedTaskId: null },
    { scope: "Global", digest: focusDigest({ id: "global", taskId: null, originalTaskId: null }), orphanedTaskId: null },
    { scope: "orphaned", digest: focusDigest({ id: "orphaned", taskId: null, originalTaskId: "deleted-task", orphaned: true }), orphanedTaskId: "deleted-task" },
  ])("keeps $scope digest scope and sourceFamily on every page", async ({ digest, orphanedTaskId }) => {
    const first = { objects: [focusEvent()], total: 2, nextOffset: 1 };
    const last = { objects: [focusEvent({ id: "event-2" })], total: 2, nextOffset: null };
    apiMocks.fetchFocusEventDigestPage.mockResolvedValueOnce(first).mockResolvedValueOnce(last);
    const result = await mountHook(() => useDashboardDigestPagesQuery(digest, true));
    expect(result.current().data?.pages).toEqual([first]);
    expect(result.current().hasNextPage).toBe(true);
    await result.harness.act(async () => { await result.current().fetchNextPage(); });
    await advanceTimersByTimeAct(result.harness.act, 10);
    const expectedFilter = {
      taskId: digest.taskId, keyPrefix: digest.keyPrefix, category: digest.category,
      sourceFamily: digest.sourceFamily, orphanedTaskId,
    };
    expect(apiMocks.fetchFocusEventDigestPage.mock.calls).toEqual([[expectedFilter, 0], [expectedFilter, 1]]);
    expect(result.current().data?.pages).toEqual([first, last]);
    expect(result.current().hasNextPage).toBe(false);
  });

  it("fails closed when an orphaned digest has lost its original task identity", async () => {
    apiMocks.fetchFocusEventDigestPage.mockResolvedValue({ objects: [], total: 0, nextOffset: null });
    const digest = focusDigest({ taskId: null, originalTaskId: null, orphaned: true });
    const result = await mountHook(() => useDashboardDigestPagesQuery(digest, true));
    expect(result.current().isError).toBe(true);
    expect(result.current().error?.message).toContain("Source task identity is unavailable");
    expect(result.current().data).toBeUndefined();
    expect(apiMocks.fetchFocusEventDigestPage).not.toHaveBeenCalled();

    await result.harness.act(async () => { await result.current().refetch(); });
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(result.current().isError).toBe(true);
    expect(apiMocks.fetchFocusEventDigestPage).not.toHaveBeenCalled();
  });

  it("paginates transitions in 100-row batches and stops on the final short page", async () => {
    const first = Array.from({ length: 100 }, (_, index) => transition(`transition-${index}`));
    const last = [transition("transition-last")];
    apiMocks.fetchFocusTransitionPage.mockResolvedValueOnce(first).mockResolvedValueOnce(last);
    const result = await mountHook(() => useFocusTransitionPagesQuery("decision-1", true));
    expect(result.current().hasNextPage).toBe(true);
    await result.harness.act(async () => { await result.current().fetchNextPage(); });
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusTransitionPage.mock.calls).toEqual([["decision-1", 0, 100], ["decision-1", 100, 100]]);
    expect(result.current().data?.pages).toEqual([first, last]);
    expect(result.current().hasNextPage).toBe(false);
  });
});

describe("Focus governance and telemetry queries", () => {
  it("loads authority pages and stops polling once the panel is disabled", async () => {
    let enabled = true;
    const first = Array.from({ length: 50 }, (_, index) => focusGrant({ id: `grant-${index}` }));
    apiMocks.fetchFocusAuthorityPage.mockResolvedValueOnce(first).mockResolvedValueOnce([focusGrant()]);
    const result = await mountHook(() => useFocusAuthorityPagesQuery(enabled));
    expect(result.current().hasNextPage).toBe(true);
    await result.harness.act(async () => { await result.current().fetchNextPage(); });
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusAuthorityPage.mock.calls).toEqual([[0, 50], [50, 50]]);
    expect(result.current().hasNextPage).toBe(false);

    enabled = false;
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 30_000);
    expect(apiMocks.fetchFocusAuthorityPage).toHaveBeenCalledTimes(2);
  });

  it("paginates coverage using loaded assertion count and the complete summary total", async () => {
    const summary = { ...focusSnapshot().coverage.summary!, total: 3 };
    const first = { assertions: [focusCoverage({ id: "one" }), focusCoverage({ id: "two" })], summary };
    const last = { assertions: [focusCoverage({ id: "three" })], summary };
    apiMocks.fetchFocusCoveragePage.mockResolvedValueOnce(first).mockResolvedValueOnce(last);
    const result = await mountHook(() => useFocusCoveragePagesQuery(true));
    expect(result.current().hasNextPage).toBe(true);
    await result.harness.act(async () => { await result.current().fetchNextPage(); });
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusCoveragePage.mock.calls).toEqual([[0, 50], [2, 50]]);
    expect(result.current().data?.pages).toEqual([first, last]);
    expect(result.current().hasNextPage).toBe(false);
  });

  it("stops empty coverage pages even if their summary still reports unavailable assertions", async () => {
    apiMocks.fetchFocusCoveragePage.mockResolvedValue({ assertions: [], summary: { ...focusSnapshot().coverage.summary!, total: 5 } });
    const result = await mountHook(() => useFocusCoveragePagesQuery(true));
    expect(result.current().isSuccess).toBe(true);
    expect(result.current().hasNextPage).toBe(false);
    expect(apiMocks.fetchFocusCoveragePage).toHaveBeenCalledExactlyOnceWith(0, 50);
  });

  it("gates object, audit, metrics, events, and delivery requests behind enabled state", async () => {
    let enabled = false;
    apiMocks.fetchFocusObject.mockResolvedValue(focusDecision());
    apiMocks.fetchFocusAuditPage.mockResolvedValue([focusAudit()]);
    apiMocks.fetchFocusAttentionMetrics.mockResolvedValue({
      since: FOCUS_TEST_NOW, until: FOCUS_TEST_NOW, days: 30, counts: {}, total: 0,
      noOpRate: null, notifications: [], audits: [],
    });
    apiMocks.fetchFocusAttentionEvents.mockResolvedValue([]);
    apiMocks.fetchFocusNotificationDeliveries.mockResolvedValue([]);
    const result = await mountHook(() => ({
      object: useFocusObjectQuery("decision", "decision-1", enabled),
      audits: useFocusAuditPagesQuery(enabled),
      metrics: useFocusAttentionMetricsQuery(30, enabled),
      events: useFocusAttentionEventsQuery("decision-1", enabled),
      deliveries: useFocusNotificationDeliveriesQuery(enabled),
    }));
    expect(Object.values(apiMocks).every((mock) => mock.mock.calls.length === 0)).toBe(true);

    enabled = true;
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusObject).toHaveBeenCalledExactlyOnceWith("decision", "decision-1");
    expect(apiMocks.fetchFocusAuditPage).toHaveBeenCalledExactlyOnceWith(0, 50, "open");
    expect(apiMocks.fetchFocusAttentionMetrics).toHaveBeenCalledExactlyOnceWith(30);
    expect(apiMocks.fetchFocusAttentionEvents).toHaveBeenCalledExactlyOnceWith("decision-1");
    expect(apiMocks.fetchFocusNotificationDeliveries).toHaveBeenCalledExactlyOnceWith(100);
    expect(Object.values(result.current()).every((query) => query.isSuccess)).toBe(true);
  });
});

describe("Focus mutation query coordination", () => {
  it.each([
    { outcome: "success", fails: false, actions: false },
    { outcome: "stale failure", fails: true, actions: true },
  ])("refreshes on $outcome, opts into Action caches, and never retries", async ({ fails, actions }) => {
    const mutate = vi.fn(async (input: { text: string }) => {
      if (fails) throw new Error("Focus activation changed");
      return input.text;
    });
    const result = await mountHook(() => useFocusMutation("decision-1", mutate, actions));
    const focusKeys = [queryKeys.focusSnapshot, queryKeys.focusHistory({ objectId: "decision-1" }), queryKeys.focusObject("decision", "decision-1")];
    const taskKey = queryKeys.taskChecklistItems("old-destination");
    for (const key of [...focusKeys, taskKey, queryKeys.settings]) result.client.setQueryData(key, "cached");

    await result.harness.act(async () => {
      const mutation = result.current().mutateAsync({ text: "Accepted work" });
      if (fails) await expect(mutation).rejects.toThrow("Focus activation changed");
      else await expect(mutation).resolves.toBe("Accepted work");
    });
    await advanceTimersByTimeAct(result.harness.act, 30_000);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({ text: "Accepted work" });
    for (const key of focusKeys) expect(result.client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(result.client.getQueryState(taskKey)?.isInvalidated).toBe(actions);
    expect(result.client.getQueryState(queryKeys.settings)?.isInvalidated).toBe(false);
    expect(result.current().isError).toBe(fails);
  });

  it.each([false, true])("refreshes digest viewing metrics only after a successful mark (fails=%s)", async (fails) => {
    const input = { digestId: focusDigest().id, viewedAt: FOCUS_TEST_NOW };
    if (fails) apiMocks.markFocusDigestViewed.mockRejectedValue(new Error("View was not recorded"));
    else apiMocks.markFocusDigestViewed.mockResolvedValue({ digestId: input.digestId, lastViewedAt: input.viewedAt });
    const result = await mountHook(() => useMarkFocusDigestViewedMutation());
    const refreshedKeys: QueryKey[] = [
      queryKeys.focusSnapshot, queryKeys.focusMetrics(7), queryKeys.focusMetrics(30),
      queryKeys.focusAttentionEvents(), queryKeys.focusAttentionEvents("event-1"),
    ];
    const retainedKeys: QueryKey[] = [
      queryKeys.focusDigest(input.digestId), queryKeys.focusHistory(), queryKeys.focusCoverage, queryKeys.tasks, queryKeys.settings,
    ];
    for (const key of [...refreshedKeys, ...retainedKeys]) result.client.setQueryData(key, "cached");

    await result.harness.act(async () => {
      const mutation = result.current().mutateAsync(input);
      if (fails) await expect(mutation).rejects.toThrow("View was not recorded");
      else await expect(mutation).resolves.toEqual({ digestId: input.digestId, lastViewedAt: input.viewedAt });
    });
    await advanceTimersByTimeAct(result.harness.act, 30_000);
    expect(apiMocks.markFocusDigestViewed).toHaveBeenCalledExactlyOnceWith(input.digestId, input.viewedAt);
    for (const key of refreshedKeys) expect(result.client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(!fails);
    for (const key of retainedKeys) expect(result.client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
  });

});

describe("persisted Focus launch receipt queries", () => {
  it("does not fetch or poll disabled receipt queries, including cached in-progress receipts", async () => {
    let enabled = false;
    const object = focusDecision();
    const receipt = focusLaunchReceipt({
      status: "creating", sessionId: null, promptStatus: "pending", linkedAt: null, promptDispatchedAt: null, version: 2,
    });
    apiMocks.fetchFocusLaunchReceipt.mockResolvedValue(receipt);
    apiMocks.fetchFocusLaunchReceipts.mockResolvedValue([receipt]);
    const result = await mountHook(() => ({
      receipt: useFocusLaunchReceiptQuery(receipt, enabled),
      receipts: useFocusLaunchReceiptsQuery(object, enabled),
    }));
    await result.harness.act(async () => {
      await result.client.invalidateQueries({ queryKey: queryKeys.focusRoot });
    });
    await advanceTimersByTimeAct(result.harness.act, 10_000);
    expect(apiMocks.fetchFocusLaunchReceipt).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusLaunchReceipts).not.toHaveBeenCalled();
    expect(result.current().receipt.fetchStatus).toBe("idle");
    expect(result.current().receipts.fetchStatus).toBe("idle");

    enabled = true;
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusLaunchReceipt).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(apiMocks.fetchFocusLaunchReceipts).toHaveBeenCalledExactlyOnceWith(object.id, object.activationId);
    expect(result.current().receipt.data).toEqual(receipt);
    expect(result.current().receipts.data).toEqual([receipt]);

    enabled = false;
    await result.rerender();
    await result.harness.act(async () => {
      await result.client.invalidateQueries({ queryKey: queryKeys.focusRoot });
    });
    await advanceTimersByTimeAct(result.harness.act, 10_000);
    expect(apiMocks.fetchFocusLaunchReceipt).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchFocusLaunchReceipts).toHaveBeenCalledTimes(1);
    expectNoLaunchWrites();
  });

  it("re-reads durable state after remounting and after losing the query cache", async () => {
    const object = focusDecision();
    const failed = focusLaunchReceipt({
      status: "failed", error: "Link unavailable", errorStage: "link",
      linkedAt: null, promptStatus: "pending", promptDispatchedAt: null,
    });
    const ready = focusLaunchReceipt({ version: 6 });
    apiMocks.fetchFocusLaunchReceipt.mockResolvedValueOnce(failed).mockResolvedValue(ready);
    apiMocks.fetchFocusLaunchReceipts.mockResolvedValueOnce([failed]).mockResolvedValue([ready]);
    const useReceipts = () => ({
      receipt: useFocusLaunchReceiptQuery(failed),
      receipts: useFocusLaunchReceiptsQuery(object, true),
    });
    const first = await mountHook(useReceipts);
    expect(first.current().receipt.data).toEqual(failed);
    expect(first.current().receipts.data).toEqual([failed]);
    await first.harness.cleanup();

    const remounted = await mountHook(useReceipts, first.client);
    expect(remounted.current().receipt.data).toEqual(ready);
    expect(remounted.current().receipts.data).toEqual([ready]);
    expect(apiMocks.fetchFocusLaunchReceipt).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchFocusLaunchReceipts).toHaveBeenCalledTimes(2);
    await remounted.harness.cleanup();
    remounted.client.clear();

    const recovered = await mountHook(useReceipts);
    expect(recovered.client).not.toBe(first.client);
    expect(recovered.current().receipt.data).toEqual(ready);
    expect(recovered.current().receipts.data).toEqual([ready]);
    expect(apiMocks.fetchFocusLaunchReceipt.mock.calls).toEqual([[failed], [failed], [failed]]);
    expect(apiMocks.fetchFocusLaunchReceipts.mock.calls).toEqual([
      [object.id, object.activationId], [object.id, object.activationId], [object.id, object.activationId],
    ]);
    expectNoLaunchWrites();
  });

  it.each([
    { field: "objectId", update: { objectId: "other-object" } },
    { field: "activationId", update: { activationId: "other-activation" } },
    { field: "source", update: { source: "discussion" } },
  ] satisfies Array<{ field: string; update: Partial<FocusLaunchIdentity> }>)("isolates single-receipt queries by $field", async ({ update }) => {
    const receipt = focusLaunchReceipt();
    const original: FocusLaunchIdentity = {
      objectId: receipt.objectId, activationId: receipt.activationId, source: receipt.source,
    };
    let identity = original;
    apiMocks.fetchFocusLaunchReceipt.mockResolvedValueOnce(receipt).mockResolvedValueOnce(null);
    const result = await mountHook(() => useFocusLaunchReceiptQuery(identity));
    expect(result.current().data).toEqual(receipt);

    identity = { ...original, ...update };
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusLaunchReceipt.mock.calls).toEqual([[original], [identity]]);
    expect(result.current().data).toBeNull();
    expect(result.client.getQueryData(queryKeys.focusLaunchReceipt(original))).toEqual(receipt);
    expectNoLaunchWrites();
  });

  it.each(["id", "activationId"] as const)("isolates episode receipt lists by the object's %s", async (field) => {
    const original = focusDecision();
    let object = original;
    const receipts = [
      focusLaunchReceipt(),
      focusLaunchReceipt({ id: "discussion-receipt", source: "discussion", expectedSessionId: "discussion-receipt", sessionId: "discussion-receipt" }),
    ];
    apiMocks.fetchFocusLaunchReceipts.mockResolvedValueOnce(receipts).mockResolvedValueOnce([]);
    const result = await mountHook(() => useFocusLaunchReceiptsQuery(object, true));
    object = { ...original, [field]: "other /?#" };
    await result.rerender();
    await advanceTimersByTimeAct(result.harness.act, 10);
    expect(apiMocks.fetchFocusLaunchReceipts.mock.calls).toEqual([
      [original.id, original.activationId], [object.id, object.activationId],
    ]);
    expect(result.current().data).toEqual([]);
    expect(result.client.getQueryData(queryKeys.focusLaunchReceipts(original.id, original.activationId))).toEqual(receipts);
    expectNoLaunchWrites();
  });

  it("polls only GETs through creating and created, then stops once the server confirms readiness", async () => {
    const creating = focusLaunchReceipt({
      status: "creating", sessionId: null, promptStatus: "pending", linkedAt: null, promptDispatchedAt: null, version: 2,
    });
    const created = { ...creating, status: "created" as const, sessionId: creating.expectedSessionId, version: 3 };
    const ready = focusLaunchReceipt({ version: 6 });
    const discussion = focusLaunchReceipt({
      id: "discussion-receipt", source: "discussion", expectedSessionId: "discussion-receipt", sessionId: "discussion-receipt",
    });
    apiMocks.fetchFocusLaunchReceipt.mockResolvedValueOnce(creating).mockResolvedValueOnce(created).mockResolvedValue(ready);
    apiMocks.fetchFocusLaunchReceipts
      .mockResolvedValueOnce([discussion, creating])
      .mockResolvedValueOnce([discussion, created])
      .mockResolvedValue([discussion, ready]);
    const object = focusDecision();
    const result = await mountHook(() => ({
      receipt: useFocusLaunchReceiptQuery(creating),
      receipts: useFocusLaunchReceiptsQuery(object, true),
    }));
    expect(result.current().receipt.data?.sessionId).toBeNull();
    expect(result.current().receipt.data?.status).toBe("creating");
    await advanceTimersByTimeAct(result.harness.act, 1_000);
    expect(apiMocks.fetchFocusLaunchReceipt).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchFocusLaunchReceipts).toHaveBeenCalledTimes(1);

    await advanceTimersByTimeAct(result.harness.act, 1_010);
    expect(apiMocks.fetchFocusLaunchReceipt).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchFocusLaunchReceipts).toHaveBeenCalledTimes(2);
    expect(result.current().receipt.data).toEqual(created);
    expect(result.current().receipts.data).toEqual([discussion, created]);
    expect(result.current().receipt.data?.promptStatus).toBe("pending");

    await advanceTimersByTimeAct(result.harness.act, 2_010);
    expect(result.current().receipt.data).toEqual(ready);
    expect(result.current().receipts.data).toEqual([discussion, ready]);
    await advanceTimersByTimeAct(result.harness.act, 10_000);
    expect(apiMocks.fetchFocusLaunchReceipt.mock.calls).toEqual([[creating], [creating], [creating]]);
    expect(apiMocks.fetchFocusLaunchReceipts.mock.calls).toEqual([
      [object.id, object.activationId], [object.id, object.activationId], [object.id, object.activationId],
    ]);
    expectNoLaunchWrites();
  });

  it.each([
    {
      state: "prepared",
      receipt: focusLaunchReceipt({
        status: "prepared", sessionId: null, promptStatus: "pending", creationDispatchedAt: null,
        linkedAt: null, promptDispatchedAt: null, version: 0,
      }),
    },
    { state: "ready", receipt: focusLaunchReceipt() },
    {
      state: "failed",
      receipt: focusLaunchReceipt({
        status: "failed", error: "Link failed", errorStage: "link", linkedAt: null,
        promptStatus: "pending", promptDispatchedAt: null,
      }),
    },
    {
      state: "unknown",
      receipt: focusLaunchReceipt({ status: "unknown", error: "Prompt delivery unconfirmed", errorStage: "prompt", promptStatus: "unknown" }),
    },
    {
      state: "superseded",
      receipt: focusLaunchReceipt({
        status: "superseded", error: "Episode changed", errorStage: "link", linkedAt: null,
        promptStatus: "pending", promptDispatchedAt: null,
      }),
    },
    { state: "missing", receipt: null },
  ])("reads $state receipts without polling or starting work automatically", async ({ receipt }) => {
    const identity: FocusLaunchIdentity = { objectId: "decision-1", activationId: "activation-1", source: "launch_prompt" };
    const receipts = receipt ? [receipt] : [];
    apiMocks.fetchFocusLaunchReceipt.mockResolvedValue(receipt);
    apiMocks.fetchFocusLaunchReceipts.mockResolvedValue(receipts);
    const result = await mountHook(() => ({
      receipt: useFocusLaunchReceiptQuery(identity),
      receipts: useFocusLaunchReceiptsQuery(focusDecision(), true),
    }));
    await advanceTimersByTimeAct(result.harness.act, 10_000);
    expect(result.current().receipt.data).toEqual(receipt);
    expect(result.current().receipts.data).toEqual(receipts);
    expect(apiMocks.fetchFocusLaunchReceipt).toHaveBeenCalledExactlyOnceWith(identity);
    expect(apiMocks.fetchFocusLaunchReceipts).toHaveBeenCalledExactlyOnceWith("decision-1", "activation-1");
    expectNoLaunchWrites();
  });

  it("overrides retry-enabled defaults and surfaces receipt read failures without POST recovery", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 10, gcTime: Infinity, staleTime: Infinity } } });
    const error = new Error("Receipt storage unavailable");
    apiMocks.fetchFocusLaunchReceipt.mockRejectedValue(error);
    apiMocks.fetchFocusLaunchReceipts.mockRejectedValue(error);
    const receipt = focusLaunchReceipt();
    const result = await mountHook(() => ({
      receipt: useFocusLaunchReceiptQuery(receipt),
      receipts: useFocusLaunchReceiptsQuery(focusDecision(), true),
    }), client);
    await advanceTimersByTimeAct(result.harness.act, 30_000);
    expect(result.current().receipt.isError).toBe(true);
    expect(result.current().receipts.isError).toBe(true);
    expect(result.current().receipt.error).toBe(error);
    expect(result.current().receipts.error).toBe(error);
    expect(result.current().receipt.data).toBeUndefined();
    expect(result.current().receipts.data).toBeUndefined();
    expect(apiMocks.fetchFocusLaunchReceipt).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchFocusLaunchReceipts).toHaveBeenCalledTimes(1);
    expectNoLaunchWrites();
  });
});

describe("remembering versioned Focus launch receipts", () => {
  it("seeds identity and receipt-ID caches without pretending an unfetched episode list is complete", () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const receipt = focusLaunchReceipt();
    try {
      rememberFocusLaunchReceipt(client, receipt);
      expect(client.getQueryData(queryKeys.focusLaunchReceipt(receipt))).toEqual(receipt);
      expect(client.getQueryData(queryKeys.focusLaunchReceiptById(receipt.id))).toEqual(receipt);
      expect(client.getQueryData(queryKeys.focusLaunchReceipts(receipt.objectId, receipt.activationId))).toBeUndefined();
      expect(apiMocks.fetchFocusLaunchReceipt).not.toHaveBeenCalled();
      expect(apiMocks.fetchFocusLaunchReceipts).not.toHaveBeenCalled();
      expectNoLaunchWrites();
    } finally {
      client.clear();
    }
  });

  it("keeps versions monotonic in identity, receipt-ID, and already-loaded episode caches", () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const creating = focusLaunchReceipt({
      status: "creating", sessionId: null, promptStatus: "pending", linkedAt: null, promptDispatchedAt: null, version: 2,
    });
    const created: FocusSessionLaunch = { ...creating, status: "created", sessionId: creating.expectedSessionId, version: 3 };
    const ready = focusLaunchReceipt({ version: 6 });
    const identityKey = queryKeys.focusLaunchReceipt(creating);
    const idKey = queryKeys.focusLaunchReceiptById(creating.id);
    const listKey = queryKeys.focusLaunchReceipts(creating.objectId, creating.activationId);
    try {
      client.setQueryData(listKey, [creating]);
      rememberFocusLaunchReceipt(client, creating);
      rememberFocusLaunchReceipt(client, ready);
      rememberFocusLaunchReceipt(client, created);
      rememberFocusLaunchReceipt(client, creating);
      expect(client.getQueryData(identityKey)).toEqual(ready);
      expect(client.getQueryData(idKey)).toEqual(ready);
      expect(client.getQueryData(listKey)).toEqual([ready]);
      expect(creating.updatedAt).toBe(ready.updatedAt);
      expectNoLaunchWrites();
    } finally {
      client.clear();
    }
  });

  it("adds an unseen receipt only to its loaded episode list and preserves other sources and activations", () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const receipt = focusLaunchReceipt();
    const discussion = focusLaunchReceipt({
      id: "discussion-receipt", source: "discussion", expectedSessionId: "discussion-receipt", sessionId: "discussion-receipt",
    });
    const otherEpisode = focusLaunchReceipt({
      id: "new-episode-receipt", activationId: "activation-2", expectedSessionId: "new-episode-receipt", sessionId: "new-episode-receipt",
    });
    const listKey = queryKeys.focusLaunchReceipts(receipt.objectId, receipt.activationId);
    const otherListKey = queryKeys.focusLaunchReceipts(otherEpisode.objectId, otherEpisode.activationId);
    try {
      client.setQueryData(listKey, [discussion]);
      client.setQueryData(otherListKey, [otherEpisode]);
      rememberFocusLaunchReceipt(client, discussion);
      rememberFocusLaunchReceipt(client, otherEpisode);
      rememberFocusLaunchReceipt(client, receipt);
      rememberFocusLaunchReceipt(client, receipt);
      const list = client.getQueryData<FocusSessionLaunch[]>(listKey);
      expect(list).toHaveLength(2);
      expect(list).toEqual(expect.arrayContaining([discussion, receipt]));
      expect(client.getQueryData(queryKeys.focusLaunchReceipt(discussion))).toEqual(discussion);
      expect(client.getQueryData(queryKeys.focusLaunchReceiptById(discussion.id))).toEqual(discussion);
      expect(client.getQueryData(otherListKey)).toEqual([otherEpisode]);
      expect(client.getQueryData(queryKeys.focusLaunchReceipt(otherEpisode))).toEqual(otherEpisode);
      expect(client.getQueryData(queryKeys.focusLaunchReceiptById(otherEpisode.id))).toEqual(otherEpisode);
      expectNoLaunchWrites();
    } finally {
      client.clear();
    }
  });
});
