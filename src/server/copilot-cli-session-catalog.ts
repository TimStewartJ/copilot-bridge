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

  function listSessions(): CopilotCliCatalogSession[] | undefined {
    const start = Date.now();
    if (!existsSync(dbPath)) {
      recordSpan("session.cliCatalog.list", start, { result: "missing" });
      return undefined;
    }

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as any[];
      const colNames = new Set(cols.map((col) => col.name));
      for (const required of REQUIRED_SESSION_COLUMNS) {
        if (!colNames.has(required)) {
          recordSpan("session.cliCatalog.list", start, { result: "unsupported_schema", missingColumn: required });
          return undefined;
        }
      }

      const hasRepository = colNames.has("repository");
      const hasBranch = colNames.has("branch");
      const hasHostType = colNames.has("host_type");
      const rows = db.prepare(`
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
        ORDER BY COALESCE(updated_at, created_at, id) DESC
      `).all() as any[];

      recordSpan("session.cliCatalog.list", start, { result: "hit", count: rows.length });
      return rows
        .map((row) => ({
          sessionId: String(row.id),
          summary: typeof row.summary === "string" && row.summary.trim() ? row.summary.trim() : undefined,
          startTime: typeof row.created_at === "string" ? row.created_at : undefined,
          modifiedTime: typeof row.updated_at === "string" ? row.updated_at : undefined,
          context: typeof row.cwd === "string" && row.cwd.trim() ? { cwd: row.cwd } : undefined,
          repository: typeof row.repository === "string" && row.repository.trim() ? row.repository : undefined,
          branch: typeof row.branch === "string" && row.branch.trim() ? row.branch : undefined,
          hostType: typeof row.host_type === "string" && row.host_type.trim() ? row.host_type : undefined,
        }));
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

  return { listSessions };
}
