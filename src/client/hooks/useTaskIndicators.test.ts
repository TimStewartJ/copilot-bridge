import { describe, expect, it } from "vitest";
import type { Session, Task } from "../api";
import { countChatTabUnread, countTaskTabUnread, countTaskUnread } from "./useTaskIndicators";

const NOW = "2026-04-17T15:00:00.000Z";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    status: "active",
    notes: "",
    priority: 0,
    pinned: false,
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    modifiedTime: NOW,
    lastVisibleActivityAt: NOW,
    busy: false,
    archived: false,
    diskSizeBytes: 0,
    ...overrides,
  };
}

describe("countTaskTabUnread", () => {
  it("counts only non-archived tasks with unread indicators", () => {
    const tasks = [
      createTask({ id: "task-unread" }),
      createTask({ id: "task-read" }),
      createTask({ id: "task-archived", status: "archived" }),
    ];
    const indicators = new Map([
      ["task-unread", { busy: false, unread: true, busyCount: 0, unreadCount: 1, lastActivity: NOW }],
      ["task-read", { busy: false, unread: false, busyCount: 0, unreadCount: 0, lastActivity: NOW }],
      ["task-archived", { busy: false, unread: true, busyCount: 0, unreadCount: 1, lastActivity: NOW }],
    ]);

    expect(countTaskTabUnread(tasks, indicators)).toBe(1);
  });
});

describe("countChatTabUnread", () => {
  it("counts only idle, non-archived unread orphan sessions", () => {
    const sessions = [
      createSession({ sessionId: "chat-unread" }),
      createSession({ sessionId: "chat-busy", busy: true }),
      createSession({ sessionId: "chat-stalled", runState: "stalled", busy: true }),
      createSession({ sessionId: "chat-archived", archived: true }),
      createSession({ sessionId: "chat-read" }),
    ];

    const isUnread = (sessionId: string) => !["chat-read", "chat-stalled"].includes(sessionId);

    expect(countChatTabUnread(sessions, isUnread)).toBe(1);
  });

  it("checks the latest visible activity timestamp", () => {
    const session = createSession({
      sessionId: "chat-visible-activity",
      modifiedTime: "2026-04-17T14:00:00.000Z",
      lastVisibleActivityAt: "2026-04-17T16:00:00.000Z",
    });

    expect(countChatTabUnread([session], (_sessionId, modifiedTime) => {
      return modifiedTime === "2026-04-17T16:00:00.000Z";
    })).toBe(1);
  });
});


describe("countTaskUnread", () => {
  it("excludes stalled sessions from unread counts", () => {
    const task = createTask({ sessionIds: ["idle-1", "stalled-1"] });
    const sessionMap = new Map<string, Session>([
      ["idle-1", createSession({ sessionId: "idle-1" })],
      ["stalled-1", createSession({ sessionId: "stalled-1", runState: "stalled", busy: true })],
    ]);

    const unread = countTaskUnread(task, sessionMap, (sessionId) => sessionId !== "stalled-1");

    expect(unread).toBe(1);
  });
});
