import { describe, expect, it } from "vitest";
import { getTaskKindLabel, getTaskKindUpdate, isOngoingTask } from "./task-kind";

describe("getTaskKindUpdate", () => {
  it("clears doneWhen when switching to ongoing", () => {
    expect(
      getTaskKindUpdate({ kind: "task", status: "active", doneWhen: "Ship it" }, "ongoing"),
    ).toEqual({
      kind: "ongoing",
      doneWhen: null,
    });
  });

  it("reopens done tasks when switching to ongoing", () => {
    expect(
      getTaskKindUpdate({ kind: "task", status: "done", doneWhen: "Merged" }, "ongoing"),
    ).toEqual({
      kind: "ongoing",
      status: "active",
      doneWhen: null,
    });
  });

  it("returns null when nothing changes", () => {
    expect(
      getTaskKindUpdate({ kind: "ongoing", status: "active", doneWhen: undefined }, "ongoing"),
    ).toBeNull();
  });

  it("switches ongoing items back to task without changing status", () => {
    expect(
      getTaskKindUpdate({ kind: "ongoing", status: "active", doneWhen: undefined }, "task"),
    ).toEqual({
      kind: "task",
    });
  });
});

describe("task kind helpers", () => {
  it("labels task kinds for the UI", () => {
    expect(getTaskKindLabel("task")).toBe("Task");
    expect(getTaskKindLabel("ongoing")).toBe("Ongoing");
  });

  it("detects ongoing tasks", () => {
    expect(isOngoingTask({ kind: "ongoing" })).toBe(true);
    expect(isOngoingTask({ kind: "task" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// task helpers (merged from task-helpers.test.ts)
// ---------------------------------------------------------------------------
import type { Task, TaskGroup } from "./api";
import { buildGroupSections, sortTasksByStatusAndOrder } from "./task-helpers";

const NOW_HELPERS = "2026-05-01T12:00:00.000Z";

function createTaskHelper(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    kind: "task",
    muted: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: NOW_HELPERS,
    updatedAt: NOW_HELPERS,
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

function createGroupHelper(overrides: Partial<TaskGroup> = {}): TaskGroup {
  return {
    id: "group-1",
    name: "Group",
    color: "blue",
    notes: "",
    order: 0,
    collapsed: false,
    createdAt: NOW_HELPERS,
    updatedAt: NOW_HELPERS,
    ...overrides,
  };
}

describe("task helpers", () => {
  it("sorts ongoing tasks above normal tasks within each status", () => {
    const tasks = [
      createTaskHelper({ id: "normal-old", order: 0 }),
      createTaskHelper({ id: "ongoing-newer", kind: "ongoing", order: 4 }),
      createTaskHelper({ id: "done-normal", status: "done", order: 0 }),
      createTaskHelper({ id: "normal-new", order: 1 }),
    ];

    expect(sortTasksByStatusAndOrder(tasks).map((task) => task.id)).toEqual([
      "ongoing-newer",
      "normal-old",
      "normal-new",
      "done-normal",
    ]);
  });

  it("floats ongoing tasks to the top of grouped sections", () => {
    const group = createGroupHelper();
    const tasks = [
      createTaskHelper({ id: "normal-active", groupId: group.id, order: 0 }),
      createTaskHelper({ id: "ongoing-active", kind: "ongoing", groupId: group.id, order: 2 }),
    ];

    const sections = buildGroupSections(tasks, [group]);

    expect(sections[0].tasks.map((task) => task.id)).toEqual([
      "ongoing-active",
      "normal-active",
    ]);
  });
});
