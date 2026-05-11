import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { listDatabaseMigrations } from "../db-migrations.js";
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

describe("database migration registry", () => {
  it("keeps the compatibility migration order explicit", () => {
    expect(listDatabaseMigrations().map((migration) => migration.id)).toEqual([
      "mcp-registry-from-legacy-settings-and-tag-configs",
      "task-sessions-linked-at-column",
      "session-meta-last-visible-activity-column",
      "bridge-session-state-last-attention-column",
      "bridge_session_state_legacy_backfill_v1",
      "schedule-reuse-fields-normalization",
      "schedule-reuse-final-new-session-normalization-v1",
      "schedule_runs_legacy_backfill_v1",
      "checklist-items-from-legacy-todos",
      "task-groups-notes-column",
      "tasks-kind-momentum-and-status-repair",
      "task-work-items-text-item-id",
    ]);
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
});
