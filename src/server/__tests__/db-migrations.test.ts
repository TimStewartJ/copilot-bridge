import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINIMUM_SUPPORTED_DATABASE_BASELINE,
  MINIMUM_SUPPORTED_DATABASE_MIGRATION,
  listDatabaseMigrations,
} from "../db-migrations.js";
import { openDatabase } from "../db.js";
import { makeTestDir } from "./helpers.js";

const ACTIVE_MIGRATION_IDS = [
  "legacy-tag-mcp-servers-drop-v1",
  "schedule-launch-option-columns-v1",
  "fork-auto-name-columns-v1",
] as const;

function databasePath(dataDir: string): string {
  return join(dataDir, "bridge.db");
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return !!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function columnNames(db: DatabaseSync, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function migrationIds(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>)
    .map((row) => row.id);
}

function createSupportedBaselineDatabase(
  dataDir: string,
  options: { legacyTagRow?: boolean } = {},
): void {
  const db = openDatabase(dataDir);
  db.prepare(`
    INSERT INTO tasks (id, title, kind, muted, status, notes, priority, "order", createdAt, updatedAt)
    VALUES ('task-1', 'Baseline task', 'task', 0, 'active', '', 0, 0, ?, ?)
  `).run("2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z");
  db.prepare(`
    INSERT INTO schedules (
      id, taskId, name, prompt, type, enabled, createdAt, updatedAt, runCount
    ) VALUES ('schedule-1', 'task-1', 'Baseline schedule', 'Run', 'once', 1, ?, ?, 0)
  `).run("2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z");
  db.prepare("DELETE FROM schema_migrations WHERE id IN (?, ?, ?)")
    .run(...ACTIVE_MIGRATION_IDS);
  db.exec(`
    ALTER TABLE schedules DROP COLUMN reasoningEffort;
    ALTER TABLE schedules DROP COLUMN contextTier;
    ALTER TABLE bridge_session_state DROP COLUMN pendingAutoName;
    ALTER TABLE bridge_session_state DROP COLUMN pendingAutoNameReplaceTitle;
    CREATE TABLE tag_mcp_servers (
      tagId TEXT NOT NULL,
      serverName TEXT NOT NULL,
      config TEXT NOT NULL,
      PRIMARY KEY (tagId, serverName),
      FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
    );
  `);
  if (options.legacyTagRow) {
    db.prepare(`
      INSERT INTO tags (id, name, nameKey, color, instructions, "order", createdAt, updatedAt)
      VALUES ('tag-1', 'Legacy', 'legacy', 'slate', '', 0, ?, ?)
    `).run("2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z");
    db.prepare(`
      INSERT INTO tag_mcp_servers (tagId, serverName, config)
      VALUES ('tag-1', 'unmigrated', '{not-json')
    `).run();
  }
  db.close();
}

describe("supported database baseline", () => {
  it("keeps only post-baseline migrations active", () => {
    expect(listDatabaseMigrations()).toEqual([
      {
        id: "legacy-tag-mcp-servers-drop-v1",
        runMode: "once",
        transaction: "auto",
        description: "Drop the retired per-tag MCP configuration table after verifying that no rows remain.",
      },
      {
        id: "schedule-launch-option-columns-v1",
        runMode: "once",
        transaction: "auto",
        description: "Add optional reasoning effort and context tier overrides to supported baseline databases.",
      },
      {
        id: "fork-auto-name-columns-v1",
        runMode: "once",
        transaction: "auto",
        description: "Track fork sessions that should be auto-named from their next user message.",
      },
    ]);
  });

  it("records the baseline and active migrations for a fresh persistent database", () => {
    const dataDir = makeTestDir("db-migration-fresh");
    let db = openDatabase(dataDir);

    expect(migrationIds(db)).toEqual([
      "legacy-tag-mcp-servers-drop-v1",
      "schedule-launch-option-columns-v1",
      "fork-auto-name-columns-v1",
      MINIMUM_SUPPORTED_DATABASE_MIGRATION,
    ].sort());
    expect(tableExists(db, "tag_mcp_servers")).toBe(false);
    db.close();

    db = openDatabase(dataDir);
    expect(migrationIds(db)).toHaveLength(4);
    db.close();
  });

  it("recovers an empty database file left by an interrupted first startup", () => {
    const dataDir = makeTestDir("db-migration-empty-file");
    new DatabaseSync(databasePath(dataDir)).close();

    const db = openDatabase(dataDir);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(migrationIds(db)).toEqual([
      "legacy-tag-mcp-servers-drop-v1",
      "schedule-launch-option-columns-v1",
      "fork-auto-name-columns-v1",
      MINIMUM_SUPPORTED_DATABASE_MIGRATION,
    ].sort());
    db.close();
  });

  it("upgrades the oldest supported baseline without rerunning retired migrations", () => {
    const dataDir = makeTestDir("db-migration-supported-baseline");
    createSupportedBaselineDatabase(dataDir);

    const db = openDatabase(dataDir);
    expect(columnNames(db, "schedules")).toEqual(expect.arrayContaining(["reasoningEffort", "contextTier"]));
    expect(columnNames(db, "bridge_session_state")).toEqual(expect.arrayContaining([
      "pendingAutoName",
      "pendingAutoNameReplaceTitle",
    ]));
    expect(db.prepare("SELECT id, name FROM schedules").get()).toEqual({
      id: "schedule-1",
      name: "Baseline schedule",
    });
    expect(tableExists(db, "tag_mcp_servers")).toBe(false);
    expect(migrationIds(db)).toEqual(expect.arrayContaining([...ACTIVE_MIGRATION_IDS]));
    db.close();
  });

  it("rejects pre-baseline databases before current schema DDL can mask missing state", () => {
    const dataDir = makeTestDir("db-migration-pre-baseline");
    const legacyDb = new DatabaseSync(databasePath(dataDir));
    legacyDb.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        appliedAt TEXT NOT NULL
      );
    `);
    legacyDb.close();

    expect(() => openDatabase(dataDir)).toThrow(
      new RegExp(`Unsupported Bridge database.*${MINIMUM_SUPPORTED_DATABASE_BASELINE.replace(/[()]/g, "\\$&")}`),
    );

    const inspected = new DatabaseSync(databasePath(dataDir), { readOnly: true });
    expect(tableExists(inspected, "tasks")).toBe(false);
    inspected.close();
  });

  it("rejects a marker-only database that still has retired session title state", () => {
    const dataDir = makeTestDir("db-migration-retired-session-titles");
    const db = openDatabase(dataDir);
    db.exec(`
      CREATE TABLE session_titles (
        sessionId TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
    `);
    db.close();

    expect(() => openDatabase(dataDir)).toThrow(/retired table session_titles still exists/);
  });

  it("preserves legacy MCP rows and fails instead of dropping unreadable data", () => {
    const dataDir = makeTestDir("db-migration-retained-mcp");
    createSupportedBaselineDatabase(dataDir, { legacyTagRow: true });

    expect(() => openDatabase(dataDir)).toThrow(
      /Database migration "legacy-tag-mcp-servers-drop-v1" failed: Refusing to drop tag_mcp_servers because 1 legacy row/,
    );

    const inspected = new DatabaseSync(databasePath(dataDir), { readOnly: true });
    expect(inspected.prepare("SELECT serverName, config FROM tag_mcp_servers").get()).toEqual({
      serverName: "unmigrated",
      config: "{not-json",
    });
    expect(migrationIds(inspected)).not.toContain("legacy-tag-mcp-servers-drop-v1");
    inspected.close();
  });
});
