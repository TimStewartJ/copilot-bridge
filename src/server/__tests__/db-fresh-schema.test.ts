import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, openMemoryDatabase } from "../db.js";
import {
  MINIMUM_SUPPORTED_DATABASE_MIGRATION,
  listDatabaseMigrations,
  runDatabaseMigrations,
} from "../db-migrations.js";
import { makeTestDir } from "./helpers.js";

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

// `rootpage` is a physical detail that legitimately differs between two
// databases with identical schemas, so it is excluded deliberately.
function schemaObjects(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all() as unknown as SchemaObjectRow[]
  ).map((row) => `${row.type}|${row.name}|${row.tbl_name}|${(row.sql ?? "").replace(/\s+/g, " ").trim()}`);
}

function tableContents(db: DatabaseSync): string[] {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as { name: string }[]
  ).map((row) => row.name);

  const dump: string[] = [];
  for (const table of tables) {
    // `schema_migrations.appliedAt` is wall-clock, so only the recorded ids are
    // comparable. They are asserted separately.
    if (table === "schema_migrations" || table.startsWith("sqlite_")) continue;
    dump.push(`${table}=${JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())}`);
  }
  return dump;
}

function recordedMigrationIds(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as unknown as { id: string }[]
  ).map((row) => row.id);
}

/**
 * A database created by `openMemoryDatabase` skips the compatibility migrations
 * and records the one-time ones instead. Re-running the full migration set on
 * top of it must therefore be a no-op — that is the entire justification for
 * skipping them.
 */
function migrateFreshDatabase(): DatabaseSync {
  const db = openMemoryDatabase();
  for (const migration of listDatabaseMigrations()) {
    db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(migration.id);
  }
  runDatabaseMigrations(db);
  return db;
}

describe("fresh database schema parity", () => {
  it("produces the same schema whether or not migrations run", () => {
    const fresh = openMemoryDatabase();
    const migrated = migrateFreshDatabase();

    // Compared as arrays so a diff names the offending object. A migration that
    // adds a table, column or index must also be added to the schema DDL in
    // db.ts, otherwise freshly created databases silently lack it.
    expect(schemaObjects(fresh)).toEqual(schemaObjects(migrated));

    fresh.close();
    migrated.close();
  });

  it("produces the same table contents whether or not migrations run", () => {
    const fresh = openMemoryDatabase();
    const migrated = migrateFreshDatabase();

    expect(tableContents(fresh)).toEqual(tableContents(migrated));

    fresh.close();
    migrated.close();
  });

  it("records the same one-time migrations that running them would record", () => {
    const fresh = openMemoryDatabase();
    const migrated = migrateFreshDatabase();

    const expectedOneTimeIds = [
      MINIMUM_SUPPORTED_DATABASE_MIGRATION,
      ...listDatabaseMigrations().map((migration) => migration.id),
    ].sort();

    expect(recordedMigrationIds(fresh)).toEqual(expectedOneTimeIds);
    expect(recordedMigrationIds(fresh)).toEqual(recordedMigrationIds(migrated));

    fresh.close();
    migrated.close();
  });

  it("leaves no foreign key violations", () => {
    const fresh = openMemoryDatabase();

    expect(fresh.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    fresh.close();
  });

  it("matches the persistent fresh-database bootstrap", () => {
    const fresh = openMemoryDatabase();
    const persistent = openDatabase(makeTestDir("db-fresh-parity"));

    expect(schemaObjects(fresh)).toEqual(schemaObjects(persistent));
    expect(tableContents(fresh)).toEqual(tableContents(persistent));
    expect(recordedMigrationIds(fresh)).toEqual(recordedMigrationIds(persistent));

    fresh.close();
    persistent.close();
  });

  it("creates the tables and indexes that only migrations used to add", () => {
    const fresh = openMemoryDatabase();

    const names = new Set(
      (
        fresh.prepare("SELECT name FROM sqlite_master").all() as unknown as { name: string }[]
      ).map((row) => row.name),
    );
    for (const name of [
      "copilot_model_prices",
      "copilot_usage_sessions",
      "copilot_usage_scan_state",
      "event_log_stats_folds",
      "idx_event_log_stats_folds_updated",
      "idx_tags_name_key",
      "idx_tasks_nextTouchAt",
      "idx_bridge_session_state_lastAttentionAt",
    ]) {
      expect(names, `missing ${name}`).toContain(name);
    }

    const taskColumns = (
      fresh.prepare("PRAGMA table_info(tasks)").all() as unknown as { name: string }[]
    ).map((row) => row.name);
    expect(taskColumns).toContain("completedAt");

    fresh.close();
  });
});
