// Durable markers for accepted runs, so a run cut off by a server kill or crash can be resumed on boot.

import type { DatabaseSync } from "./db.js";

export interface InterruptedRunMarker {
  sessionId: string;
  attentionMode: "normal" | "quiet";
  acceptedAt: string;
  lastResumedAt: string | null;
}

export function createInterruptedRunStore(db: DatabaseSync) {
  // lastResumedAt is deliberately not overwritten: the resumed run re-accepts under the same
  // sessionId, and resetting the stamp there would defeat the boot-time resume cooldown.
  const upsert = db.prepare(`
      INSERT INTO interrupted_run_markers (sessionId, attentionMode, acceptedAt, lastResumedAt)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(sessionId) DO UPDATE SET
        attentionMode = excluded.attentionMode,
        acceptedAt = excluded.acceptedAt
    `);
  const remove = db.prepare("DELETE FROM interrupted_run_markers WHERE sessionId = ?");
  const selectAll = db.prepare(
    "SELECT sessionId, attentionMode, acceptedAt, lastResumedAt FROM interrupted_run_markers ORDER BY acceptedAt ASC",
  );
  const stampResumed = db.prepare("UPDATE interrupted_run_markers SET lastResumedAt = ? WHERE sessionId = ?");

  return {
    markAccepted(sessionId: string, attentionMode: "normal" | "quiet", at: Date = new Date()): void {
      upsert.run(sessionId, attentionMode, at.toISOString());
    },
    clear(sessionId: string): void {
      remove.run(sessionId);
    },
    list(): InterruptedRunMarker[] {
      return (selectAll.all() as Array<Record<string, unknown>>).map((row) => ({
        sessionId: String(row.sessionId),
        attentionMode: row.attentionMode === "quiet" ? "quiet" : "normal",
        acceptedAt: String(row.acceptedAt),
        lastResumedAt: typeof row.lastResumedAt === "string" ? row.lastResumedAt : null,
      }));
    },
    markResumed(sessionId: string, at: Date = new Date()): void {
      stampResumed.run(at.toISOString(), sessionId);
    },
  };
}

export type InterruptedRunStore = ReturnType<typeof createInterruptedRunStore>;
