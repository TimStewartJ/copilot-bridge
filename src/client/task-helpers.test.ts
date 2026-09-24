import { describe, expect, it } from "vitest";
import type { Task } from "./api";
import { isSetAsideTask, mergeVisibleOrder } from "./task-helpers";

const task = (id: string, order: number, extra: Partial<Task> = {}): Task => ({
  id, title: id, kind: "task", muted: false, deferred: false, status: "active", notes: "", priority: 0, order,
  createdAt: "", updatedAt: "", sessionIds: [], workItems: [], pullRequests: [], ...extra,
});

describe("sidebar ordering around set-aside tasks", () => {
  it("keeps hidden tasks in their slots when the visible tasks are reordered", () => {
    const tasks = [task("a", 0), task("hidden", 1, { deferred: true }), task("b", 2), task("c", 3)];
    expect(mergeVisibleOrder(tasks, new Set(["hidden"]), ["c", "a", "b"])).toEqual(["c", "hidden", "a", "b"]);
  });
  it("returns every active task exactly once, so resuming a task never collides with another's position", () => {
    const tasks = [task("m", 0, { muted: true }), task("a", 1), task("b", 2), task("d", 3, { deferred: true })];
    const merged = mergeVisibleOrder(tasks, new Set(["m", "d"]), ["b", "a"]);
    expect(merged).toEqual(["m", "b", "a", "d"]);
    expect(new Set(merged).size).toBe(tasks.length);
  });
  it("passes the order through untouched when nothing is hidden", () => {
    expect(mergeVisibleOrder([task("a", 0), task("b", 1)], new Set(), ["b", "a"])).toEqual(["b", "a"]);
  });
  it("sets aside deferred and muted active tasks only", () => {
    expect(isSetAsideTask(task("x", 0, { deferred: true }))).toBe(true);
    expect(isSetAsideTask(task("x", 0, { muted: true }))).toBe(true);
    expect(isSetAsideTask(task("x", 0, { muted: true, status: "archived" }))).toBe(false);
    expect(isSetAsideTask(task("x", 0))).toBe(false);
  });
  it("leaves hidden tasks in other groups alone when one group is reordered", () => {
    const tasks = [task("a", 0, { groupId: "A" }), task("b", 1, { groupId: "B" }), task("hidden", 2, { groupId: "B", deferred: true }), task("c", 3, { groupId: "B" })];
    expect(mergeVisibleOrder(tasks, new Set(["hidden"]), ["a"])).toEqual(["a"]);
    expect(mergeVisibleOrder(tasks, new Set(["hidden"]), ["c", "b"])).toEqual(["c", "hidden", "b"]);
  });
  it("uses the destination group's hidden tasks when a task moves between groups", () => {
    const tasks = [task("a", 0, { groupId: "A" }), task("hiddenA", 1, { groupId: "A", muted: true }), task("b", 2, { groupId: "B" }), task("hiddenB", 3, { groupId: "B", deferred: true })];
    expect(mergeVisibleOrder(tasks, new Set(["hiddenA", "hiddenB"]), ["a", "b"], "B")).toEqual(["a", "b", "hiddenB"]);
    expect(mergeVisibleOrder(tasks, new Set(["hiddenA", "hiddenB"]), ["b", "a"], null)).toEqual(["b", "a"]);
  });
});
