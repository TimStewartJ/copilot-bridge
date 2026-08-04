import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../db.js";
import { listDatabaseMigrations, runDatabaseMigrations } from "../db-migrations.js";
import { makeTestDir } from "./helpers.js";
import { createSettingsStore } from "../settings-store.js";
import { createGlobalBus } from "../global-bus.js";
import { createTaskStore } from "../task-store.js";

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
      "bridge-session-state-terminal-overlay-column",
      "bridge_session_state_legacy_backfill_v1",
      "schedule-auto-archive-keep-column",
      "schedule-model-column",
      "feed-cards-visual-json-column",
      "feed-cards-action-json-column",
      "schedule-reuse-columns-drop-v1",
      "schedule_runs_legacy_backfill_v1",
      "legacy_session_overlay_tables_drop_v1",
      "checklist-items-from-legacy-todos",
      "task-groups-notes-column",
      "tasks-kind-momentum-and-status-repair",
      "task-work-items-text-item-id",
      "task-work-items-canonicalize-item-id",
      "voice-jobs-task-foreign-key",
      "session-context-telemetry-tables",
      "copilot-model-prices-table",
      "copilot-usage-cache-tables",
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
      "bridge-session-state-terminal-overlay-column": "auto",
      "schedule-auto-archive-keep-column": "auto",
      "schedule-model-column": "auto",
      "feed-cards-visual-json-column": "auto",
      "feed-cards-action-json-column": "auto",
      "checklist-items-from-legacy-todos": "self",
      "task-groups-notes-column": "auto",
      "tasks-kind-momentum-and-status-repair": "self",
      "task-work-items-text-item-id": "auto",
      "voice-jobs-task-foreign-key": "self",
      "session-context-telemetry-tables": "auto",
      "copilot-model-prices-table": "auto",
      "copilot-usage-cache-tables": "auto",
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

  it("drops orphaned legacy session tables only after their backfills land", () => {
    const dataDir = createTempDataDir();
    const sessionId = "drop-legacy-session";
    const now = "2026-05-09T00:00:00.000Z";

    // Seed a pre-migration database so the one-time backfills see legacy rows.
    const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
    createLegacySessionTables(legacyDb);
    legacyDb.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        type TEXT NOT NULL,
        cron TEXT,
        runAt TEXT,
        timezone TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        lastSessionId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastRunAt TEXT,
        nextRunAt TEXT,
        runCount INTEGER NOT NULL DEFAULT 0,
        maxRuns INTEGER,
        expiresAt TEXT
      );
    `);
    legacyDb.prepare(`
      INSERT INTO session_meta (sessionId, archived, archivedAt, triggeredBy, scheduleId, scheduleName, lastVisibleActivityAt)
      VALUES (?, 1, ?, 'schedule', 'legacy-schedule', 'Legacy schedule', ?)
    `).run(sessionId, now, now);
    legacyDb.prepare("INSERT INTO session_workspace (sessionId, cwd, updatedAt) VALUES (?, '/legacy-workspace', ?)")
      .run(sessionId, now);
    legacyDb.prepare(`
      INSERT INTO schedules (id, taskId, name, prompt, type, lastSessionId, createdAt, updatedAt)
      VALUES ('legacy-schedule', 'task-id', 'Legacy schedule', 'prompt', 'once', ?, ?, ?)
    `).run(sessionId, now, now);
    legacyDb.close();

    let db = openDatabase(dataDir);
    const state = db.prepare(`
      SELECT archived, archivedAt, pinnedCwd, scheduleId, scheduleName
      FROM bridge_session_state
      WHERE sessionId = ?
    `).get(sessionId);
    const scheduleRunCount = (db.prepare("SELECT COUNT(*) AS count FROM schedule_runs WHERE sessionId = ?")
      .get(sessionId) as { count: number }).count;
    const legacyMetaExists = sqliteTableExists(db, "session_meta");
    const legacyWorkspaceExists = sqliteTableExists(db, "session_workspace");
    db.close();

    // Backfilled data survived the drop.
    expect(state).toMatchObject({
      archived: 1,
      archivedAt: now,
      pinnedCwd: "/legacy-workspace",
      scheduleId: "legacy-schedule",
      scheduleName: "Legacy schedule",
    });
    expect(scheduleRunCount).toBe(1);
    expect(legacyMetaExists).toBe(false);
    expect(legacyWorkspaceExists).toBe(false);

    // Idempotent: reopening does not recreate or re-drop the tables.
    db = openDatabase(dataDir);
    expect(sqliteTableExists(db, "session_meta")).toBe(false);
    expect(sqliteTableExists(db, "session_workspace")).toBe(false);
    db.close();

    expect(listRecordedMigrations(dataDir).map((row) => row.id))
      .toContain("legacy_session_overlay_tables_drop_v1");
  });

  it("is a no-op on a fresh database that never had the legacy tables", () => {
    const dataDir = createTempDataDir();
    const db = openDatabase(dataDir);
    expect(sqliteTableExists(db, "session_meta")).toBe(false);
    expect(sqliteTableExists(db, "session_workspace")).toBe(false);
    db.close();
    expect(listRecordedMigrations(dataDir).map((row) => row.id))
      .toContain("legacy_session_overlay_tables_drop_v1");
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

// ── Merged from db-bridge-session-state-migration.test.ts ────────────────────
describe("bridge session state legacy backfill (merged)", () => {
  const bssDirs: string[] = [];
  function createBssTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bridge-session-state-migration-"));
    bssDirs.push(dir);
    return dir;
  }
  function cleanupBssDirs() {
    for (const dir of bssDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }

  function createLegacyBssSessionTables(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE session_meta (
        sessionId TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 0,
        archivedAt TEXT,
        triggeredBy TEXT,
        scheduleId TEXT,
        scheduleName TEXT
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

  it("does not create legacy session metadata tables for fresh databases", () => {
    const dataDir = createBssTempDir();
    try {
      const db = openDatabase(dataDir);
      expect(db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('session_meta', 'session_titles', 'session_workspace')
        ORDER BY name
      `).all()).toEqual([]);
      db.close();
    } finally {
      cleanupBssDirs();
    }
  });

  it("imports legacy session metadata once without letting stale legacy rows overwrite later overlay changes", () => {
    const dataDir = createBssTempDir();
    try {
      const dbPath = join(dataDir, "bridge.db");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec("PRAGMA foreign_keys = ON");
      createLegacyBssSessionTables(legacyDb);
      legacyDb.prepare(`
        INSERT INTO session_meta (sessionId, archived, archivedAt, triggeredBy, scheduleId, scheduleName)
        VALUES (?, 1, ?, 'schedule', ?, ?)
      `).run("session-1", "2026-05-01T00:00:00.000Z", "sched-1", "Legacy schedule");
      legacyDb.prepare("INSERT INTO session_titles (sessionId, title) VALUES (?, ?)").run("session-1", "Legacy title");
      legacyDb.prepare("INSERT INTO session_workspace (sessionId, cwd, updatedAt) VALUES (?, ?, ?)").run("session-1", "D:\\legacy", "2026-05-01T00:00:00.000Z");
      legacyDb.close();

      let db = openDatabase(dataDir);
      expect(db.prepare(`
        SELECT archived, archivedAt, titleOverride, pinnedCwd, scheduleId, scheduleName
        FROM bridge_session_state WHERE sessionId = ?
      `).get("session-1")).toEqual({
        archived: 1, archivedAt: "2026-05-01T00:00:00.000Z",
        titleOverride: "Legacy title", pinnedCwd: "D:\\legacy",
        scheduleId: "sched-1", scheduleName: "Legacy schedule",
      });

      db.prepare(`
        UPDATE bridge_session_state
        SET archived = 0, archivedAt = NULL, titleOverride = 'New title',
            pinnedCwd = 'D:\\new', pinnedCwdUpdatedAt = '2026-05-02T00:00:00.000Z',
            updatedAt = '2026-05-02T00:00:00.000Z'
        WHERE sessionId = ?
      `).run("session-1");
      db.close();

      db = openDatabase(dataDir);
      expect(db.prepare(`
        SELECT archived, archivedAt, titleOverride, pinnedCwd, scheduleId, scheduleName
        FROM bridge_session_state WHERE sessionId = ?
      `).get("session-1")).toEqual({
        archived: 0, archivedAt: null,
        titleOverride: "New title", pinnedCwd: "D:\\new",
        scheduleId: "sched-1", scheduleName: "Legacy schedule",
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get("bridge_session_state_legacy_backfill_v1")).toEqual({ count: 1 });
      db.close();
    } finally {
      cleanupBssDirs();
    }
  });
});

