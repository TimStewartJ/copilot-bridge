import type { CopilotUsageSessionScanResult } from "./copilot-usage.js";
import type { DatabaseSync } from "./db.js";

export type CopilotUsageFileFingerprint =
  | { state: "file"; size: number; mtimeMs: number }
  | { state: "missing" }
  | { state: "error" };

export interface CopilotUsageSessionFingerprint {
  events: CopilotUsageFileFingerprint;
  modelState: CopilotUsageFileFingerprint;
}

export interface CopilotUsageCacheEntry {
  sessionId: string;
  parserVersion: number;
  fingerprint: CopilotUsageSessionFingerprint;
  result: CopilotUsageSessionScanResult;
}

export interface CopilotUsageStore {
  listSessionIds(): string[];
  listEntries(): CopilotUsageCacheEntry[];
  upsertEntries(entries: readonly CopilotUsageCacheEntry[]): void;
  deleteEntries(sessionIds: readonly string[]): void;
  getLastCompletedAt(): string | null;
  setLastCompletedAt(completedAt: string): void;
}

interface CopilotUsageCacheRow {
  sessionId: string;
  parserVersion: number;
  fingerprintJson: string;
  resultJson: string;
}

export function createCopilotUsageStore(db: DatabaseSync): CopilotUsageStore {
  const selectSessionIds = db.prepare(`
    SELECT sessionId
    FROM copilot_usage_sessions
    ORDER BY sessionId
  `);
  const selectEntries = db.prepare(`
    SELECT sessionId, parserVersion, fingerprintJson, resultJson
    FROM copilot_usage_sessions
    ORDER BY sessionId
  `);
  const upsertEntry = db.prepare(`
    INSERT INTO copilot_usage_sessions (
      sessionId, parserVersion, fingerprintJson, resultJson, updatedAt
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      parserVersion = excluded.parserVersion,
      fingerprintJson = excluded.fingerprintJson,
      resultJson = excluded.resultJson,
      updatedAt = excluded.updatedAt
  `);
  const deleteEntry = db.prepare("DELETE FROM copilot_usage_sessions WHERE sessionId = ?");
  const selectState = db.prepare("SELECT completedAt FROM copilot_usage_scan_state WHERE id = 1");
  const upsertState = db.prepare(`
    INSERT INTO copilot_usage_scan_state (id, completedAt)
    VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET completedAt = excluded.completedAt
  `);

  function listEntries(): CopilotUsageCacheEntry[] {
    const rows = selectEntries.all() as unknown as CopilotUsageCacheRow[];
    const entries: CopilotUsageCacheEntry[] = [];
    for (const row of rows) {
      try {
        const fingerprint = JSON.parse(row.fingerprintJson) as unknown;
        const result = JSON.parse(row.resultJson) as unknown;
        if (!isSessionFingerprint(fingerprint) || !isSessionScanResult(result)) {
          throw new Error("invalid cached usage payload");
        }
        entries.push({
          sessionId: row.sessionId,
          parserVersion: row.parserVersion,
          fingerprint,
          result,
        });
      } catch (error) {
        console.warn(`[copilot-usage-store] Skipping corrupted cache row "${row.sessionId}".`, error);
      }
    }
    return entries;
  }

  function listSessionIds(): string[] {
    return (selectSessionIds.all() as Array<{ sessionId: string }>)
      .map((row) => row.sessionId);
  }

  function upsertEntries(entries: readonly CopilotUsageCacheEntry[]): void {
    if (entries.length === 0) return;
    const updatedAt = new Date().toISOString();
    db.exec("BEGIN");
    try {
      for (const entry of entries) {
        upsertEntry.run(
          entry.sessionId,
          entry.parserVersion,
          JSON.stringify(entry.fingerprint),
          JSON.stringify(entry.result),
          updatedAt,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function deleteEntries(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    db.exec("BEGIN");
    try {
      for (const sessionId of sessionIds) {
        deleteEntry.run(sessionId);
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function getLastCompletedAt(): string | null {
    const row = selectState.get() as { completedAt?: unknown } | undefined;
    return typeof row?.completedAt === "string" ? row.completedAt : null;
  }

  function setLastCompletedAt(completedAt: string): void {
    upsertState.run(completedAt);
  }

  return {
    listSessionIds,
    listEntries,
    upsertEntries,
    deleteEntries,
    getLastCompletedAt,
    setLastCompletedAt,
  };
}

function isSessionFingerprint(value: unknown): value is CopilotUsageSessionFingerprint {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isFileFingerprint(record.events) && isFileFingerprint(record.modelState);
}

function isFileFingerprint(value: unknown): value is CopilotUsageFileFingerprint {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.state === "missing" || record.state === "error") return true;
  return record.state === "file"
    && typeof record.size === "number"
    && Number.isFinite(record.size)
    && typeof record.mtimeMs === "number"
    && Number.isFinite(record.mtimeMs);
}

function isSessionScanResult(value: unknown): value is CopilotUsageSessionScanResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.hasEvents === "boolean"
    && typeof record.included === "boolean"
    && Array.isArray(record.includedUsageAts)
    && Array.isArray(record.modelRows)
    && Boolean(record.totals && typeof record.totals === "object");
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // BEGIN may have failed before a transaction became active.
  }
}

export type CreateCopilotUsageStore = typeof createCopilotUsageStore;
