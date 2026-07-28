import { describe, expect, it } from "vitest";
import type { Session, Task } from "../api";
import {
  getSessionPath,
  getTaskActiveChatSessionId,
  getTaskChatPath,
  getTaskDraftSessionPath,
} from "./session-path";

function task(sessionIds: string[]): Pick<Task, "id" | "sessionIds"> {
  return {
    id: "task-123",
    sessionIds,
  };
}

function session(
  sessionId: string,
  activityTime: string,
  opts: Pick<Session, "archived"> = {},
): Session {
  return {
    sessionId,
    summary: sessionId,
    lastVisibleActivityAt: activityTime,
    deferSummary: { count: 0, nextRunAt: null },
    ...opts,
  };
}

describe("getSessionPath", () => {
  it("uses the task session route when task context is present, quick chat route otherwise", () => {
    expect(getSessionPath({ sessionId: "session-456", taskId: "task-123" })).toBe(
      "/tasks/task-123/sessions/session-456",
    );
    expect(getSessionPath({ sessionId: "session-456", taskId: null })).toBe("/sessions/session-456");
    expect(getSessionPath({ sessionId: "session-456" })).toBe("/sessions/session-456");
  });
});

describe("task chat navigation", () => {
  it("uses the draft task chat route when there are no linked sessions", () => {
    const target = { task: task([]), sessions: [] };

    expect(getTaskActiveChatSessionId(target)).toBeNull();
    expect(getTaskDraftSessionPath("task-123")).toBe("/tasks/task-123/sessions/new");
    expect(getTaskChatPath(target)).toBe("/tasks/task-123/sessions/new");
  });

  it("prefers a valid active last-viewed linked session", () => {
    const target = {
      task: task(["older", "newer"]),
      sessions: [
        session("older", "2026-04-28T10:00:00.000Z"),
        session("newer", "2026-04-28T11:00:00.000Z"),
      ],
      lastViewedSessionId: "older",
    };

    expect(getTaskActiveChatSessionId(target)).toBe("older");
    expect(getTaskChatPath(target)).toBe("/tasks/task-123/sessions/older");
  });

  it("falls back to the most recent active linked session", () => {
    const target = {
      task: task(["older", "newer"]),
      sessions: [
        session("newer", "2026-04-28T11:00:00.000Z"),
        session("older", "2026-04-28T10:00:00.000Z"),
      ],
      lastViewedSessionId: null,
    };

    expect(getTaskActiveChatSessionId(target)).toBe("newer");
    expect(getTaskChatPath(target)).toBe("/tasks/task-123/sessions/newer");
  });

  it("ignores archived linked sessions when choosing the default chat", () => {
    const target = {
      task: task(["archived"]),
      sessions: [
        session("archived", "2026-04-28T11:00:00.000Z", { archived: true }),
      ],
      lastViewedSessionId: "archived",
    };

    expect(getTaskActiveChatSessionId(target)).toBeNull();
    expect(getTaskChatPath(target)).toBe("/tasks/task-123/sessions/new");
  });

  it("ignores stale last-viewed and missing linked sessions", () => {
    const target = {
      task: task(["missing", "active"]),
      sessions: [
        session("active", "2026-04-28T11:00:00.000Z"),
      ],
      lastViewedSessionId: "missing",
    };

    expect(getTaskActiveChatSessionId(target)).toBe("active");
    expect(getTaskChatPath(target)).toBe("/tasks/task-123/sessions/active");
  });
});

// ---------------------------------------------------------------------------
// composer key helpers (merged from composer-key.test.ts)
// ---------------------------------------------------------------------------
import {
  getComposerKeyFromPathname,
  getDraftComposerKey,
  getTaskIdFromDraftComposerKey,
  isDraftComposerKey,
} from "./composer-key";

describe("composer key helpers", () => {
  it("builds, detects, parses, and derives draft keys from routes in one round-trip", () => {
    expect(getDraftComposerKey()).toBe("draft:quickchat");
    expect(getDraftComposerKey("task-123")).toBe("draft:task:task-123");

    expect(isDraftComposerKey("draft:quickchat")).toBe(true);
    expect(isDraftComposerKey("draft:task:task-123")).toBe(true);
    expect(isDraftComposerKey("session-123")).toBe(false);
    expect(getTaskIdFromDraftComposerKey("draft:task:task-123")).toBe("task-123");
    expect(getTaskIdFromDraftComposerKey("draft:quickchat")).toBeUndefined();

    expect(getComposerKeyFromPathname("/sessions/new")).toBe("draft:quickchat");
    expect(getComposerKeyFromPathname("/tasks/task-123/sessions/new")).toBe("draft:task:task-123");
    expect(getComposerKeyFromPathname("/sessions/session-123")).toBe("session-123");
    expect(getComposerKeyFromPathname("/tasks/task-123/sessions/session-456")).toBe("session-456");
    expect(getComposerKeyFromPathname("/tasks/task-123")).toBeNull();
  });
});
