import { describe, expect, it } from "vitest";
import type { Task } from "./api";
import type { TaskIndicator } from "./hooks/useTaskIndicators";
import { getTaskRowSignals, shouldShowTaskRowUnreadDot } from "./task-row-signals";

const NOW = new Date("2026-05-01T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Example task",
    kind: "task",
    muted: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

function makeIndicator(overrides: Partial<TaskIndicator> = {}): TaskIndicator {
  return {
    busy: false,
    stalled: false,
    unread: false,
    busyCount: 0,
    unreadCount: 0,
    needsUserInputCount: 0,
    lastActivity: NOW_ISO,
    ...overrides,
  };
}

describe("getTaskRowSignals", () => {
  it("keeps muted tasks quiet even when their sessions are busy or need an answer", () => {
    const signals = getTaskRowSignals(
      makeTask({ muted: true }),
      makeIndicator({
        busy: true,
        stalled: true,
        unread: false,
        busyCount: 2,
        unreadCount: 1,
        needsUserInputCount: 1,
      }),
      NOW,
    );

    expect(signals).toEqual([]);
  });

  it("prioritizes answer-needed above stalled and unread states", () => {
    const signals = getTaskRowSignals(
      makeTask(),
      makeIndicator({
        busy: true,
        stalled: true,
        unread: true,
        busyCount: 1,
        unreadCount: 2,
        needsUserInputCount: 1,
      }),
      NOW,
    );

    expect(signals.map((signal) => signal.kind)).toEqual([
      "needs-input",
      "stalled",
      "needs-decision",
      "unread",
    ]);
  });

  it("keeps unread as a secondary state when work is currently running", () => {
    const signals = getTaskRowSignals(
      makeTask({ nextAction: "Review the result" }),
      makeIndicator({
        busy: true,
        unread: true,
        busyCount: 2,
        unreadCount: 1,
      }),
      NOW,
    );

    expect(signals.map((signal) => signal.kind)).toEqual(["busy", "unread"]);
    expect(signals[0]?.shortLabel).toBe("2 working");
  });

  it("distinguishes overdue and due-today follow-ups", () => {
    expect(getTaskRowSignals(
      makeTask({ nextTouchAt: "2026-04-30T12:00:00.000Z" }),
      undefined,
      NOW,
    )[0]?.kind).toBe("follow-up-overdue");

    expect(getTaskRowSignals(
      makeTask({ nextTouchAt: "2026-05-01T09:00:00.000Z" }),
      undefined,
      NOW,
    )[0]?.kind).toBe("follow-up-due");
  });

  it("preserves the deliberate choice not to badge waiting tasks", () => {
    const signals = getTaskRowSignals(
      makeTask({ waitingOn: "Design feedback" }),
      undefined,
      NOW,
    );

    expect(signals).toEqual([]);
  });

  it("shows lifecycle state without active-task noise", () => {
    expect(getTaskRowSignals(
      makeTask({
        completedAt: "2026-05-01T10:00:00.000Z",
        nextTouchAt: "2026-04-30T12:00:00.000Z",
      }),
      makeIndicator({ unread: true, unreadCount: 1 }),
      NOW,
    ).map((signal) => signal.kind)).toEqual(["completed"]);

    expect(getTaskRowSignals(
      makeTask({ status: "archived" }),
      makeIndicator({ busy: true, unread: true, busyCount: 1, unreadCount: 1 }),
      NOW,
    ).map((signal) => signal.kind)).toEqual(["archived"]);
  });

  it("handles a missing indicator and retains needs-decision behavior", () => {
    expect(getTaskRowSignals(makeTask(), undefined, NOW)[0]?.kind).toBe("needs-decision");
  });

  it("shows the supporting unread dot only for active tasks with actual new results", () => {
    const task = makeTask({ nextAction: "Review results" });
    const busyAndUnread = makeIndicator({
      busy: true,
      unread: true,
      busyCount: 1,
      unreadCount: 1,
    });
    const busySignal = getTaskRowSignals(task, busyAndUnread, NOW)[0];
    expect(shouldShowTaskRowUnreadDot(task, busyAndUnread, busySignal)).toBe(true);

    const answerOnly = makeIndicator({
      busy: true,
      unread: true,
      busyCount: 1,
      unreadCount: 0,
      needsUserInputCount: 1,
    });
    const answerSignal = getTaskRowSignals(task, answerOnly, NOW)[0];
    expect(shouldShowTaskRowUnreadDot(task, answerOnly, answerSignal)).toBe(false);

    const completedTask = makeTask({ completedAt: NOW_ISO });
    const completedSignal = getTaskRowSignals(completedTask, busyAndUnread, NOW)[0];
    expect(shouldShowTaskRowUnreadDot(completedTask, busyAndUnread, completedSignal)).toBe(false);
  });
});
