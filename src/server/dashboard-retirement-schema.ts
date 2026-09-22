import type { DatabaseSync } from "node:sqlite";

export function initializeDashboardRetirementSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checklist_item_details (
      itemId TEXT PRIMARY KEY REFERENCES checklist_items(id) ON DELETE CASCADE,
      stableKey TEXT UNIQUE, sourceUrl TEXT, originalTaskId TEXT, originalTaskTitle TEXT, orphanedAt TEXT,
      archivedSourcesJson TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(archivedSourcesJson))
    );
    CREATE TABLE IF NOT EXISTS dashboard_retirement (
      version INTEGER PRIMARY KEY, completedAt TEXT NOT NULL, manifestJson TEXT NOT NULL, backupPath TEXT
    );
    CREATE TABLE IF NOT EXISTS dashboard_legacy_rows (
      tableName TEXT NOT NULL, rowKey TEXT NOT NULL, rowJson TEXT NOT NULL CHECK(json_valid(rowJson)),
      PRIMARY KEY(tableName,rowKey)
    );
    CREATE TABLE IF NOT EXISTS dashboard_legacy_objects (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, status TEXT, lifecycle TEXT,
      taskId TEXT, taskTitle TEXT, interventionBy TEXT, createdAt TEXT, body TEXT,
      rawJson TEXT NOT NULL CHECK(json_valid(rawJson))
    );
    CREATE TRIGGER IF NOT EXISTS dashboard_archive_rows_no_update BEFORE UPDATE ON dashboard_legacy_rows BEGIN SELECT RAISE(ABORT,'Dashboard archive is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS dashboard_archive_rows_no_delete BEFORE DELETE ON dashboard_legacy_rows BEGIN SELECT RAISE(ABORT,'Dashboard archive is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS dashboard_archive_objects_no_update BEFORE UPDATE ON dashboard_legacy_objects BEGIN SELECT RAISE(ABORT,'Dashboard archive is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS dashboard_archive_objects_no_delete BEFORE DELETE ON dashboard_legacy_objects BEGIN SELECT RAISE(ABORT,'Dashboard archive is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS checklist_preserve_task_provenance BEFORE DELETE ON tasks BEGIN
      INSERT INTO checklist_item_details(itemId,originalTaskId,originalTaskTitle,orphanedAt)
      SELECT id,OLD.id,OLD.title,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM checklist_items WHERE taskId=OLD.id
      ON CONFLICT(itemId) DO UPDATE SET originalTaskId=OLD.id,originalTaskTitle=OLD.title,orphanedAt=excluded.orphanedAt;
    END;
  `);
}
