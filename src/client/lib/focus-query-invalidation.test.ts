import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../queryClient";
import { focusAction, focusDigest, focusTask } from "../test-focus-fixtures";
import { invalidateFocusMutationQueries, invalidateFocusProtectionQueries } from "./focus-query-invalidation";

const clients: QueryClient[] = [];
const unsubscribe: Array<() => void> = [];

function createClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  });
  clients.push(client);
  return client;
}

function observe<T>(client: QueryClient, queryKey: QueryKey, cached: T, refreshed: T) {
  client.setQueryData(queryKey, cached);
  const fetch = vi.fn(async () => refreshed);
  const observer = new QueryObserver(client, { queryKey, queryFn: fetch });
  unsubscribe.push(observer.subscribe(() => {}));
  return fetch;
}

afterEach(() => {
  for (const stop of unsubscribe.splice(0)) stop();
  for (const client of clients.splice(0)) client.clear();
});

const focusKeys: QueryKey[] = [
  queryKeys.focusSnapshot,
  queryKeys.focusDecisions,
  queryKeys.focusAlerts,
  queryKeys.focusDigest(focusDigest().id),
  queryKeys.focusDigest("orphaned-task-digest"),
  queryKeys.focusCleared,
  queryKeys.focusObject("decision", "decision-1"),
  queryKeys.focusObject("alert", "alert-1"),
  queryKeys.focusObject("event", "event-1"),
  queryKeys.focusHistory(),
  queryKeys.focusHistory({ objectType: "action" }),
  queryKeys.focusHistory({ objectId: "decision-1" }),
  queryKeys.focusTransitions("decision-1"),
  queryKeys.focusTransitions("action-1"),
  queryKeys.focusAuthority,
  queryKeys.focusCoverage,
  queryKeys.focusAudits,
  queryKeys.focusMetrics(7),
  queryKeys.focusMetrics(30),
  queryKeys.focusAttentionEvents(),
  queryKeys.focusAttentionEvents("decision-1"),
  queryKeys.focusDeliveries,
  queryKeys.focusProtectionCurrent,
  queryKeys.focusProtectionHistory,
  queryKeys.focusQuietConcerns({ taskId: "task-1" }),
  queryKeys.focusEpisode("decision-1", "activation-1"),
  queryKeys.focusLaunchReceipts("decision-1", "activation-1"),
  queryKeys.focusLaunchReceipt({ objectId: "decision-1", activationId: "activation-1", source: "launch_prompt" }),
  queryKeys.focusLaunchReceiptById("receipt-1"),
];

