import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-db-migration-"));
  tempDirs.push(dir);
  return dir;
}

function createLegacyTaskTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      groupId TEXT,
      cwd TEXT,
      notes TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      "order" INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

describe("database checklist migration", () => {
  it("migrates legacy todos into checklist_items without losing checklist data", () => {
    const dataDir = createTempDataDir();
    const dbPath = join(dataDir, "bridge.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");
    createLegacyTaskTable(legacyDb);
    legacyDb.exec(`
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        taskId TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        "order" INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        completedAt TEXT,
        deadline TEXT
      );
    `);
    legacyDb.prepare(`
      INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, pinned, "order", createdAt, updatedAt)
      VALUES (?, ?, 'active', NULL, NULL, '', 0, 0, 0, ?, ?)
    `).run("task-1", "Migrated task", "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
    legacyDb.prepare(`
      INSERT INTO todos (id, taskId, text, done, "order", createdAt, completedAt, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "task-item",
      "task-1",
      "Task-scoped item",
      1,
      3,
      "2026-04-02T00:00:00.000Z",
      "2026-04-03T00:00:00.000Z",
      "2026-04-10",
    );
    legacyDb.prepare(`
      INSERT INTO todos (id, taskId, text, done, "order", createdAt, completedAt, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "global-item",
      null,
      "Global item",
      0,
      1,
      "2026-04-04T00:00:00.000Z",
      null,
      "2026-04-11",
    );
    legacyDb.close();

    const db = openDatabase(dataDir);
    const migratedRows = db.prepare(`
      SELECT id, taskId, text, done, "order", createdAt, completedAt, deadline
      FROM checklist_items
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get()).toBeUndefined();
    expect(migratedRows).toEqual([
      {
        id: "global-item",
        taskId: null,
        text: "Global item",
        done: 0,
        order: 1,
        createdAt: "2026-04-04T00:00:00.000Z",
        completedAt: null,
        deadline: "2026-04-11",
      },
      {
        id: "task-item",
        taskId: "task-1",
        text: "Task-scoped item",
        done: 1,
        order: 3,
        createdAt: "2026-04-02T00:00:00.000Z",
        completedAt: "2026-04-03T00:00:00.000Z",
        deadline: "2026-04-10",
      },
    ]);

    db.prepare("DELETE FROM tasks WHERE id = ?").run("task-1");
    const remainingRows = db.prepare(`
      SELECT id, taskId, text
      FROM checklist_items
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    expect(remainingRows).toEqual([
      { id: "global-item", taskId: null, text: "Global item" },
    ]);

    db.close();
  });

  it("normalizes partially migrated checklist_items to allow global items and deadlines", () => {
    const dataDir = createTempDataDir();
    const dbPath = join(dataDir, "bridge.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");
    createLegacyTaskTable(legacyDb);
    legacyDb.exec(`
      CREATE TABLE checklist_items (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        "order" INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        completedAt TEXT
      );
    `);
    legacyDb.prepare(`
      INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, pinned, "order", createdAt, updatedAt)
      VALUES (?, ?, 'active', NULL, NULL, '', 0, 0, 0, ?, ?)
    `).run("task-2", "Normalized task", "2026-04-05T00:00:00.000Z", "2026-04-05T00:00:00.000Z");
    legacyDb.prepare(`
      INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "existing-item",
      "task-2",
      "Existing item",
      0,
      0,
      "2026-04-06T00:00:00.000Z",
      null,
    );
    legacyDb.close();

    const db = openDatabase(dataDir);
    const checklistItemCols = db.prepare("PRAGMA table_info(checklist_items)").all() as Array<{ name: string; notnull: number }>;
    expect(checklistItemCols.some((column) => column.name === "deadline")).toBe(true);
    expect(checklistItemCols.find((column) => column.name === "taskId")?.notnull).toBe(0);

    db.prepare(`
      INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, completedAt, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "new-global-item",
      null,
      "New global item",
      0,
      1,
      "2026-04-07T00:00:00.000Z",
      null,
      "2026-04-12",
    );

    const rows = db.prepare(`
      SELECT id, taskId, text, deadline
      FROM checklist_items
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { id: "existing-item", taskId: "task-2", text: "Existing item", deadline: null },
      { id: "new-global-item", taskId: null, text: "New global item", deadline: "2026-04-12" },
    ]);

    db.close();
  });
});
