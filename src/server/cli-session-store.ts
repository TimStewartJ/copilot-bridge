import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SESSION_ID_TABLES = ["turns", "checkpoints", "session_files", "session_refs"] as const;

export function deleteCliSessionStoreRows(copilotHome: string, sessionId: string): void {
  const dbPath = join(copilotHome, "session-store.db");
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  const tableExists = (table: string) =>
    !!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const tableHasColumn = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).some((row) => row.name === column);
  const deleteSessionRows = (table: string) => {
    if (tableExists(table) && tableHasColumn(table, "session_id")) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
  };

  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of SESSION_ID_TABLES) deleteSessionRows(table);
      if (tableExists("sessions")) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    try {
      deleteSessionRows("search_index");
    } catch {
      // FTS search rows are non-authoritative; keep deletion successful once source rows are gone.
    }
  } finally {
    db.close();
  }
}
