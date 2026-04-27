import { describe, expect, it } from "vitest";
import type { Session } from "../../api";
import { mergeOptimisticSessions } from "./useSessions";

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
