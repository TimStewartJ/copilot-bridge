import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db.js";
import { createGlobalBus } from "../global-bus.js";
import { createTaskStore } from "../task-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(join(process.cwd(), ".kind-schema-test-data"), { recursive: true, force: true });
});

function createLocalDataDir(): string {
  const dir = join(process.cwd(), ".kind-schema-test-data", crypto.randomUUID());
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("database task kind migration", () => {
  it("adds kind to legacy task tables, removes pinned, and preserves existing rows", () => {
    const dataDir = createLocalDataDir();
    const dbPath = join(dataDir, "bridge.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");
    legacyDb.exec(`
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
    legacyDb.prepare(`
      INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, pinned, "order", createdAt, updatedAt)
      VALUES (?, ?, 'active', NULL, NULL, '', 0, ?, ?, ?, ?)
    `).run("legacy-task", "Migrated task", 0, 0, "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
    legacyDb.prepare(`
      INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, pinned, "order", createdAt, updatedAt)
      VALUES (?, ?, 'active', NULL, NULL, '', 0, ?, ?, ?, ?)
    `).run("legacy-pinned", "Migrated pinned task", 1, 1, "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
    legacyDb.close();

    const db = openDatabase(dataDir);
    const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(taskCols.some((column) => column.name === "kind")).toBe(true);
    expect(taskCols.some((column) => column.name === "pinned")).toBe(false);
    const taskIndexes = db.prepare("PRAGMA index_list(tasks)").all() as Array<{ name: string }>;
    expect(taskIndexes.some((index) => index.name === "idx_tasks_status")).toBe(true);

    const migratedRows = db.prepare(`
      SELECT id, title, kind, status, priority, "order", createdAt, updatedAt
      FROM tasks
      WHERE id IN ('legacy-pinned', 'legacy-task')
      ORDER BY id
    `).all();
    expect(migratedRows).toEqual([
      {
        id: "legacy-pinned",
        title: "Migrated pinned task",
        kind: "ongoing",
        status: "active",
        priority: 0,
        order: 1,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      {
        id: "legacy-task",
        title: "Migrated task",
        kind: "task",
        status: "active",
        priority: 0,
        order: 0,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ]);
    db.close();
  });

  it("repairs legacy invalid ongoing rows so they can be edited again", () => {
    const dataDir = createLocalDataDir();
    const dbPath = join(dataDir, "bridge.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task',
        status TEXT NOT NULL DEFAULT 'active',
        groupId TEXT,
        cwd TEXT,
        notes TEXT NOT NULL DEFAULT '',
        doneWhen TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        "order" INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    legacyDb.prepare(`
      INSERT INTO tasks (id, title, kind, status, groupId, cwd, notes, doneWhen, priority, pinned, "order", createdAt, updatedAt)
      VALUES (?, ?, ?, ?, NULL, NULL, '', ?, 0, 0, ?, ?, ?)
    `).run(
      "legacy-ongoing-done",
      "Legacy ongoing done",
      "ongoing",
      "done",
      "Already finished",
      3,
      "2026-04-02T00:00:00.000Z",
      "2026-04-02T00:00:00.000Z",
    );
    legacyDb.prepare(`
      INSERT INTO tasks (id, title, kind, status, groupId, cwd, notes, doneWhen, priority, pinned, "order", createdAt, updatedAt)
      VALUES (?, ?, ?, ?, NULL, NULL, '', ?, 0, 0, ?, ?, ?)
    `).run(
      "legacy-ongoing-paused",
      "Legacy ongoing paused",
      "ongoing",
      "paused",
      "Needs cleanup",
      4,
      "2026-04-03T00:00:00.000Z",
      "2026-04-03T00:00:00.000Z",
    );
    legacyDb.close();

    const db = openDatabase(dataDir);
    const repairedRows = db.prepare(`
      SELECT id, status, doneWhen
      FROM tasks
      WHERE id IN ('legacy-ongoing-done', 'legacy-ongoing-paused')
      ORDER BY id
    `).all() as Array<{ id: string; status: string; doneWhen: string | null }>;
    expect(repairedRows).toEqual([
      { id: "legacy-ongoing-done", status: "active", doneWhen: null },
      { id: "legacy-ongoing-paused", status: "active", doneWhen: null },
    ]);

    const store = createTaskStore(db, createGlobalBus());
    expect(store.updateTask("legacy-ongoing-done", { notes: "Edited after repair" })).toMatchObject({
      kind: "ongoing",
      status: "active",
      doneWhen: undefined,
      notes: "Edited after repair",
    });
    expect(store.updateTask("legacy-ongoing-paused", { waitingOn: "Vendor reply" })).toMatchObject({
      kind: "ongoing",
      status: "active",
      doneWhen: undefined,
      waitingOn: "Vendor reply",
    });

    db.close();
  });
});
