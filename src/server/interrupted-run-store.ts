// Durable markers so a run cut off by a server kill or crash can be resumed on boot.

import type { DatabaseSync } from "./db.js";

export interface InterruptedRunMarker {
  sessionId: string;
  attentionMode: "normal" | "quiet";
  acceptedAt: string;
  /** When the run was last resumed after a server exit, or when a put-off resume is due. */
  lastResumedAt: string | null;
  /** True while `lastResumedAt` names a resume that was put off rather than one made at once. */
  retryScheduled: boolean;
}

export function createInterruptedRunStore(db: DatabaseSync) {
  // Keep lastResumedAt and retryScheduled: a resumed run re-accepts; resetting skips the cooldown.
  const upsert = db.prepare(`
      INSERT INTO interrupted_run_markers (sessionId, attentionMode, acceptedAt, lastResumedAt)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(sessionId) DO UPDATE SET
        attentionMode = excluded.attentionMode,
        acceptedAt = excluded.acceptedAt
    `);
  const remove = db.prepare(
    "DELETE FROM interrupted_run_markers WHERE sessionId = ? RETURNING retryScheduled, attentionMode",
  );
  const selectAll = db.prepare(
    "SELECT sessionId, attentionMode, acceptedAt, lastResumedAt, retryScheduled FROM interrupted_run_markers ORDER BY acceptedAt ASC",
  );
  const stampResumed = db.prepare(
    "UPDATE interrupted_run_markers SET lastResumedAt = ?, retryScheduled = ? WHERE sessionId = ?",
  );

  return {
    markAccepted(sessionId: string, attentionMode: "normal" | "quiet", at: Date = new Date()): void {
      upsert.run(sessionId, attentionMode, at.toISOString());
    },
    /** Removes the marker; true when it held a put-off resume of the user's own (not quiet) run. */
    clear(sessionId: string): boolean {
      const removed = remove.get(sessionId) as { retryScheduled?: number; attentionMode?: string } | undefined;
      return removed?.retryScheduled === 1 && removed.attentionMode !== "quiet";
    },
    list(): InterruptedRunMarker[] {
      return (selectAll.all() as Array<Record<string, unknown>>).map((row) => ({
        sessionId: String(row.sessionId),
        attentionMode: row.attentionMode === "quiet" ? "quiet" : "normal",
        acceptedAt: String(row.acceptedAt),
        lastResumedAt: typeof row.lastResumedAt === "string" ? row.lastResumedAt : null,
        retryScheduled: row.retryScheduled === 1,
      }));
    },
    markResumed(sessionId: string, at: Date = new Date()): void {
      stampResumed.run(at.toISOString(), 0, sessionId);
    },
    /** Records that the run will be resumed at `at` instead of now. */
    markRetryScheduled(sessionId: string, at: Date): void {
      stampResumed.run(at.toISOString(), 1, sessionId);
    },
  };
}

export type InterruptedRunStore = ReturnType<typeof createInterruptedRunStore>;