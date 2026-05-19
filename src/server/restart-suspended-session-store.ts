import type { DatabaseSync } from "./db.js";

export type RestartSuspendedSessionRunKind = "message";

export type RestartSuspendedSessionStatus = "suspending" | "suspended" | "resuming" | "failed";

export interface RestartSuspendedSessionRecord {
  sessionId: string;
  runKind: RestartSuspendedSessionRunKind;
  pendingPrompt?: string;
  promptAccepted: boolean;
  suspendedAt: string;
  lastEventAt?: string;
  status: RestartSuspendedSessionStatus;
  resumeAttempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertRestartSuspendedSessionInput {
  sessionId: string;
  runKind: RestartSuspendedSessionRunKind;
  pendingPrompt?: string;
  promptAccepted: boolean;
  suspendedAt: string;
  lastEventAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hydrate(row: any): RestartSuspendedSessionRecord {
  return {
    sessionId: row.sessionId,
    runKind: row.runKind,
    pendingPrompt: row.pendingPrompt ?? undefined,
    promptAccepted: row.promptAccepted === 1,
    suspendedAt: row.suspendedAt,
    lastEventAt: row.lastEventAt ?? undefined,
    status: row.status,
    resumeAttempts: Number(row.resumeAttempts ?? 0),
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createRestartSuspendedSessionStore(db: DatabaseSync) {
  function upsertSuspending(input: UpsertRestartSuspendedSessionInput): RestartSuspendedSessionRecord {
    const now = nowIso();
    db.prepare(`
      INSERT INTO restart_suspended_sessions (
        sessionId, runKind, pendingPrompt, promptAccepted, suspendedAt, lastEventAt,
        status, resumeAttempts, lastError, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, 'suspending', 0, NULL, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        runKind = excluded.runKind,
        pendingPrompt = excluded.pendingPrompt,
        promptAccepted = excluded.promptAccepted,
        suspendedAt = excluded.suspendedAt,
        lastEventAt = excluded.lastEventAt,
        status = 'suspending',
        lastError = NULL,
        updatedAt = excluded.updatedAt
    `).run(
      input.sessionId,
      input.runKind,
      input.pendingPrompt ?? null,
      input.promptAccepted ? 1 : 0,
      input.suspendedAt,
      input.lastEventAt ?? null,
      now,
      now,
    );
    return get(input.sessionId)!;
  }

  function markSuspended(sessionId: string, suspendedAt = nowIso()): void {
    db.prepare(`
      UPDATE restart_suspended_sessions
      SET status = 'suspended',
          suspendedAt = ?,
          updatedAt = ?
      WHERE sessionId = ?
    `).run(suspendedAt, nowIso(), sessionId);
  }

  function markResuming(sessionId: string): void {
    db.prepare(`
      UPDATE restart_suspended_sessions
      SET status = 'resuming',
          resumeAttempts = resumeAttempts + 1,
          updatedAt = ?
      WHERE sessionId = ?
    `).run(nowIso(), sessionId);
  }

  function markFailed(sessionId: string, error: string): void {
    db.prepare(`
      UPDATE restart_suspended_sessions
      SET status = 'failed',
          lastError = ?,
          updatedAt = ?
      WHERE sessionId = ?
    `).run(error, nowIso(), sessionId);
  }

  function remove(sessionId: string): void {
    db.prepare("DELETE FROM restart_suspended_sessions WHERE sessionId = ?").run(sessionId);
  }

  function get(sessionId: string): RestartSuspendedSessionRecord | undefined {
    const row = db.prepare("SELECT * FROM restart_suspended_sessions WHERE sessionId = ?").get(sessionId) as any;
    return row ? hydrate(row) : undefined;
  }

  function listRecoverable(maxAttempts = 3): RestartSuspendedSessionRecord[] {
    const rows = db.prepare(`
      SELECT *
      FROM restart_suspended_sessions
      WHERE status IN ('suspending', 'suspended', 'resuming')
        AND resumeAttempts < ?
      ORDER BY datetime(suspendedAt) ASC, sessionId ASC
    `).all(maxAttempts) as any[];
    return rows.map(hydrate);
  }

  function listAll(): RestartSuspendedSessionRecord[] {
    const rows = db.prepare(`
      SELECT *
      FROM restart_suspended_sessions
      ORDER BY datetime(suspendedAt) ASC, sessionId ASC
    `).all() as any[];
    return rows.map(hydrate);
  }

  return {
    upsertSuspending,
    markSuspended,
    markResuming,
    markFailed,
    delete: remove,
    get,
    listRecoverable,
    listAll,
  };
}

export type RestartSuspendedSessionStore = ReturnType<typeof createRestartSuspendedSessionStore>;
