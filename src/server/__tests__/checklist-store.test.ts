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

    it("edits, completes, reopens and deletes the same dated item", () => {
      const task = taskStore.createTask("Test");
      const item = checklistStore.createChecklistItem(task.id, "Original", "2026-04-01");
      const done = checklistStore.updateChecklistItem(item.id, { text: "Updated", done: true, deadline: null });
      expect(done).toMatchObject({ text: "Updated", done: true, completedAt: expect.any(String), deadline: undefined });
      const reopened = checklistStore.updateChecklistItem(done.id, { done: false });
      expect(reopened).toMatchObject({ done: false, completedAt: undefined });
      checklistStore.deleteChecklistItem(reopened.id);
      expect(checklistStore.getChecklistItem(item.id)).toBeUndefined();
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
    it("lists only unchecked items belonging to active tasks", () => {
      const active = taskStore.createTask("Active");
      const done = taskStore.createTask("Done");
      taskStore.updateTask(done.id, { completionAction: "complete-and-archive" });

      const checked = checklistStore.createChecklistItem(active.id, "Checked item");
      checklistStore.updateChecklistItem(checked.id, { done: true });
      checklistStore.createChecklistItem(active.id, "Open item");
      checklistStore.createChecklistItem(done.id, "Done task item");

      const open = checklistStore.listAllOpenChecklistItems();
      expect(open).toHaveLength(1);
      expect(open[0].text).toBe("Open item");
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

    it("moves a dated global action from the open list to recently completed", () => {
      const global = checklistStore.createChecklistItem(null, "Global item", "2026-04-01");
      expect(global).toMatchObject({ taskId: null, text: "Global item", deadline: "2026-04-01", done: false });
      const task = taskStore.createTask("Active");
      const local = checklistStore.createChecklistItem(task.id, "Task item");
      expect(checklistStore.listAllOpenChecklistItems().map((item) => item.id)).toEqual([local.id, global.id]);
      checklistStore.updateChecklistItem(global.id, { done: true });
      expect(checklistStore.listRecentlyCompletedChecklistItems()).toMatchObject([{ id: global.id, taskId: null }]);
    });

  });
});
