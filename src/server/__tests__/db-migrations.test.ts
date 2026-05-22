import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { listDatabaseMigrations, runDatabaseMigrations } from "../db-migrations.js";
import { makeTestDir } from "./helpers.js";

function createTempDataDir(): string {
  return makeTestDir("db-migrations");
}

function listRecordedMigrations(dataDir: string) {
  const db = openDatabase(dataDir);
  const rows = db.prepare(`
    SELECT id, appliedAt
    FROM schema_migrations
    ORDER BY id
  `).all() as Array<{
    id: string;
    appliedAt: string;
  }>;
  db.close();
  return rows;
}

function createLegacySessionTables(db: ReturnType<typeof openDatabase>): void {
  db.exec(`
    CREATE TABLE session_meta (
      sessionId TEXT PRIMARY KEY,
      archived INTEGER NOT NULL DEFAULT 0,
      archivedAt TEXT,
      triggeredBy TEXT,
      scheduleId TEXT,
      scheduleName TEXT,
      lastVisibleActivityAt TEXT
    );
    CREATE TABLE session_titles (
      sessionId TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE session_workspace (
      sessionId TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function createExecFailureDb(db: DatabaseSync, shouldFail: (sql: string) => boolean): DatabaseSync {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return (sql: string) => {
          const normalized = normalizeSql(sql);
          if (shouldFail(normalized)) throw new Error(`Injected migration failure before: ${normalized}`);
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
}

function sqliteTableExists(db: DatabaseSync, tableName: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function columnNames(db: DatabaseSync, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function columnType(db: DatabaseSync, tableName: string, columnName: string): string | undefined {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>)
    .find((column) => column.name === columnName)?.type;
}

function replaceTasksWithLegacyPinnedTable(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("DROP TABLE tasks");
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
    db.prepare(`
      INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, pinned, "order", createdAt, updatedAt)
      VALUES ('legacy-paused-pinned', 'Legacy paused pinned', 'paused', NULL, NULL, '', 0, 1, 0, ?, ?)
    `).run("2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function replaceTaskWorkItemsWithIntegerIds(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO tasks (id, title, kind, muted, status, notes, priority, "order", createdAt, updatedAt)
    VALUES ('work-item-task', 'Work item task', 'task', 0, 'active', '', 0, 0, ?, ?)
  `).run("2026-05-02T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
  db.exec("DROP TABLE task_work_items");
  db.exec(`
    CREATE TABLE task_work_items (
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      itemId INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'ado',
      PRIMARY KEY (taskId, itemId, provider)
    );
  `);
  db.prepare("INSERT INTO task_work_items (taskId, itemId, provider) VALUES ('work-item-task', 12345, 'ado')").run();
}

