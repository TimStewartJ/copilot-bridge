import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, createTestBus } from "./helpers.js";
import {
  areSessionUnreadBubblesMuted,
  createTaskStore,
  PLACEHOLDER_TASK_TITLE,
  TASK_MOMENTUM_EVENT_PREVIEW_CHARS,
  TASK_MOMENTUM_EVENTS_KEEP,
  TASK_MOMENTUM_EVENTS_MAX_LIMIT,
} from "../task-store.js";
import type { TaskStore } from "../task-store.js";
import type { DatabaseSync } from "../db.js";

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
    it("defers and resumes task visibility without clearing context or muting sessions", () => {
      const task = store.createTask("Set aside");
      store.linkSession(task.id, "conversation");
      const context = { notes: "Keep this", nextAction: "Review", waitingOn: "A reply", nextTouchAt: "2000-01-01T00:00:00Z" };
      const deferred = store.updateTask(task.id, { ...context, deferred: true });
      expect(deferred).toMatchObject({ ...context, nextTouchAt: "2000-01-01T00:00:00.000Z", deferred: true, muted: false, status: "active", sessionIds: ["conversation"] });
      expect(areSessionUnreadBubblesMuted([deferred])).toBe(false);
      expect(store.listTasks()).toContainEqual(deferred);
      expect(store.updateTask(task.id, { nextAction: "A different step" }).deferred).toBe(true);
      const resumed = store.updateTask(task.id, { deferred: false });
      expect(resumed).toMatchObject({ deferred: false, waitingOn: "A reply", nextAction: "A different step", nextTouchAt: "2000-01-01T00:00:00.000Z" });
      expect(() => store.updateTask(task.id, JSON.parse('{"deferred":"true"}'))).toThrow("deferred must be a boolean");
      expect(() => store.updateTask(task.id, JSON.parse('{"deferred":null}'))).toThrow("deferred must be a boolean");
    });

    it("allows undated deferral, clears it on archive/completion, and rejects deferring archived work", () => {
      for (const completion of [false, true]) {
        const task = store.createTask("Set aside");
        expect(store.updateTask(task.id, { deferred: true, nextTouchAt: null })).toMatchObject({ deferred: true, nextTouchAt: undefined });
        const [event] = store.listMomentumEvents(task.id);
        expect(event).toMatchObject({ source: "system", changes: [{ field: "deferred", before: false, after: true }] });
        expect(event.sessionId).toBeUndefined();
        expect(store.updateTask(task.id, completion ? { completionAction: "complete-and-archive" } : { status: "archived" }))
          .toMatchObject({ status: "archived", deferred: false, nextTouchAt: undefined });
        expect(() => store.updateTask(task.id, { deferred: true })).toThrow("Only active tasks can be deferred");
        expect(store.updateTask(task.id, { deferred: false }).deferred).toBe(false);
        expect(store.updateTask(task.id, { status: "active" }).deferred).toBe(false);
      }
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

    it("createTask links the work items it is given, each once", () => {
      const task = store.createTask("Tracked", undefined, undefined, [
        { workItemId: "00100", provider: "ado" },
        { workItemId: "101", provider: "ado" },
        { workItemId: "100", provider: "ado" },
        { workItemId: "100", provider: "github" },
      ]);

      expect(task.workItems).toHaveLength(3);
      expect(task.workItems).toEqual(expect.arrayContaining([
        { id: "100", provider: "ado" },
        { id: "101", provider: "ado" },
        { id: "100", provider: "github" },
      ]));
    });

    it("createTask leaves nothing behind when a link cannot be saved", () => {
      const first = store.createTask("First");
      db.exec("CREATE TRIGGER fail_initial_link BEFORE INSERT ON task_work_items BEGIN SELECT RAISE(ABORT, 'link down'); END;");

      expect(() => store.createTask("Tracked", undefined, undefined, [{ workItemId: "100", provider: "ado" }]))
        .toThrow(/link down/);
      db.exec("DROP TRIGGER fail_initial_link");

      expect(store.listTasks().map((task) => ({ id: task.id, order: task.order }))).toEqual([{ id: first.id, order: 0 }]);
    });

    it("listTasks floats ongoing tasks above normal tasks within status buckets", () => {
      const normal = store.createTask("Normal");
      expect(normal).toMatchObject({ kind: "task", status: "active", notes: "", muted: false, deferred: false });
      const ongoing = store.createTask("Ongoing", undefined, "ongoing");
      const newerNormal = store.createTask("Newer normal");

      const active = store.listTasks().filter((task) => task.status === "active");
      expect(active.map((task) => task.id)).toEqual([ongoing.id, newerNormal.id, normal.id]);
    });

    it("hydrates task kind from stored rows and defaults missing or invalid kinds to task", () => {
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

      expect(store.getTask("task-kind-default"), "missing kind defaults to task").toMatchObject({ kind: "task" });
      expect(store.getTask("task-kind-ongoing"), "ongoing kind preserved").toMatchObject({ kind: "ongoing" });
      expect(store.getTask("task-kind-invalid"), "invalid kind defaults to task").toMatchObject({ kind: "task" });
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

    it("updateTask rejects completion for ongoing tasks unless the kind is changed", () => {
      const task = store.createTask("Original");
      store.updateTask(task.id, { kind: "ongoing" });

      expect(() => store.updateTask(task.id, { completionAction: "complete-and-archive" }))
        .toThrow("Ongoing tasks cannot be completed");

      const converted = store.updateTask(task.id, { kind: "task", completionAction: "complete-and-archive" });
      expect(converted).toMatchObject({ kind: "task", status: "archived" });
      expect(converted.completedAt).toBeDefined();
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

    it("hydrates null, empty-string, and invalid nextTouchAt momentum fields as undefined", () => {
      const now = new Date().toISOString();

      // null and empty-string fields become undefined
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

      expect(store.getTask("task-hydrate-empty"), "null/empty fields").toMatchObject({
        doneWhen: undefined,
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });

      // invalid nextTouchAt becomes undefined
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

      expect(store.getTask("task-hydrate-invalid-touch"), "invalid nextTouchAt").toMatchObject({
        nextTouchAt: undefined,
      });
    });

    it("updateTask throws for missing task", () => {
      expect(() => store.updateTask("nope", { title: "x" })).toThrow("not found");
    });

    it("completes a task at the top of its archive and preserves completion until reopening", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const task = store.createTask("Complete me");
      store.createTask("Still active");
      vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));
      const archived = store.updateTask(task.id, { completionAction: "complete-and-archive" });
      expect(archived).toMatchObject({ status: "archived", completedAt: "2026-04-01T10:00:00.000Z" });
      expect(store.listTasks().filter((candidate) => candidate.status === "archived")).toMatchObject([{ id: task.id, order: 0 }]);

      vi.setSystemTime(new Date("2026-04-01T11:00:00.000Z"));
      expect(store.updateTask(task.id, { status: "archived" }).completedAt).toBe(archived.completedAt);
      expect(store.updateTask(task.id, { notes: "Still done" }).completedAt).toBe(archived.completedAt);
      expect(db.prepare("SELECT status, completedAt FROM tasks WHERE id = ?").get(task.id))
        .toEqual({ status: "archived", completedAt: archived.completedAt });
      expect(store.updateTask(task.id, { status: "active" }).completedAt).toBeUndefined();
    });

    it("updateTask rejects completion for archived tasks", () => {
      const task = store.createTask("Archived already");
      store.updateTask(task.id, { status: "archived" });

      expect(() => store.updateTask(task.id, { completionAction: "complete-and-archive" }))
        .toThrow("Archived tasks cannot be completed again; reopen the task first");
    });

    it("updateTask rejects unknown status values", () => {
      const task = store.createTask("Normalize me");

      expect(() => store.updateTask(task.id, { status: "paused" as any }))
        .toThrow("status must be one of: active, archived");
      expect(() => store.updateTask(task.id, { status: "done" as any }))
        .toThrow("status must be one of: active, archived");
    });

    it("updateTask clears parked momentum when a task is completed or archived", () => {
      // completed case
      const doneTask = store.createTask("Ship it");
      store.updateTask(doneTask.id, {
        doneWhen: "Feature flag is enabled everywhere",
        nextAction: "Check rollout metrics",
        waitingOn: "Support sign-off",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      const donedResult = store.updateTask(doneTask.id, { completionAction: "complete-and-archive" });
      expect(donedResult, "completion clears momentum").toMatchObject({
        status: "archived",
        doneWhen: "Feature flag is enabled everywhere",
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });

      const doneRaw = db.prepare("SELECT doneWhen, nextAction, waitingOn, nextTouchAt FROM tasks WHERE id = ?").get(doneTask.id) as any;
      expect(doneRaw).toEqual({
        doneWhen: "Feature flag is enabled everywhere",
        nextAction: null,
        waitingOn: null,
        nextTouchAt: null,
      });

      // archived case
      const archiveTask = store.createTask("Archive it");
      store.updateTask(archiveTask.id, {
        nextAction: "Check rollout metrics",
        waitingOn: "Support sign-off",
        nextTouchAt: "2025-02-03T04:05:06.000Z",
      });

      const archivedResult = store.updateTask(archiveTask.id, { status: "archived" });
      expect(archivedResult, "archived clears momentum").toMatchObject({
        status: "archived",
        completedAt: undefined,
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });

      const archiveRaw = db.prepare("SELECT nextAction, waitingOn, nextTouchAt FROM tasks WHERE id = ?").get(archiveTask.id) as any;
      expect(archiveRaw).toEqual({
        nextAction: null,
        waitingOn: null,
        nextTouchAt: null,
      });
    });

    it("updateTask rejects parked momentum updates for completed tasks", () => {
      const task = store.createTask("Already done");
      store.updateTask(task.id, { completionAction: "complete-and-archive" });

      expect(() => store.updateTask(task.id, { nextAction: "Re-open the task" as any }))
        .toThrow("nextAction, waitingOn, and nextTouchAt can only be set on active tasks");

      expect(store.getTask(task.id)).toMatchObject({
        status: "archived",
        nextAction: undefined,
        waitingOn: undefined,
        nextTouchAt: undefined,
      });
    });

    it("updateTask switches completed tasks back to active when kind changes to ongoing", () => {
      const existingActive = store.createTask("Already active");
      const task = store.createTask("Task 1");
      store.updateTask(task.id, { doneWhen: "Ship it" });
      store.updateTask(task.id, { completionAction: "complete-and-archive" });

      const updated = store.updateTask(task.id, { kind: "ongoing" });
      expect(updated).toMatchObject({ kind: "ongoing", status: "active", doneWhen: undefined, order: 0 });

      const active = store.listTasks().filter((candidate) => candidate.status === "active");
      expect(active.map((candidate) => candidate.id)).toEqual([task.id, existingActive.id]);

      const raw = db.prepare('SELECT status, doneWhen, completedAt, "order" FROM tasks WHERE id = ?').get(task.id) as any;
      expect(raw).toEqual({ status: "active", doneWhen: null, completedAt: null, order: 0 });
    });

    it("updateTask preserves explicit status updates when switching to ongoing", () => {
      const task = store.createTask("Task 1");
      store.updateTask(task.id, { completionAction: "complete-and-archive" });

      const updated = store.updateTask(task.id, { kind: "ongoing", status: "archived" });
      expect(updated).toMatchObject({ kind: "ongoing", status: "archived", completedAt: undefined });

      const raw = db.prepare("SELECT completedAt FROM tasks WHERE id = ?").get(task.id) as any;
      expect(raw.completedAt).toBeNull();

      expect(() => store.updateTask(task.id, { kind: "ongoing", completionAction: "complete-and-archive" }))
        .toThrow("Ongoing tasks cannot be completed");
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

      expect(store.getTask(task.id)).toEqual(updated);
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

  describe("title history", () => {
    function historyTexts(taskId: string) {
      return (db.prepare("SELECT source, sessionId, text FROM task_history_entries WHERE taskId = ? ORDER BY id")
        .all(taskId) as Array<{ source: string; sessionId: string | null; text: string }>);
    }

    it("records attributed renames on bounded lines, ignoring initial and unchanged names", () => {
      const task = store.createTask(PLACEHOLDER_TASK_TITLE);
      store.updateTask(task.id, { title: "Fix the gate" }, { source: "agent", sessionId: "session-1" });
      store.updateTask(task.id, { title: "Fix the gate", notes: "same title" }, { source: "agent", sessionId: "session-1" });
      store.updateTask(task.id, { title: "Fix the E2E gate" }, { source: "agent", sessionId: "session-2" });
      store.updateTask(task.id, { title: `Gate fix\n${"x".repeat(1000)}` }, { source: "user" });

      const history = historyTexts(task.id);
      expect(history).toEqual([
        { source: "agent", sessionId: "session-2", text: 'Renamed by an agent from "Fix the gate" to "Fix the E2E gate".' },
        { source: "user", sessionId: null, text: expect.stringMatching(/^Renamed by the user from "Fix the E2E gate" to "Gate fix x+…"\.$/) },
      ]);
      expect(history[1].text.length).toBeLessThan(400);
    });
  });

  describe("momentum audit", () => {
    it("records one event per changing update with normalized before/after values and the actor", () => {
      const task = store.createTask("Audit me");
      store.updateTask(task.id, { nextAction: "Call", nextTouchAt: "2030-01-01T09:00:00-08:00" }, {
        source: "agent", sessionId: "session-1", scheduleId: "sched-1", scheduleName: "Daily check",
      });
      store.updateTask(task.id, { waitingOn: "   " }, { source: "user" });
      store.updateTask(task.id, { title: "Renamed", notes: "n" }, { source: "user" });

      const events = store.listMomentumEvents(task.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        taskId: task.id, source: "agent", sessionId: "session-1", scheduleId: "sched-1", scheduleName: "Daily check",
        changes: [
          { field: "nextAction", before: null, after: "Call" },
          { field: "nextTouchAt", before: null, after: "2030-01-01T17:00:00.000Z" },
        ],
      });
    });

    it("records implicit clears from archiving and from switching to ongoing", () => {
      const task = store.createTask("Implicit");
      store.updateTask(task.id, { nextAction: "Step", waitingOn: "Reply", doneWhen: "Shipped" }, { source: "user" });
      store.updateTask(task.id, { kind: "ongoing" }, { source: "user" });
      store.updateTask(task.id, { status: "archived" }, { source: "user" });

      const [archive, kindSwitch] = store.listMomentumEvents(task.id);
      expect(kindSwitch.changes).toEqual([{ field: "doneWhen", before: "Shipped", after: null }]);
      expect(archive.changes).toEqual([
        { field: "nextAction", before: "Step", after: null },
        { field: "waitingOn", before: "Reply", after: null },
      ]);
    });

    it("stores bounded previews of long values with their original length", () => {
      const task = store.createTask("Long");
      const long = "x".repeat(TASK_MOMENTUM_EVENT_PREVIEW_CHARS + 250);
      store.updateTask(task.id, { nextAction: long }, { source: "agent" });
      store.updateTask(task.id, { nextAction: null }, { source: "agent" });

      const [cleared, set] = store.listMomentumEvents(task.id);
      expect(set.changes[0]).toEqual({
        field: "nextAction", before: null, after: long.slice(0, TASK_MOMENTUM_EVENT_PREVIEW_CHARS), afterLength: long.length,
      });
      expect(cleared.changes[0]).toMatchObject({ before: long.slice(0, TASK_MOMENTUM_EVENT_PREVIEW_CHARS), beforeLength: long.length, after: null });
      expect(store.getTask(task.id)?.nextAction).toBeUndefined();
    });

    it("keeps only the newest events per task and bounds the list limit", () => {
      const task = store.createTask("Busy");
      const other = store.createTask("Other");
      store.updateTask(other.id, { nextAction: "Untouched" }, { source: "user" });
      for (let i = 0; i < TASK_MOMENTUM_EVENTS_KEEP + 5; i += 1) {
        store.updateTask(task.id, { nextAction: `Step ${i}` }, { source: "agent" });
      }
      const count = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM task_momentum_events WHERE taskId = ?").get(id) as { n: number }).n;
      expect(count(task.id)).toBe(TASK_MOMENTUM_EVENTS_KEEP);
      expect(count(other.id)).toBe(1);
      expect(store.listMomentumEvents(task.id, 3).map((event) => event.changes[0].after)).toEqual([
        `Step ${TASK_MOMENTUM_EVENTS_KEEP + 4}`, `Step ${TASK_MOMENTUM_EVENTS_KEEP + 3}`, `Step ${TASK_MOMENTUM_EVENTS_KEEP + 2}`,
      ]);
      expect(store.listMomentumEvents(task.id, 10_000)).toHaveLength(TASK_MOMENTUM_EVENTS_MAX_LIMIT);
      expect(store.listMomentumEvents(task.id, 0)).toHaveLength(1);
    });

    it("rolls the task update back when the audit write fails", () => {
      const task = store.createTask("Atomic");
      db.exec(`CREATE TRIGGER fail_momentum_audit BEFORE INSERT ON task_momentum_events BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);
      expect(() => store.updateTask(task.id, { nextAction: "Lost" }, { source: "user" })).toThrow(/audit down/);
      expect(store.getTask(task.id)?.nextAction).toBeUndefined();
      db.exec("DROP TRIGGER fail_momentum_audit");
    });

    it("attaches a schedule to that session's unattributed agent events only", () => {
      const task = store.createTask("Late schedule");
      store.updateTask(task.id, { nextAction: "Early write" }, { source: "agent", sessionId: "run-1" });
      store.updateTask(task.id, { nextAction: "Other session" }, { source: "agent", sessionId: "run-2" });
      store.updateTask(task.id, { nextAction: "Mine" }, { source: "user" });

      expect(store.attributeMomentumEventsToSchedule("run-1", "sched-1", "Hourly scout")).toBe(1);
      expect(store.attributeMomentumEventsToSchedule("run-1", "sched-x", "Renamed")).toBe(0);
      const [user, other, early] = store.listMomentumEvents(task.id);
      expect(early).toMatchObject({ sessionId: "run-1", scheduleId: "sched-1", scheduleName: "Hourly scout" });
      expect(other.scheduleName).toBeUndefined();
      expect(user.scheduleName).toBeUndefined();
    });

    it("deletes a task's history with the task", () => {
      const task = store.createTask("Gone");
      store.updateTask(task.id, { nextAction: "Step" }, { source: "user" });
      store.deleteTask(task.id);
      expect(db.prepare("SELECT COUNT(*) AS n FROM task_momentum_events").get()).toEqual({ n: 0 });
    });
  });

  describe("link/unlink sessions", () => {
    it("resolves a linked session once and forgets it after unlinking", () => {
      const { id } = store.createTask("Linked conversation");
      expect(store.linkSession(id, "session-1").sessionIds).toEqual(["session-1"]);
      store.linkSession(id, "session-1");
      expect(store.getTask(id)?.sessionIds).toEqual(["session-1"]);
      expect(store.findTaskBySessionId("session-1")?.id).toBe(id);
      store.unlinkSession(id, "session-1");
      expect(store.getTask(id)?.sessionIds).toEqual([]);
      expect(store.findTaskBySessionId("session-1")).toBeUndefined();
    });

    it("linkSession throws for missing task", () => {
      expect(() => store.linkSession("nope", "s1")).toThrow("not found");
    });
  });

  describe("link/unlink work items", () => {
    it("links work items once per provider and unlinks only that provider's item", () => {
      const { id } = store.createTask("WI task");
      const links = () => store.getTask(id)!.workItems;
      const ado = { id: "100", provider: "ado" };
      store.linkWorkItem(id, "100");
      expect(links()).toEqual([ado]);
      store.linkWorkItem(id, "100", "ado");
      expect(links()).toEqual([ado]);
      store.linkWorkItem(id, "100", "github");
      expect(links()).toHaveLength(2);

      expect(store.unlinkWorkItem(id, "100", "ado").removed).toBe(true);
      expect(links()).toEqual([{ id: "100", provider: "github" }]);
      expect(store.unlinkWorkItem(id, "100", "github").removed).toBe(true);
      expect(links()).toEqual([]);
    });

    it("unlinkWorkItem reports a no-op instead of a false success", () => {
      const task = store.createTask("WI task");
      store.linkWorkItem(task.id, "100", "ado");
      const before = store.getTask(task.id)!;

      const missingId = store.unlinkWorkItem(task.id, "999", "ado");
      expect(missingId.removed).toBe(false);
      const wrongProvider = store.unlinkWorkItem(task.id, "100", "github");
      expect(wrongProvider.removed).toBe(false);

      const after = store.getTask(task.id)!;
      expect(after.workItems).toEqual(before.workItems);
      // A no-op must not look like a change to clients polling updatedAt.
      expect(after.updatedAt).toBe(before.updatedAt);
    });

    it("normalizes numeric ids without losing precision", () => {
      const task = store.createTask("Big id task");
      store.linkWorkItem(task.id, "0009007199254740993", "ado");
      expect(store.getTask(task.id)!.workItems).toEqual([
        { id: "9007199254740993", provider: "ado" },
      ]);
      expect(store.unlinkWorkItem(task.id, "9007199254740993", "ado").removed).toBe(true);
    });

    it("linkWorkItem supports string identifiers (Linear-style)", () => {
      const task = store.createTask("Linear task");
      store.linkWorkItem(task.id, "ENG-123", "linear");
      const found = store.getTask(task.id)!;
      expect(found.workItems).toEqual([{ id: "ENG-123", provider: "linear" }]);
    });

    it("canonicalizes GitHub references so aliases link and unlink as one item", () => {
      const task = store.createTask("GitHub task");
      store.linkWorkItem(task.id, "https://github.com/octo/bridge/issues/12", "github");
      store.linkWorkItem(task.id, "octo/bridge#12", "github");
      expect(store.getTask(task.id)!.workItems).toEqual([{ id: "octo/bridge#12", provider: "github" }]);

      store.unlinkWorkItem(task.id, "https://github.com/octo/bridge/pull/12", "github");
      expect(store.getTask(task.id)!.workItems).toHaveLength(0);
    });  });

  describe("link/unlink PRs", () => {
    it("links a PR only once and unlinks it by repository and provider", () => {
      const task = store.createTask("PR task");
      const pr = { repoId: "repo-1", prId: 42, provider: "ado" as const };
      store.linkPR(task.id, pr);
      store.linkPR(task.id, pr);
      expect(store.getTask(task.id)!.pullRequests).toEqual([expect.objectContaining(pr)]);
      store.unlinkPR(task.id, [pr.repoId], pr.prId, pr.provider);
      expect(store.getTask(task.id)!.pullRequests).toEqual([]);
    });
  });

  describe("session links read by session and by page", () => {
    const linkAt = (taskId: string, sessionId: string, linkedAt: string) =>
      db.prepare("INSERT INTO task_sessions (taskId, sessionId, linkedAt) VALUES (?, ?, ?)").run(taskId, sessionId, linkedAt);
    const setState = (sessionId: string, state: { archived?: boolean; visible?: string; attention?: string }) =>
      db.prepare(`INSERT INTO bridge_session_state (sessionId, archived, lastVisibleActivityAt, lastAttentionAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`)
        .run(sessionId, state.archived ? 1 : 0, state.visible ?? null, state.attention ?? null);

    it("lists the tasks of the given sessions in task-list order, with each task's folder", () => {
      const second = store.createTask("Second");
      const first = store.createTask("First");
      store.updateTask(first.id, { cwd: "/work/first" });
      store.reorderTasks([first.id, second.id]);
      store.linkSession(second.id, "shared");
      store.linkSession(first.id, "shared");
      store.linkSession(second.id, "single");
      store.linkSession(second.id, "not-asked-for");

      const links = store.listTaskLinksBySession(["shared", "single", "unlinked"]);

      expect([...links.keys()].sort()).toEqual(["shared", "single"]);
      expect(links.get("shared")).toMatchObject([{ id: first.id, cwd: "/work/first" }, { id: second.id }]);
      expect(links.get("single")!.map((task) => task.id)).toEqual([second.id]);
      expect(store.listTaskLinksBySession([]).size).toBe(0);
      expect([...store.listTaskLinksBySession().keys()].sort()).toEqual(["not-asked-for", "shared", "single"]);
    });

    it("lists tasks without their session links, otherwise equal to the task list", () => {
      const task = store.createTask("With links");
      store.linkSession(task.id, "session-1");
      store.createTask("Without links");

      const withoutSessions = store.listTasksWithoutSessions();

      expect(withoutSessions.every((item) => !("sessionIds" in item))).toBe(true);
      expect(withoutSessions).toEqual(store.listTasks().map(({ sessionIds: _sessionIds, ...rest }) => rest));
    });

    it("summarises each task's links: active ids in link order, counts, and a revision of every link", () => {
      const task = store.createTask("Summarised");
      const empty = store.createTask("No links");
      linkAt(task.id, "b-first", "2026-05-01 10:00:00");
      linkAt(task.id, "a-second", "2026-05-01 11:00:00");
      linkAt(task.id, "archived", "2026-05-01 12:00:00");
      linkAt(task.id, "no-state-row", "2026-05-01 13:00:00");
      // Linked at the same moment and stored in the other order: the id decides.
      linkAt(task.id, "tie-z", "2026-05-01 14:00:00");
      linkAt(task.id, "tie-c", "2026-05-01 14:00:00");
      setState("b-first", {});
      setState("a-second", { visible: "2026-05-02T00:00:00.000Z" });
      setState("archived", { archived: true });

      const summary = store.listTaskSessionSummaries().get(task.id)!;

      expect(summary).toMatchObject({
        activeSessionIds: ["b-first", "a-second", "no-state-row", "tie-c", "tie-z"],
        sessionCount: 6,
        archivedSessionCount: 1,
      });
      expect(store.listTaskSessionSummaries().has(empty.id)).toBe(false);
      expect(store.listTaskSessionSummaries(task.id).get(task.id)).toEqual(summary);
      const revision = summary.sessionLinksRevision;
      // The value browsers already hold: every linked id in link order, one per line, hashed.
      expect(revision).toBe(createHash("sha1")
        .update("b-first\na-second\narchived\nno-state-row\ntie-c\ntie-z\n").digest("hex").slice(0, 16));
      setState("no-state-row", { archived: true });
      expect(store.listTaskSessionSummaries().get(task.id)).toMatchObject({ archivedSessionCount: 2, sessionLinksRevision: revision });
      store.unlinkSession(task.id, "archived");
      expect(store.listTaskSessionSummaries().get(task.id)!.sessionLinksRevision).not.toBe(revision);
    });

    it("pages a task's archived sessions by latest activity, then by link time", () => {
      const task = store.createTask("Archive");
      const other = store.createTask("Other");
      linkAt(task.id, "old-activity", "2026-05-01 10:00:00");
      linkAt(task.id, "new-attention", "2026-05-01 10:00:01");
      linkAt(task.id, "no-activity-linked-late", "2026-05-03 10:00:00");
      linkAt(task.id, "no-activity-linked-early", "2026-04-01 10:00:00");
      linkAt(task.id, "still-active", "2026-05-01 10:00:02");
      linkAt(other.id, "elsewhere", "2026-05-01 10:00:03");
      setState("old-activity", { archived: true, visible: "2026-05-02T08:00:00.000Z" });
      setState("new-attention", { archived: true, visible: "2026-05-01T08:00:00.000Z", attention: "2026-05-04T08:00:00.000Z" });
      setState("no-activity-linked-late", { archived: true });
      setState("no-activity-linked-early", { archived: true });
      setState("still-active", { visible: "2026-05-05T08:00:00.000Z" });
      setState("elsewhere", { archived: true, visible: "2026-05-06T08:00:00.000Z" });

      expect(store.listArchivedSessionIdsForTask(task.id, { limit: 3, offset: 0 })).toEqual({
        sessionIds: ["new-attention", "no-activity-linked-late", "old-activity"],
        total: 4,
      });
      expect(store.listArchivedSessionIdsForTask(task.id, { limit: 3, offset: 3 })).toEqual({
        sessionIds: ["no-activity-linked-early"],
        total: 4,
      });
    });
  });
});
