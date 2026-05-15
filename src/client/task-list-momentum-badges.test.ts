import { describe, expect, it, vi } from "vitest";
import type { Task } from "./api";
import { getTaskListMomentumBadges } from "./components/task-list/SortableTaskItem";

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
    createdAt: "2026-04-24T20:00:00.000Z",
    updatedAt: "2026-04-24T20:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

describe("getTaskListMomentumBadges", () => {
  it("shows a follow-up badge when the follow-up is due", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const badges = getTaskListMomentumBadges(makeTask({ nextTouchAt: "2026-05-01T11:00:00.000Z" }));
      expect(badges.map((badge) => badge.label)).toEqual(["Follow up"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a needs decision badge when the task has no actionable momentum fields", () => {
    const badges = getTaskListMomentumBadges(makeTask());
    expect(badges.map((badge) => badge.label)).toEqual(["Needs decision"]);
  });

  it("does not show a waiting badge for blocked tasks in the rail list", () => {
    const badges = getTaskListMomentumBadges(makeTask({ waitingOn: "Design feedback" }));
    expect(badges).toEqual([]);
  });
});