describe("database migration registry", () => {
  it("keeps the compatibility migration order explicit", () => {
    expect(listDatabaseMigrations().map((migration) => migration.id)).toEqual([
      "mcp-registry-from-legacy-settings-and-tag-configs",
      "tag-name-key-normalization",
      "task-sessions-linked-at-column",
      "session-meta-last-visible-activity-column",
      "bridge-session-state-last-attention-column",
      "bridge_session_state_legacy_backfill_v1",
      "schedule-auto-archive-keep-column",
      "feed-cards-visual-json-column",
      "feed-cards-action-json-column",
      "schedule-reuse-columns-drop-v1",
      "schedule_runs_legacy_backfill_v1",
      "checklist-items-from-legacy-todos",
      "task-groups-notes-column",
      "tasks-kind-momentum-and-status-repair",
      "task-work-items-text-item-id",
    ]);
  });

  it("declares the every-open transaction contract explicitly", () => {
    const transactionsById = Object.fromEntries(
      listDatabaseMigrations()
        .filter((migration) => migration.runMode === "every-open")
        .map((migration) => [migration.id, migration.transaction]),
    );

    expect(transactionsById).toEqual({
      "mcp-registry-from-legacy-settings-and-tag-configs": "self",
      "tag-name-key-normalization": "auto",
      "task-sessions-linked-at-column": "auto",
      "session-meta-last-visible-activity-column": "auto",
      "bridge-session-state-last-attention-column": "auto",
      "schedule-auto-archive-keep-column": "auto",
      "feed-cards-visual-json-column": "auto",
      "feed-cards-action-json-column": "auto",
      "checklist-items-from-legacy-todos": "self",
      "task-groups-notes-column": "auto",
      "tasks-kind-momentum-and-status-repair": "self",
      "task-work-items-text-item-id": "auto",
    });
  });

  it("uses schema_migrations to gate one-time backfills without hiding the full registry", () => {
    const dataDir = createTempDataDir();
    const expectedOneShotMigrations = listDatabaseMigrations()
      .filter((migration) => migration.runMode === "once")
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    const firstRows = listRecordedMigrations(dataDir);
    expect(firstRows.map((row) => row.id)).toEqual(expectedOneShotMigrations.map((migration) => migration.id));
    for (const row of firstRows) {
      expect(Date.parse(row.appliedAt)).not.toBeNaN();
    }

    const secondRows = listRecordedMigrations(dataDir);
    expect(secondRows).toEqual(firstRows);
  });

  it("does not rerun one-time backfills when legacy rows remain", () => {
    const dataDir = createTempDataDir();
    const sessionId = "legacy-session";
    const now = "2026-05-08T00:00:00.000Z";
    let db = openDatabase(dataDir);
    db.prepare(`
      INSERT INTO bridge_session_state (sessionId, archived, titleOverride, pinnedCwd, createdAt, updatedAt)
      VALUES (?, 0, 'canonical-title', '/canonical-workspace', ?, ?)
    `).run(sessionId, now, now);
    createLegacySessionTables(db);
    db.prepare(`
      INSERT INTO session_meta (sessionId, archived, archivedAt, triggeredBy, scheduleId, scheduleName, lastVisibleActivityAt)
      VALUES (?, 1, ?, 'schedule', 'legacy-schedule', 'Legacy schedule', ?)
    `).run(sessionId, now, now);
    db.prepare("INSERT INTO session_titles (sessionId, title) VALUES (?, 'legacy-title')").run(sessionId);
    db.prepare("INSERT INTO session_workspace (sessionId, cwd, updatedAt) VALUES (?, '/legacy-workspace', ?)").run(sessionId, now);
    db.prepare(`
      INSERT INTO schedules (id, taskId, name, prompt, type, lastSessionId, createdAt, updatedAt)
      VALUES ('legacy-schedule', 'task-id', 'Legacy schedule', 'prompt', 'once', ?, ?, ?)
    `).run(sessionId, now, now);
    db.close();

    db = openDatabase(dataDir);
    const state = db.prepare(`
      SELECT archived, archivedAt, titleOverride, pinnedCwd, scheduleId
      FROM bridge_session_state
      WHERE sessionId = ?
    `).get(sessionId);
    const scheduleRunCount = (db.prepare("SELECT COUNT(*) AS count FROM schedule_runs").get() as { count: number }).count;
    db.close();

    expect(state).toMatchObject({
      archived: 0,
      archivedAt: null,
      titleOverride: "canonical-title",
      pinnedCwd: "/canonical-workspace",
      scheduleId: null,
    });
    expect(scheduleRunCount).toBe(0);
  });

  it("adds lastAttentionAt before creating its index on existing bridge session state tables", () => {
    const dataDir = createTempDataDir();
    const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
    legacyDb.exec(`
      CREATE TABLE bridge_session_state (
        sessionId TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 0,
        archivedAt TEXT,
        titleOverride TEXT,
        titleOverrideUpdatedAt TEXT,
        pinnedCwd TEXT,
        pinnedCwdUpdatedAt TEXT,
        triggeredBy TEXT,
        scheduleId TEXT,
        scheduleName TEXT,
        lastVisibleActivityAt TEXT,
        hiddenReason TEXT,
        hiddenAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    legacyDb.close();

    const db = openDatabase(dataDir);
    const columns = db.prepare("PRAGMA table_info(bridge_session_state)").all() as Array<{ name: string }>;
    const indexes = db.prepare("PRAGMA index_list(bridge_session_state)").all() as Array<{ name: string }>;
    db.close();

    expect(columns.map((column) => column.name)).toContain("lastAttentionAt");
    expect(indexes.map((index) => index.name)).toContain("idx_bridge_session_state_lastAttentionAt");
  });

  it("adds visualJson and actionJson to existing feed_cards tables", () => {
    const dataDir = createTempDataDir();
    const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
    legacyDb.exec(`
      CREATE TABLE feed_cards (
        id TEXT PRIMARY KEY,
        dedupeKey TEXT,
        title TEXT NOT NULL,
        body TEXT,
        kind TEXT NOT NULL DEFAULT 'note',
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'active',
        taskId TEXT,
        sessionId TEXT,
        url TEXT,
        linksJson TEXT NOT NULL DEFAULT '[]',
        metadataJson TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        statusChangedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO feed_cards (
        id, title, kind, priority, status, linksJson, pinned, statusChangedAt, createdAt, updatedAt
      ) VALUES (
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        'Legacy feed card',
        'note',
        'normal',
        'active',
        '[]',
        0,
        '2026-05-13T10:00:00.000Z',
        '2026-05-13T10:00:00.000Z',
        '2026-05-13T10:00:00.000Z'
      );
    `);
    legacyDb.close();

    const db = openDatabase(dataDir);
    const columns = db.prepare("PRAGMA table_info(feed_cards)").all() as Array<{ name: string }>;
    const row = db.prepare("SELECT title, visualJson, actionJson FROM feed_cards").get() as {
      title: string;
      visualJson: string | null;
      actionJson: string | null;
    };
    db.close();

    expect(columns.map((column) => column.name)).toContain("visualJson");
    expect(columns.map((column) => column.name)).toContain("actionJson");
    expect(row).toEqual({ title: "Legacy feed card", visualJson: null, actionJson: null });
  });

  it("rolls back the self-transactional task schema repair after an injected table rebuild failure", () => {
    const dataDir = createTempDataDir();
    const db = openDatabase(dataDir);
    replaceTasksWithLegacyPinnedTable(db);

    const flakyDb = createExecFailureDb(db, (sql) => sql === "DROP TABLE tasks");
    expect(() => runDatabaseMigrations(flakyDb)).toThrow(/tasks-kind-momentum-and-status-repair/);

    expect(sqliteTableExists(db, "tasks_new")).toBe(false);
    expect(columnNames(db, "tasks")).toEqual([
      "id",
      "title",
      "status",
      "groupId",
      "cwd",
      "notes",
      "priority",
      "pinned",
      "order",
      "createdAt",
      "updatedAt",
    ]);
    expect(db.prepare("SELECT status, pinned FROM tasks WHERE id = 'legacy-paused-pinned'").get()).toEqual({
      status: "paused",
      pinned: 1,
    });
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);

    runDatabaseMigrations(db);
    expect(sqliteTableExists(db, "tasks_new")).toBe(false);
    expect(columnNames(db, "tasks")).not.toContain("pinned");
    expect(db.prepare("SELECT kind, muted, status FROM tasks WHERE id = 'legacy-paused-pinned'").get()).toEqual({
      kind: "ongoing",
      muted: 0,
      status: "active",
    });

    runDatabaseMigrations(db);
    db.close();
  });

  it("rolls back a centrally wrapped every-open work item rebuild and reruns cleanly", () => {
    const dataDir = createTempDataDir();
    const db = openDatabase(dataDir);
    replaceTaskWorkItemsWithIntegerIds(db);

    const flakyDb = createExecFailureDb(db, (sql) => sql === "DROP TABLE task_work_items");
    expect(() => runDatabaseMigrations(flakyDb)).toThrow(/task-work-items-text-item-id/);

    expect(sqliteTableExists(db, "task_work_items_new")).toBe(false);
    expect(columnType(db, "task_work_items", "itemId")).toBe("INTEGER");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(db.prepare("SELECT taskId, itemId, provider FROM task_work_items").get()).toEqual({
      taskId: "work-item-task",
      itemId: 12345,
      provider: "ado",
    });

    runDatabaseMigrations(db);
    expect(sqliteTableExists(db, "task_work_items_new")).toBe(false);
    expect(columnType(db, "task_work_items", "itemId")).toBe("TEXT");
    expect(db.prepare("SELECT taskId, itemId, provider FROM task_work_items").get()).toEqual({
      taskId: "work-item-task",
      itemId: "12345",
      provider: "ado",
    });

    runDatabaseMigrations(db);
    db.close();
  });
});
