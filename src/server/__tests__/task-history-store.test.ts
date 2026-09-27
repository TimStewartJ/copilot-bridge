import { describe, expect, it } from "vitest";
import { createTaskStore } from "../task-store.js";
import {
  createTaskHistoryStore,
  InvalidTaskHistoryEntryError,
  MAX_TASK_HISTORY_LIST_LIMIT,
  MAX_TASK_HISTORY_TEXT_LENGTH,
} from "../task-history-store.js";
import { createTestBus, setupTestDb } from "./helpers.js";

function setup() {
  const db = setupTestDb();
  const taskStore = createTaskStore(db, createTestBus());
  const history = createTaskHistoryStore(db);
  const task = taskStore.createTask("History task");
  return { db, taskStore, history, task };
}

describe("task history store", () => {
  it("records trimmed entries with their author and lists them newest first", () => {
    const { history, task } = setup();
    history.addEntry(task.id, "  Toured the unit  ", { source: "user" }, "2026-09-25T10:00:00.000Z");
    history.addEntry(task.id, "Landlord replied", { source: "agent", sessionId: "session-1" }, "2026-09-26T10:00:00.000Z");

    const entries = history.listEntries(task.id);
    expect(entries.map((entry) => entry.text)).toEqual(["Landlord replied", "Toured the unit"]);
    expect(entries[0]).toMatchObject({ taskId: task.id, source: "agent", sessionId: "session-1", at: "2026-09-26T10:00:00.000Z" });
    expect(entries[1]).not.toHaveProperty("sessionId");
    expect(history.countEntries(task.id)).toBe(2);
  });

  it("rejects empty, non-string and oversized text", () => {
    const { history, task } = setup();
    expect(() => history.addEntry(task.id, "   ", { source: "user" })).toThrow(InvalidTaskHistoryEntryError);
    expect(() => history.addEntry(task.id, 42, { source: "user" })).toThrow("text must be a string");
    expect(() => history.addEntry(task.id, "x".repeat(MAX_TASK_HISTORY_TEXT_LENGTH + 1), { source: "user" }))
      .toThrow(`at most ${MAX_TASK_HISTORY_TEXT_LENGTH}`);
    expect(history.addEntry(task.id, "x".repeat(MAX_TASK_HISTORY_TEXT_LENGTH), { source: "user" }).text)
      .toHaveLength(MAX_TASK_HISTORY_TEXT_LENGTH);
  });

  it("pages by id, clamps the limit and searches text literally", () => {
    const { history, task } = setup();
    const ids = ["alpha", "50% off", "beta_1", "betaX1", "gamma!"].map((text) => history.addEntry(task.id, text, { source: "user" }).id);

    expect(history.listEntries(task.id, { limit: 2 }).map((entry) => entry.text)).toEqual(["gamma!", "betaX1"]);
    expect(history.listEntries(task.id, { before: ids[2] }).map((entry) => entry.text)).toEqual(["50% off", "alpha"]);
    expect(history.listEntries(task.id, { query: "%" }).map((entry) => entry.text)).toEqual(["50% off"]);
    expect(history.listEntries(task.id, { query: "beta_" }).map((entry) => entry.text)).toEqual(["beta_1"]);
    expect(history.listEntries(task.id, { query: "!" }).map((entry) => entry.text)).toEqual(["gamma!"]);
    expect(history.listEntries(task.id, { query: "ALPHA" }).map((entry) => entry.text)).toEqual(["alpha"]);
    expect(history.listEntries(task.id, { limit: 0 })).toHaveLength(1);
    expect(history.listEntries(task.id, { limit: MAX_TASK_HISTORY_LIST_LIMIT + 50 })).toHaveLength(5);
  });

  it("deletes only an entry of the given task", () => {
    const { history, task, taskStore } = setup();
    const other = taskStore.createTask("Other");
    const entry = history.addEntry(task.id, "Keep me", { source: "user" });
    expect(history.deleteEntry(other.id, entry.id)).toBe(false);
    expect(history.deleteEntry(task.id, entry.id)).toBe(true);
    expect(history.deleteEntry(task.id, entry.id)).toBe(false);
    expect(history.countEntries(task.id)).toBe(0);
  });

  it("attributes a run's unattributed entries to its schedule once", () => {
    const { history, task } = setup();
    history.addEntry(task.id, "Run found two units", { source: "agent", sessionId: "run-1" });
    history.addEntry(task.id, "Other run", { source: "agent", sessionId: "run-2" });
    history.addEntry(task.id, "Already owned", { source: "agent", sessionId: "run-1", scheduleId: "s-0", scheduleName: "Old" });

    expect(history.attributeToSchedule("run-1", "s-1", "Daily search")).toBe(1);
    const entries = history.listEntries(task.id);
    expect(entries.find((entry) => entry.text === "Run found two units")).toMatchObject({ scheduleId: "s-1", scheduleName: "Daily search" });
    expect(entries.find((entry) => entry.text === "Already owned")).toMatchObject({ scheduleId: "s-0", scheduleName: "Old" });
    expect(entries.find((entry) => entry.text === "Other run")).not.toHaveProperty("scheduleId");
  });

  it("drops a task's history with the task", () => {
    const { history, task, taskStore } = setup();
    history.addEntry(task.id, "Gone soon", { source: "user" });
    taskStore.deleteTask(task.id);
    expect(history.countEntries(task.id)).toBe(0);
  });
});
