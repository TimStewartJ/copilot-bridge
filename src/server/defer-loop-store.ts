// Recurring defer loop store — SQLite-backed persistence for same-session interval deferrals

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./db.js";
import { toIntervalDeferId } from "./defer-ids.js";

export type DeferLoopStatus = "active" | "running" | "cancelled" | "completed" | "failed" | "expired";

export interface DeferLoop {
  id: string;
  deferId: string;
  sessionId: string;
  name?: string;
  prompt: string;
  intervalSeconds: number;
  nextRunAt: string;
  status: DeferLoopStatus;
  runCount: number;
  maxRuns?: number;
  expiresAt?: string;
  attempts: number;
  claimToken?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface DeferLoopCreate {
  sessionId: string;
  name?: string;
  prompt: string;
  intervalSeconds: number;
  nextRunAt: string;
  maxRuns?: number;
  expiresAt?: string;
}

export function createDeferLoopStore(db: DatabaseSync) {
  const insertRow = db.prepare(`
    INSERT INTO defer_loops
      (id, sessionId, name, prompt, intervalSeconds, nextRunAt, status, runCount,
       maxRuns, expiresAt, attempts, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, 0, ?, ?)
  `);

  const selectById = db.prepare("SELECT * FROM defer_loops WHERE id = ?");
  const selectForSession = db.prepare(`
    SELECT * FROM defer_loops
    WHERE sessionId = ?
    ORDER BY nextRunAt ASC, createdAt ASC
  `);
  const selectDue = db.prepare(`
    SELECT * FROM defer_loops
    WHERE status = 'active' AND nextRunAt <= ?
    ORDER BY nextRunAt ASC, createdAt ASC
  `);
  const selectNextActive = db.prepare(`
    SELECT * FROM defer_loops
    WHERE status = 'active'
    ORDER BY nextRunAt ASC, createdAt ASC
    LIMIT 1
  `);
  const selectNextFutureActive = db.prepare(`
    SELECT * FROM defer_loops
    WHERE status = 'active' AND nextRunAt > ?
    ORDER BY nextRunAt ASC, createdAt ASC
    LIMIT 1
  `);
  const selectNextRunningLease = db.prepare(`
    SELECT * FROM defer_loops
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL
    ORDER BY leaseExpiresAt ASC, updatedAt ASC
    LIMIT 1
  `);

  const claimActive = db.prepare(`
    UPDATE defer_loops
    SET status = 'running',
        claimToken = ?,
        leaseExpiresAt = ?,
        attempts = attempts + 1,
        updatedAt = ?
    WHERE id = ? AND status = 'active' AND nextRunAt <= ?
  `);
  const renewClaimStmt = db.prepare(`
    UPDATE defer_loops
    SET leaseExpiresAt = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const releaseClaimWithoutAttemptStmt = db.prepare(`
    UPDATE defer_loops
    SET status = 'active',
        claimToken = NULL,
        leaseExpiresAt = NULL,
        attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE attempts END,
        updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const retryStmt = db.prepare(`
    UPDATE defer_loops
    SET status = 'active',
        claimToken = NULL,
        leaseExpiresAt = NULL,
        nextRunAt = ?,
        lastError = ?,
        updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const markFailedStmt = db.prepare(`
    UPDATE defer_loops
    SET status = 'failed', claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const markFailedByIdStmt = db.prepare(`
    UPDATE defer_loops
    SET status = 'failed', claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
    WHERE id = ? AND status IN ('active', 'running')
  `);
  const markCancelledById = db.prepare(`
    UPDATE defer_loops
    SET status = 'cancelled', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE id = ? AND status IN ('active', 'running')
  `);
  const cancelForSessionStmt = db.prepare(`
    UPDATE defer_loops
    SET status = 'cancelled', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE sessionId = ? AND status IN ('active', 'running')
  `);
  const markCompletedStmt = db.prepare(`
    UPDATE defer_loops
    SET status = 'completed', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE id = ? AND status IN ('active', 'running')
  `);
  const markExpiredStmt = db.prepare(`
    UPDATE defer_loops
    SET status = 'expired', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE id = ? AND status IN ('active', 'running')
  `);
  const reclaimExpiredStmt = db.prepare(`
    UPDATE defer_loops
    SET status = 'active', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
  `);

  function toRow(raw: any): DeferLoop {
    return {
      id: raw.id,
      deferId: toIntervalDeferId(raw.id),
      sessionId: raw.sessionId,
      name: raw.name ?? undefined,
      prompt: raw.prompt,
      intervalSeconds: raw.intervalSeconds,
      nextRunAt: raw.nextRunAt,
      status: raw.status as DeferLoopStatus,
      runCount: raw.runCount,
      maxRuns: raw.maxRuns ?? undefined,
      expiresAt: raw.expiresAt ?? undefined,
      attempts: raw.attempts,
      claimToken: raw.claimToken ?? undefined,
      leaseExpiresAt: raw.leaseExpiresAt ?? undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      lastError: raw.lastError ?? undefined,
    };
  }

  function create(input: DeferLoopCreate): DeferLoop {
    const id = randomUUID();
    const now = new Date().toISOString();
    insertRow.run(
      id,
      input.sessionId,
      input.name ?? null,
      input.prompt,
      input.intervalSeconds,
      input.nextRunAt,
      input.maxRuns ?? null,
      input.expiresAt ?? null,
      now,
      now,
    );
    return toRow(selectById.get(id));
  }

  function get(id: string): DeferLoop | undefined {
    const row = selectById.get(id);
    return row ? toRow(row) : undefined;
  }

  function listForSession(sessionId: string): DeferLoop[] {
    return (selectForSession.all(sessionId) as any[]).map(toRow);
  }

  function listDue(now = new Date().toISOString()): DeferLoop[] {
    return (selectDue.all(now) as any[]).map(toRow);
  }

  function getNextActive(): DeferLoop | undefined {
    const row = selectNextActive.get();
    return row ? toRow(row) : undefined;
  }

  function getNextFutureActive(now = new Date().toISOString()): DeferLoop | undefined {
    const row = selectNextFutureActive.get(now);
    return row ? toRow(row) : undefined;
  }

  function getNextRunningLeaseExpiry(): DeferLoop | undefined {
    const row = selectNextRunningLease.get();
    return row ? toRow(row) : undefined;
  }

  function claimDue(id: string, leaseMs: number, now = new Date().toISOString()): { loop: DeferLoop; claimToken: string } | undefined {
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = claimActive.run(claimToken, leaseExpiresAt, now, id, now);
    if ((result as any).changes === 0) return undefined;
    const row = selectById.get(id);
    return row ? { loop: toRow(row), claimToken } : undefined;
  }

  function renewClaim(id: string, claimToken: string, leaseMs: number): boolean {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = renewClaimStmt.run(leaseExpiresAt, now.toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  function releaseClaimWithoutAttempt(id: string, claimToken: string): boolean {
    const result = releaseClaimWithoutAttemptStmt.run(new Date().toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  function retry(id: string, claimToken: string, nextRunAt: string, lastError?: string): boolean {
    const result = retryStmt.run(nextRunAt, lastError ?? null, new Date().toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  function completeOccurrence(id: string, claimToken: string, nextRunAt: string, now = new Date().toISOString()): DeferLoop | undefined {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = selectById.get(id) as any;
      if (!row || row.status !== "running" || row.claimToken !== claimToken) {
        db.exec("ROLLBACK");
        return undefined;
      }
      const runCount = row.runCount + 1;
      const status: DeferLoopStatus = row.maxRuns !== null && runCount >= row.maxRuns
        ? "completed"
        : row.expiresAt !== null && Date.parse(now) >= Date.parse(row.expiresAt)
          ? "expired"
          : "active";
      db.prepare(`
        UPDATE defer_loops
        SET status = ?,
            runCount = ?,
            nextRunAt = ?,
            attempts = 0,
            claimToken = NULL,
            leaseExpiresAt = NULL,
            lastError = NULL,
            updatedAt = ?
        WHERE id = ?
      `).run(status, runCount, nextRunAt, now, id);
      db.exec("COMMIT");
      return get(id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function markCompleted(id: string): boolean {
    const result = markCompletedStmt.run(new Date().toISOString(), id);
    return (result as any).changes > 0;
  }

  function markFailed(id: string, claimToken: string, lastError: string): boolean {
    const result = markFailedStmt.run(lastError, new Date().toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  function markFailedById(id: string, lastError: string): boolean {
    const result = markFailedByIdStmt.run(lastError, new Date().toISOString(), id);
    return (result as any).changes > 0;
  }

  function markExpired(id: string): boolean {
    const result = markExpiredStmt.run(new Date().toISOString(), id);
    return (result as any).changes > 0;
  }

  function cancelById(id: string): boolean {
    const result = markCancelledById.run(new Date().toISOString(), id);
    return (result as any).changes > 0;
  }

  function cancelForSession(sessionId: string): number {
    const result = cancelForSessionStmt.run(new Date().toISOString(), sessionId);
    return (result as any).changes as number;
  }

  function reclaimExpiredRunning(now = new Date().toISOString()): number {
    const result = reclaimExpiredStmt.run(now, now);
    return (result as any).changes as number;
  }

  return {
    create,
    get,
    listForSession,
    listDue,
    getNextActive,
    getNextFutureActive,
    getNextRunningLeaseExpiry,
    claimDue,
    renewClaim,
    releaseClaimWithoutAttempt,
    retry,
    completeOccurrence,
    markCompleted,
    markFailed,
    markFailedById,
    markExpired,
    cancelById,
    cancelForSession,
    reclaimExpiredRunning,
  };
}

export type DeferLoopStore = ReturnType<typeof createDeferLoopStore>;
