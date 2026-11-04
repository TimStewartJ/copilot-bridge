import { beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, createTestBus } from "../server/__tests__/helpers.js";
import { createTaskStore, type TaskStore } from "../server/task-store.js";
import { createTaskGroupStore, type TaskGroupStore } from "../server/task-group-store.js";
import { createChecklistStore, type ChecklistStore } from "../server/checklist-store.js";
import { createTagStore, type TagStore } from "../server/tag-store.js";
import { NestedTransactionError } from "../server/db-transaction.js";
import type { DatabaseSync } from "../server/db.js";

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
      expect(db.isTransaction).toBe(false);
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
    it("rolls back the full cascade when group recompact fails", () => {
      const first = groupStore.createGroup("First");
      const second = groupStore.createGroup("Second");
      const task = taskStore.createTask("Grouped", first.id);
      const tag = tagStore.createTag("group-tag");
      tagStore.setEntityTags("task_group", first.id, [tag.id]);
      const beforeTask = taskStore.getTask(task.id);
      const beforeGroups = groupStore.listGroups();
      const events: unknown[] = [];
      const unsubscribe = bus.subscribe((event) => events.push(event));

      const restore = failOnStatement('UPDATE task_groups SET "order" = ? WHERE id = ?');
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
  });
});
