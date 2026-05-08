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
  const dir = mkdtempSync(join(tmpdir(), "bridge-session-state-migration-"));
  tempDirs.push(dir);
  return dir;
}

function createLegacySessionTables(db: DatabaseSync): void {
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

describe("bridge session state legacy backfill", () => {
  it("imports legacy session metadata once without letting stale legacy rows overwrite later overlay changes", () => {
    const dataDir = createTempDataDir();
    const dbPath = join(dataDir, "bridge.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("PRAGMA foreign_keys = ON");
    createLegacySessionTables(legacyDb);
    legacyDb.prepare(`
      INSERT INTO session_meta (sessionId, archived, archivedAt, triggeredBy, scheduleId, scheduleName)
      VALUES (?, 1, ?, 'schedule', ?, ?)
    `).run("session-1", "2026-05-01T00:00:00.000Z", "sched-1", "Legacy schedule");
    legacyDb.prepare("INSERT INTO session_titles (sessionId, title) VALUES (?, ?)")
      .run("session-1", "Legacy title");
    legacyDb.prepare("INSERT INTO session_workspace (sessionId, cwd, updatedAt) VALUES (?, ?, ?)")
      .run("session-1", "D:\\legacy", "2026-05-01T00:00:00.000Z");
    legacyDb.close();

    let db = openDatabase(dataDir);
    expect(db.prepare(`
      SELECT archived, archivedAt, titleOverride, pinnedCwd, scheduleId, scheduleName
      FROM bridge_session_state
      WHERE sessionId = ?
    `).get("session-1")).toEqual({
      archived: 1,
      archivedAt: "2026-05-01T00:00:00.000Z",
      titleOverride: "Legacy title",
      pinnedCwd: "D:\\legacy",
      scheduleId: "sched-1",
      scheduleName: "Legacy schedule",
    });

    db.prepare(`
      UPDATE bridge_session_state
      SET archived = 0,
          archivedAt = NULL,
          titleOverride = 'New title',
          pinnedCwd = 'D:\\new',
          pinnedCwdUpdatedAt = '2026-05-02T00:00:00.000Z',
          updatedAt = '2026-05-02T00:00:00.000Z'
      WHERE sessionId = ?
    `).run("session-1");
    db.close();

    db = openDatabase(dataDir);
    expect(db.prepare(`
      SELECT archived, archivedAt, titleOverride, pinnedCwd, scheduleId, scheduleName
      FROM bridge_session_state
      WHERE sessionId = ?
    `).get("session-1")).toEqual({
      archived: 0,
      archivedAt: null,
      titleOverride: "New title",
      pinnedCwd: "D:\\new",
      scheduleId: "sched-1",
      scheduleName: "Legacy schedule",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
      .get("bridge_session_state_legacy_backfill_v1")).toEqual({ count: 1 });
    db.close();
  });
});
