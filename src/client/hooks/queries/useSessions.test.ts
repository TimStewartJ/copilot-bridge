import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Session } from "../../api";
import { queryKeys } from "../../queryClient";
import { mergeActiveAndArchivedSessions, mergeOptimisticSessions, patchSessionQueryData } from "./useSessions";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    summary: "Session",
    modifiedTime: "2026-04-27T18:00:00.000Z",
    deferSummary: { count: 0, nextRunAt: null },
    ...overrides,
  };
}

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
  it("updates defer summaries across session caches including cleared summaries", () => {
    const queryClient = new QueryClient();
    const activeQueryKey = queryKeys.sessions({ includeArchived: false });
    const archivedQueryKey = queryKeys.sessions({ includeArchived: true });
    const pendingSummary = { count: 2, nextRunAt: "2030-01-01T00:00:00.000Z" };
    const otherSummary = { count: 1, nextRunAt: "2030-01-02T00:00:00.000Z" };
    const clearedSummary = { count: 0, nextRunAt: null };

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