describe("invalidateFocusMutationQueries", () => {
  it("refetches every mounted Focus domain, detail, History, and attention query", async () => {
    const client = createClient();
    const queries = focusKeys.map((key) => ({ key, fetch: observe(client, key, "cached", "refreshed") }));
    const settingsFetch = observe(client, queryKeys.settings, "settings", "changed-settings");
    const workMapFetch = observe(client, queryKeys.workMap(false, true), "work-map", "changed-work-map");
    const taskFetch = observe(client, queryKeys.task("task-1"), "task", "changed-task");

    await invalidateFocusMutationQueries(client);

    for (const { key, fetch } of queries) {
      expect(fetch, JSON.stringify(key)).toHaveBeenCalledOnce();
      expect(client.getQueryData(key), JSON.stringify(key)).toBe("refreshed");
    }
    expect(settingsFetch).not.toHaveBeenCalled();
    expect(workMapFetch).not.toHaveBeenCalled();
    expect(taskFetch).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.settings)).toBe("settings");
  });

  describe("invalidateFocusProtectionQueries", () => {
    it("refetches active protection/current/list and affected runner/notification state without unrelated data", async () => {
      const client = createClient();
      const keys = [
        queryKeys.focusProtectionCurrent, queryKeys.focusProtectionHistory, queryKeys.focusSnapshot,
        queryKeys.focusDeliveries, queryKeys.focusAttentionEvents(), queryKeys.focusMetrics(),
        queryKeys.dashboard, queryKeys.sessions(), queryKeys.sessions({ includeArchived: true }),
        queryKeys.tasks, queryKeys.task("task-1"), queryKeys.taskSchedules("task-1"),
        queryKeys.scheduleSessions("schedule-1"),
      ];
      const queries = keys.map((key) => ({ key, fetch: observe(client, key, "cached", "refreshed") }));
      const untouched = [queryKeys.settings, queryKeys.models, queryKeys.taskGitStatus("task-1"), queryKeys.workMap(false, false)]
        .map((key) => observe(client, key, "retained", "wrong"));
      await invalidateFocusProtectionQueries(client);
      for (const { key, fetch } of queries) {
        expect(fetch, JSON.stringify(key)).toHaveBeenCalledOnce();
        expect(client.getQueryData(key)).toBe("refreshed");
      }
      for (const fetch of untouched) expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("marks inactive Focus pages stale without clearing recovery state or unrelated caches", async () => {
    const client = createClient();
    const untouchedKeys: QueryKey[] = [
      queryKeys.settings,
      queryKeys.models,
      queryKeys.dashboard,
      queryKeys.tasks,
      queryKeys.task("task-1"),
      queryKeys.taskChecklistItems("task-1"),
      queryKeys.openChecklistItems,
      queryKeys.sessions(),
    ];
    for (const key of [...focusKeys, ...untouchedKeys]) client.setQueryData(key, { retained: true });

    await invalidateFocusMutationQueries(client, false);

    for (const key of focusKeys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
      expect(client.getQueryData(key)).toEqual({ retained: true });
    }
    for (const key of untouchedKeys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
      expect(client.getQueryData(key)).toEqual({ retained: true });
    }
  });

  it.each([
    { from: "old-task", to: "new-task" },
    { from: "old-task", to: null },
    { from: null, to: "new-task" },
  ])("refreshes both Action destinations when moving $from → $to", async ({ from, to }) => {
    const client = createClient();
    const before = focusAction({ taskId: from });
    const after = focusAction({ taskId: to });
    const tasks = [
      focusTask({ id: "old-task", title: "Previous destination" }),
      focusTask({ id: "new-task", title: "New destination" }),
    ];
    const expectedFetches: Array<() => Promise<unknown>> = [
      observe(client, queryKeys.dashboard, "old-dashboard", "new-dashboard"),
      observe(client, queryKeys.tasks, tasks, tasks),
      observe(client, queryKeys.openChecklistItems, [before], [after]),
      observe(client, queryKeys.focusObject("decision", "decision-1"), "old-source", "new-source"),
      observe(client, queryKeys.focusHistory({ objectType: "action" }), "old-history", "new-history"),
    ];
    if (from) {
      expectedFetches.push(
        observe(client, queryKeys.task(from), tasks[0], tasks[0]),
        observe(client, queryKeys.taskChecklistItems(from), [before], []),
      );
    }
    if (to) {
      expectedFetches.push(
        observe(client, queryKeys.task(to), tasks[1], tasks[1]),
        observe(client, queryKeys.taskChecklistItems(to), [], [after]),
      );
    }
    const untouchedKeys: QueryKey[] = [
      queryKeys.settings,
      queryKeys.workMap(false, false),
      queryKeys.taskGitStatus("old-task"),
      queryKeys.taskEnriched("new-task"),
      queryKeys.taskAgentDefinitions("old-task"),
      queryKeys.taskSchedules("new-task"),
      queryKeys.taskSessionStorage("old-task", ["session-1"]),
    ];
    const untouched = untouchedKeys.map((key) => observe(client, key, "retained", "incorrectly-refetched"));

    await invalidateFocusMutationQueries(client, true);

    for (const fetch of expectedFetches) expect(fetch).toHaveBeenCalledOnce();
    expect(client.getQueryData(queryKeys.openChecklistItems)).toEqual([after]);
    if (from) expect(client.getQueryData(queryKeys.taskChecklistItems(from))).toEqual([]);
    if (to) expect(client.getQueryData(queryKeys.taskChecklistItems(to))).toEqual([after]);
    for (const fetch of untouched) expect(fetch).not.toHaveBeenCalled();
    for (const key of untouchedKeys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
      expect(client.getQueryData(key)).toBe("retained");
    }
  });

  it("also invalidates unmounted old and new task checklists during Action mutations", async () => {
    const client = createClient();
    const keys = [
      queryKeys.dashboard, queryKeys.tasks, queryKeys.openChecklistItems,
      queryKeys.task("old-task"), queryKeys.task("new-task"),
      queryKeys.taskChecklistItems("old-task"), queryKeys.taskChecklistItems("new-task"),
    ];
    for (const key of keys) client.setQueryData(key, "cached");
    client.setQueryData(queryKeys.settings, "settings");

    await invalidateFocusMutationQueries(client, true);

    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    expect(client.getQueryState(queryKeys.settings)?.isInvalidated).toBe(false);
  });

  it("does not settle before an active Focus refresh completes", async () => {
    const client = createClient();
    client.setQueryData(queryKeys.focusSnapshot, "cached");
    let release!: (value: string) => void;
    const refreshed = new Promise<string>((resolve) => { release = resolve; });
    const fetch = vi.fn(() => refreshed);
    const observer = new QueryObserver(client, { queryKey: queryKeys.focusSnapshot, queryFn: fetch });
    unsubscribe.push(observer.subscribe(() => {}));
    let settled = false;

    const invalidation = invalidateFocusMutationQueries(client).then(() => { settled = true; });
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(client.getQueryData(queryKeys.focusSnapshot)).toBe("cached");

    release("refreshed");
    await invalidation;
    expect(settled).toBe(true);
    expect(client.getQueryData(queryKeys.focusSnapshot)).toBe("refreshed");
  });
});
