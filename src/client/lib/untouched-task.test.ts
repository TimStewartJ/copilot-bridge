import { describe, expect, it } from "vitest";
import type { Task } from "../api";
import { looksUntouched } from "./untouched-task";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "New Task",
    kind: "task",
    muted: false,
    deferred: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
    activeSessionIds: [],
    sessionCount: 0,
    archivedSessionCount: 0,
    sessionLinksRevision: "rev",
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

describe("looksUntouched", () => {
  it("accepts a task exactly as it was created", () => {
    expect(looksUntouched(createTask())).toBe(true);
  });

  it.each<[string, Partial<Task>]>([
    ["was edited", { updatedAt: "2026-10-07T10:05:00.000Z" }],
    ["has a session, even an archived one", { sessionCount: 1, archivedSessionCount: 1 }],
    ["has a work item", { workItems: [{ id: "123", provider: "ado" }] }],
    ["has a pull request", { pullRequests: [{ repoId: "repo", prId: 7, provider: "ado" }] }],
    ["has a tag", { tags: [{ id: "tag-1", name: "release" } as NonNullable<Task["tags"]>[number]] }],
    ["is archived", { status: "archived" }],
  ])("rejects a task that %s", (_label, overrides) => {
    expect(looksUntouched(createTask(overrides))).toBe(false);
  });
});
