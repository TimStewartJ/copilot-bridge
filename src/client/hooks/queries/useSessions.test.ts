import { describe, expect, it, vi } from "vitest";
import { QueryClient, isCancelledError, type InfiniteData } from "@tanstack/react-query";
import type { Session, TaskArchivedSessionsResponse } from "../../api";
import { queryKeys } from "../../queryClient";
import {
  mergeActiveAndArchivedSessions,
  mergeOptimisticSessions,
  addOptimisticSessionToCache,
  patchSessionQueryData,
  shareSessionsStructurally,
} from "./useSessions";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    summary: "Session",
    modifiedTime: "2026-04-27T18:00:00.000Z",
    deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("optimistic session insertion", () => {
  it("keeps the existing creation defaults, expiry and caller overrides in the query layer", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T17:00:00.000Z"));
    const queryClient = new QueryClient();
    const key = queryKeys.sessions({ includeArchived: false });
    try {
      queryClient.setQueryData<Session[]>(key, []);
      addOptimisticSessionToCache(queryClient, "new", { runState: "busy", summary: "Draft" });
      const cached = queryClient.getQueryData<Session[]>(key);
      expect(cached?.[0]).toMatchObject({
        sessionId: "new", runState: "busy", summary: "Draft",
        isOptimistic: true, optimisticUntil: Date.now() + 2 * 60_000,
        lastVisibleActivityAt: "2026-10-16T17:00:00.000Z",
        deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
      });
      addOptimisticSessionToCache(queryClient, "new", { summary: "Do not replace" });
      expect(queryClient.getQueryData(key)).toBe(cached);
    } finally {
      queryClient.clear();
      vi.useRealTimers();
    }
  });

  it("does not create a list before its initial server read", () => {
    const queryClient = new QueryClient();
    addOptimisticSessionToCache(queryClient, "new");
    expect(queryClient.getQueryData(queryKeys.sessions({ includeArchived: false }))).toBeUndefined();
    queryClient.clear();
  });
});

describe("shareSessionsStructurally", () => {
  it("returns the cached array when a poll brings back identical data", () => {
    const cached = [createSession({ sessionId: "a" }), createSession({ sessionId: "b" })];
    const fresh = [createSession({ sessionId: "a" }), createSession({ sessionId: "b" })];

    expect(shareSessionsStructurally(cached, fresh)).toBe(cached);
  });

  it("keeps references for unchanged sessions and replaces only changed ones", () => {
    const cached = [createSession({ sessionId: "a" }), createSession({ sessionId: "b" })];
    const fresh = [
      createSession({ sessionId: "a" }),
      createSession({ sessionId: "b", summary: "Renamed" }),
    ];

    const shared = shareSessionsStructurally(cached, fresh);
    expect(shared).not.toBe(cached);
    expect(shared[0]).toBe(cached[0]);
    expect(shared[1]).not.toBe(cached[1]);
    expect(shared[1].summary).toBe("Renamed");
  });

  it("still carries optimistic sessions the server has not returned yet", () => {
    const optimistic = createSession({ sessionId: "optimistic", isOptimistic: true, optimisticUntil: 1_000 });
    const cached = [optimistic, createSession({ sessionId: "a" })];
    const fresh = [createSession({ sessionId: "a" })];

    const shared = shareSessionsStructurally(cached, fresh, 500);
    expect(shared).toBe(cached);
  });
});

describe("mergeOptimisticSessions", () => {
  it("keeps optimistic sessions omitted by a stale refetch", () => {
    const serverSessions = [
      createSession({ sessionId: "server-session", summary: "Server session" }),
    ];
    const cachedSessions = [
      createSession({
        sessionId: "new-session",
        summary: "New session",
        isOptimistic: true,
        optimisticUntil: 1_000,
      }),
      createSession({ sessionId: "server-session", summary: "Cached server session" }),
    ];

    expect(mergeOptimisticSessions(serverSessions, cachedSessions, 500)).toEqual([
      cachedSessions[0],
      serverSessions[0],
    ]);
  });

  it("replaces optimistic state once the server returns the session", () => {
    const serverSession = createSession({ sessionId: "new-session", summary: "Real title" });
    const cachedSession = createSession({
      sessionId: "new-session",
      summary: "New session",
      isOptimistic: true,
      optimisticUntil: 1_000,
    });

    expect(mergeOptimisticSessions([serverSession], [cachedSession], 500)).toEqual([
      serverSession,
    ]);
  });

  it("drops expired optimistic sessions", () => {
    const serverSessions = [
      createSession({ sessionId: "server-session", summary: "Server session" }),
    ];
    const cachedSessions = [
      createSession({
        sessionId: "expired-session",
        summary: "New session",
        isOptimistic: true,
        optimisticUntil: 500,
      }),
    ];

    expect(mergeOptimisticSessions(serverSessions, cachedSessions, 1_000)).toEqual(serverSessions);
  });
});

