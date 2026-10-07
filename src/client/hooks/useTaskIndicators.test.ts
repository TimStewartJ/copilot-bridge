import { describe, expect, it } from "vitest";
import type { Session, Task } from "../api";
import {
  countUnreadTasks,
  unreadTasksLabel,
  countTaskUnread,
  describeTabAttention,
  getArchivedActivityByTask,
  getTaskIndicator,
  summarizeChatTabAttention,
  summarizeTaskTabAttention,
  type TaskIndicator,
} from "./useTaskIndicators";
import { getTaskStatus } from "../task-row-signals";

const NOW = "2026-04-17T15:00:00.000Z";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    kind: "task",
    muted: false,
    deferred: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
    activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0",
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
    archived: false,
    diskSizeBytes: 0,
    deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
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
  it("counts each unmuted task once, archived ones too, and tracks needs-answer tasks", () => {
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

    // Archiving a task marks its conversations read, so what is unread there arrived afterwards.
    expect(summarizeTaskTabAttention(tasks, indicators)).toEqual({
      count: 4,
      needsUserInputCount: 3,
    });
    expect(countUnreadTasks(tasks, indicators)).toBe(3);
    expect(unreadTasksLabel(3)).toBe("3 unread");
  });

  it("does not double-count a task with unread and needs-answer sessions", () => {
    const task = createTask({
      activeSessionIds: ["unread-session", "needs-answer-session"],
    });
    const sessionMap = new Map<string, Session>([
      ["unread-session", createSession({ sessionId: "unread-session" })],
      ["needs-answer-session", createSession({
        sessionId: "needs-answer-session",
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
        runState: "busy",
        needsUserInput: true,
      }),
      createSession({
        sessionId: "chat-both",
        needsUserInput: true,
      }),
      createSession({ sessionId: "chat-busy", runState: "busy" }),
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
    const task = createTask({ activeSessionIds: ["idle-1", "stalled-1"] });
    const sessionMap = new Map<string, Session>([
      ["idle-1", createSession({ sessionId: "idle-1" })],
      ["stalled-1", createSession({ sessionId: "stalled-1", runState: "stalled" })],
    ]);

    const unread = countTaskUnread(task, sessionMap, (sessionId) => sessionId !== "stalled-1");

    expect(unread).toBe(1);
  });

  it("keeps pending user input out of mark-read counts", () => {
    const task = createTask({ activeSessionIds: ["needs-answer"] });
    const sessionMap = new Map<string, Session>([
      ["needs-answer", createSession({
        sessionId: "needs-answer",
        runState: "busy",
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
    const task = createTask({ activeSessionIds: ["needs-answer"] });
    const sessionMap = new Map<string, Session>([
      ["needs-answer", createSession({
        sessionId: "needs-answer",
        runState: "busy",
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
    const task = createTask({ muted: true, activeSessionIds: ["unread-1"] });
    const sessionMap = new Map<string, Session>([
      ["unread-1", createSession({ sessionId: "unread-1" })],
    ]);

    const indicator = getTaskIndicator(task, sessionMap, () => true);

    expect(indicator).toMatchObject({
      unread: false,
      unreadCount: 1,
    });
  });

  describe("getTaskStatus", () => {
    it("gives an answer needed precedence over stalled, working and unread states", () => {
      expect(getTaskStatus(createIndicator({
        busy: true,
        stalled: true,
        needsUserInputCount: 1,
        unreadCount: 2,
      }))).toEqual({ kind: "needs-input", label: "Answer needed" });
      expect(getTaskStatus(createIndicator({ busy: true, stalled: true })))
        .toEqual({ kind: "warning", label: "Stalled" });
      expect(getTaskStatus(createIndicator({ unreadCount: 1 })))
        .toEqual({ kind: "unread", label: "Unread conversations" });
      expect(getTaskStatus(createIndicator({ busy: true })))
        .toEqual({ kind: "working", label: "Agent working" });
      expect(getTaskStatus(createIndicator())).toBeNull();
    });

    it("shows unread results and a working agent as one state, without hiding either", () => {
      expect(getTaskStatus(createIndicator({ busy: true, unreadCount: 1 })))
        .toEqual({ kind: "unread-working", label: "Unread conversations, agent working" });
      expect(getTaskStatus(createIndicator({ busy: true, stalled: true, unreadCount: 1 })))
        .toEqual({ kind: "warning", label: "Stalled" });
    });
  });
});

describe("archived session activity", () => {
  it("counts loaded archived sessions through their own links, since tasks list only active ones", () => {
    const task = createTask({ updatedAt: "2026-04-17T10:00:00.000Z" });
    const archived = createSession({
      sessionId: "archived-run",
      archived: true,
      linkedTaskIds: ["task-1"],
      modifiedTime: "2026-04-17T12:00:00.000Z",
      lastVisibleActivityAt: "2026-04-17T12:00:00.000Z",
    });
    const sessionMap = new Map([[archived.sessionId, archived]]);

    const indicator = getTaskIndicator(task, sessionMap, undefined, null, getArchivedActivityByTask([archived]));

    expect(indicator.lastActivity).toBe("2026-04-17T12:00:00.000Z");
    expect(indicator.unreadCount).toBe(0);
  });
});
