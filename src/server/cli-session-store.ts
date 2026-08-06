import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const RELATED_SESSION_TABLES = ["turns", "checkpoints", "session_files", "session_refs"] as const;
const BEST_EFFORT_SESSION_TABLES = ["search_index"] as const;

interface SessionReference {
  table: string;
  column: string;
}

function openWritableSessionStore(copilotHome: string): DatabaseSync | undefined {
  const dbPath = join(copilotHome, "session-store.db");
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all() as Array<{ name?: string }>)
    .some((row) => row.name === column);
}

function listSessionReferences(db: DatabaseSync): SessionReference[] {
  const references = new Map<string, SessionReference>();
  const addReference = (table: string, column: string) => {
    references.set(`${table}\0${column}`, { table, column });
  };

  for (const table of RELATED_SESSION_TABLES) {
    if (tableExists(db, table) && tableHasColumn(db, table, "session_id")) {
      addReference(table, "session_id");
    }
  }

  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> 'sessions'
  `).all() as Array<{ name?: unknown }>;
  for (const row of tables) {
    if (typeof row.name !== "string" || !row.name) continue;
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteSqlIdentifier(row.name)})`).all() as Array<{
      table?: unknown;
      from?: unknown;
      to?: unknown;
    }>;
    for (const foreignKey of foreignKeys) {
      if (
        foreignKey.table === "sessions"
        && typeof foreignKey.from === "string"
        && (foreignKey.to === "id" || foreignKey.to == null)
      ) {
        addReference(row.name, foreignKey.from);
      }
    }
  }

  return [...references.values()];
}

function parseCliTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  const normalized = trimmed.includes("T") || /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

export function deleteCliSessionStoreRows(copilotHome: string, sessionId: string): void {
  const db = openWritableSessionStore(copilotHome);
  if (!db) return;
  const deleteSessionRows = (table: string, column = "session_id") => {
    if (tableExists(db, table) && tableHasColumn(db, table, column)) {
      db.prepare(
        `DELETE FROM ${quoteSqlIdentifier(table)} WHERE ${quoteSqlIdentifier(column)} = ?`,
      ).run(sessionId);
    }
  };

  try {
    const sessionReferences = listSessionReferences(db);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("PRAGMA defer_foreign_keys=ON");
      for (const reference of sessionReferences) {
        deleteSessionRows(reference.table, reference.column);
      }
      if (tableExists(db, "sessions")) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* best-effort */ }
      throw error;
    }
    try {
      for (const table of BEST_EFFORT_SESSION_TABLES) deleteSessionRows(table);
    } catch {
      // FTS search rows are non-authoritative; keep deletion successful once source rows are gone.
    }
  } finally {
    db.close();
  }
}

export function sweepLeakedCliSessionStoreRows(opts: {
  copilotHome: string;
  idPrefix: string;
  cutoffTimestampMs: number;
}): string[] {
  const db = openWritableSessionStore(opts.copilotHome);
  if (!db) return [];
  const sessionStateDir = join(opts.copilotHome, "session-state");
  let staleIds: string[] = [];

  try {
    if (!tableExists(db, "sessions")) return [];
    const rows = db.prepare(`
      SELECT id, created_at, updated_at
      FROM sessions
      WHERE id LIKE ?
    `).all(`${opts.idPrefix}-%`) as Array<{ id?: unknown; created_at?: unknown; updated_at?: unknown }>;
    staleIds = rows
      .map((row) => ({
        id: typeof row.id === "string" ? row.id : undefined,
        timestampMs: parseCliTimestampMs(row.updated_at) ?? parseCliTimestampMs(row.created_at),
      }))
      .filter((row): row is { id: string; timestampMs: number } =>
        !!row.id
        && typeof row.timestampMs === "number"
        && row.timestampMs <= opts.cutoffTimestampMs
        && !existsSync(join(sessionStateDir, row.id)))
      .map((row) => row.id);
  } finally {
    db.close();
  }
  for (const sessionId of staleIds) {
    deleteCliSessionStoreRows(opts.copilotHome, sessionId);
  }
  return staleIds;
}
