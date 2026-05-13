import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export interface CopilotCliSessionCatalog {
  listSessions(): CopilotCliCatalogSession[] | undefined;
  getSession(sessionId: string): CopilotCliCatalogSession | undefined;
  hasSession(sessionId: string): boolean | undefined;
}

const REQUIRED_SESSION_COLUMNS = new Set(["id", "cwd", "summary", "created_at", "updated_at"]);

export function createCopilotCliSessionCatalog(deps: {
  copilotHome?: string;
  recordSpan?: (name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>) => void;
} = {}): CopilotCliSessionCatalog {
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");
  const dbPath = join(copilotHome, "session-store.db");

  function recordSpan(name: string, start: number, metadata?: Record<string, unknown>): void {
    deps.recordSpan?.(name, Date.now() - start, undefined, metadata);
  }

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

  function readSessionColumns(db: DatabaseSync): Set<string> | undefined {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as any[];
    const colNames = new Set(cols.map((col) => col.name));
    for (const required of REQUIRED_SESSION_COLUMNS) {
      if (!colNames.has(required)) return undefined;
    }
    return colNames;
  }

  function buildSessionSelect(colNames: Set<string>, whereClause = ""): string {
    const hasRepository = colNames.has("repository");
    const hasBranch = colNames.has("branch");
    const hasHostType = colNames.has("host_type");
    return `
      SELECT
        id,
        cwd,
        summary,
        created_at,
        updated_at
        ${hasRepository ? ", repository" : ""}
        ${hasBranch ? ", branch" : ""}
        ${hasHostType ? ", host_type" : ""}
      FROM sessions
      ${whereClause}
    `;
  }

  function listSessions(): CopilotCliCatalogSession[] | undefined {
    const start = Date.now();
    if (!existsSync(dbPath)) {
      recordSpan("session.cliCatalog.list", start, { result: "missing" });
      return undefined;
    }

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const colNames = readSessionColumns(db);
      if (!colNames) {
        recordSpan("session.cliCatalog.list", start, { result: "unsupported_schema" });
        return undefined;
      }

      const rows = db.prepare(`
        ${buildSessionSelect(colNames)}
        ORDER BY COALESCE(updated_at, created_at, id) DESC
      `).all() as any[];

      recordSpan("session.cliCatalog.list", start, { result: "hit", count: rows.length });
      return rows.map(mapSessionRow);
    } catch (error) {
      recordSpan("session.cliCatalog.list", start, {
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      db?.close();
    }
  }

  function getSession(sessionId: string): CopilotCliCatalogSession | undefined {
    const start = Date.now();
    if (!existsSync(dbPath)) {
      recordSpan("session.cliCatalog.get", start, { result: "missing" });
      return undefined;
    }

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const colNames = readSessionColumns(db);
      if (!colNames) {
        recordSpan("session.cliCatalog.get", start, { result: "unsupported_schema" });
        return undefined;
      }

      const row = db.prepare(buildSessionSelect(colNames, "WHERE id = ?")).get(sessionId) as any | undefined;
      recordSpan("session.cliCatalog.get", start, { result: row ? "hit" : "miss" });
      return row ? mapSessionRow(row) : undefined;
    } catch (error) {
      recordSpan("session.cliCatalog.get", start, {
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      db?.close();
    }
  }

  function hasSession(sessionId: string): boolean | undefined {
    const start = Date.now();
    if (!existsSync(dbPath)) {
      recordSpan("session.cliCatalog.has", start, { result: "missing" });
      return undefined;
    }

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const colNames = readSessionColumns(db);
      if (!colNames) {
        recordSpan("session.cliCatalog.has", start, { result: "unsupported_schema" });
        return undefined;
      }

      const row = db.prepare("SELECT 1 AS found FROM sessions WHERE id = ?").get(sessionId);
      recordSpan("session.cliCatalog.has", start, { result: row ? "hit" : "miss" });
      return !!row;
    } catch (error) {
      recordSpan("session.cliCatalog.has", start, {
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      db?.close();
    }
  }

  return { listSessions, getSession, hasSession };
}
