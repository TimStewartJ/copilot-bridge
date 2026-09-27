import type { DatabaseSync } from "./db.js";

export type VoiceJobStatus =
  | "accepted"
  | "transcribing"
  | "sending"
  | "done"
  | "error"
  | "recovered";

export interface VoiceJob {
  id: string;
  composerKey: string;
  taskId?: string;
  targetSessionId?: string;
  status: VoiceJobStatus;
  transcript?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredVoiceJob extends VoiceJob {
  audioPath: string;
}

interface VoiceJobCreate {
  id: string;
  composerKey: string;
  taskId?: string;
  targetSessionId?: string;
  audioPath: string;
}

const RELEVANT_STATUSES: readonly VoiceJobStatus[] = ["accepted", "transcribing", "sending", "error"];
const TERMINAL_STATUSES: readonly VoiceJobStatus[] = ["done", "error", "recovered"];

export function createVoiceJobStore(db: DatabaseSync) {
  function hydrate(row: any): StoredVoiceJob {
    return {
      id: row.id,
      composerKey: row.composerKey,
      taskId: row.taskId ?? undefined,
      targetSessionId: row.targetSessionId ?? undefined,
      status: row.status,
      audioPath: row.audioPath,
      transcript: row.transcript ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function createVoiceJob(input: VoiceJobCreate): StoredVoiceJob {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO voice_jobs (
        id, composerKey, taskId, targetSessionId, status, audioPath, transcript, error, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, 'accepted', ?, NULL, NULL, ?, ?)
    `).run(
      input.id,
      input.composerKey,
      input.taskId ?? null,
      input.targetSessionId ?? null,
      input.audioPath,
      now,
      now,
    );
    return getVoiceJob(input.id)!;
  }

  function getVoiceJob(id: string): StoredVoiceJob | undefined {
    const row = db.prepare("SELECT * FROM voice_jobs WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function updateVoiceJob(
    id: string,
    updates: Partial<Pick<StoredVoiceJob, "status" | "targetSessionId" | "audioPath" | "transcript" | "error">>,
  ): StoredVoiceJob | undefined {
    const existing = getVoiceJob(id);
    if (!existing) return undefined;

    const next: StoredVoiceJob = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    db.prepare(`
      UPDATE voice_jobs
      SET targetSessionId = ?, status = ?, audioPath = ?, transcript = ?, error = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      next.targetSessionId ?? null,
      next.status,
      next.audioPath,
      next.transcript ?? null,
      next.error ?? null,
      next.updatedAt,
      id,
    );

    return getVoiceJob(id);
  }

  function markError(id: string, error: string, transcript?: string): StoredVoiceJob | undefined {
    const existing = getVoiceJob(id);
    if (!existing) return undefined;
    return updateVoiceJob(id, {
      status: "error",
      error,
      transcript: transcript ?? existing.transcript,
    });
  }

  /** Only a failed job can be recovered; an in-flight one must stay resumable after a restart. */
  function markRecovered(id: string): StoredVoiceJob | undefined {
    const existing = getVoiceJob(id);
    if (!existing || existing.status !== "error") return existing;
    return updateVoiceJob(id, {
      status: "recovered",
      error: undefined,
    });
  }

  function listPendingVoiceJobs(): StoredVoiceJob[] {
    const rows = db.prepare(`
      SELECT * FROM voice_jobs
      WHERE status IN ('accepted', 'transcribing', 'sending')
      ORDER BY createdAt ASC
    `).all() as any[];
    return rows.map(hydrate);
  }

  function listTerminalVoiceJobs(): StoredVoiceJob[] {
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT * FROM voice_jobs
      WHERE status IN (${placeholders})
      ORDER BY updatedAt ASC
    `).all(...TERMINAL_STATUSES) as any[];
    return rows.map(hydrate);
  }

  function listVoiceJobIds(): string[] {
    const rows = db.prepare("SELECT id FROM voice_jobs").all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  function pruneTerminalVoiceJobs(updatedBefore: string): number {
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    const result = db.prepare(`
      DELETE FROM voice_jobs
      WHERE status IN (${placeholders})
        AND updatedAt < ?
    `).run(...TERMINAL_STATUSES, updatedBefore);
    return Number(result.changes ?? 0);
  }

  /**
   * A failed job with no transcript has nothing left to recover, so any newer job for the same
   * composer supersedes it. A failed job that still holds a transcript stays visible until the
   * client puts the transcript back and marks it recovered.
   */
  function findLatestRelevantForComposer(composerKey: string): StoredVoiceJob | undefined {
    const placeholders = RELEVANT_STATUSES.map(() => "?").join(", ");
    const row = db.prepare(`
      SELECT * FROM voice_jobs AS job
      WHERE (job.composerKey = ? OR job.targetSessionId = ?)
        AND job.status IN (${placeholders})
        AND NOT (
          job.status = 'error'
          AND job.transcript IS NULL
          AND EXISTS (
            SELECT 1 FROM voice_jobs AS newer
            WHERE (newer.composerKey = ? OR newer.targetSessionId = ?)
              AND (newer.createdAt > job.createdAt
                OR (newer.createdAt = job.createdAt AND newer.rowid > job.rowid))
          )
        )
      ORDER BY job.updatedAt DESC, job.createdAt DESC
      LIMIT 1
    `).get(composerKey, composerKey, ...RELEVANT_STATUSES, composerKey, composerKey) as any;
    return row ? hydrate(row) : undefined;
  }

  return {
    createVoiceJob,
    getVoiceJob,
    updateVoiceJob,
    markError,
    markRecovered,
    listPendingVoiceJobs,
    listTerminalVoiceJobs,
    listVoiceJobIds,
    pruneTerminalVoiceJobs,
    findLatestRelevantForComposer,
  };
}

export type VoiceJobStore = ReturnType<typeof createVoiceJobStore>;
