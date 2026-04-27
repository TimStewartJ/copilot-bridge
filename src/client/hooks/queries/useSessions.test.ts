import { describe, expect, it } from "vitest";
import type { Session } from "../../api";
import { mergeActiveAndArchivedSessions, mergeOptimisticSessions } from "./useSessions";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    summary: "Session",
    modifiedTime: "2026-04-27T18:00:00.000Z",
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
