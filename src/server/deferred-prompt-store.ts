// Deferred prompt store — SQLite-backed persistence for same-session deferred prompts

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./db.js";
import { toOnceDeferId } from "./defer-ids.js";

// ── Types ─────────────────────────────────────────────────────────

export type DeferredPromptStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface DeferredPrompt {
  id: string;
  deferId: string;
  sessionId: string;
  prompt: string;
  /** ISO timestamp — when the prompt should be dispatched */
  runAt: string;
  status: DeferredPromptStatus;
  attempts: number;
  claimToken?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

// ── Factory ───────────────────────────────────────────────────────

export function createDeferredPromptStore(db: DatabaseSync) {
  // ── Prepared statements ──────────────────────────────────────────

  const insertRow = db.prepare(`
    INSERT INTO deferred_prompts
      (id, sessionId, prompt, runAt, status, attempts, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
  `);

  const selectById = db.prepare(
    "SELECT * FROM deferred_prompts WHERE id = ?",
  );

  const selectForSession = db.prepare(`
    SELECT * FROM deferred_prompts
    WHERE sessionId = ?
    ORDER BY runAt ASC, createdAt ASC
  `);

  const selectDue = db.prepare(`
    SELECT * FROM deferred_prompts
    WHERE status = 'pending' AND runAt <= ?
    ORDER BY runAt ASC, createdAt ASC
  `);

  const selectNextPending = db.prepare(`
    SELECT * FROM deferred_prompts
    WHERE status = 'pending'
    ORDER BY runAt ASC, createdAt ASC
    LIMIT 1
  `);

  const selectNextFuturePending = db.prepare(`
    SELECT * FROM deferred_prompts
    WHERE status = 'pending' AND runAt > ?
    ORDER BY runAt ASC, createdAt ASC
    LIMIT 1
  `);

  const selectNextRunningLease = db.prepare(`
    SELECT * FROM deferred_prompts
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL
    ORDER BY leaseExpiresAt ASC, updatedAt ASC
    LIMIT 1
  `);

  // CAS claim: only succeeds when status is still 'pending'
  const claimPending = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'running',
        claimToken = ?,
        leaseExpiresAt = ?,
        attempts = attempts + 1,
        updatedAt = ?
    WHERE id = ? AND status = 'pending'
  `);

  // Completion/retry/failure require the matching claimToken
  const markCompletedStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'completed', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);

  const markCompletedByIdStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'completed', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `);

  const markFailedStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'failed', claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);

  const retryStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'pending', claimToken = NULL, leaseExpiresAt = NULL, runAt = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);

  const releaseClaimWithoutAttemptStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'pending',
        claimToken = NULL,
        leaseExpiresAt = NULL,
        attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE attempts END,
        updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);

  const renewClaimStmt = db.prepare(`
    UPDATE deferred_prompts
    SET leaseExpiresAt = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);

  const markCancelledById = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'cancelled', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `);

  const cancelForSessionStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'cancelled', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE sessionId = ? AND status IN ('pending', 'running')
  `);

  const reclaimExpiredStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'pending', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
  `);

  // ── Helpers ──────────────────────────────────────────────────────

  function toRow(raw: any): DeferredPrompt {
    return {
      id: raw.id,
      deferId: toOnceDeferId(raw.id),
      sessionId: raw.sessionId,
      prompt: raw.prompt,
      runAt: raw.runAt,
      status: raw.status as DeferredPromptStatus,
      attempts: raw.attempts,
      claimToken: raw.claimToken ?? undefined,
      leaseExpiresAt: raw.leaseExpiresAt ?? undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      lastError: raw.lastError ?? undefined,
    };
  }

  // ── Public API ────────────────────────────────────────────────────

  function create(sessionId: string, prompt: string, runAt: string): DeferredPrompt {
    const id = randomUUID();
    const now = new Date().toISOString();
    insertRow.run(id, sessionId, prompt, runAt, now, now);
    return toRow(selectById.get(id));
  }

  function get(id: string): DeferredPrompt | undefined {
    const row = selectById.get(id);
    return row ? toRow(row) : undefined;
  }

  function listForSession(sessionId: string): DeferredPrompt[] {
    return (selectForSession.all(sessionId) as any[]).map(toRow);
  }

  function listDue(now = new Date().toISOString()): DeferredPrompt[] {
    return (selectDue.all(now) as any[]).map(toRow);
  }

  function getNextPending(): DeferredPrompt | undefined {
    const row = selectNextPending.get();
    return row ? toRow(row) : undefined;
  }

  function getNextFuturePending(now = new Date().toISOString()): DeferredPrompt | undefined {
    const row = selectNextFuturePending.get(now);
    return row ? toRow(row) : undefined;
  }

  function getNextRunningLeaseExpiry(): DeferredPrompt | undefined {
    const row = selectNextRunningLease.get();
    return row ? toRow(row) : undefined;
  }

  /**
   * Atomically claim a pending prompt for execution.
   * Returns the claimed prompt + claimToken, or undefined if already claimed.
   */
  function claimDue(id: string, leaseMs: number): { prompt: DeferredPrompt; claimToken: string } | undefined {
    const claimToken = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const nowIso = now.toISOString();
    const result = claimPending.run(claimToken, leaseExpiresAt, nowIso, id);
    if ((result as any).changes === 0) return undefined;
    const row = selectById.get(id);
    return row ? { prompt: toRow(row), claimToken } : undefined;
  }

  function markCompleted(id: string, claimToken: string): boolean {
    const result = markCompletedStmt.run(new Date().toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  function markCompletedById(id: string): boolean {
    const result = markCompletedByIdStmt.run(new Date().toISOString(), id);
    return (result as any).changes > 0;
  }

  function markFailed(id: string, claimToken: string, lastError: string): boolean {
    const result = markFailedStmt.run(lastError, new Date().toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  /**
   * Reschedule a running prompt for retry (requires matching claimToken).
   */
  function retry(id: string, claimToken: string, runAt: string): boolean {
    const result = retryStmt.run(runAt, new Date().toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  function releaseClaimWithoutAttempt(id: string, claimToken: string): boolean {
    const result = releaseClaimWithoutAttemptStmt.run(new Date().toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  function renewClaim(id: string, claimToken: string, leaseMs: number): boolean {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = renewClaimStmt.run(leaseExpiresAt, now.toISOString(), id, claimToken);
    return (result as any).changes > 0;
  }

  function cancelById(id: string): boolean {
    const result = markCancelledById.run(new Date().toISOString(), id);
    return (result as any).changes > 0;
  }

  /** Cancel all pending deferrals for a session. Returns number of rows affected. */
  function cancelForSession(sessionId: string): number {
    const result = cancelForSessionStmt.run(new Date().toISOString(), sessionId);
    return (result as any).changes as number;
  }

  /** Move expired running rows back to pending so they can be retried. Returns count. */
  function reclaimExpiredRunning(now = new Date().toISOString()): number {
    const result = reclaimExpiredStmt.run(now, now);
    return (result as any).changes as number;
  }

  return {
    create,
    get,
    listForSession,
    listDue,
    getNextPending,
    getNextFuturePending,
    getNextRunningLeaseExpiry,
    claimDue,
    markCompleted,
    markCompletedById,
    markFailed,
    retry,
    releaseClaimWithoutAttempt,
    renewClaim,
    cancelById,
    cancelForSession,
    reclaimExpiredRunning,
  };
}

export type DeferredPromptStore = ReturnType<typeof createDeferredPromptStore>;
