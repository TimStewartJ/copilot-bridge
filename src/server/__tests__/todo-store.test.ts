import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createTodoStore } from "../todo-store.js";
import { createTaskStore } from "../task-store.js";
import type { TodoStore } from "../todo-store.js";
import type { TaskStore } from "../task-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let todoStore: TodoStore;
let taskStore: TaskStore;

beforeEach(() => {
  db = setupTestDb();
  const bus = createTestBus();
  taskStore = createTaskStore(db, bus);
  todoStore = createTodoStore(db, bus);
});

describe("todo-store", () => {
  describe("CRUD", () => {
    it("listTodos returns empty array for task with no todos", () => {
      const task = taskStore.createTask("Test");
      expect(todoStore.listTodos(task.id)).toEqual([]);
    });

    it("createTodo returns a valid todo", () => {
      const task = taskStore.createTask("Test");
      const todo = todoStore.createTodo(task.id, "Buy milk");
      expect(todo.id).toBeTruthy();
      expect(todo.text).toBe("Buy milk");
      expect(todo.done).toBe(false);
      expect(todo.taskId).toBe(task.id);
      expect(todo.order).toBe(0);
    });

    it("createTodo throws for missing task", () => {
      expect(() => todoStore.createTodo("nonexistent", "test")).toThrow("not found");
    });

    it("createTodo assigns incrementing order", () => {
      const task = taskStore.createTask("Test");
      const t1 = todoStore.createTodo(task.id, "First");
      const t2 = todoStore.createTodo(task.id, "Second");
      expect(t1.order).toBe(0);
      expect(t2.order).toBe(1);
    });

    it("getTodo returns created todo", () => {
      const task = taskStore.createTask("Test");
      const created = todoStore.createTodo(task.id, "Find me");
      const found = todoStore.getTodo(created.id);
      expect(found).toBeDefined();
      expect(found!.text).toBe("Find me");
    });

    it("getTodo returns undefined for missing id", () => {
      expect(todoStore.getTodo("nonexistent")).toBeUndefined();
    });

    it("updateTodo changes text", () => {
      const task = taskStore.createTask("Test");
      const todo = todoStore.createTodo(task.id, "Original");
      const updated = todoStore.updateTodo(todo.id, { text: "Updated" });
      expect(updated.text).toBe("Updated");
    });

    it("updateTodo marks done with completedAt", () => {
      const task = taskStore.createTask("Test");
      const todo = todoStore.createTodo(task.id, "Do this");
      const updated = todoStore.updateTodo(todo.id, { done: true });
      expect(updated.done).toBe(true);
      expect(updated.completedAt).toBeTruthy();
    });

    it("updateTodo undone clears completedAt", () => {
      const task = taskStore.createTask("Test");
      const todo = todoStore.createTodo(task.id, "Do this");
      todoStore.updateTodo(todo.id, { done: true });
      const undone = todoStore.updateTodo(todo.id, { done: false });
      expect(undone.done).toBe(false);
      expect(undone.completedAt).toBeUndefined();
    });

    it("updateTodo throws for missing todo", () => {
      expect(() => todoStore.updateTodo("nope", { text: "x" })).toThrow("not found");
    });

    it("deleteTodo removes the todo", () => {
      const task = taskStore.createTask("Test");
      const todo = todoStore.createTodo(task.id, "Delete me");
      todoStore.deleteTodo(todo.id);
      expect(todoStore.getTodo(todo.id)).toBeUndefined();
    });

    it("deleteTodo is idempotent for missing id", () => {
      expect(() => todoStore.deleteTodo("nonexistent")).not.toThrow();
    });
  });

  describe("reorderTodos", () => {
    it("reorders todos by given id array", () => {
      const task = taskStore.createTask("Test");
      const t1 = todoStore.createTodo(task.id, "A");
      const t2 = todoStore.createTodo(task.id, "B");
      const t3 = todoStore.createTodo(task.id, "C");
      const reordered = todoStore.reorderTodos(task.id, [t3.id, t1.id, t2.id]);
      expect(reordered[0].id).toBe(t3.id);
      expect(reordered[1].id).toBe(t1.id);
      expect(reordered[2].id).toBe(t2.id);
    });
  });

  describe("listAllOpen", () => {
    it("returns unchecked todos from active tasks only", () => {
      const active = taskStore.createTask("Active");
      const done = taskStore.createTask("Done");
      taskStore.updateTask(done.id, { status: "done" });

      todoStore.createTodo(active.id, "Open item");
      todoStore.createTodo(done.id, "Done task item");

      const open = todoStore.listAllOpen();
      expect(open).toHaveLength(1);
      expect(open[0].text).toBe("Open item");
    });

    it("excludes checked todos", () => {
      const task = taskStore.createTask("Test");
      const todo = todoStore.createTodo(task.id, "Check me");
      todoStore.updateTodo(todo.id, { done: true });
      todoStore.createTodo(task.id, "Still open");

      const open = todoStore.listAllOpen();
      expect(open).toHaveLength(1);
      expect(open[0].text).toBe("Still open");
    });
  });

  describe("cascade delete", () => {
    it("deleting a task deletes its todos", () => {
      const task = taskStore.createTask("Cascade");
      const todo = todoStore.createTodo(task.id, "Will be deleted");
      taskStore.deleteTask(task.id);
      expect(todoStore.getTodo(todo.id)).toBeUndefined();
    });
  });
});
