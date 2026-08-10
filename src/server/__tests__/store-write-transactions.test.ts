import { beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createTaskStore, type TaskStore } from "../task-store.js";
import { createTaskGroupStore, type TaskGroupStore } from "../task-group-store.js";
import { createChecklistStore, type ChecklistStore } from "../checklist-store.js";
import { createTagStore, type TagStore } from "../tag-store.js";
import { NestedTransactionError, runTransaction } from "../db-transaction.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let taskStore: TaskStore;
let groupStore: TaskGroupStore;
let checklistStore: ChecklistStore;
let tagStore: TagStore;
let bus: ReturnType<typeof createTestBus>;

beforeEach(() => {
  db = setupTestDb();
  bus = createTestBus();
  taskStore = createTaskStore(db, bus);
  groupStore = createTaskGroupStore(db, bus);
  checklistStore = createChecklistStore(db, bus);
  tagStore = createTagStore(db);
});

function taskOrders(): Record<string, number> {
  const rows = db.prepare('SELECT title, "order" AS ord FROM tasks').all() as Array<{ title: string; ord: number }>;
  return Object.fromEntries(rows.map((row) => [row.title, row.ord]));
}

/**
 * Force the next matching write to fail, simulating a crash partway through a
 * multi-statement sequence.
 */
function failOnStatement(match: string): () => void {
  const original = db.prepare.bind(db);
  const restore = () => { (db as any).prepare = original; };
  (db as any).prepare = (sql: string) => {
    const stmt = original(sql);
    if (!sql.includes(match)) return stmt;
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return () => { throw new Error("injected write failure"); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  return restore;
}

describe("store write transactions", () => {
  describe("task-store", () => {
    it("leaves active task order untouched when createTask's INSERT fails", () => {
      taskStore.createTask("First");
      taskStore.createTask("Second");
      const before = taskOrders();

      const restore = failOnStatement("INSERT INTO tasks");
      try {
        expect(() => taskStore.createTask("Third")).toThrow(/injected write failure/);
      } finally {
        restore();
      }

      expect(taskOrders()).toEqual(before);
      expect(taskStore.listTasks()).toHaveLength(2);
    });

    it("leaves the cohort unshifted when updateTask's row write fails", () => {
      const a = taskStore.createTask("A");
      taskStore.createTask("B");
      const moved = taskStore.updateTask(a.id, { status: "archived" });
      const before = taskOrders();

      const restore = failOnStatement("UPDATE tasks SET updatedAt");
      try {
        expect(() => taskStore.updateTask(a.id, { status: "active" })).toThrow(/injected write failure/);
      } finally {
        restore();
      }

      expect(taskOrders()).toEqual(before);
      expect(taskStore.getTask(a.id)!.status).toBe(moved.status);
    });

    it("rolls back every order write when a reorder fails mid-sequence", () => {
      const a = taskStore.createTask("A");
      const b = taskStore.createTask("B");
      const c = taskStore.createTask("C");
      const before = taskOrders();

      let calls = 0;
      const original = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        const stmt = original(sql);
        if (!sql.includes('UPDATE tasks SET "order" = ? WHERE id = ?')) return stmt;
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop === "run") {
              return (...args: unknown[]) => {
                if (++calls > 1) throw new Error("injected write failure");
                return (target as any).run(...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      };
      try {
        expect(() => taskStore.reorderTasks([c.id, b.id, a.id])).toThrow(/injected write failure/);
      } finally {
        (db as any).prepare = original;
      }

      expect(taskOrders()).toEqual(before);
    });

    it("rejects missing task-group references before task writes or events", () => {
      const task = taskStore.createTask("Existing");
      const beforeOrders = taskOrders();
      const beforeTask = taskStore.getTask(task.id);
      const events: unknown[] = [];
      const unsubscribe = bus.subscribe((event) => events.push(event));

      try {
        expect(() => taskStore.createTask("Invalid create", "missing-group"))
          .toThrow("Task group missing-group not found");
        expect(() => taskStore.updateTask(task.id, { groupId: "missing-group" }))
          .toThrow("Task group missing-group not found");
      } finally {
        unsubscribe();
      }

      expect(taskOrders()).toEqual(beforeOrders);
      expect(taskStore.getTask(task.id)).toEqual(beforeTask);
      expect(taskStore.listTasks()).toHaveLength(1);
      expect(events).toEqual([]);
    });
  });

  describe("task-group-store", () => {
    it.each([
      ["task ungrouping", "UPDATE tasks SET groupId = NULL"],
      ["group tag cleanup", "DELETE FROM entity_tags WHERE entityType = 'task_group'"],
      ["group recompact", 'UPDATE task_groups SET "order" = ? WHERE id = ?'],
    ])("rolls back the full cascade when %s fails", (_stage, match) => {
      const first = groupStore.createGroup("First");
      const second = groupStore.createGroup("Second");
      const task = taskStore.createTask("Grouped", first.id);
      const tag = tagStore.createTag("group-tag");
      tagStore.setEntityTags("task_group", first.id, [tag.id]);
      const beforeTask = taskStore.getTask(task.id);
      const beforeGroups = groupStore.listGroups();
      const events: unknown[] = [];
      const unsubscribe = bus.subscribe((event) => events.push(event));

      const restore = failOnStatement(match);
      try {
        expect(() => groupStore.deleteGroup(first.id)).toThrow(/injected write failure/);
      } finally {
        restore();
        unsubscribe();
      }

      expect(taskStore.getTask(task.id)).toEqual(beforeTask);
      expect(tagStore.getEntityTags("task_group", first.id).map((item) => item.id)).toEqual([tag.id]);
      expect(groupStore.listGroups()).toEqual(beforeGroups);
      expect(groupStore.getGroup(first.id)?.id).toBe(first.id);
      expect(groupStore.getGroup(second.id)?.id).toBe(second.id);
      expect(events).toEqual([]);
    });

    it("commits the full cascade before emitting affected task events", () => {
      const first = groupStore.createGroup("First");
      const second = groupStore.createGroup("Second");
      const taskA = taskStore.createTask("A", first.id);
      const taskB = taskStore.createTask("B", first.id);
      const unaffected = taskStore.createTask("Other", second.id);
      db.prepare("UPDATE tasks SET updatedAt = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)")
        .run(taskA.id, taskB.id);
      const tag = tagStore.createTag("group-tag");
      tagStore.setEntityTags("task_group", first.id, [tag.id]);
      const observed: Array<{
        taskId?: string;
        groupMissing: boolean;
        taskGroupId?: string;
        taskUpdatedAt?: string;
      }> = [];
      const unsubscribe = bus.subscribe((event) => {
        if (event.type !== "task:changed") return;
        const task = event.taskId ? taskStore.getTask(event.taskId) : undefined;
        observed.push({
          taskId: event.taskId,
          groupMissing: groupStore.getGroup(first.id) === undefined,
          taskGroupId: task?.groupId,
          taskUpdatedAt: task?.updatedAt,
        });
      });

      let result;
      try {
        result = groupStore.deleteGroup(first.id);
      } finally {
        unsubscribe();
      }

      expect(result).toEqual({
        affectedTaskIds: expect.arrayContaining([taskA.id, taskB.id]),
        deleted: true,
      });
      expect(result.affectedTaskIds).toHaveLength(2);
      expect(taskStore.getTask(taskA.id)?.groupId).toBeUndefined();
      expect(taskStore.getTask(taskB.id)?.groupId).toBeUndefined();
      expect(taskStore.getTask(taskA.id)?.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
      expect(taskStore.getTask(taskB.id)?.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
      expect(taskStore.getTask(unaffected.id)?.groupId).toBe(second.id);
      expect(tagStore.getEntityTags("task_group", first.id)).toEqual([]);
      expect(groupStore.listGroups()).toEqual([
        expect.objectContaining({ id: second.id, order: 0 }),
      ]);
      expect(observed).toHaveLength(2);
      expect(observed.map((item) => item.taskId)).toEqual(expect.arrayContaining([taskA.id, taskB.id]));
      expect(observed.every((item) =>
        item.groupMissing
        && item.taskGroupId === undefined
        && item.taskUpdatedAt !== "2020-01-01T00:00:00.000Z"
      )).toBe(true);
    });
  });

  describe("checklist-store", () => {
    it("rolls back every order write when a reorder fails mid-sequence", () => {
      const task = taskStore.createTask("Task");
      const a = checklistStore.createChecklistItem(task.id, "A");
      const b = checklistStore.createChecklistItem(task.id, "B");
      const before = checklistStore.listChecklistItems(task.id).map((item) => [item.id, item.order] as const);

      let calls = 0;
      const original = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        const stmt = original(sql);
        if (!sql.includes('UPDATE checklist_items SET "order" = ?')) return stmt;
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop === "run") {
              return (...args: unknown[]) => {
                if (++calls > 1) throw new Error("injected write failure");
                return (target as any).run(...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      };
      try {
        expect(() => checklistStore.reorderChecklistItems(task.id, [b.id, a.id])).toThrow(/injected write failure/);
      } finally {
        (db as any).prepare = original;
      }

      expect(checklistStore.listChecklistItems(task.id).map((item) => [item.id, item.order] as const)).toEqual(before);
    });
  });

  describe("tag-store", () => {
    it("does not strip an entity's tags when the re-insert fails", () => {
      const task = taskStore.createTask("Task");
      const red = tagStore.createTag("red");
      const blue = tagStore.createTag("blue");
      tagStore.setEntityTags("task", task.id, [red.id, blue.id]);

      const restore = failOnStatement("INSERT INTO entity_tags");
      try {
        expect(() => tagStore.setEntityTags("task", task.id, [red.id])).toThrow(/injected write failure/);
      } finally {
        restore();
      }

      expect(tagStore.getEntityTags("task", task.id).map((tag) => tag.name).sort()).toEqual(["blue", "red"]);
    });

    it("rolls back the tag delete when the recompact fails", () => {
      const red = tagStore.createTag("red");
      tagStore.createTag("blue");

      const restore = failOnStatement('UPDATE tags SET "order" = ? WHERE id = ?');
      try {
        expect(() => tagStore.deleteTag(red.id)).toThrow(/injected write failure/);
      } finally {
        restore();
      }

      expect(tagStore.listTags().map((tag) => tag.name).sort()).toEqual(["blue", "red"]);
    });
  });

  describe("nesting", () => {
    it("rejects a store write that would run inside an open transaction", () => {
      db.exec("BEGIN");
      try {
        expect(() => taskStore.createTask("Nested")).toThrow(NestedTransactionError);
      } finally {
        db.exec("ROLLBACK");
      }
    });

    it("leaves no transaction open after a rollback", () => {
      expect(() => runTransaction(db, () => { throw new Error("boom"); })).toThrow(/boom/);
      expect(db.isTransaction).toBe(false);
      expect(() => taskStore.createTask("After rollback")).not.toThrow();
    });
  });
});
