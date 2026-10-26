import type { DatabaseSync } from "node:sqlite";

export function initializeDashboardRetirementSchema(db: DatabaseSync): void {
  // archivedSourcesJson is no longer read; SQLite cannot drop a column that carries a CHECK constraint.
  db.exec(`
    CREATE TABLE IF NOT EXISTS checklist_item_details (
      itemId TEXT PRIMARY KEY REFERENCES checklist_items(id) ON DELETE CASCADE,
      stableKey TEXT UNIQUE, sourceUrl TEXT, originalTaskId TEXT, originalTaskTitle TEXT, orphanedAt TEXT,
      archivedSourcesJson TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(archivedSourcesJson))
    );
    CREATE TABLE IF NOT EXISTS dashboard_retirement (
      version INTEGER PRIMARY KEY, completedAt TEXT NOT NULL, manifestJson TEXT NOT NULL, backupPath TEXT
    );
    CREATE TRIGGER IF NOT EXISTS checklist_preserve_task_provenance BEFORE DELETE ON tasks BEGIN
      INSERT INTO checklist_item_details(itemId,originalTaskId,originalTaskTitle,orphanedAt)
      SELECT id,OLD.id,OLD.title,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM checklist_items WHERE taskId=OLD.id
      ON CONFLICT(itemId) DO UPDATE SET originalTaskId=OLD.id,originalTaskTitle=OLD.title,orphanedAt=excluded.orphanedAt;
    END;
  `);
}