describe("mergeActiveAndArchivedSessions", () => {
  it("uses only active-query sessions until archives are requested", () => {
    const activeSession = createSession({ sessionId: "active-session" });
    const archivedSession = createSession({ sessionId: "archived-session", archived: true });

    expect(mergeActiveAndArchivedSessions([activeSession], [activeSession, archivedSession], false))
      .toEqual([activeSession]);
  });

  it("adds archived-query archived sessions without duplicating active sessions", () => {
    const activeSession = createSession({ sessionId: "active-session" });
    const archivedSession = createSession({ sessionId: "archived-session", archived: true });
    const staleActiveSession = createSession({ sessionId: "stale-active-session" });

    expect(mergeActiveAndArchivedSessions(
      [activeSession],
      [activeSession, staleActiveSession, archivedSession],
      true,
    )).toEqual([activeSession, archivedSession]);
  });

  it("keeps restoring unarchived sessions until the active query contains them", () => {
    const activeSession = createSession({ sessionId: "active-session" });
    const restoringSession = createSession({ sessionId: "restoring-session", archived: false });
    const staleActiveSession = createSession({ sessionId: "stale-active-session", archived: false });

    expect(mergeActiveAndArchivedSessions(
      [activeSession],
      [restoringSession, staleActiveSession],
      true,
      new Set(["restoring-session"]),
    )).toEqual([activeSession, restoringSession]);
  });
});

