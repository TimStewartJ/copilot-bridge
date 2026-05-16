import { describe, expect, it } from "vitest";
import type { Session, Task } from "../api";
import { getQuickChatSessions } from "./quick-chat-sessions";

function createSession(overrides: Partial<Session> & { sessionId: string }): Session {
  return {
    summary: "Session",
    deferSummary: { count: 0, nextRunAt: null },
    ...overrides,
  };
}

function createTaskSessionIndex(...sessionIds: string[]): Pick<Task, "sessionIds"> {
  return { sessionIds };
}

describe("getQuickChatSessions", () => {
  it("hides sessions linked by server session metadata when tasks are stale", () => {
    const sessions = [
      createSession({ sessionId: "scheduled-session", linkedTaskIds: ["task-1"] }),
      createSession({ sessionId: "quick-chat", linkedTaskIds: [] }),
    ];

    expect(getQuickChatSessions(sessions, [createTaskSessionIndex()]).map((session) => session.sessionId))
      .toEqual(["quick-chat"]);
  });

  it("hides sessions linked by task cache when session metadata is stale", () => {
    const sessions = [
      createSession({ sessionId: "moved-session", linkedTaskIds: [] }),
      createSession({ sessionId: "quick-chat", linkedTaskIds: [] }),
    ];

    expect(getQuickChatSessions(sessions, [createTaskSessionIndex("moved-session")]).map((session) => session.sessionId))
      .toEqual(["quick-chat"]);
  });

  it("keeps optimistic sessions without linkage metadata in quick chats", () => {
    const sessions = [
      createSession({ sessionId: "optimistic-session", isOptimistic: true }),
      createSession({ sessionId: "linked-session", linkedTaskIds: ["task-1"] }),
    ];

    expect(getQuickChatSessions(sessions, []).map((session) => session.sessionId))
      .toEqual(["optimistic-session"]);
  });
});
