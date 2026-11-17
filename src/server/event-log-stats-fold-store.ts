import type { DatabaseSync } from "./db.js";
import type { EventLogStatsCacheEntry, EventLogStatsPersistence } from "./session-disk-reader.js";

/** Bump when the fold shape or folding rules change, so stale rows are ignored, not misread. */
export const EVENT_LOG_STATS_FOLD_SCHEMA_VERSION = 7;

/** Persists the stats fold so a restart resumes from the saved offset instead of rescanning. */
export function createEventLogStatsFoldStore(db: DatabaseSync): EventLogStatsPersistence {
  const selectStmt = db.prepare(
    `SELECT scannedBytes, fingerprint, fileId, stateJson
       FROM event_log_stats_folds
      WHERE sessionId = ? AND eventsPath = ? AND schemaVersion = ?`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO event_log_stats_folds
       (sessionId, eventsPath, schemaVersion, scannedBytes, fingerprint, fileId, stateJson, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sessionId, eventsPath) DO UPDATE SET
       schemaVersion = excluded.schemaVersion,
       scannedBytes = excluded.scannedBytes,
       fingerprint = excluded.fingerprint,
       fileId = excluded.fileId,
       stateJson = excluded.stateJson,
       updatedAt = excluded.updatedAt`,
  );
  const deleteStmt = db.prepare("DELETE FROM event_log_stats_folds WHERE sessionId = ?");
  const clearStmt = db.prepare("DELETE FROM event_log_stats_folds");

  return {
    load(eventsPath, sessionId) {
      const row = selectStmt.get(sessionId, eventsPath, EVENT_LOG_STATS_FOLD_SCHEMA_VERSION) as
        | { scannedBytes: number; fingerprint: string; fileId: string; stateJson: string }
        | undefined;
      if (!row) return undefined;
      let state: EventLogStatsCacheEntry["state"];
      try {
        state = JSON.parse(row.stateJson);
      } catch {
        return undefined;
      }
      if (!state || typeof state !== "object") return undefined;
      return {
        eventsPath,
        sessionId,
        scannedBytes: Number(row.scannedBytes),
        fingerprint: row.fingerprint,
        fileId: row.fileId,
        state,
      };
    },
    save(entry) {
      upsertStmt.run(
        entry.sessionId,
        entry.eventsPath,
        EVENT_LOG_STATS_FOLD_SCHEMA_VERSION,
        entry.scannedBytes,
        entry.fingerprint,
        entry.fileId,
        JSON.stringify(entry.state),
        new Date().toISOString(),
      );
    },
    delete(sessionId) {
      deleteStmt.run(sessionId);
    },
    clear() {
      clearStmt.run();
    },
  };
}