describe("patchSessionQueryData", () => {
  it("resolves functional updates per cache and preserves them across a stale fetch", async () => {
    const queryClient = new QueryClient();
    const active = queryKeys.sessions({ includeArchived: false });
    const all = queryKeys.sessions({ includeArchived: true });
    const archived = queryKeys.taskArchivedSessions("task");
    queryClient.setQueryData(active, [createSession({ summary: "Active" })]);
    queryClient.setQueryData(all, [createSession({ summary: "All" })]);
    queryClient.setQueryData<InfiniteData<TaskArchivedSessionsResponse>>(archived, {
      pages: [{ sessions: [createSession({ summary: "Page" })], offset: 0, total: 1 }],
      pageParams: [0],
    });
    const response = createDeferred<Session[]>();
    const pending = queryClient.fetchQuery({ queryKey: active, queryFn: () => response.promise });
    const update = vi.fn((session: Session): Partial<Session> => ({ intentText: session.summary, runState: "busy" }));
    try {
      patchSessionQueryData(queryClient, ["session-1"], update);
      response.resolve([createSession({ summary: "Fresh", runState: "idle" })]);
      await pending;
      expect(queryClient.getQueryData<Session[]>(active)?.[0]).toMatchObject({
        summary: "Fresh", intentText: "Active", runState: "busy",
      });
      expect(queryClient.getQueryData<Session[]>(all)?.[0].intentText).toBe("All");
      expect(queryClient.getQueryData<InfiniteData<TaskArchivedSessionsResponse>>(archived)?.pages[0].sessions[0].intentText)
        .toBe("Page");
      expect(update).toHaveBeenCalledTimes(3);
    } finally {
      queryClient.clear();
    }
  });

  it.each(["busy", "stalled", "idle"] as const)(
    "keeps a newer %s event when an older list response arrives",
    async (runState) => {
      const queryClient = new QueryClient();
      const key = queryKeys.sessions({ includeArchived: false });
      const oldState = runState === "idle" ? "busy" : "idle";
      queryClient.setQueryData(key, [createSession({ runState: oldState })]);
      const response = createDeferred<Session[]>();
      const pending = queryClient.fetchQuery({ queryKey: key, queryFn: () => response.promise });
      try {
        patchSessionQueryData(queryClient, ["session-1"], { runState });
        patchSessionQueryData(queryClient, ["session-1"], { intentText: "Latest intent" });
        response.resolve([
          createSession({ runState: oldState, summary: "Fresh title" }),
          createSession({ sessionId: "other", runState: "busy" }),
        ]);
        await pending;

        expect(queryClient.getQueryData(key)).toMatchObject([
          { runState, intentText: "Latest intent", summary: "Fresh title" },
          { sessionId: "other", runState: "busy" },
        ]);
        expect(queryClient.getQueryCache().hasListeners()).toBe(false);

        await queryClient.fetchQuery({
          queryKey: key,
          queryFn: async () => [createSession({ runState: oldState })],
        });
        expect(queryClient.getQueryData<Session[]>(key)?.[0].runState).toBe(oldState);
      } finally {
        queryClient.clear();
      }
    },
  );

  it("keeps the latest event even when the status changes back during a fetch", async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.sessions({ includeArchived: false });
    queryClient.setQueryData(key, [createSession({ runState: "idle" })]);
    const response = createDeferred<Session[]>();
    const pending = queryClient.fetchQuery({ queryKey: key, queryFn: () => response.promise });
    try {
      patchSessionQueryData(queryClient, ["session-1"], { runState: "busy", intentText: "Working" });
      patchSessionQueryData(queryClient, ["session-1"], { runState: "idle", intentText: null });
      response.resolve([createSession({ runState: "busy", intentText: "Old intent" })]);
      await pending;
      expect(queryClient.getQueryData(key)).toMatchObject([{ runState: "idle", intentText: null }]);
    } finally {
      queryClient.clear();
    }
  });

  it.each([false, true])("keeps patches scoped to the fetch they overlapped (new event: %s)", async (newEvent) => {
    const queryClient = new QueryClient();
    const key = queryKeys.sessions({ includeArchived: false });
    queryClient.setQueryData(key, [createSession({ runState: "idle" })]);
    const oldResponse = createDeferred<Session[]>();
    const newResponse = createDeferred<Session[]>();
    let reads = 0;
    const first = queryClient.fetchQuery({
      queryKey: key,
      queryFn: () => reads++ === 0 ? oldResponse.promise : newResponse.promise,
    });
    try {
      patchSessionQueryData(queryClient, ["session-1"], { runState: "busy", intentText: "Old intent" });
      const replacement = queryClient.refetchQueries({ queryKey: key, exact: true });
      if (newEvent) patchSessionQueryData(queryClient, ["session-1"], { runState: "stalled" });
      newResponse.resolve([createSession({ runState: "idle", intentText: "Fresh intent" })]);
      oldResponse.resolve([createSession({ runState: "idle", intentText: "Old response" })]);
      await Promise.all([first, replacement]);
      expect(queryClient.getQueryData(key)).toMatchObject([{
        runState: newEvent ? "stalled" : "idle",
        intentText: "Fresh intent",
      }]);
      expect(queryClient.getQueryCache().hasListeners()).toBe(false);
    } finally {
      queryClient.clear();
    }
  });

  it("keeps live status on an initial load before the session is cached", async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.sessions({ includeArchived: false });
    const response = createDeferred<Session[]>();
    const pending = queryClient.fetchQuery({ queryKey: key, queryFn: () => response.promise });
    try {
      patchSessionQueryData(queryClient, ["session-1"], { runState: "busy" });
      response.resolve([createSession({ runState: "idle" })]);
      await pending;
      expect(queryClient.getQueryData(key)).toMatchObject([{ runState: "busy" }]);
    } finally {
      queryClient.clear();
    }
  });

  it("protects both lists without changing a newer archived-list response", async () => {
    const queryClient = new QueryClient();
    const activeKey = queryKeys.sessions({ includeArchived: false });
    const archivedKey = queryKeys.sessions({ includeArchived: true });
    queryClient.setQueryData(activeKey, [createSession({ runState: "idle" })]);
    queryClient.setQueryData(archivedKey, [createSession({ runState: "idle" })]);
    const response = createDeferred<Session[]>();
    const pending = queryClient.fetchQuery({ queryKey: activeKey, queryFn: () => response.promise });
    try {
      patchSessionQueryData(queryClient, ["session-1"], { runState: "busy" });
      await queryClient.fetchQuery({
        queryKey: archivedKey,
        queryFn: async () => [createSession({ runState: "idle" })],
      });
      response.resolve([createSession({ runState: "idle" })]);
      await pending;
      expect(queryClient.getQueryData(activeKey)).toMatchObject([{ runState: "busy" }]);
      expect(queryClient.getQueryData(archivedKey)).toMatchObject([{ runState: "idle" }]);
    } finally {
      queryClient.clear();
    }
  });

  it("protects earlier archive pages while later pages are being refetched", async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.taskArchivedSessions("task-1");
    const page = (offset: number, session: Session): TaskArchivedSessionsResponse => ({
      sessions: [session], offset, total: 2,
    });
    queryClient.setQueryData<InfiniteData<TaskArchivedSessionsResponse>>(key, {
      pages: [
        page(0, createSession({ runState: "idle" })),
        page(1, createSession({ sessionId: "other", runState: "idle" })),
      ],
      pageParams: [0, 1],
    });
    const lastPage = createDeferred<TaskArchivedSessionsResponse>();
    const readingLastPage = createDeferred<void>();
    const pending = queryClient.fetchInfiniteQuery({
      queryKey: key,
      initialPageParam: 0,
      queryFn: async ({ pageParam }) => {
        if (pageParam === 0) return page(0, createSession({ runState: "idle", summary: "Fresh title" }));
        readingLastPage.resolve();
        return lastPage.promise;
      },
      getNextPageParam: (last: TaskArchivedSessionsResponse) => last.offset === 0 ? 1 : undefined,
    });
    try {
      await readingLastPage.promise;
      patchSessionQueryData(queryClient, ["session-1"], { runState: "busy" });
      lastPage.resolve(page(1, createSession({ sessionId: "other", summary: "Other fresh title" })));
      await pending;
      expect(queryClient.getQueryData<InfiniteData<TaskArchivedSessionsResponse>>(key)).toMatchObject({
        pages: [
          { sessions: [{ runState: "busy", summary: "Fresh title" }], total: 2, offset: 0 },
          { sessions: [{ sessionId: "other", summary: "Other fresh title" }], total: 2, offset: 1 },
        ],
        pageParams: [0, 1],
      });
      expect(queryClient.getQueryCache().hasListeners()).toBe(false);
    } finally {
      queryClient.clear();
    }
  });

  it("cleans up a failed fetch without hiding its error or pinning later responses", async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.sessions({ includeArchived: false });
    queryClient.setQueryData(key, [createSession({ runState: "idle" })]);
    const response = createDeferred<Session[]>();
    const pending = queryClient.fetchQuery({
      queryKey: key, queryFn: () => response.promise, retry: false,
    });
    try {
      patchSessionQueryData(queryClient, ["session-1"], { runState: "busy" });
      response.reject(new Error("List unavailable"));
      await expect(pending).rejects.toThrow("List unavailable");
      expect(queryClient.getQueryState(key)?.status).toBe("error");
      expect(queryClient.getQueryData(key)).toMatchObject([{ runState: "busy" }]);
      expect(queryClient.getQueryCache().hasListeners()).toBe(false);
      await queryClient.fetchQuery({
        queryKey: key, queryFn: async () => [createSession({ runState: "idle" })],
      });
      expect(queryClient.getQueryData(key)).toMatchObject([{ runState: "idle" }]);
    } finally {
      queryClient.clear();
    }
  });

  it("cleans up when an in-flight query is removed without recreating it", async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.sessions({ includeArchived: false });
    const response = createDeferred<Session[]>();
    const pending = queryClient.fetchQuery({ queryKey: key, queryFn: () => response.promise });
    patchSessionQueryData(queryClient, ["session-1"], { runState: "busy" });
    queryClient.removeQueries({ queryKey: key, exact: true });
    response.resolve([createSession({ runState: "idle" })]);
    expect(await pending.then(() => false, isCancelledError)).toBe(true);
    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(queryClient.getQueryCache().hasListeners()).toBe(false);
    queryClient.clear();
  });

  it("updates defer summaries across session caches including cleared summaries", () => {
    const queryClient = new QueryClient();
    const activeQueryKey = queryKeys.sessions({ includeArchived: false });
    const archivedQueryKey = queryKeys.sessions({ includeArchived: true });
    const pendingSummary = { count: 2, runningCount: 0, nextRunAt: "2030-01-01T00:00:00.000Z" };
    const otherSummary = { count: 1, runningCount: 0, nextRunAt: "2030-01-02T00:00:00.000Z" };
    const clearedSummary = { count: 0, runningCount: 0, nextRunAt: null };

    queryClient.setQueryData<Session[]>(activeQueryKey, [
      createSession({ sessionId: "session-1", deferSummary: pendingSummary }),
      createSession({ sessionId: "session-2", deferSummary: otherSummary }),
    ]);
    queryClient.setQueryData<Session[]>(archivedQueryKey, [
      createSession({ sessionId: "session-1", archived: true, deferSummary: pendingSummary }),
    ]);

    patchSessionQueryData(queryClient, ["session-1"], { deferSummary: clearedSummary });

    expect(queryClient.getQueryData<Session[]>(activeQueryKey)).toMatchObject([
      { sessionId: "session-1", deferSummary: clearedSummary },
      { sessionId: "session-2", deferSummary: otherSummary },
    ]);
    expect(queryClient.getQueryData<Session[]>(archivedQueryKey)).toMatchObject([
      { sessionId: "session-1", deferSummary: clearedSummary },
    ]);
  });
});
