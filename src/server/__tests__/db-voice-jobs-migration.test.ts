import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openDatabase } from "../db.js";
import { makeTestDir } from "./helpers.js";

function createLegacyDatabase(dbPath: string): void {
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
      "order" INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  // Legacy voice_jobs table without a foreign key on taskId.
  legacyDb.exec(`
    CREATE TABLE voice_jobs (
      id TEXT PRIMARY KEY,
      composerKey TEXT NOT NULL,
      taskId TEXT,
      targetSessionId TEXT,
      status TEXT NOT NULL,
      audioPath TEXT NOT NULL,
      transcript TEXT,
      error TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
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
    INSERT INTO voice_jobs (
      id, composerKey, taskId, targetSessionId, status, audioPath, transcript, error, createdAt, updatedAt
    ) VALUES (?, ?, ?, NULL, 'accepted', ?, NULL, NULL, ?, ?)
  `);
  insertJob.run("voice-keep", "draft:task:task-keep", "task-keep", "voice-keep.wav", "2026-04-02T00:00:00.000Z", "2026-04-02T00:00:00.000Z");
  // Orphaned row: taskId points at a task that no longer exists.
  insertJob.run("voice-orphan", "draft:task:task-gone", "task-gone", "voice-orphan.wav", "2026-04-02T00:00:00.000Z", "2026-04-02T00:00:00.000Z");
  legacyDb.close();
}

function voiceJobsHasTaskSetNullFk(db: DatabaseSync): boolean {
  const fks = db.prepare("PRAGMA foreign_key_list(voice_jobs)").all() as Array<{
    table?: string;
    from?: string;
    on_delete?: string;
  }>;
  return fks.some(
    (fk) => fk.table === "tasks" && fk.from === "taskId" && String(fk.on_delete ?? "").toUpperCase() === "SET NULL",
  );
}

describe("voice_jobs task foreign key migration", () => {
  it("rebuilds voice_jobs with an ON DELETE SET NULL task reference and clears orphaned taskIds", () => {
    const dataDir = makeTestDir("voice-jobs-migration");
    createLegacyDatabase(join(dataDir, "bridge.db"));

    const db = openDatabase(dataDir);
    try {
      expect(voiceJobsHasTaskSetNullFk(db)).toBe(true);

      const rows = db.prepare("SELECT id, taskId FROM voice_jobs ORDER BY id").all() as Array<{
        id: string;
        taskId: string | null;
      }>;
      expect(rows).toEqual([
        { id: "voice-keep", taskId: "task-keep" },
        { id: "voice-orphan", taskId: null },
      ]);

      const indexNames = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'voice_jobs'",
      ).all() as Array<{ name: string }>).map((row) => row.name);
      for (const expected of [
        "idx_voice_jobs_composer",
        "idx_voice_jobs_target_session",
        "idx_voice_jobs_status",
        "idx_voice_jobs_updated",
        "idx_voice_jobs_taskId",
      ]) {
        expect(indexNames).toContain(expected);
      }

      // Deleting the surviving task should null its voice job taskId, not orphan it.
      db.prepare("DELETE FROM tasks WHERE id = ?").run("task-keep");
      const keptRow = db.prepare("SELECT taskId FROM voice_jobs WHERE id = ?").get("voice-keep") as {
        taskId: string | null;
      };
      expect(keptRow.taskId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("is idempotent and leaves an already-migrated voice_jobs table untouched", () => {
    const dataDir = makeTestDir("voice-jobs-migration-idempotent");
    createLegacyDatabase(join(dataDir, "bridge.db"));

    const first = openDatabase(dataDir);
    first.close();

    const second = openDatabase(dataDir);
    try {
      expect(voiceJobsHasTaskSetNullFk(second)).toBe(true);
      const rows = second.prepare("SELECT id, taskId FROM voice_jobs ORDER BY id").all() as Array<{
        id: string;
        taskId: string | null;
      }>;
      expect(rows).toEqual([
        { id: "voice-keep", taskId: "task-keep" },
        { id: "voice-orphan", taskId: null },
      ]);
    } finally {
      second.close();
    }
  });
});
