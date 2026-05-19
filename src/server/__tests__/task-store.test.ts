import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { setupTestDb, createTestBus } from "./helpers.js";
import { areSessionUnreadBubblesMuted, createTaskStore } from "../task-store.js";
import type { TaskStore } from "../task-store.js";
import type { DatabaseSync } from "../db.js";
import { resolveRuntimePaths } from "../runtime-paths.js";

let db: DatabaseSync;
let store: TaskStore;

beforeEach(() => {
  db = setupTestDb();
  store = createTaskStore(db, createTestBus());
});

afterEach(() => {
  vi.useRealTimers();
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
      expect(task.kind).toBe("task");
      expect(task.muted).toBe(false);
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

    it("createTask accepts ongoing kind and rejects invalid kinds", () => {
      const ongoing = store.createTask("Keep watch", undefined, "ongoing");
      expect(ongoing).toMatchObject({
        title: "Keep watch",
        kind: "ongoing",
        status: "active",
      });

      const raw = db.prepare("SELECT kind FROM tasks WHERE id = ?").get(ongoing.id) as any;
      expect(raw.kind).toBe("ongoing");

      expect(() => store.createTask("Bad kind", undefined, "invalid" as any))
        .toThrow("kind must be either 'task' or 'ongoing'");
    });

    it("createTask rejects invalid kinds without reordering active tasks", () => {
      const first = store.createTask("First");
      const second = store.createTask("Second");
      const before = store.listTasks().map((task) => ({
        id: task.id,
        order: task.order,
      }));

      expect(() => store.createTask("Bad kind", undefined, "invalid" as any))
        .toThrow("kind must be either 'task' or 'ongoing'");

      expect(store.listTasks().map((task) => ({
        id: task.id,
        order: task.order,
      }))).toEqual(before);
      expect(store.getTask(second.id)).toMatchObject({ order: 0 });
      expect(store.getTask(first.id)).toMatchObject({ order: 1 });
    });

    it("does not default task cwd from runtime workspace paths", () => {
      const runtimePaths = resolveRuntimePaths({}, {
        dataDir: join("runtime-root"),
        workspaceDir: join("runtime-root", "workspace"),
      });
      const runtimeStore = createTaskStore(db, createTestBus(), { runtimePaths });
      const task = runtimeStore.createTask("Runtime Task");
      expect(task.cwd).toBeUndefined();
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

    it("listTasks floats ongoing tasks above normal tasks within status buckets", () => {
      const normal = store.createTask("Normal");
      const ongoing = store.createTask("Ongoing", undefined, "ongoing");
      const newerNormal = store.createTask("Newer normal");

      const active = store.listTasks().filter((task) => task.status === "active");
      expect(active.map((task) => task.id)).toEqual([ongoing.id, newerNormal.id, normal.id]);
    });

    it("updateTask changes fields", () => {
      const task = store.createTask("Original");
      const updated = store.updateTask(task.id, { title: "Updated", notes: "some notes" });
      expect(updated.title).toBe("Updated");
      expect(updated.notes).toBe("some notes");
    });

    it("hydrates task kind from stored rows and defaults missing kinds to task", () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (
          id, title, status, groupId, cwd, notes, priority, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-kind-default",
        "Kind default",
        "active",
        null,
        null,
        "",
        0,
        0,
        now,
        now,
      );
      db.prepare(`
        INSERT INTO tasks (
          id, title, kind, status, groupId, cwd, notes, priority, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-kind-ongoing",
        "Kind ongoing",
        "ongoing",
        "active",
        null,
        null,
        "",
        0,
        1,
        now,
        now,
      );

      expect(store.getTask("task-kind-default")).toMatchObject({ kind: "task" });
      expect(store.getTask("task-kind-ongoing")).toMatchObject({ kind: "ongoing" });
    });

    it("hydrates invalid stored task kinds as task", () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (
          id, title, kind, status, groupId, cwd, notes, priority, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-kind-invalid",
        "Kind invalid",
        "mystery",
        "active",
        null,
        null,
        "",
        0,
        0,
        now,
        now,
      );

      expect(store.getTask("task-kind-invalid")).toMatchObject({ kind: "task" });
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

    it("updateTask persists kind changes", () => {
      const task = store.createTask("Original");
      const updated = store.updateTask(task.id, { kind: "ongoing" });
      expect(updated.kind).toBe("ongoing");

      const raw = db.prepare("SELECT kind FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw.kind).toBe("ongoing");
    });

    it("updateTask persists muted changes and rejects non-boolean muted values", () => {
      const task = store.createTask("Original");

      const muted = store.updateTask(task.id, { muted: true });
      expect(muted.muted).toBe(true);
      expect((db.prepare("SELECT muted FROM tasks WHERE id = ?").get(task.id) as any).muted).toBe(1);

      const unmuted = store.updateTask(task.id, { muted: false });
      expect(unmuted.muted).toBe(false);
      expect((db.prepare("SELECT muted FROM tasks WHERE id = ?").get(task.id) as any).muted).toBe(0);

      expect(() => store.updateTask(task.id, { muted: "yes" as any }))
        .toThrow("muted must be a boolean");
    });

    it("treats a linked session as muted only when every visible linked task is muted", () => {
      const muted = store.updateTask(store.createTask("Muted").id, { muted: true });
      const unmuted = store.createTask("Unmuted");
      const archivedMuted = store.updateTask(store.createTask("Archived muted").id, {
        muted: true,
        status: "archived",
      });

      expect(areSessionUnreadBubblesMuted([muted])).toBe(true);
      expect(areSessionUnreadBubblesMuted([muted, unmuted])).toBe(false);
      expect(areSessionUnreadBubblesMuted([archivedMuted])).toBe(false);
    });

    it("updateTask rejects invalid task kinds", () => {
      const task = store.createTask("Original");
      expect(() => store.updateTask(task.id, { kind: "invalid" as any }))
        .toThrow("kind must be either 'task' or 'ongoing'");
    });

    it("updateTask rejects done status for ongoing tasks unless explicitly changed", () => {
      const task = store.createTask("Original");
      store.updateTask(task.id, { kind: "ongoing" });

      expect(() => store.updateTask(task.id, { status: "done" }))
        .toThrow("Ongoing tasks cannot be marked done");

      const converted = store.updateTask(task.id, { kind: "task", status: "done" });
      expect(converted).toMatchObject({ kind: "task", status: "archived" });
    });

    it("updateTask clears doneWhen when switching to ongoing unless explicitly preserved", () => {
      const task = store.createTask("Original");
      store.updateTask(task.id, { doneWhen: "Ship it" });

      const converted = store.updateTask(task.id, { kind: "ongoing" });
      expect(converted).toMatchObject({ kind: "ongoing", doneWhen: undefined });

      const raw = db.prepare("SELECT doneWhen FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw.doneWhen).toBeNull();

      const explicit = store.createTask("Explicit");
      store.updateTask(explicit.id, { doneWhen: "Still here" });
      expect(() => store.updateTask(explicit.id, { kind: "ongoing", doneWhen: "Still here" }))
        .toThrow("Ongoing tasks cannot keep doneWhen");
    });

    it("hydrates optional momentum fields from stored rows", () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (
          id, title, status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
          priority, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          priority, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          priority, "order", createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    it("updateTask legacy done status archives the task at the top of the archived group", () => {
      const t1 = store.createTask("Task 1");
      const t2 = store.createTask("Task 2");
      const archived = store.updateTask(t1.id, { status: "done" });
      expect(archived.status).toBe("archived");
      expect(store.listTasks().filter((t) => t.status === "archived")).toEqual([
        expect.objectContaining({ id: t1.id, order: 0 }),
      ]);
      const raw = db.prepare("SELECT status FROM tasks WHERE id = ?").get(t1.id) as any;
      expect(raw.status).toBe("archived");
    });

    it("updateTask complete-and-archive sets completedAt and reopening clears it", () => {
      vi.useFakeTimers();
      const task = store.createTask("Complete me");

      vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));
      const archived = store.updateTask(task.id, { completionAction: "complete-and-archive" });
      expect(archived.status).toBe("archived");
      expect(archived.completedAt).toBe("2026-04-01T10:00:00.000Z");

      vi.setSystemTime(new Date("2026-04-01T11:00:00.000Z"));
      const active = store.updateTask(task.id, { status: "active" });
      expect(active.completedAt).toBeUndefined();
    });

    it("updateTask rejects completion for archived tasks, including legacy done requests", () => {
      const task = store.createTask("Archived already");
      store.updateTask(task.id, { status: "archived" });

      expect(() => store.updateTask(task.id, { completionAction: "complete-and-archive" }))
        .toThrow("Archived tasks cannot be completed again; reopen the task first");
      expect(() => store.updateTask(task.id, { status: "done" }))
        .toThrow("Archived tasks cannot be completed again; reopen the task first");
    });

    it("updateTask archiving an incomplete task does not set completedAt", () => {
      const task = store.createTask("Archive me");
      const archived = store.updateTask(task.id, { status: "archived" });
      expect(archived.status).toBe("archived");
      expect(archived.completedAt).toBeUndefined();
    });

    it("updateTask archiving a completed task preserves completedAt", () => {
      vi.useFakeTimers();
      const task = store.createTask("Already complete");

      vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));
      store.updateTask(task.id, { completionAction: "complete-and-archive" });

      vi.setSystemTime(new Date("2026-04-01T11:00:00.000Z"));
      const archived = store.updateTask(task.id, { status: "archived" });
      expect(archived.status).toBe("archived");
      expect(archived.completedAt).toBe("2026-04-01T10:00:00.000Z");
    });

    it("updateTask preserves completedAt across non-status updates", () => {
      vi.useFakeTimers();
      const task = store.createTask("Preserve completion");

      vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));
      const done = store.updateTask(task.id, { completionAction: "complete-and-archive" });

      vi.setSystemTime(new Date("2026-04-01T11:00:00.000Z"));
      const updated = store.updateTask(task.id, { notes: "Still done" });

      expect(updated.completedAt).toBe(done.completedAt);
      const raw = db.prepare("SELECT completedAt FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw.completedAt).toBe("2026-04-01T10:00:00.000Z");
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
        status: "archived",
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
        status: "archived",
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });
    });

    it("updateTask switches done tasks back to active when kind changes to ongoing", () => {
      const existingActive = store.createTask("Already active");
      const task = store.createTask("Task 1");
      store.updateTask(task.id, { status: "done", doneWhen: "Ship it" });

      const updated = store.updateTask(task.id, { kind: "ongoing" });
      expect(updated).toMatchObject({ kind: "ongoing", status: "active", doneWhen: undefined, order: 0 });

      const active = store.listTasks().filter((candidate) => candidate.status === "active");
      expect(active.map((candidate) => candidate.id)).toEqual([task.id, existingActive.id]);

      const raw = db.prepare('SELECT status, doneWhen, completedAt, "order" FROM tasks WHERE id = ?').get(task.id) as any;
      expect(raw).toEqual({ status: "active", doneWhen: null, completedAt: null, order: 0 });
    });

    it("updateTask preserves explicit status updates when switching to ongoing", () => {
      const task = store.createTask("Task 1");
      store.updateTask(task.id, { status: "done" });

      const updated = store.updateTask(task.id, { kind: "ongoing", status: "archived" });
      expect(updated).toMatchObject({ kind: "ongoing", status: "archived", completedAt: undefined });

      const raw = db.prepare("SELECT completedAt FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw.completedAt).toBeNull();

      expect(() => store.updateTask(task.id, { kind: "ongoing", status: "done" }))
        .toThrow("Ongoing tasks cannot be marked done");
    });

    it("updateTask persists optional momentum fields and clears empty strings", () => {
      const task = store.createTask("Momentum");

      const updated = store.updateTask(task.id, {
        doneWhen: "Merged and deployed",
        nextAction: "Contact support",
        waitingOn: "Vendor response",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      expect(updated).toMatchObject({
        doneWhen: "Merged and deployed",
        nextAction: "Contact support",
        waitingOn: "Vendor response",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      const raw = db.prepare("SELECT doneWhen, nextAction, waitingOn, nextTouchAt FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw).toEqual({
        doneWhen: "Merged and deployed",
        nextAction: "Contact support",
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
