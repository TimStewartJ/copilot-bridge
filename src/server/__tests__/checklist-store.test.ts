import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createChecklistStore } from "../checklist-store.js";
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
    it("listChecklistItems returns empty array for task with no checklist items", () => {
      const task = taskStore.createTask("Test");
      expect(checklistStore.listChecklistItems(task.id)).toEqual([]);
    });

    it("createChecklistItem returns a valid checklist item", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Buy milk");
      expect(checklistItem.id).toBeTruthy();
      expect(checklistItem.text).toBe("Buy milk");
      expect(checklistItem.done).toBe(false);
      expect(checklistItem.taskId).toBe(task.id);
      expect(checklistItem.order).toBe(0);
    });

    it("createChecklistItem throws for missing task", () => {
      expect(() => checklistStore.createChecklistItem("nonexistent", "test")).toThrow("not found");
    });

    it("createChecklistItem assigns incrementing order", () => {
      const task = taskStore.createTask("Test");
      const t1 = checklistStore.createChecklistItem(task.id, "First");
      const t2 = checklistStore.createChecklistItem(task.id, "Second");
      expect(t1.order).toBe(0);
      expect(t2.order).toBe(1);
    });

    it("getChecklistItem returns created checklist item", () => {
      const task = taskStore.createTask("Test");
      const created = checklistStore.createChecklistItem(task.id, "Find me");
      const found = checklistStore.getChecklistItem(created.id);
      expect(found).toBeDefined();
      expect(found!.text).toBe("Find me");
    });

    it("getChecklistItem returns undefined for missing id", () => {
      expect(checklistStore.getChecklistItem("nonexistent")).toBeUndefined();
    });

    it("updateChecklistItem changes text", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Original");
      const updated = checklistStore.updateChecklistItem(checklistItem.id, { text: "Updated" });
      expect(updated.text).toBe("Updated");
    });

    it("updateChecklistItem marks done with completedAt", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Do this");
      const updated = checklistStore.updateChecklistItem(checklistItem.id, { done: true });
      expect(updated.done).toBe(true);
      expect(updated.completedAt).toBeTruthy();
    });

    it("updateChecklistItem undone clears completedAt", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Do this");
      checklistStore.updateChecklistItem(checklistItem.id, { done: true });
      const undone = checklistStore.updateChecklistItem(checklistItem.id, { done: false });
      expect(undone.done).toBe(false);
      expect(undone.completedAt).toBeUndefined();
    });

    it("updateChecklistItem throws for missing checklist item", () => {
      expect(() => checklistStore.updateChecklistItem("nope", { text: "x" })).toThrow("not found");
    });

    it("deleteChecklistItem removes the checklist item", () => {
      const task = taskStore.createTask("Test");
      const checklistItem = checklistStore.createChecklistItem(task.id, "Delete me");
      checklistStore.deleteChecklistItem(checklistItem.id);
      expect(checklistStore.getChecklistItem(checklistItem.id)).toBeUndefined();
    });

    it("deleteChecklistItem is idempotent for missing id", () => {
      expect(() => checklistStore.deleteChecklistItem("nonexistent")).not.toThrow();
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
      taskStore.updateTask(done.id, { status: "done" });

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
    it("creates a checklist item without a taskId", () => {
      const checklistItem = checklistStore.createChecklistItem(null, "Global item");
      expect(checklistItem.id).toBeTruthy();
      expect(checklistItem.taskId).toBeNull();
      expect(checklistItem.text).toBe("Global item");
      expect(checklistItem.done).toBe(false);
    });

    it("global checklist items have independent ordering", () => {
      const task = taskStore.createTask("Test");
      checklistStore.createChecklistItem(task.id, "Task item");
      const g1 = checklistStore.createChecklistItem(null, "Global 1");
      const g2 = checklistStore.createChecklistItem(null, "Global 2");
      expect(g1.order).toBe(0);
      expect(g2.order).toBe(1);
    });

    it("global checklist items appear in listAllOpenChecklistItems", () => {
      const task = taskStore.createTask("Active");
      checklistStore.createChecklistItem(task.id, "Task item");
      checklistStore.createChecklistItem(null, "Global item");
      const open = checklistStore.listAllOpenChecklistItems();
      expect(open).toHaveLength(2);
      expect(open.some((t) => t.taskId === null && t.text === "Global item")).toBe(true);
    });

    it("global checklist items appear first in listAllOpenChecklistItems when created first", () => {
      const globalChecklistItem = checklistStore.createChecklistItem(null, "Global item");
      const task = taskStore.createTask("Active");
      checklistStore.createChecklistItem(task.id, "Task item");
      const open = checklistStore.listAllOpenChecklistItems();
      // Server sorts by createdAt DESC, so the task item (created last) comes first
      expect(open[0].taskId).toBe(task.id);
      expect(open[1].taskId).toBeNull();
      expect(globalChecklistItem.taskId).toBeNull();
    });

    it("completed global checklist items appear in listRecentlyCompletedChecklistItems", () => {
      const checklistItem = checklistStore.createChecklistItem(null, "Done global");
      checklistStore.updateChecklistItem(checklistItem.id, { done: true });
      const completed = checklistStore.listRecentlyCompletedChecklistItems();
      expect(completed).toHaveLength(1);
      expect(completed[0].taskId).toBeNull();
    });

    it("global checklist item can be updated and deleted", () => {
      const checklistItem = checklistStore.createChecklistItem(null, "Editable");
      const updated = checklistStore.updateChecklistItem(checklistItem.id, { text: "Changed" });
      expect(updated.text).toBe("Changed");
      checklistStore.deleteChecklistItem(checklistItem.id);
      expect(checklistStore.getChecklistItem(checklistItem.id)).toBeUndefined();
    });

    it("global checklist item supports deadline", () => {
      const checklistItem = checklistStore.createChecklistItem(null, "With deadline", "2026-04-01");
      expect(checklistItem.deadline).toBe("2026-04-01");
    });
  });
});
