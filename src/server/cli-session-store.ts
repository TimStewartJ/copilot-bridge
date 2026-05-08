import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function deleteCliSessionStoreRows(copilotHome: string, sessionId: string): void {
  const dbPath = join(copilotHome, "session-store.db");
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);
  const tableExists = (table: string) =>
    !!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const tableHasColumn = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).some((row) => row.name === column);

  try {
    for (const table of ["turns", "checkpoints", "session_files", "session_refs", "search_index"]) {
      if (tableExists(table) && tableHasColumn(table, "session_id")) {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      }
    }
    if (tableExists("sessions")) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  } finally {
    db.close();
  }
}
