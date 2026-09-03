import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./db.js";

export type SessionMessageOutboxStatus = "pending" | "running" | "completed" | "failed";

export interface SessionMessageOutboxItem {
  id: string;
  sessionId: string;
  prompt: string;
  source: string;
  sourceId?: string;
  availableAt: string;
  status: SessionMessageOutboxStatus;
  attempts: number;
  claimToken?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface SessionMessageOutboxCreate {
  id?: string;
  sessionId: string;
  prompt: string;
  source: string;
  sourceId?: string;
  availableAt?: string;
}

export function prepareSessionMessageOutboxEnqueue(db: DatabaseSync) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO session_message_outbox
      (id, sessionId, prompt, source, sourceId, availableAt, status, attempts, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  return (input: SessionMessageOutboxCreate, now = new Date().toISOString()): boolean => {
    const result = insert.run(
      input.id ?? randomUUID(),
      input.sessionId,
      input.prompt,
      input.source,
      input.sourceId ?? null,
      input.availableAt ?? now,
      now,
      now,
    );
    return (result as any).changes > 0;
  };
}

export function createSessionMessageOutboxStore(db: DatabaseSync) {
  const enqueueRow = prepareSessionMessageOutboxEnqueue(db);
  const selectById = db.prepare("SELECT * FROM session_message_outbox WHERE id = ?");
  const selectForSession = db.prepare(`
    SELECT * FROM session_message_outbox
    WHERE sessionId = ?
    ORDER BY createdAt DESC
  `);
  const selectDue = db.prepare(`
    SELECT * FROM session_message_outbox
    WHERE status = 'pending' AND availableAt <= ?
    ORDER BY availableAt ASC, createdAt ASC
  `);
  const selectNextPending = db.prepare(`
    SELECT * FROM session_message_outbox
    WHERE status = 'pending'
    ORDER BY availableAt ASC, createdAt ASC
    LIMIT 1
  `);
  const selectNextFuturePending = db.prepare(`
    SELECT * FROM session_message_outbox
    WHERE status = 'pending' AND availableAt > ?
    ORDER BY availableAt ASC, createdAt ASC
    LIMIT 1
  `);
  const selectNextRunningLease = db.prepare(`
    SELECT * FROM session_message_outbox
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL
    ORDER BY leaseExpiresAt ASC, updatedAt ASC
    LIMIT 1
  `);
  const selectExpiredRunningSessionIds = db.prepare(`
    SELECT DISTINCT sessionId FROM session_message_outbox
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
  `);
  const claimPending = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'running',
        claimToken = ?,
        leaseExpiresAt = ?,
        attempts = attempts + 1,
        updatedAt = ?
    WHERE id = ? AND status = 'pending' AND availableAt <= ?
  `);
  const markCompleted = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'completed', claimToken = NULL, leaseExpiresAt = NULL, lastError = NULL, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const markCompletedById = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'completed', claimToken = NULL, leaseExpiresAt = NULL, lastError = NULL, updatedAt = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `);
  const retry = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'pending',
        claimToken = NULL,
        leaseExpiresAt = NULL,
        availableAt = ?,
        lastError = ?,
        updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const releaseClaim = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'pending',
        claimToken = NULL,
        leaseExpiresAt = NULL,
        attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE attempts END,
        updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const renewClaim = db.prepare(`
    UPDATE session_message_outbox
    SET leaseExpiresAt = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const markFailed = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'failed', claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const markFailedById = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'failed', claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `);
  const reactivateFailedForSource = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'pending',
        attempts = 0,
        claimToken = NULL,
        leaseExpiresAt = NULL,
        availableAt = ?,
        lastError = NULL,
        updatedAt = ?
    WHERE sessionId = ? AND sourceId = ? AND status = 'failed'
  `);
  const deleteForSession = db.prepare("DELETE FROM session_message_outbox WHERE sessionId = ?");
  const pruneTerminal = db.prepare(`
    DELETE FROM session_message_outbox
    WHERE id IN (
      SELECT id FROM session_message_outbox
      WHERE status IN ('completed', 'failed') AND updatedAt < ?
      ORDER BY updatedAt ASC
      LIMIT ?
    )
  `);
  const reclaimExpired = db.prepare(`
    UPDATE session_message_outbox
    SET status = 'pending', claimToken = NULL, leaseExpiresAt = NULL, updatedAt = ?
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
  `);

  function toRow(raw: any): SessionMessageOutboxItem {
    return {
      id: raw.id,
      sessionId: raw.sessionId,
      prompt: raw.prompt,
      source: raw.source,
      sourceId: raw.sourceId ?? undefined,
      availableAt: raw.availableAt,
      status: raw.status as SessionMessageOutboxStatus,
      attempts: raw.attempts,
      claimToken: raw.claimToken ?? undefined,
      leaseExpiresAt: raw.leaseExpiresAt ?? undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      lastError: raw.lastError ?? undefined,
    };
  }

  function get(id: string): SessionMessageOutboxItem | undefined {
    const row = selectById.get(id);
    return row ? toRow(row) : undefined;
  }

  function claimDue(
    id: string,
    leaseMs: number,
    now = new Date().toISOString(),
  ): { item: SessionMessageOutboxItem; claimToken: string } | undefined {
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = claimPending.run(claimToken, leaseExpiresAt, now, id, now);
    if ((result as any).changes === 0) return undefined;
    const item = get(id);
    return item ? { item, claimToken } : undefined;
  }

  return {
    enqueue: (input: SessionMessageOutboxCreate) => {
      const id = input.id ?? randomUUID();
      if (!enqueueRow({ ...input, id })) {
        throw new Error(`Session message ${id} already exists.`);
      }
      return get(id);
    },
    get,
    listForSession: (sessionId: string) =>
      (selectForSession.all(sessionId) as any[]).map(toRow),
    listDue: (now = new Date().toISOString()) =>
      (selectDue.all(now) as any[]).map(toRow),
    getNextPending: () => {
      const row = selectNextPending.get();
      return row ? toRow(row) : undefined;
    },
    getNextFuturePending: (now = new Date().toISOString()) => {
      const row = selectNextFuturePending.get(now);
      return row ? toRow(row) : undefined;
    },
    getNextRunningLeaseExpiry: () => {
      const row = selectNextRunningLease.get();
      return row ? toRow(row) : undefined;
    },
    listExpiredRunningSessionIds: (now = new Date().toISOString()) =>
      (selectExpiredRunningSessionIds.all(now) as Array<{ sessionId: string }>).map((row) => row.sessionId),
    claimDue,
    markCompleted: (id: string, claimToken: string) =>
      (markCompleted.run(new Date().toISOString(), id, claimToken) as any).changes > 0,
    markCompletedById: (id: string) =>
      (markCompletedById.run(new Date().toISOString(), id) as any).changes > 0,
    retry: (id: string, claimToken: string, availableAt: string, lastError: string) =>
      (retry.run(availableAt, lastError, new Date().toISOString(), id, claimToken) as any).changes > 0,
    releaseClaimWithoutAttempt: (id: string, claimToken: string) =>
      (releaseClaim.run(new Date().toISOString(), id, claimToken) as any).changes > 0,
    renewClaim: (id: string, claimToken: string, leaseMs: number) => {
      const now = new Date();
      return (renewClaim.run(
        new Date(now.getTime() + leaseMs).toISOString(),
        now.toISOString(),
        id,
        claimToken,
      ) as any).changes > 0;
    },
    markFailed: (id: string, claimToken: string, lastError: string) =>
      (markFailed.run(lastError, new Date().toISOString(), id, claimToken) as any).changes > 0,
    markFailedById: (id: string, lastError: string) =>
      (markFailedById.run(lastError, new Date().toISOString(), id) as any).changes > 0,
    reactivateFailedForSource: (
      sessionId: string,
      sourceId: string,
      availableAt = new Date().toISOString(),
    ) =>
      (reactivateFailedForSource.run(
        availableAt,
        new Date().toISOString(),
        sessionId,
        sourceId,
      ) as any).changes as number,
    deleteForSession: (sessionId: string) =>
      (deleteForSession.run(sessionId) as any).changes as number,
    pruneTerminalRows: (olderThanIso: string, limit = 500) =>
      (pruneTerminal.run(olderThanIso, Math.max(1, Math.floor(limit))) as any).changes as number,
    reclaimExpiredRunning: (now = new Date().toISOString()) =>
      (reclaimExpired.run(now, now) as any).changes as number,
  };
}

export type SessionMessageOutboxStore = ReturnType<typeof createSessionMessageOutboxStore>;