// ── Merged from db-checklist-migration.test.ts ────────────────────────────────
describe("database checklist migration (merged)", () => {
  const chkDirs: string[] = [];
  function createChkTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bridge-db-migration-"));
    chkDirs.push(dir);
    return dir;
  }
  function cleanupChkDirs() {
    for (const dir of chkDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }

  function createChkLegacyTaskTable(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        groupId TEXT,
        cwd TEXT,
        notes TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0,
        "order" INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  it("migrates legacy todos into checklist_items without losing checklist data", () => {
    const dataDir = createChkTempDir();
    try {
      const dbPath = join(dataDir, "bridge.db");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec("PRAGMA foreign_keys = ON");
      createChkLegacyTaskTable(legacyDb);
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
        INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, "order", createdAt, updatedAt)
        VALUES (?, ?, 'active', NULL, NULL, '', 0, 0, ?, ?)
      `).run("task-1", "Migrated task", "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
      legacyDb.prepare(`
        INSERT INTO todos (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("task-item", "task-1", "Task-scoped item", 1, 3, "2026-04-02T00:00:00.000Z", "2026-04-03T00:00:00.000Z", "2026-04-10");
      legacyDb.prepare(`
        INSERT INTO todos (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("global-item", null, "Global item", 0, 1, "2026-04-04T00:00:00.000Z", null, "2026-04-11");
      legacyDb.close();

      const db = openDatabase(dataDir);
      const migratedRows = db.prepare(`
        SELECT id, taskId, text, done, "order", createdAt, completedAt, deadline
        FROM checklist_items ORDER BY id
      `).all() as Array<Record<string, unknown>>;

      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get()).toBeUndefined();
      expect(migratedRows).toEqual([
        { id: "global-item", taskId: null, text: "Global item", done: 0, order: 1, createdAt: "2026-04-04T00:00:00.000Z", completedAt: null, deadline: "2026-04-11" },
        { id: "task-item", taskId: "task-1", text: "Task-scoped item", done: 1, order: 3, createdAt: "2026-04-02T00:00:00.000Z", completedAt: "2026-04-03T00:00:00.000Z", deadline: "2026-04-10" },
      ]);

      db.prepare("DELETE FROM tasks WHERE id = ?").run("task-1");
      expect(db.prepare("SELECT id, taskId, text FROM checklist_items ORDER BY id").all()).toEqual([
        { id: "global-item", taskId: null, text: "Global item" },
      ]);
      db.close();
    } finally {
      cleanupChkDirs();
    }
  });

  it("normalizes partially migrated checklist_items to allow global items and deadlines", () => {
    const dataDir = createChkTempDir();
    try {
      const dbPath = join(dataDir, "bridge.db");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec("PRAGMA foreign_keys = ON");
      createChkLegacyTaskTable(legacyDb);
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
        INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, "order", createdAt, updatedAt)
        VALUES (?, ?, 'active', NULL, NULL, '', 0, 0, ?, ?)
      `).run("task-2", "Normalized task", "2026-04-05T00:00:00.000Z", "2026-04-05T00:00:00.000Z");
      legacyDb.prepare(`
        INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, completedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("existing-item", "task-2", "Existing item", 0, 0, "2026-04-06T00:00:00.000Z", null);
      legacyDb.close();

      const db = openDatabase(dataDir);
      const checklistItemCols = db.prepare("PRAGMA table_info(checklist_items)").all() as Array<{ name: string; notnull: number }>;
      expect(checklistItemCols.some((column) => column.name === "deadline")).toBe(true);
      expect(checklistItemCols.find((column) => column.name === "taskId")?.notnull).toBe(0);

      db.prepare(`
        INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("new-global-item", null, "New global item", 0, 1, "2026-04-07T00:00:00.000Z", null, "2026-04-12");

      expect(db.prepare("SELECT id, taskId, text, deadline FROM checklist_items ORDER BY id").all()).toEqual([
        { id: "existing-item", taskId: "task-2", text: "Existing item", deadline: null },
        { id: "new-global-item", taskId: null, text: "New global item", deadline: "2026-04-12" },
      ]);
      db.close();
    } finally {
      cleanupChkDirs();
    }
  });

  it("preserves a colliding legacy todo whose content differs from the checklist row", () => {
    const dataDir = createChkTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
      legacyDb.exec("PRAGMA foreign_keys = ON");
      createChkLegacyTaskTable(legacyDb);
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
        CREATE TABLE checklist_items (
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
        INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, "order", createdAt, updatedAt)
        VALUES (?, ?, 'active', NULL, NULL, '', 0, 0, ?, ?)
      `).run("task-3", "Collision task", "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
      // Same id in both tables with different content: the old INSERT OR IGNORE
      // dropped the legacy payload silently.
      legacyDb.prepare(`
        INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("shared-id", "task-3", "Destination text", 0, 0, "2026-04-06T00:00:00.000Z", null, null);
      legacyDb.prepare(`
        INSERT INTO todos (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("shared-id", "task-3", "Legacy text worth keeping", 1, 5, "2026-04-02T00:00:00.000Z", "2026-04-03T00:00:00.000Z", "2026-04-10");
      // An identical collision must NOT be duplicated.
      legacyDb.prepare(`
        INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("identical-id", "task-3", "Same", 0, 2, "2026-04-06T00:00:00.000Z", null, null);
      legacyDb.prepare(`
        INSERT INTO todos (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("identical-id", "task-3", "Same", 0, 2, "2026-04-06T00:00:00.000Z", null, null);
      legacyDb.close();

      const db = openDatabase(dataDir);
      const rows = db.prepare(`
        SELECT id, text, done, "order", deadline FROM checklist_items ORDER BY text
      `).all() as Array<{ id: string; text: string; done: number; order: number; deadline: string | null }>;

      // Destination rows stay authoritative and keep their ids.
      expect(rows.filter((row) => row.id === "shared-id").map((row) => row.text)).toEqual(["Destination text"]);
      expect(rows.filter((row) => row.id === "identical-id")).toHaveLength(1);
      // The differing legacy row survived under a fresh id.
      const preserved = rows.find((row) => row.text === "Legacy text worth keeping");
      expect(preserved).toBeDefined();
      expect(preserved!.id).not.toBe("shared-id");
      expect(preserved!.done).toBe(1);
      expect(preserved!.deadline).toBe("2026-04-10");
      expect(rows).toHaveLength(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Preserved 1 legacy todo row(s)"));
      db.close();
    } finally {
      warn.mockRestore();
      cleanupChkDirs();
    }
  });
});

// ── Merged from db-mcp-registry-migration.test.ts ─────────────────────────────
describe("database MCP registry migration (merged)", () => {
  const mcpDirs: string[] = [];
  function createMcpLocalDataDir(): string {
    const dir = join(process.cwd(), ".mcp-registry-test-data", crypto.randomUUID());
    mkdirSync(dir, { recursive: true });
    mcpDirs.push(dir);
    return dir;
  }
  function cleanupMcpDirs() {
    for (const dir of mcpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), ".mcp-registry-test-data"), { recursive: true, force: true });
  }

  function mcpInsertTag(db: DatabaseSync, id: string, name: string): void {
    db.prepare(`
      INSERT INTO tags (id, name, color, instructions, "order", createdAt, updatedAt)
      VALUES (?, ?, 'slate', '', 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
    `).run(id, name);
  }

  function mcpSelectServers(db: DatabaseSync) {
    return db.prepare(`
      SELECT id, name, config, enabledByDefault, createdAt, updatedAt
      FROM mcp_servers ORDER BY name COLLATE NOCASE
    `).all() as Array<{ id: string; name: string; config: string; enabledByDefault: number; createdAt: string; updatedAt: string }>;
  }

  function mcpSelectRefs(db: DatabaseSync) {
    return db.prepare(`
      SELECT refs.tagId, refs.serverId, ms.name AS serverName, ms.config
      FROM tag_mcp_server_refs refs
      JOIN mcp_servers ms ON ms.id = refs.serverId
      ORDER BY refs.tagId, ms.name COLLATE NOCASE
    `).all() as Array<{ tagId: string; serverId: string; serverName: string; config: string }>;
  }

  it("promotes legacy settings and tag MCP configs into the canonical registry idempotently", () => {
    const dataDir = createMcpLocalDataDir();
    try {
      const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
      legacyDb.exec("PRAGMA foreign_keys = ON");
      legacyDb.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE tags (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          color TEXT NOT NULL DEFAULT 'slate', instructions TEXT NOT NULL DEFAULT '',
          "order" INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE tag_mcp_servers (
          tagId TEXT NOT NULL, serverName TEXT NOT NULL, config TEXT NOT NULL,
          PRIMARY KEY (tagId, serverName),
          FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
        );
      `);

      const globalConfig = { command: "global-mcp", args: ["--global"] };
      const sharedConfig = { type: "http" as const, url: "https://shared.example/mcp" };
      const overrideConfig = { command: "override-mcp", args: ["--tag"] };
      const tagOnlyConfig = { type: "sse" as const, url: "https://tag-only.example/sse" };

      legacyDb.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify({
        theme: "dark", mcpServers: { global: globalConfig, shared: sharedConfig },
      }));
      mcpInsertTag(legacyDb, "tag-shared", "Shared");
      mcpInsertTag(legacyDb, "tag-override", "Override");
      mcpInsertTag(legacyDb, "tag-only", "Tag only");
      legacyDb.prepare("INSERT INTO tag_mcp_servers (tagId, serverName, config) VALUES (?, ?, ?)").run("tag-shared", "shared", JSON.stringify(sharedConfig));
      legacyDb.prepare("INSERT INTO tag_mcp_servers (tagId, serverName, config) VALUES (?, ?, ?)").run("tag-override", "global", JSON.stringify(overrideConfig));
      legacyDb.prepare("INSERT INTO tag_mcp_servers (tagId, serverName, config) VALUES (?, ?, ?)").run("tag-only", "tag-only", JSON.stringify(tagOnlyConfig));
      legacyDb.close();

      const db = openDatabase(dataDir);
      const servers = mcpSelectServers(db);
      expect(servers).toHaveLength(4);
      expect(servers.map((server) => [server.name, server.enabledByDefault])).toEqual([
        ["global", 1],
        [expect.stringMatching(/^global \(tag override/), 0],
        ["shared", 1],
        ["tag-only", 0],
      ]);

      const global = servers.find((server) => server.name === "global")!;
      const shared = servers.find((server) => server.name === "shared")!;
      const override = servers.find((server) => server.name.startsWith("global (tag override"))!;
      const tagOnly = servers.find((server) => server.name === "tag-only")!;
      expect(JSON.parse(global.config)).toEqual(globalConfig);
      expect(JSON.parse(shared.config)).toEqual(sharedConfig);
      expect(JSON.parse(override.config)).toEqual(overrideConfig);
      expect(JSON.parse(tagOnly.config)).toEqual(tagOnlyConfig);

      expect(mcpSelectRefs(db).map((ref) => [ref.tagId, ref.serverName])).toEqual([
        ["tag-only", "tag-only"],
        ["tag-override", override.name],
        ["tag-shared", "shared"],
      ]);
      expect((db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_servers").get() as any).count).toBe(0);

      const rawSettings = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as any).value);
      expect(rawSettings).toEqual({ theme: "dark" });
      expect(createSettingsStore(db).getMcpServers()).toEqual({ global: globalConfig, shared: sharedConfig });

      const beforeServers = mcpSelectServers(db);
      const beforeRefs = mcpSelectRefs(db);
      db.close();

      const reopened = openDatabase(dataDir);
      expect(mcpSelectServers(reopened)).toEqual(beforeServers);
      expect(mcpSelectRefs(reopened)).toEqual(beforeRefs);
      reopened.close();
    } finally {
      cleanupMcpDirs();
    }
  });

  it("retains legacy tag rows it could not parse instead of deleting them", () => {
    const dataDir = createMcpLocalDataDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
      legacyDb.exec("PRAGMA foreign_keys = ON");
      legacyDb.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE tags (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          color TEXT NOT NULL DEFAULT 'slate', instructions TEXT NOT NULL DEFAULT '',
          "order" INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE tag_mcp_servers (
          tagId TEXT NOT NULL, serverName TEXT NOT NULL, config TEXT NOT NULL,
          PRIMARY KEY (tagId, serverName),
          FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
        );
      `);
      mcpInsertTag(legacyDb, "tag-good", "Good");
      mcpInsertTag(legacyDb, "tag-bad", "Bad");
      const goodConfig = { command: "good-mcp", args: ["--go"] };
      const insert = legacyDb.prepare("INSERT INTO tag_mcp_servers (tagId, serverName, config) VALUES (?, ?, ?)");
      insert.run("tag-good", "good", JSON.stringify(goodConfig));
      insert.run("tag-bad", "not-json", "{ this is not json");
      insert.run("tag-bad", "wrong-shape", JSON.stringify({ nonsense: true }));
      legacyDb.close();

      const db = openDatabase(dataDir);
      // The readable row migrated and was removed.
      expect(mcpSelectRefs(db).map((ref) => [ref.tagId, ref.serverName])).toEqual([["tag-good", "good"]]);
      // The unreadable rows survived rather than being silently destroyed.
      const retained = db.prepare("SELECT tagId, serverName, config FROM tag_mcp_servers ORDER BY serverName")
        .all() as Array<{ tagId: string; serverName: string; config: string }>;
      expect(retained.map((row) => row.serverName)).toEqual(["not-json", "wrong-shape"]);
      expect(retained[0]!.config).toBe("{ this is not json");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Retained 2 unreadable tag_mcp_servers row(s)"));
      db.close();
    } finally {
      warn.mockRestore();
      cleanupMcpDirs();
    }
  });
});

describe("task work item id canonicalization migration", () => {
  const workItemDirs: string[] = [];
  function createWorkItemDataDir(): string {
    const dir = join(process.cwd(), ".work-item-migration-test-data", crypto.randomUUID());
    mkdirSync(dir, { recursive: true });
    workItemDirs.push(dir);
    return dir;
  }
  function cleanupWorkItemDirs() {
    for (const dir of workItemDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), ".work-item-migration-test-data"), { recursive: true, force: true });
  }

  function seedWorkItems(dataDir: string, rows: Array<[taskId: string, itemId: string, provider: string]>): void {
    const db = openDatabase(dataDir);
    db.prepare(`
      INSERT INTO tasks (id, title, kind, status, notes, priority, "order", createdAt, updatedAt)
      VALUES ('task-1', 'Task', 'task', 'active', '', 0, 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
    `).run();
    const insert = db.prepare("INSERT OR IGNORE INTO task_work_items (taskId, itemId, provider) VALUES (?, ?, ?)");
    for (const [taskId, itemId, provider] of rows) insert.run(taskId, itemId, provider);
    // Reset the once-marker so the migration reruns against the seeded rows.
    db.prepare("DELETE FROM schema_migrations WHERE id = 'task-work-items-canonicalize-item-id'").run();
    db.close();
  }

  function readWorkItems(dataDir: string) {
    const db = openDatabase(dataDir);
    const rows = db.prepare("SELECT taskId, itemId, provider FROM task_work_items ORDER BY provider, itemId")
      .all() as Array<{ taskId: string; itemId: string; provider: string }>;
    db.close();
    return rows;
  }

  it("canonicalizes legacy ids and collapses duplicates without losing links", () => {
    const dataDir = createWorkItemDataDir();
    try {
      seedWorkItems(dataDir, [
        ["task-1", "https://github.com/octo/bridge/issues/12", "github"],
        // Same issue already stored canonically — the rewrite must collapse onto it.
        ["task-1", "octo/bridge#12", "github"],
        ["task-1", "#123", "ado"],
        ["task-1", "00456", "ado"],
        // Already canonical; must be left alone.
        ["task-1", "789", "ado"],
        ["task-1", "ENG-42", "linear"],
      ]);

      expect(readWorkItems(dataDir)).toEqual([
        { taskId: "task-1", itemId: "123", provider: "ado" },
        { taskId: "task-1", itemId: "456", provider: "ado" },
        { taskId: "task-1", itemId: "789", provider: "ado" },
        { taskId: "task-1", itemId: "octo/bridge#12", provider: "github" },
        { taskId: "task-1", itemId: "ENG-42", provider: "linear" },
      ]);
    } finally {
      cleanupWorkItemDirs();
    }
  });

  it("is idempotent and leaves already-canonical tables untouched", () => {
    const dataDir = createWorkItemDataDir();
    try {
      seedWorkItems(dataDir, [
        ["task-1", "octo/bridge#12", "github"],
        ["task-1", "123", "ado"],
      ]);
      const first = readWorkItems(dataDir);

      const db = openDatabase(dataDir);
      db.prepare("DELETE FROM schema_migrations WHERE id = 'task-work-items-canonicalize-item-id'").run();
      db.close();

      expect(readWorkItems(dataDir)).toEqual(first);
    } finally {
      cleanupWorkItemDirs();
    }
  });

  it("preserves numeric ids too large for double precision", () => {
    const dataDir = createWorkItemDataDir();
    try {
      seedWorkItems(dataDir, [["task-1", "0009007199254740993", "ado"]]);
      expect(readWorkItems(dataDir)).toEqual([
        { taskId: "task-1", itemId: "9007199254740993", provider: "ado" },
      ]);
    } finally {
      cleanupWorkItemDirs();
    }
  });
});

// ── Merged from db-task-kind-migration.test.ts ────────────────────────────────
describe("database task kind migration (merged)", () => {
  const kindDirs: string[] = [];
  function createKindLocalDataDir(): string {
    const dir = join(process.cwd(), ".kind-schema-test-data", crypto.randomUUID());
    mkdirSync(dir, { recursive: true });
    kindDirs.push(dir);
    return dir;
  }
  function cleanupKindDirs() {
    for (const dir of kindDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), ".kind-schema-test-data"), { recursive: true, force: true });
  }

  it("repairs legacy invalid ongoing rows so they can be edited again", () => {
    const dataDir = createKindLocalDataDir();
    try {
      const dbPath = join(dataDir, "bridge.db");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec("PRAGMA foreign_keys = ON");
      legacyDb.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'task', status TEXT NOT NULL DEFAULT 'active',
          groupId TEXT, cwd TEXT, notes TEXT NOT NULL DEFAULT '',
          doneWhen TEXT, completedAt TEXT,
          priority INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
          "order" INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO tasks (id, title, kind, status, groupId, cwd, notes, doneWhen, completedAt, priority, pinned, "order", createdAt, updatedAt)
        VALUES (?, ?, ?, ?, NULL, NULL, '', ?, NULL, 0, 0, ?, ?, ?)
      `).run("legacy-ongoing-done", "Legacy ongoing done", "ongoing", "done", "Already finished", 3, "2026-04-02T00:00:00.000Z", "2026-04-02T00:00:00.000Z");
      legacyDb.prepare(`
        INSERT INTO tasks (id, title, kind, status, groupId, cwd, notes, doneWhen, completedAt, priority, pinned, "order", createdAt, updatedAt)
        VALUES (?, ?, ?, ?, NULL, NULL, '', ?, NULL, 0, 0, ?, ?, ?)
      `).run("legacy-ongoing-paused", "Legacy ongoing paused", "ongoing", "paused", "Needs cleanup", 4, "2026-04-03T00:00:00.000Z", "2026-04-03T00:00:00.000Z");
      legacyDb.prepare(`
        INSERT INTO tasks (id, title, kind, status, groupId, cwd, notes, doneWhen, completedAt, priority, pinned, "order", createdAt, updatedAt)
        VALUES (?, ?, ?, ?, NULL, NULL, '', NULL, ?, 0, 0, ?, ?, ?)
      `).run("legacy-ongoing-archived-completed", "Legacy ongoing archived completed", "ongoing", "archived", "2026-04-04T00:00:00.000Z", 5, "2026-04-04T00:00:00.000Z", "2026-04-04T00:00:00.000Z");
      legacyDb.close();

      const db = openDatabase(dataDir);
      const repairedRows = db.prepare(`
        SELECT id, status, doneWhen, completedAt FROM tasks
        WHERE id IN ('legacy-ongoing-archived-completed', 'legacy-ongoing-done', 'legacy-ongoing-paused')
        ORDER BY id
      `).all() as Array<{ id: string; status: string; doneWhen: string | null; completedAt: string | null }>;
      expect(repairedRows).toEqual([
        { id: "legacy-ongoing-archived-completed", status: "archived", doneWhen: null, completedAt: null },
        { id: "legacy-ongoing-done", status: "active", doneWhen: null, completedAt: null },
        { id: "legacy-ongoing-paused", status: "active", doneWhen: null, completedAt: null },
      ]);

      const store = createTaskStore(db, createGlobalBus());
      expect(store.updateTask("legacy-ongoing-done", { notes: "Edited after repair" })).toMatchObject({ kind: "ongoing", status: "active", doneWhen: undefined, notes: "Edited after repair" });
      expect(store.updateTask("legacy-ongoing-paused", { waitingOn: "Vendor reply" })).toMatchObject({ kind: "ongoing", status: "active", doneWhen: undefined, waitingOn: "Vendor reply" });
      db.close();
    } finally {
      cleanupKindDirs();
    }
  });

  it("preserves muted while rebuilding legacy pinned task tables", () => {
    const dataDir = createKindLocalDataDir();
    try {
      const dbPath = join(dataDir, "bridge.db");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec("PRAGMA foreign_keys = ON");
      legacyDb.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'task', muted INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active', groupId TEXT, cwd TEXT,
          notes TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0, "order" INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO tasks (id, title, kind, muted, status, groupId, cwd, notes, priority, pinned, "order", createdAt, updatedAt)
        VALUES (?, ?, 'task', 1, 'active', NULL, NULL, '', 0, 1, 0, ?, ?)
      `).run("legacy-muted-pinned", "Muted pinned task", "2026-04-03T00:00:00.000Z", "2026-04-03T00:00:00.000Z");
      legacyDb.close();

      const db = openDatabase(dataDir);
      const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      expect(taskCols.some((column) => column.name === "pinned")).toBe(false);
      expect(taskCols.some((column) => column.name === "muted")).toBe(true);
      const row = db.prepare("SELECT kind, muted FROM tasks WHERE id = ?").get("legacy-muted-pinned") as any;
      expect(row).toEqual({ kind: "ongoing", muted: 1 });
      const store = createTaskStore(db, createGlobalBus());
      expect(store.getTask("legacy-muted-pinned")).toMatchObject({ kind: "ongoing", muted: true });
      db.close();
    } finally {
      cleanupKindDirs();
    }
  });
});

// ── Merged from db-voice-jobs-migration.test.ts ───────────────────────────────
describe("voice_jobs task foreign key migration (merged)", () => {
  function createVoiceLegacyDatabase(dbPath: string): void {
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', groupId TEXT, cwd TEXT,
        notes TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0,
        "order" INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `);
    // Legacy voice_jobs table without a foreign key on taskId.
    legacyDb.exec(`
      CREATE TABLE voice_jobs (
        id TEXT PRIMARY KEY, composerKey TEXT NOT NULL, taskId TEXT, targetSessionId TEXT,
        status TEXT NOT NULL, audioPath TEXT NOT NULL, transcript TEXT, error TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX idx_voice_jobs_composer ON voice_jobs(composerKey);
      CREATE INDEX idx_voice_jobs_target_session ON voice_jobs(targetSessionId);
      CREATE INDEX idx_voice_jobs_status ON voice_jobs(status);
      CREATE INDEX idx_voice_jobs_updated ON voice_jobs(updatedAt);
    `);
    legacyDb.prepare(`
      INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, "order", createdAt, updatedAt)
      VALUES (?, ?, 'active', NULL, NULL, '', 0, 0, ?, ?)
    `).run("task-keep", "Kept task", "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
    const insertJob = legacyDb.prepare(`
      INSERT INTO voice_jobs (id, composerKey, taskId, targetSessionId, status, audioPath, transcript, error, createdAt, updatedAt)
      VALUES (?, ?, ?, NULL, 'accepted', ?, NULL, NULL, ?, ?)
    `);
    insertJob.run("voice-keep", "draft:task:task-keep", "task-keep", "voice-keep.wav", "2026-04-02T00:00:00.000Z", "2026-04-02T00:00:00.000Z");
    // Orphaned row: taskId points at a task that no longer exists.
    insertJob.run("voice-orphan", "draft:task:task-gone", "task-gone", "voice-orphan.wav", "2026-04-02T00:00:00.000Z", "2026-04-02T00:00:00.000Z");
    legacyDb.close();
  }

  function voiceJobsHasTaskSetNullFk(db: DatabaseSync): boolean {
    const fks = db.prepare("PRAGMA foreign_key_list(voice_jobs)").all() as Array<{ table?: string; from?: string; on_delete?: string }>;
    return fks.some((fk) => fk.table === "tasks" && fk.from === "taskId" && String(fk.on_delete ?? "").toUpperCase() === "SET NULL");
  }

  it("rebuilds voice_jobs with an ON DELETE SET NULL task reference and clears orphaned taskIds", () => {
    const dataDir = makeTestDir("voice-jobs-migration");
    createVoiceLegacyDatabase(join(dataDir, "bridge.db"));

    const db = openDatabase(dataDir);
    try {
      expect(voiceJobsHasTaskSetNullFk(db)).toBe(true);

      const rows = db.prepare("SELECT id, taskId FROM voice_jobs ORDER BY id").all() as Array<{ id: string; taskId: string | null }>;
      expect(rows).toEqual([
        { id: "voice-keep", taskId: "task-keep" },
        { id: "voice-orphan", taskId: null },
      ]);

      const indexNames = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'voice_jobs'"
      ).all() as Array<{ name: string }>).map((row) => row.name);
      for (const expected of ["idx_voice_jobs_composer", "idx_voice_jobs_target_session", "idx_voice_jobs_status", "idx_voice_jobs_updated", "idx_voice_jobs_taskId"]) {
        expect(indexNames).toContain(expected);
      }

      // Deleting the surviving task should null its voice job taskId via ON DELETE SET NULL.
      db.prepare("DELETE FROM tasks WHERE id = ?").run("task-keep");
      const keptRow = db.prepare("SELECT taskId FROM voice_jobs WHERE id = ?").get("voice-keep") as { taskId: string | null };
      expect(keptRow.taskId).toBeNull();
    } finally {
      db.close();
    }
  });
});
