import { createElement } from "react";
import { QueryClient, QueryClientProvider, QueryObserver, useQuery, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../queryClient";
import { advanceTimersByTimeAct, createReactDomHarness } from "../test-react-harness";
import {
  createCoalescedInvalidator,
  EVENT_REFETCH_GAP_MS,
  EVENT_REFETCH_MAX_WAIT_MS,
} from "./coalesced-invalidation";
import { createDeferredTaskChangeInvalidator } from "./task-change-invalidation";

const ACTIVE_SESSIONS = queryKeys.sessions({ includeArchived: false });
const ARCHIVED_SESSIONS = queryKeys.sessions({ includeArchived: true });

/** A request counter for one query key. Every fetch stays open until the test answers it; its data is its number. */
function createEndpoint(queryKey: QueryKey) {
  const answers: Array<() => void> = [];
  return {
    queryKey,
    queryFn: () => new Promise<number>((resolve) => {
      const call = answers.length + 1;
      answers.push(() => resolve(call));
    }),
    requests: () => answers.length,
    /** Answers every request sent so far and lets the query settle. */
    async answer() {
      for (const answer of answers) answer();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

let queryClient: QueryClient;
let unsubscribe: Array<() => void>;

/** A query shown on screen, already loaded once (request 1). */
async function showQuery(queryKey: QueryKey, options: { enabled?: boolean } = {}) {
  const endpoint = createEndpoint(queryKey);
  unsubscribe.push(new QueryObserver(queryClient, { queryKey, queryFn: endpoint.queryFn, ...options }).subscribe(() => {}));
  await endpoint.answer();
  return endpoint;
}

beforeEach(() => {
  vi.useFakeTimers();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  unsubscribe = [];
});

afterEach(() => {
  for (const stop of unsubscribe) stop();
  queryClient.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("createCoalescedInvalidator", () => {
  it("answers a burst of 30 invalidations with one refetch at once and one follow-up", async () => {
    const sessions = await showQuery(ACTIVE_SESSIONS);
    const events = createCoalescedInvalidator(queryClient);

    for (let index = 0; index < 30; index += 1) void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS, exact: true });

    // The first refetch needs no timer.
    expect(sessions.requests()).toBe(2);
    await sessions.answer();
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_GAP_MS - 1);
    expect(sessions.requests()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.requests()).toBe(3);

    await sessions.answer();
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_MAX_WAIT_MS * 2);
    expect(sessions.requests()).toBe(3);
    expect(queryClient.getQueryData(ACTIVE_SESSIONS)).toBe(3);
  });

  it("refetches at once again when the previous refetch is over and the gap has passed", async () => {
    const sessions = await showQuery(ACTIVE_SESSIONS);
    const events = createCoalescedInvalidator(queryClient);

    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS });
    await sessions.answer();
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_GAP_MS);
    expect(sessions.requests()).toBe(2);

    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS });
    expect(sessions.requests()).toBe(3);
  });

  it("never has two of its refetches of one query in flight: a slow answer delays the follow-up", async () => {
    const sessions = await showQuery(ACTIVE_SESSIONS);
    const events = createCoalescedInvalidator(queryClient);

    for (let index = 0; index < 30; index += 1) void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS });
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_GAP_MS * 5);
    expect(sessions.requests()).toBe(2);

    await sessions.answer();
    expect(sessions.requests()).toBe(3);
  });

  it("stops waiting for a request that never answers", async () => {
    const sessions = await showQuery(ACTIVE_SESSIONS);
    const events = createCoalescedInvalidator(queryClient);

    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS });
    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS });
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_MAX_WAIT_MS - 1);
    expect(sessions.requests()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.requests()).toBe(3);
  });

  it("counts per query, whichever filters name it", async () => {
    const active = await showQuery(ACTIVE_SESSIONS);
    const archived = await showQuery(ARCHIVED_SESSIONS);
    const events = createCoalescedInvalidator(queryClient);

    for (let index = 0; index < 15; index += 1) {
      void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS, exact: true });
      void events.invalidateQueries({ queryKey: ["sessions"] });
    }
    expect([active.requests(), archived.requests()]).toEqual([2, 2]);

    await Promise.all([active.answer(), archived.answer()]);
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_GAP_MS);
    expect([active.requests(), archived.requests()]).toEqual([3, 3]);
  });

  it("only marks queries that nothing shows, and leaves disabled ones alone", async () => {
    const hidden = createEndpoint(queryKeys.tasks);
    void queryClient.prefetchQuery({ queryKey: hidden.queryKey, queryFn: hidden.queryFn });
    await hidden.answer();
    const disabled = await showQuery(queryKeys.taskGroups, { enabled: false });
    const events = createCoalescedInvalidator(queryClient);

    await events.invalidateQueries({ queryKey: queryKeys.tasks });
    await events.invalidateQueries({ queryKey: queryKeys.taskGroups });
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_GAP_MS);

    expect(hidden.requests()).toBe(1);
    expect(queryClient.getQueryState(queryKeys.tasks)?.isInvalidated).toBe(true);
    expect(disabled.requests()).toBe(0);
  });

  it("replaces a fetch that started before the event, so the data is from after it", async () => {
    const sessions = await showQuery(ACTIVE_SESSIONS);
    const events = createCoalescedInvalidator(queryClient);
    void queryClient.refetchQueries({ queryKey: ACTIVE_SESSIONS });
    expect(sessions.requests()).toBe(2);

    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS });
    expect(sessions.requests()).toBe(3);

    await sessions.answer();
    expect(queryClient.getQueryData(ACTIVE_SESSIONS)).toBe(3);
  });

  it("settles with the refetch it started and does not wait for a follow-up", async () => {
    const sessions = await showQuery(ACTIVE_SESSIONS);
    const events = createCoalescedInvalidator(queryClient);

    let first = "pending";
    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS }).then(() => { first = "settled"; });
    let second = "pending";
    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS }).then(() => { second = "settled"; });
    await vi.advanceTimersByTimeAsync(0);
    expect([first, second]).toEqual(["pending", "settled"]);

    await sessions.answer();
    expect(first).toBe("settled");
  });

  it("leaves an awaited invalidation of the query client with data fetched after that call", async () => {
    const sessions = await showQuery(ACTIVE_SESSIONS);
    const events = createCoalescedInvalidator(queryClient);
    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS });
    void events.invalidateQueries({ queryKey: ACTIVE_SESSIONS });
    await sessions.answer();

    // A user action answers and awaits fresh lists while the follow-up is still due.
    let userData: unknown;
    void queryClient.invalidateQueries({ queryKey: ["sessions"] }).then(() => {
      userData = queryClient.getQueryData(ACTIVE_SESSIONS);
    });
    expect(sessions.requests()).toBe(3);
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_GAP_MS);
    // The follow-up replaced the user's fetch; the user's promise follows the replacement.
    expect(sessions.requests()).toBe(4);
    expect(userData).toBeUndefined();

    await sessions.answer();
    expect(userData).toBe(4);
  });

  it("stands in for the query client in the task-change invalidator, deferral included", async () => {
    const tasks = await showQuery(queryKeys.tasks);
    const enriched = await showQuery(queryKeys.taskEnriched("task-1"));
    const otherTask = await showQuery(queryKeys.taskEnriched("task-2"));
    const taskChanges = createDeferredTaskChangeInvalidator(createCoalescedInvalidator(queryClient));

    taskChanges.beginTaskMutation();
    for (let index = 0; index < 5; index += 1) taskChanges.handleTaskChange("task-1");
    expect(tasks.requests()).toBe(1);
    taskChanges.endTaskMutation();
    for (let index = 0; index < 12; index += 1) taskChanges.handleTaskChange("task-1");
    expect([tasks.requests(), enriched.requests()]).toEqual([2, 2]);

    await Promise.all([tasks.answer(), enriched.answer()]);
    await vi.advanceTimersByTimeAsync(EVENT_REFETCH_GAP_MS);
    expect([tasks.requests(), enriched.requests(), otherTask.requests()]).toEqual([3, 3, 1]);
  });

  it("treats a query mounted with useQuery as shown", async () => {
    const sessions = createEndpoint(ACTIVE_SESSIONS);
    const harness = await createReactDomHarness();
    function Probe() {
      useQuery({ queryKey: sessions.queryKey, queryFn: sessions.queryFn });
      return null;
    }
    await harness.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
    await harness.act(() => sessions.answer());
    const events = createCoalescedInvalidator(queryClient);

    await harness.act(async () => {
      for (let index = 0; index < 30; index += 1) void events.invalidateQueries({ queryKey: ["sessions"] });
    });
    expect(sessions.requests()).toBe(2);

    await harness.act(() => sessions.answer());
    await advanceTimersByTimeAct(harness.act, EVENT_REFETCH_GAP_MS);
    expect(sessions.requests()).toBe(3);
    await harness.act(() => sessions.answer());
  });
});
