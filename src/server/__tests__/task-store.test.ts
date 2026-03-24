import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupDataDir, cleanupDataDir } from "./helpers.js";

// Dynamic import so BRIDGE_DATA_DIR is set before module loads
let taskStore: typeof import("../task-store.js");
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = setupDataDir();
  taskStore = await import("../task-store.js");
});

afterEach(() => {
  cleanupDataDir(dataDir);
});

describe("task-store", () => {
  describe("CRUD", () => {
    it("listTasks returns empty array when no file", () => {
      expect(taskStore.listTasks()).toEqual([]);
    });

    it("createTask returns a valid task", () => {
      const task = taskStore.createTask("My Task");
      expect(task.id).toBeTruthy();
      expect(task.title).toBe("My Task");
      expect(task.status).toBe("active");
      expect(task.notes).toBe("");
      expect(task.sessionIds).toEqual([]);
      expect(task.workItems).toEqual([]);
      expect(task.pullRequests).toEqual([]);
    });

    it("getTask returns created task", () => {
      const created = taskStore.createTask("Find me");
      const found = taskStore.getTask(created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Find me");
    });

    it("getTask returns undefined for missing id", () => {
      expect(taskStore.getTask("nonexistent")).toBeUndefined();
    });

    it("listTasks returns tasks sorted by status then order", () => {
      const t1 = taskStore.createTask("First");
      const t2 = taskStore.createTask("Second");
      // t2 was created second but gets order 0, t1 bumped to order 1
      const list = taskStore.listTasks();
      expect(list[0].id).toBe(t2.id);
      expect(list[1].id).toBe(t1.id);
    });

    it("updateTask changes fields", () => {
      const task = taskStore.createTask("Original");
      const updated = taskStore.updateTask(task.id, { title: "Updated", notes: "some notes" });
      expect(updated.title).toBe("Updated");
      expect(updated.notes).toBe("some notes");
    });

    it("updateTask throws for missing task", () => {
      expect(() => taskStore.updateTask("nope", { title: "x" })).toThrow("not found");
    });

    it("updateTask status change puts task at top of new group", () => {
      const t1 = taskStore.createTask("Task 1");
      const t2 = taskStore.createTask("Task 2");
      taskStore.updateTask(t1.id, { status: "done" });
      const done = taskStore.listTasks().filter((t) => t.status === "done");
      expect(done).toHaveLength(1);
      expect(done[0].order).toBe(0);
    });

    it("deleteTask removes the task", () => {
      const task = taskStore.createTask("Delete me");
      expect(taskStore.getTask(task.id)).toBeDefined();
      taskStore.deleteTask(task.id);
      expect(taskStore.getTask(task.id)).toBeUndefined();
    });

    it("deleteTask is idempotent for missing id", () => {
      expect(() => taskStore.deleteTask("nonexistent")).not.toThrow();
    });
  });

  describe("reorderTasks", () => {
    it("reorders tasks by given id array", () => {
      const t1 = taskStore.createTask("A");
      const t2 = taskStore.createTask("B");
      const t3 = taskStore.createTask("C");
      taskStore.reorderTasks([t1.id, t3.id, t2.id]);
      const list = taskStore.listTasks();
      const orders = list.map((t) => ({ id: t.id, order: t.order }));
      expect(orders.find((o) => o.id === t1.id)!.order).toBe(0);
      expect(orders.find((o) => o.id === t3.id)!.order).toBe(1);
      expect(orders.find((o) => o.id === t2.id)!.order).toBe(2);
    });
  });

  describe("link/unlink sessions", () => {
    it("linkSession adds session id", () => {
      const task = taskStore.createTask("Linkable");
      const updated = taskStore.linkSession(task.id, "session-1");
      expect(updated.sessionIds).toContain("session-1");
    });

    it("linkSession is idempotent", () => {
      const task = taskStore.createTask("Linkable");
      taskStore.linkSession(task.id, "session-1");
      taskStore.linkSession(task.id, "session-1");
      const found = taskStore.getTask(task.id)!;
      expect(found.sessionIds.filter((s) => s === "session-1")).toHaveLength(1);
    });

    it("unlinkSession removes session id", () => {
      const task = taskStore.createTask("Unlinkable");
      taskStore.linkSession(task.id, "session-1");
      taskStore.unlinkSession(task.id, "session-1");
      const found = taskStore.getTask(task.id)!;
      expect(found.sessionIds).not.toContain("session-1");
    });

    it("linkSession throws for missing task", () => {
      expect(() => taskStore.linkSession("nope", "s1")).toThrow("not found");
    });
  });

  describe("link/unlink work items", () => {
    it("linkWorkItem adds work item ref", () => {
      const task = taskStore.createTask("WI task");
      taskStore.linkWorkItem(task.id, 12345);
      const found = taskStore.getTask(task.id)!;
      expect(found.workItems).toEqual([{ id: 12345, provider: "ado" }]);
    });

    it("linkWorkItem is idempotent for same id+provider", () => {
      const task = taskStore.createTask("WI task");
      taskStore.linkWorkItem(task.id, 100);
      taskStore.linkWorkItem(task.id, 100);
      expect(taskStore.getTask(task.id)!.workItems).toHaveLength(1);
    });

    it("linkWorkItem allows same id with different provider", () => {
      const task = taskStore.createTask("WI task");
      taskStore.linkWorkItem(task.id, 100, "ado");
      taskStore.linkWorkItem(task.id, 100, "github");
      expect(taskStore.getTask(task.id)!.workItems).toHaveLength(2);
    });

    it("unlinkWorkItem removes by id and provider", () => {
      const task = taskStore.createTask("WI task");
      taskStore.linkWorkItem(task.id, 100, "ado");
      taskStore.unlinkWorkItem(task.id, 100, "ado");
      expect(taskStore.getTask(task.id)!.workItems).toHaveLength(0);
    });
  });

  describe("link/unlink PRs", () => {
    it("linkPR adds PR ref", () => {
      const task = taskStore.createTask("PR task");
      taskStore.linkPR(task.id, { repoId: "repo-1", repoName: "my-repo", prId: 42, provider: "ado" });
      const found = taskStore.getTask(task.id)!;
      expect(found.pullRequests).toHaveLength(1);
      expect(found.pullRequests[0].prId).toBe(42);
    });

    it("linkPR is idempotent for same repo+pr+provider", () => {
      const task = taskStore.createTask("PR task");
      const pr = { repoId: "repo-1", prId: 42, provider: "ado" as const };
      taskStore.linkPR(task.id, pr);
      taskStore.linkPR(task.id, pr);
      expect(taskStore.getTask(task.id)!.pullRequests).toHaveLength(1);
    });

    it("unlinkPR removes PR ref", () => {
      const task = taskStore.createTask("PR task");
      taskStore.linkPR(task.id, { repoId: "repo-1", prId: 42, provider: "ado" });
      taskStore.unlinkPR(task.id, "repo-1", 42, "ado");
      expect(taskStore.getTask(task.id)!.pullRequests).toHaveLength(0);
    });
  });

  describe("findTaskBySessionId", () => {
    it("finds task linked to a session", () => {
      const task = taskStore.createTask("Findable");
      taskStore.linkSession(task.id, "target-session");
      const found = taskStore.findTaskBySessionId("target-session");
      expect(found).toBeDefined();
      expect(found!.id).toBe(task.id);
    });

    it("returns undefined when no match", () => {
      expect(taskStore.findTaskBySessionId("unknown")).toBeUndefined();
    });
  });
});
