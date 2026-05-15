import { describe, expect, it } from "vitest";
import type { Task, TaskGroup } from "./api";
import { buildGroupSections, sortTasksByStatusAndOrder } from "./task-helpers";

const NOW = "2026-05-01T12:00:00.000Z";

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

function createGroup(overrides: Partial<TaskGroup> = {}): TaskGroup {
  return {
    id: "group-1",
    name: "Group",
    color: "blue",
    notes: "",
    order: 0,
    collapsed: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("task helpers", () => {
  it("sorts ongoing tasks above normal tasks within each status", () => {
    const tasks = [
      createTask({ id: "normal-old", order: 0 }),
      createTask({ id: "ongoing-newer", kind: "ongoing", order: 4 }),
      createTask({ id: "done-normal", status: "done", order: 0 }),
      createTask({ id: "normal-new", order: 1 }),
    ];

    expect(sortTasksByStatusAndOrder(tasks).map((task) => task.id)).toEqual([
      "ongoing-newer",
      "normal-old",
      "normal-new",
      "done-normal",
    ]);
  });

  it("floats ongoing tasks to the top of grouped sections", () => {
    const group = createGroup();
    const tasks = [
      createTask({ id: "normal-active", groupId: group.id, order: 0 }),
      createTask({ id: "ongoing-active", kind: "ongoing", groupId: group.id, order: 2 }),
    ];

    const sections = buildGroupSections(tasks, [group]);

    expect(sections[0].tasks.map((task) => task.id)).toEqual([
      "ongoing-active",
      "normal-active",
    ]);
  });
});
