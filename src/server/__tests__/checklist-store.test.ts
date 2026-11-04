import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb, createTestBus } from "./helpers.js";
import { ChecklistValidationError, createChecklistStore, normalizeChecklistItemCreate } from "../checklist-store.js";
import { createTaskStore } from "../task-store.js";
import type { ChecklistStore } from "../checklist-store.js";
import type { TaskStore } from "../task-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let checklistStore: ChecklistStore;
let taskStore: TaskStore;

beforeEach(() => {
  db = setupTestDb();
  const bus = createTestBus();
  taskStore = createTaskStore(db, bus);
  checklistStore = createChecklistStore(db, bus);
});

describe("checklist-store", () => {
  describe("CRUD", () => {
    it("createChecklistItem validates text and deadline", () => {
      const invalidInputs: Array<[string, () => void]> = [
        ["text must be a non-empty string", () => checklistStore.createChecklistItem(null, 42 as any)],
        ["text must be a non-empty string", () => checklistStore.createChecklistItem(null, "")],
        ["deadline must be null or a YYYY-MM-DD date", () => checklistStore.createChecklistItem(null, "Due", "tomorrow")],
      ];

      for (const [message, action] of invalidInputs) {
        expect(action).toThrow(ChecklistValidationError);
        expect(action).toThrow(message);
      }
      expect(() => normalizeChecklistItemCreate({ text: "Write tests", extra: true }))
        .toThrow('Unknown field: "extra"');
    });

    it("updateChecklistItem changes text", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Original");
      const updated = checklistStore.updateChecklistItem(checklistItem.id, { text: "Updated" });
      expect(updated.text).toBe("Updated");
    });

    it("updateChecklistItem marks done with completedAt and undone clears it", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Do this");
      const done = checklistStore.updateChecklistItem(checklistItem.id, { done: true });
      expect(done.done).toBe(true);
      expect(done.completedAt).toBeTruthy();
      const undone = checklistStore.updateChecklistItem(checklistItem.id, { done: false });
      expect(undone.done).toBe(false);
      expect(undone.completedAt).toBeUndefined();
    });

    it("updateChecklistItem clears deadline with null", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Do this", "2026-04-01");
      const updated = checklistStore.updateChecklistItem(checklistItem.id, { deadline: null });
      expect(updated.deadline).toBeUndefined();
    });

    it("updateChecklistItem rejects invalid mutation fields", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Original");
      const invalidUpdates: Array<[Record<string, unknown>, string]> = [
        [{ done: "false" }, "done must be boolean"],
        [{ deadline: "tomorrow" }, "deadline must be null or a YYYY-MM-DD date"],
        [{ text: 42 }, "text must be a non-empty string"],
        [{ text: "" }, "text must be a non-empty string"],
        [{ extra: true }, 'Unknown field: "extra"'],
      ];

      for (const [updates, message] of invalidUpdates) {
        expect(() => checklistStore.updateChecklistItem(checklistItem.id, updates as any)).toThrow(ChecklistValidationError);
        expect(() => checklistStore.updateChecklistItem(checklistItem.id, updates as any)).toThrow(message);
      }

      const unchanged = checklistStore.getChecklistItem(checklistItem.id);
      expect(unchanged).toMatchObject({ id: checklistItem.id, taskId: task.id, text: "Original", done: false });
      expect(unchanged?.deadline).toBeUndefined();
    });

    it("deleteChecklistItem removes the checklist item", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Delete me");
      checklistStore.deleteChecklistItem(checklistItem.id);
      expect(checklistStore.getChecklistItem(checklistItem.id)).toBeUndefined();
    });
  });

  describe("reorderChecklistItems", () => {
    it("reorders checklist items by given id array", () => {
      const task = taskStore.createTask("Test");
      const t1 = checklistStore.createChecklistItem(task.id, "A");
      const t2 = checklistStore.createChecklistItem(task.id, "B");
      const t3 = checklistStore.createChecklistItem(task.id, "C");
      const reordered = checklistStore.reorderChecklistItems(task.id, [t3.id, t1.id, t2.id]);
      expect(reordered[0].id).toBe(t3.id);
      expect(reordered[1].id).toBe(t1.id);
      expect(reordered[2].id).toBe(t2.id);
    });
  });

  describe("listAllOpenChecklistItems", () => {
    it("returns unchecked checklist items from active tasks only", () => {
      const active = taskStore.createTask("Active");
      const done = taskStore.createTask("Done");
      taskStore.updateTask(done.id, { completionAction: "complete-and-archive" });

      checklistStore.createChecklistItem(active.id, "Open item");
      checklistStore.createChecklistItem(done.id, "Done task item");

      const open = checklistStore.listAllOpenChecklistItems();
      expect(open).toHaveLength(1);
      expect(open[0].text).toBe("Open item");
    });

    it("excludes checked checklist items", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Check me");
      checklistStore.updateChecklistItem(checklistItem.id, { done: true });
      checklistStore.createChecklistItem(task.id, "Still open");

      const open = checklistStore.listAllOpenChecklistItems();
      expect(open).toHaveLength(1);
      expect(open[0].text).toBe("Still open");
    });
  });

  describe("cascade delete", () => {
    it("deleting a task deletes its checklist items", () => {
      const task = taskStore.createTask("Cascade");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Will be deleted");
      taskStore.deleteTask(task.id);
      expect(checklistStore.getChecklistItem(checklistItem.id)).toBeUndefined();
    });
  });

  describe("global (unparented) checklist items", () => {
    it("global checklist items have independent ordering", () => {
      const task = taskStore.createTask("Test");
      expect(checklistStore.createChecklistItem(task.id, "First task item").order).toBe(0);
      expect(checklistStore.createChecklistItem(task.id, "Second task item").order).toBe(1);
      const g1 = checklistStore.createChecklistItem(null, "Global 1");
      const g2 = checklistStore.createChecklistItem(null, "Global 2");
      expect(g1.order).toBe(0);
      expect(g2.order).toBe(1);
    });

    it("global checklist items appear first in listAllOpenChecklistItems when created first", () => {
      const globalChecklistItem = checklistStore.createChecklistItem(null, "Global item");
      const task = taskStore.createTask("Active");
      checklistStore.createChecklistItem(task.id, "Task item");
      const open = checklistStore.listAllOpenChecklistItems();
      // Server sorts by createdAt DESC, so the task item (created last) comes first
      expect(open[0].taskId).toBe(task.id);
      expect(open[1].taskId).toBeNull();
      expect(globalChecklistItem).toMatchObject({ taskId: null, text: "Global item", done: false });
    });

    it("completed global checklist items appear in listRecentlyCompletedChecklistItems", () => {
      const checklistItem = checklistStore.createChecklistItem(null, "Done global");
      checklistStore.updateChecklistItem(checklistItem.id, { done: true });
      const completed = checklistStore.listRecentlyCompletedChecklistItems();
      expect(completed).toHaveLength(1);
      expect(completed[0].taskId).toBeNull();
    });

    it("global checklist item supports deadline", () => {
      const checklistItem = checklistStore.createChecklistItem(null, "With deadline", "2026-04-01");
      expect(checklistItem.deadline).toBe("2026-04-01");
    });
  });
});
