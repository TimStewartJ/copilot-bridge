import { describe, expect, it } from "vitest";
import type { Session, Task } from "../api";
import {
  countTaskUnread,
  describeTabAttention,
  getTaskIndicator,
  summarizeChatTabAttention,
  summarizeTaskTabAttention,
  type TaskIndicator,
} from "./useTaskIndicators";

const NOW = "2026-04-17T15:00:00.000Z";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    kind: "task",
    muted: false,
    status: "active",
    notes: "",
    priority: 0,
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
    deferSummary: { count: 0, nextRunAt: null },
    ...overrides,
  };
}

function createIndicator(overrides: Partial<TaskIndicator> = {}): TaskIndicator {
  return {
    busy: false,
    stalled: false,
    unread: false,
    busyCount: 0,
    unreadCount: 0,
    needsUserInputCount: 0,
    lastActivity: NOW,
    ...overrides,
  };
}

describe("summarizeTaskTabAttention", () => {
  it("counts each non-archived, unmuted task once and tracks needs-answer tasks", () => {
    const tasks = [
      createTask({ id: "task-unread" }),
      createTask({ id: "task-needs-answer" }),
      createTask({ id: "task-both" }),
      createTask({ id: "task-read" }),
      createTask({ id: "task-muted", muted: true }),
      createTask({ id: "task-archived", status: "archived" }),
    ];
    const indicators = new Map<string, TaskIndicator>([
      ["task-unread", createIndicator({ unread: true, unreadCount: 1 })],
      ["task-needs-answer", createIndicator({ unread: true, needsUserInputCount: 2 })],
      ["task-both", createIndicator({ unread: true, unreadCount: 1, needsUserInputCount: 1 })],
      ["task-read", createIndicator()],
      ["task-muted", createIndicator({ unreadCount: 1, needsUserInputCount: 1 })],
      ["task-archived", createIndicator({ unreadCount: 1, needsUserInputCount: 1 })],
    ]);

    expect(summarizeTaskTabAttention(tasks, indicators)).toEqual({
      count: 3,
      needsUserInputCount: 2,
    });
  });

  it("does not double-count a task with unread and needs-answer sessions", () => {
    const task = createTask({
      sessionIds: ["unread-session", "needs-answer-session"],
    });
    const sessionMap = new Map<string, Session>([
      ["unread-session", createSession({ sessionId: "unread-session" })],
      ["needs-answer-session", createSession({
        sessionId: "needs-answer-session",
        busy: true,
        runState: "busy",
        needsUserInput: true,
      })],
    ]);
    const indicator = getTaskIndicator(
      task,
      sessionMap,
      (sessionId) => sessionId === "unread-session",
    );

    expect(summarizeTaskTabAttention(
      [task],
      new Map([[task.id, indicator]]),
    )).toEqual({
      count: 1,
      needsUserInputCount: 1,
    });
  });
});

describe("summarizeChatTabAttention", () => {
  it("counts unread or needs-answer chats once while preserving attention exclusions", () => {
    const sessions = [
      createSession({ sessionId: "chat-unread" }),
      createSession({
        sessionId: "chat-needs-answer",
        busy: true,
        runState: "busy",
        needsUserInput: true,
      }),
      createSession({
        sessionId: "chat-both",
        needsUserInput: true,
      }),
      createSession({ sessionId: "chat-busy", busy: true, runState: "busy" }),
      createSession({ sessionId: "chat-current" }),
      createSession({
        sessionId: "chat-archived",
        archived: true,
        needsUserInput: true,
      }),
      createSession({ sessionId: "chat-read" }),
    ];

    const isUnread = (sessionId: string) => ![
      "chat-needs-answer",
      "chat-read",
    ].includes(sessionId);

    expect(summarizeChatTabAttention(
      sessions,
      isUnread,
      "chat-current",
    )).toEqual({
      count: 3,
      needsUserInputCount: 2,
    });
  });

  it("checks the latest visible activity timestamp", () => {
    const session = createSession({
      sessionId: "chat-visible-activity",
      modifiedTime: "2026-04-17T14:00:00.000Z",
      lastVisibleActivityAt: "2026-04-17T16:00:00.000Z",
    });

    expect(summarizeChatTabAttention([session], (_sessionId: string, modifiedTime?: string) => {
      return modifiedTime === "2026-04-17T16:00:00.000Z";
    })).toEqual({
      count: 1,
      needsUserInputCount: 0,
    });
  });
});

describe("describeTabAttention", () => {
  it("distinguishes total attention from needs-answer counts", () => {
    expect(describeTabAttention(
      { count: 3, needsUserInputCount: 1 },
      "task",
      "tasks",
    )).toBe("3 tasks need attention; 1 needs an answer");
    expect(describeTabAttention(
      { count: 1, needsUserInputCount: 0 },
      "chat",
      "chats",
    )).toBe("1 chat needs attention");
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

  it("keeps pending user input out of mark-read counts", () => {
    const task = createTask({ sessionIds: ["needs-answer"] });
    const sessionMap = new Map<string, Session>([
      ["needs-answer", createSession({
        sessionId: "needs-answer",
        runState: "busy",
        busy: true,
        needsUserInput: true,
        pendingUserInputCount: 1,
      })],
    ]);

    const unread = countTaskUnread(task, sessionMap, () => false, "needs-answer");

    expect(unread).toBe(0);
  });
});

describe("getTaskIndicator", () => {
  it("marks a task unread when any linked session needs user input", () => {
    const task = createTask({ sessionIds: ["needs-answer"] });
    const sessionMap = new Map<string, Session>([
      ["needs-answer", createSession({
        sessionId: "needs-answer",
        runState: "busy",
        busy: true,
        needsUserInput: true,
        pendingUserInputCount: 1,
      })],
    ]);

    const indicator = getTaskIndicator(task, sessionMap, () => false, "needs-answer");

    expect(indicator).toMatchObject({
      busy: true,
      unread: true,
      unreadCount: 0,
      needsUserInputCount: 1,
    });
  });

  it("keeps unread counts but suppresses the task-level unread indicator for muted tasks", () => {
    const task = createTask({ muted: true, sessionIds: ["unread-1"] });
    const sessionMap = new Map<string, Session>([
      ["unread-1", createSession({ sessionId: "unread-1" })],
    ]);

    const indicator = getTaskIndicator(task, sessionMap, () => true);

    expect(indicator).toMatchObject({
      unread: false,
      unreadCount: 1,
    });
  });
});
