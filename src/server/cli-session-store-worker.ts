// The only module in the server runtime that opens the Copilot CLI's session store
// (<copilot home>/session-store.db).
//
// The CLI rewrites that database constantly, and it lives in the user's profile rather than in
// the Bridge's data directory. On Windows an antivirus scan holds the open of a recently written
// file until the scan is done. Under machine load one such open was measured taking 11.8 s, and
// node:sqlite is synchronous, so on the server's main thread it froze HTTP, health probes and
// session event acknowledgements for that long. A delete also waits up to five seconds for the
// CLI's write lock. cli-session-store.ts therefore loads this module as a worker thread. The
// inline backend (tests, operational fallback) calls the same function on its own thread.
//
// Constraints: as for process-host-worker.ts, no runtime imports from the codebase and only
// erasable TypeScript syntax.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

/** Marks a thread started by cli-session-store.ts. Other worker threads (Vitest's) import this module too. */
export const CLI_SESSION_STORE_WORKER_FLAG = "bridgeCliSessionStoreWorker";

export interface CopilotCliCatalogSession {
  sessionId: string;
  summary?: string;
  startTime?: string;
  modifiedTime?: string;
  context?: { cwd: string };
  repository?: string;
  branch?: string;
  hostType?: string;
}

export type CliCatalogReadRequest =
  | { op: "list"; copilotHome: string }
  | { op: "get" | "has"; copilotHome: string; sessionId: string };

export type CliSessionStoreRequest =
  | CliCatalogReadRequest
  | { op: "delete"; copilotHome: string; sessionId: string }
  | { op: "sweep"; copilotHome: string; idPrefix: string; cutoffTimestampMs: number };

/** What a catalog read found. `sessions` is set on a "hit" of "list" (every row) and "get" (one row). */
export interface CliCatalogRead {
  result: "missing" | "unsupported_schema" | "hit" | "miss";
  sessions?: CopilotCliCatalogSession[];
}

const REQUIRED_SESSION_COLUMNS = ["id", "cwd", "summary", "created_at", "updated_at"];
const OPTIONAL_SESSION_COLUMNS = ["repository", "branch", "host_type"];
const RELATED_SESSION_TABLES = ["turns", "checkpoints", "session_files", "session_refs"] as const;
const BEST_EFFORT_SESSION_TABLES = ["search_index"] as const;

interface SessionReference {
  table: string;
  column: string;
}

const storePath = (copilotHome: string): string => join(copilotHome, "session-store.db");

function mapSessionRow(row: any): CopilotCliCatalogSession {
  return {
    sessionId: String(row.id),
    summary: typeof row.summary === "string" && row.summary.trim() ? row.summary.trim() : undefined,
    startTime: typeof row.created_at === "string" ? row.created_at : undefined,
    modifiedTime: typeof row.updated_at === "string" ? row.updated_at : undefined,
    context: typeof row.cwd === "string" && row.cwd.trim() ? { cwd: row.cwd } : undefined,
    repository: typeof row.repository === "string" && row.repository.trim() ? row.repository : undefined,
    branch: typeof row.branch === "string" && row.branch.trim() ? row.branch : undefined,
    hostType: typeof row.host_type === "string" && row.host_type.trim() ? row.host_type : undefined,
  };
}

function readCatalog(request: CliCatalogReadRequest): CliCatalogRead {
  if (!existsSync(storePath(request.copilotHome))) return { result: "missing" };
  const db = new DatabaseSync(storePath(request.copilotHome), { readOnly: true });
  try {
    const columns = new Set((db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((column) => column.name));
    if (REQUIRED_SESSION_COLUMNS.some((required) => !columns.has(required))) return { result: "unsupported_schema" };
    if (request.op === "has") {
      return { result: db.prepare("SELECT 1 AS found FROM sessions WHERE id = ?").get(request.sessionId) ? "hit" : "miss" };
    }
    const select = `SELECT ${[...REQUIRED_SESSION_COLUMNS, ...OPTIONAL_SESSION_COLUMNS.filter((name) => columns.has(name))].join(", ")} FROM sessions`;
    if (request.op === "get") {
      const row = db.prepare(`${select} WHERE id = ?`).get(request.sessionId);
      return row ? { result: "hit", sessions: [mapSessionRow(row)] } : { result: "miss" };
    }
    const rows = db.prepare(`${select} ORDER BY COALESCE(updated_at, created_at, id) DESC`).all();
    return { result: "hit", sessions: rows.map(mapSessionRow) };
  } finally {
    db.close();
  }
}

function openWritableSessionStore(copilotHome: string): DatabaseSync | undefined {
  if (!existsSync(storePath(copilotHome))) return undefined;
  const db = new DatabaseSync(storePath(copilotHome));
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

function deleteSessionStoreRows(copilotHome: string, sessionId: string): void {
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

function sweepLeakedSessionStoreRows(opts: { copilotHome: string; idPrefix: string; cutoffTimestampMs: number }): string[] {
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
    deleteSessionStoreRows(opts.copilotHome, sessionId);
  }
  return staleIds;
}

/** Runs one request to completion on the calling thread: a CliCatalogRead, the swept IDs, or nothing. */
export function runCliSessionStoreRequest(request: CliSessionStoreRequest): unknown {
  if (request.op === "delete") return deleteSessionStoreRows(request.copilotHome, request.sessionId);
  if (request.op === "sweep") return sweepLeakedSessionStoreRows(request);
  return readCatalog(request);
}

if (parentPort && (workerData as Record<string, unknown> | null)?.[CLI_SESSION_STORE_WORKER_FLAG] === true) {
  const port = parentPort;
  port.on("message", ({ id, request }: { id: number; request: CliSessionStoreRequest }) => {
    try {
      port.postMessage({ id, value: runCliSessionStoreRequest(request) });
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
