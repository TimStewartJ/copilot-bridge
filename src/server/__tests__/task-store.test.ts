import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createTaskStore } from "../task-store.js";
import type { TaskStore } from "../task-store.js";
import type { DatabaseSync } from "../db.js";
import { resolveRuntimePaths } from "../runtime-paths.js";

let db: DatabaseSync;
let store: TaskStore;

beforeEach(() => {
  db = setupTestDb();
  store = createTaskStore(db, createTestBus());
});

describe("task-store", () => {
  describe("CRUD", () => {
    it("listTasks returns empty array when no data", () => {
      expect(store.listTasks()).toEqual([]);
    });

    it("createTask returns a valid task", () => {
      const task = store.createTask("My Task");
      expect(task.id).toBeTruthy();
      expect(task.title).toBe("My Task");
      expect(task.status).toBe("active");
      expect(task.notes).toBe("");
      expect(task.doneWhen).toBeUndefined();
      expect(task.nextAction).toBeUndefined();
      expect(task.waitingOn).toBeUndefined();
      expect(task.nextTouchAt).toBeUndefined();
      expect(task.sessionIds).toEqual([]);
      expect(task.workItems).toEqual([]);
      expect(task.pullRequests).toEqual([]);
    });

    it("defaults task cwd to the demo workspace in demo mode", () => {
      const runtimePaths = resolveRuntimePaths({}, {
        demoMode: true,
        dataDir: join("demo-root"),
      });
      const demoStore = createTaskStore(db, createTestBus(), { runtimePaths });
      const task = demoStore.createTask("Demo Task");
      expect(task.cwd).toBe(runtimePaths.workspaceDir);
    });

    it("getTask returns created task", () => {
      const created = store.createTask("Find me");
      const found = store.getTask(created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Find me");
    });

    it("getTask returns undefined for missing id", () => {
      expect(store.getTask("nonexistent")).toBeUndefined();
    });

    it("listTasks returns tasks sorted by status then order", () => {
      const t1 = store.createTask("First");
      const t2 = store.createTask("Second");
      // t2 was created second but gets order 0, t1 bumped to order 1
      const list = store.listTasks();
      expect(list[0].id).toBe(t2.id);
      expect(list[1].id).toBe(t1.id);
    });

    it("updateTask changes fields", () => {
      const task = store.createTask("Original");
      const updated = store.updateTask(task.id, { title: "Updated", notes: "some notes" });
      expect(updated.title).toBe("Updated");
      expect(updated.notes).toBe("some notes");
    });

    it("updateTask rejects invalid nextTouchAt values", () => {
      const task = store.createTask("Original");
      const invalidValues = [
        "not-a-date",
        "2026-02-31T00:00:00.000Z",
        "2026-05-02 09:30",
        JSON.parse("{\"value\":123}").value,
      ];

      for (const nextTouchAt of invalidValues) {
        expect(() => store.updateTask(task.id, { nextTouchAt }))
          .toThrow("nextTouchAt must be a valid ISO timestamp with timezone");
      }

      expect(store.getTask(task.id)?.nextTouchAt).toBeUndefined();
    });

    it("hydrates optional momentum fields from stored rows", () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (
          id, title, status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
          priority, pinned, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-hydrate",
        "Hydrate me",
        "paused",
        null,
        null,
        "",
        "Ship after green build",
        "Review the latest diff",
        "QA sign-off",
        "2025-01-02T03:04:05.000Z",
        0,
        0,
        0,
        now,
        now,
      );

      expect(store.getTask("task-hydrate")).toMatchObject({
        status: "active",
        doneWhen: "Ship after green build",
        nextAction: "Review the latest diff",
        waitingOn: "QA sign-off",
        nextTouchAt: "2025-01-02T03:04:05.000Z",
      });
    });

    it("hydrates null and empty-string momentum fields as undefined", () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (
          id, title, status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
          priority, pinned, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-hydrate-empty",
        "Hydrate empty",
        "active",
        null,
        null,
        "",
        null,
        "",
        "   ",
        "",
        0,
        0,
        0,
        now,
        now,
      );

      expect(store.getTask("task-hydrate-empty")).toMatchObject({
        doneWhen: undefined,
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });
    });

    it("hydrates invalid nextTouchAt values as undefined", () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (
          id, title, status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
          priority, pinned, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-hydrate-invalid-touch",
        "Hydrate invalid touch",
        "active",
        null,
        null,
        "",
        null,
        null,
        null,
        "not-a-date",
        0,
        0,
        0,
        now,
        now,
      );

      expect(store.getTask("task-hydrate-invalid-touch")).toMatchObject({
        nextTouchAt: undefined,
      });
    });

    it("updateTask throws for missing task", () => {
      expect(() => store.updateTask("nope", { title: "x" })).toThrow("not found");
    });

    it("updateTask status change puts task at top of new group", () => {
      const t1 = store.createTask("Task 1");
      const t2 = store.createTask("Task 2");
      store.updateTask(t1.id, { status: "done" });
      const done = store.listTasks().filter((t) => t.status === "done");
      expect(done).toHaveLength(1);
      expect(done[0].order).toBe(0);
    });

    it("updateTask normalizes paused status updates to active", () => {
      const task = store.createTask("Normalize me");

      const updated = store.updateTask(task.id, { status: "paused" as any });

      expect(updated.status).toBe("active");
      const raw = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status: string };
      expect(raw.status).toBe("active");
    });

    it("updateTask clears parked momentum when a task is marked done", () => {
      const task = store.createTask("Ship it");
      store.updateTask(task.id, {
        doneWhen: "Feature flag is enabled everywhere",
        nextAction: "Check rollout metrics",
        waitingOn: "Support sign-off",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      const updated = store.updateTask(task.id, { status: "done" });

      expect(updated).toMatchObject({
        status: "done",
        doneWhen: "Feature flag is enabled everywhere",
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });

      const raw = db.prepare("SELECT doneWhen, nextAction, waitingOn, nextTouchAt FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw).toEqual({
        doneWhen: "Feature flag is enabled everywhere",
        nextAction: null,
        waitingOn: null,
        nextTouchAt: null,
      });
    });

    it("updateTask clears parked momentum when a task is archived", () => {
      const task = store.createTask("Archive it");
      store.updateTask(task.id, {
        nextAction: "Check rollout metrics",
        waitingOn: "Support sign-off",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      const updated = store.updateTask(task.id, { status: "archived" });

      expect(updated).toMatchObject({
        status: "archived",
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });

      const raw = db.prepare("SELECT nextAction, waitingOn, nextTouchAt FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw).toEqual({
        nextAction: null,
        waitingOn: null,
        nextTouchAt: null,
      });
    });

    it("updateTask rejects parked momentum updates for done tasks", () => {
      const task = store.createTask("Already done");
      store.updateTask(task.id, { status: "done" });

      expect(() => store.updateTask(task.id, { nextAction: "Re-open the task" as any }))
        .toThrow("nextAction, waitingOn, and nextTouchAt can only be set on active tasks");

      expect(store.getTask(task.id)).toMatchObject({
        status: "done",
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });
    });

    it("updateTask persists optional momentum fields and clears empty strings", () => {
      const task = store.createTask("Momentum");

      const updated = store.updateTask(task.id, {
        doneWhen: "Merged and deployed",
        nextAction: "Ping support",
        waitingOn: "Vendor response",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      expect(updated).toMatchObject({
        doneWhen: "Merged and deployed",
        nextAction: "Ping support",
        waitingOn: "Vendor response",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      const raw = db.prepare("SELECT doneWhen, nextAction, waitingOn, nextTouchAt FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw).toEqual({
        doneWhen: "Merged and deployed",
        nextAction: "Ping support",
        waitingOn: "Vendor response",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      const cleared = store.updateTask(task.id, {
        doneWhen: "",
        nextAction: "",
        waitingOn: "   ",
        nextTouchAt: "",
      });

      expect(cleared).toMatchObject({
        doneWhen: undefined,
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });

      const clearedRaw = db.prepare("SELECT doneWhen, nextAction, waitingOn, nextTouchAt FROM tasks WHERE id = ?").get(task.id) as any;
      expect(clearedRaw).toEqual({
        doneWhen: null,
        nextAction: null,
        waitingOn: null,
        nextTouchAt: null,
      });
    });

    it("deleteTask removes the task", () => {
      const task = store.createTask("Delete me");
      expect(store.getTask(task.id)).toBeDefined();
      store.deleteTask(task.id);
      expect(store.getTask(task.id)).toBeUndefined();
    });

    it("deleteTask is idempotent for missing id", () => {
      expect(() => store.deleteTask("nonexistent")).not.toThrow();
    });
  });

  describe("reorderTasks", () => {
    it("reorders tasks by given id array", () => {
      const t1 = store.createTask("A");
      const t2 = store.createTask("B");
      const t3 = store.createTask("C");
      store.reorderTasks([t1.id, t3.id, t2.id]);
      const list = store.listTasks();
      const orders = list.map((t) => ({ id: t.id, order: t.order }));
      expect(orders.find((o) => o.id === t1.id)!.order).toBe(0);
      expect(orders.find((o) => o.id === t3.id)!.order).toBe(1);
      expect(orders.find((o) => o.id === t2.id)!.order).toBe(2);
    });
  });

  describe("link/unlink sessions", () => {
    it("linkSession adds session id", () => {
      const task = store.createTask("Linkable");
      const updated = store.linkSession(task.id, "session-1");
      expect(updated.sessionIds).toContain("session-1");
    });

    it("linkSession is idempotent", () => {
      const task = store.createTask("Linkable");
      store.linkSession(task.id, "session-1");
      store.linkSession(task.id, "session-1");
      const found = store.getTask(task.id)!;
      expect(found.sessionIds.filter((s) => s === "session-1")).toHaveLength(1);
    });

    it("unlinkSession removes session id", () => {
      const task = store.createTask("Unlinkable");
      store.linkSession(task.id, "session-1");
      store.unlinkSession(task.id, "session-1");
      const found = store.getTask(task.id)!;
      expect(found.sessionIds).not.toContain("session-1");
    });

    it("linkSession throws for missing task", () => {
      expect(() => store.linkSession("nope", "s1")).toThrow("not found");
    });
  });

  describe("link/unlink work items", () => {
    it("linkWorkItem adds work item ref", () => {
      const task = store.createTask("WI task");
      store.linkWorkItem(task.id, "12345");
      const found = store.getTask(task.id)!;
      expect(found.workItems).toEqual([{ id: "12345", provider: "ado" }]);
    });

    it("linkWorkItem is idempotent for same id+provider", () => {
      const task = store.createTask("WI task");
      store.linkWorkItem(task.id, "100");
      store.linkWorkItem(task.id, "100");
      expect(store.getTask(task.id)!.workItems).toHaveLength(1);
    });

    it("linkWorkItem allows same id with different provider", () => {
      const task = store.createTask("WI task");
      store.linkWorkItem(task.id, "100", "ado");
      store.linkWorkItem(task.id, "100", "github");
      expect(store.getTask(task.id)!.workItems).toHaveLength(2);
    });

    it("unlinkWorkItem removes by id and provider", () => {
      const task = store.createTask("WI task");
      store.linkWorkItem(task.id, "100", "ado");
      store.unlinkWorkItem(task.id, "100", "ado");
      expect(store.getTask(task.id)!.workItems).toHaveLength(0);
    });

    it("linkWorkItem supports string identifiers (Linear-style)", () => {
      const task = store.createTask("Linear task");
      store.linkWorkItem(task.id, "ENG-123", "linear");
      const found = store.getTask(task.id)!;
      expect(found.workItems).toEqual([{ id: "ENG-123", provider: "linear" }]);
    });
  });

  describe("link/unlink PRs", () => {
    it("linkPR adds PR ref", () => {
      const task = store.createTask("PR task");
      store.linkPR(task.id, { repoId: "repo-1", repoName: "my-repo", prId: 42, provider: "ado" });
      const found = store.getTask(task.id)!;
      expect(found.pullRequests).toHaveLength(1);
      expect(found.pullRequests[0].prId).toBe(42);
    });

    it("linkPR is idempotent for same repo+pr+provider", () => {
      const task = store.createTask("PR task");
      const pr = { repoId: "repo-1", prId: 42, provider: "ado" as const };
      store.linkPR(task.id, pr);
      store.linkPR(task.id, pr);
      expect(store.getTask(task.id)!.pullRequests).toHaveLength(1);
    });

    it("unlinkPR removes PR ref", () => {
      const task = store.createTask("PR task");
      store.linkPR(task.id, { repoId: "repo-1", prId: 42, provider: "ado" });
      store.unlinkPR(task.id, "repo-1", 42, "ado");
      expect(store.getTask(task.id)!.pullRequests).toHaveLength(0);
    });
  });

  describe("findTaskBySessionId", () => {
    it("finds task linked to a session", () => {
      const task = store.createTask("Findable");
      store.linkSession(task.id, "target-session");
      const found = store.findTaskBySessionId("target-session");
      expect(found).toBeDefined();
      expect(found!.id).toBe(task.id);
    });

    it("returns undefined when no match", () => {
      expect(store.findTaskBySessionId("unknown")).toBeUndefined();
    });
  });
});
