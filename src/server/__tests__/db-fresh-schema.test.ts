import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openDatabase, openMemoryDatabase } from "../db.js";
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

describe("fresh database schema", () => {
  it("leaves no foreign key violations", () => {
    const fresh = openMemoryDatabase();

    expect(fresh.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    fresh.close();
  });

  it("matches the persistent fresh-database bootstrap and reopens unchanged", () => {
    const fresh = openMemoryDatabase();
    const dataDir = makeTestDir("db-fresh-parity");
    const persistent = openDatabase(dataDir);
    const expected = schemaObjects(fresh);

    expect(schemaObjects(persistent)).toEqual(expected);
    persistent.close();

    // The DDL is idempotent: reopening an existing database must not alter it.
    const reopened = openDatabase(dataDir);
    expect(schemaObjects(reopened)).toEqual(expected);
    reopened.close();

    fresh.close();
  });

  it("creates every table, column and index the stores depend on", () => {
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

    const columnNames = (table: string) =>
      (fresh.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((row) => row.name);
    expect(columnNames("tasks")).toContain("completedAt");
    expect(columnNames("schedules")).toEqual(expect.arrayContaining(["reasoningEffort", "contextTier"]));
    expect(columnNames("bridge_session_state")).toEqual(
      expect.arrayContaining(["pendingAutoName", "pendingAutoNameReplaceTitle"]),
    );
    expect(columnNames("defer_loops")).toContain("checkpoint");

    fresh.close();
  });

  it("adds the checkpoint column to an existing defer loop table", () => {
    const dataDir = makeTestDir("db-defer-checkpoint-migration");
    const legacy = new DatabaseSync(join(dataDir, "bridge.db"));
    legacy.exec(`
      CREATE TABLE defer_loops (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        name TEXT,
        prompt TEXT NOT NULL,
        intervalSeconds INTEGER NOT NULL,
        nextRunAt TEXT NOT NULL,
        status TEXT NOT NULL,
        runCount INTEGER NOT NULL DEFAULT 0,
        maxRuns INTEGER,
        expiresAt TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        claimToken TEXT,
        leaseExpiresAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastError TEXT
      );
      INSERT INTO defer_loops
        (id, sessionId, prompt, intervalSeconds, nextRunAt, status, createdAt, updatedAt)
      VALUES
        ('loop-1', 'session-1', 'Check build', 300, '2030-01-01T00:00:00.000Z',
         'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = openDatabase(dataDir);
    expect(
      (migrated.prepare("PRAGMA table_info(defer_loops)").all() as unknown as { name: string }[])
        .map((column) => column.name),
    ).toContain("checkpoint");
    expect(migrated.prepare(
      "SELECT id, checkpoint FROM defer_loops WHERE id = 'loop-1'",
    ).get()).toEqual({ id: "loop-1", checkpoint: null });
    migrated.close();
  });
});
