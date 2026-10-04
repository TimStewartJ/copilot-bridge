// Deferred prompt store — SQLite-backed persistence for same-session deferred prompts

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./db.js";
import { toOnceDeferId } from "./defer-ids.js";
import { normalizeDeferSummary } from "./defer-summary.js";
import type { DeferSummary, DeferSummaryRow } from "./defer-summary.js";
import { parseReturnedDeferPrompt, type DeferredResultDelivery } from "./defer-result-message.js";

// ── Types ─────────────────────────────────────────────────────────

export type DeferredPromptStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type DeferredPromptPurpose = "defer" | "delivery";

/** Delivery ids for management job results sent back to the session that queued the job. */
export const MANAGEMENT_JOB_DELIVERY_ID_PREFIX = "management-job:";

/** Delivery ids for chat messages the session could not take when they were sent (see chat-message-outbox.ts). */
export const CHAT_MESSAGE_DELIVERY_ID_PREFIX = "chat-message:";

/** Delivery ids and source ids for notices about stopped background commands (see background-commands.ts). */
export const BACKGROUND_COMMAND_DELIVERY_ID_PREFIX = "background-commands:";

/** Upper bound on rows removed by a single terminal-row prune pass. */
export const DEFAULT_TERMINAL_PRUNE_LIMIT = 500;

export interface DeferredPrompt {
  id: string;
  deferId: string;
  sessionId: string;
  prompt: string;
  purpose: DeferredPromptPurpose;
  sourceId?: string;
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

export function prepareDeferredResultDeliveryInsert(db: DatabaseSync) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO deferred_prompts
      (id, sessionId, prompt, purpose, sourceId, runAt, status, attempts, createdAt, updatedAt)
    VALUES (?, ?, ?, 'delivery', ?, ?, 'pending', 0, ?, ?)
  `);
  return (message: DeferredResultDelivery, now = new Date().toISOString()): boolean =>
    (insert.run(
      message.id,
      message.sessionId,
      message.prompt,
      message.sourceId,
      now,
      now,
      now,
    ) as any).changes > 0;
}

export interface SettleOptions {
  /** Require the row to still be running under this claim. */
  claimToken?: string;
  /** Parent message to queue in the same transaction. */
  message?: DeferredResultDelivery;
  now?: string;
}

// ── Factory ───────────────────────────────────────────────────────

export function createDeferredPromptStore(db: DatabaseSync) {
  // ── Prepared statements ──────────────────────────────────────────

  const insertRow = db.prepare(`
    INSERT INTO deferred_prompts
      (id, sessionId, prompt, runAt, status, attempts, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const insertDelivery = prepareDeferredResultDeliveryInsert(db);

  const selectById = db.prepare(
    "SELECT * FROM deferred_prompts WHERE id = ?",
  );

  const selectForSession = db.prepare(`
    SELECT * FROM deferred_prompts
    WHERE sessionId = ? AND purpose = 'defer'
    ORDER BY runAt ASC, createdAt ASC
  `);
  const selectDeliveriesForSession = db.prepare(`
    SELECT * FROM deferred_prompts
    WHERE sessionId = ? AND purpose = 'delivery'
    ORDER BY createdAt DESC
  `);

  const selectDue = db.prepare(`
    SELECT * FROM deferred_prompts
    WHERE status = 'pending' AND runAt <= ?
    ORDER BY runAt ASC, createdAt ASC
  `);

  // Earliest future due time or running lease expiry: when the runner has to look again.
  const selectNextWakeAt = db.prepare(`
    SELECT MIN(wakeAt) AS wakeAt FROM (
      SELECT MIN(runAt) AS wakeAt FROM deferred_prompts WHERE status = 'pending' AND runAt > ?
      UNION ALL
      SELECT MIN(leaseExpiresAt) AS wakeAt FROM deferred_prompts WHERE status = 'running'
    )
  `);

  const selectExpiredRunningSessionIds = db.prepare(`
    SELECT DISTINCT sessionId FROM deferred_prompts
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
  `);

  const selectSummaryForSession = db.prepare(`
    SELECT COUNT(*) as count,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as runningCount,
           MIN(CASE WHEN status = 'pending' THEN runAt END) as nextRunAt
    FROM deferred_prompts
    WHERE sessionId = ? AND status IN ('pending', 'running')
      AND purpose = 'defer'
  `);

  const selectSummariesBySession = db.prepare(`
    SELECT sessionId,
           COUNT(*) as count,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as runningCount,
           MIN(CASE WHEN status = 'pending' THEN runAt END) as nextRunAt
    FROM deferred_prompts
    WHERE status IN ('pending', 'running')
      AND purpose = 'defer'
    GROUP BY sessionId
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

  // With a claimToken the row must still be running under that claim; without one it must not be terminal yet.
  const settleByClaimStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = ?, claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const settleByIdStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = ?, claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `);

  // A counted retry moves runAt; an uncounted wait gives the try back and leaves runAt alone.
  const retryStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'pending', claimToken = NULL, leaseExpiresAt = NULL,
        runAt = ?, lastError = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const waitStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'pending', claimToken = NULL, leaseExpiresAt = NULL,
        attempts = MAX(attempts - 1, 0), lastError = COALESCE(?, lastError), updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const noteWaitStmt = db.prepare(`
    UPDATE deferred_prompts
    SET lastError = ?
    WHERE id = ? AND status = 'pending' AND lastError IS NOT ?
  `);
  const reactivateStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'pending', claimToken = NULL, leaseExpiresAt = NULL, attempts = 0, lastError = NULL,
        runAt = ?, updatedAt = ?
    WHERE id = ? AND status IN ('failed', 'cancelled')
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
    WHERE sessionId = ?
      AND status IN ('pending', 'running')
      AND purpose = 'defer'
  `);
  const cancelManagementJobDeliveriesStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'cancelled', updatedAt = ?
    WHERE sessionId = ?
      AND status = 'pending'
      AND purpose = 'delivery'
      AND substr(id, 1, ${MANAGEMENT_JOB_DELIVERY_ID_PREFIX.length}) = '${MANAGEMENT_JOB_DELIVERY_ID_PREFIX}'
  `);
  const reactivateFailedDeliveryStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'pending', claimToken = NULL, leaseExpiresAt = NULL,
        attempts = 0, lastError = NULL, runAt = ?, updatedAt = ?
    WHERE sessionId = ? AND purpose = 'delivery' AND sourceId = ? AND status = 'failed'
  `);

  const selectUndeliveredForSource = db.prepare(`
    SELECT id, prompt FROM deferred_prompts
    WHERE sessionId = ? AND purpose = 'delivery' AND sourceId = ? AND status IN ('pending', 'failed')
  `);
  const retireDeliveryStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'cancelled', updatedAt = ?
    WHERE id = ? AND status IN ('pending', 'failed')
  `);

  const deleteForSessionStmt = db.prepare("DELETE FROM deferred_prompts WHERE sessionId = ?");

  const pruneTerminalStmt = db.prepare(`
    DELETE FROM deferred_prompts
    WHERE id IN (
      SELECT id FROM deferred_prompts
      WHERE status IN ('completed', 'failed', 'cancelled') AND updatedAt < ?
      ORDER BY updatedAt ASC
      LIMIT ?
    )
  `);

  const reclaimExpiredStmt = db.prepare(`
    UPDATE deferred_prompts
    SET status = 'pending',
        claimToken = NULL,
        leaseExpiresAt = NULL,
        lastError = 'Deferred execution lease expired before completion.',
        updatedAt = ?
    WHERE status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
  `);

  // ── Helpers ──────────────────────────────────────────────────────

  function toRow(raw: any): DeferredPrompt {
    return {
      id: raw.id,
      deferId: toOnceDeferId(raw.id),
      sessionId: raw.sessionId,
      prompt: raw.prompt,
      purpose: raw.purpose as DeferredPromptPurpose,
      sourceId: raw.sourceId ?? undefined,
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

  function create(
    sessionId: string,
    prompt: string,
    runAt: string,
  ): DeferredPrompt {
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

  function listDeliveriesForSession(sessionId: string): DeferredPrompt[] {
    return (selectDeliveriesForSession.all(sessionId) as any[]).map(toRow);
  }

  function enqueueDelivery(
    message: DeferredResultDelivery,
    now = new Date().toISOString(),
  ): DeferredPrompt {
    if (!insertDelivery(message, now)) {
      throw new Error(`Deferred delivery ${message.id} already exists.`);
    }
    return get(message.id)!;
  }

  function listDue(now = new Date().toISOString()): DeferredPrompt[] {
    return (selectDue.all(now) as any[]).map(toRow);
  }

  function getNextWakeAt(now = new Date().toISOString()): string | undefined {
    return (selectNextWakeAt.get(now) as { wakeAt: string | null }).wakeAt ?? undefined;
  }

  function getSummaryForSession(sessionId: string): DeferSummary {
    return normalizeDeferSummary(selectSummaryForSession.get(sessionId) as DeferSummaryRow | undefined);
  }

  /** One query for every session with pending work; sessions absent from the map have no pending prompts. */
  function listSummariesBySession(): Map<string, DeferSummary> {
    const rows = selectSummariesBySession.all() as unknown as Array<DeferSummaryRow & { sessionId: string }>;
    return new Map(rows.map((row) => [row.sessionId, normalizeDeferSummary(row)]));
  }

  function hasActiveForSession(sessionId: string): boolean {
    const row = db.prepare(`
      SELECT 1 AS found
      FROM deferred_prompts
      WHERE sessionId = ?
        AND status IN ('pending', 'running')
        AND purpose = 'defer'
      LIMIT 1
    `).get(sessionId) as { found?: number } | undefined;
    return row?.found === 1;
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

  /** Runs `settle` and queues `message` for the chat in one transaction; nothing is queued when `settle` changes no row. */
  function settleWithMessage(settle: () => unknown, message: DeferredResultDelivery | undefined, now: string): boolean {
    if (!message) return (settle() as any).changes > 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      if ((settle() as any).changes === 0) {
        db.exec("ROLLBACK");
        return false;
      }
      if (!insertDelivery(message, now)) {
        throw new Error(`Deferred delivery ${message.id} already exists.`);
      }
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function settle(
    id: string,
    status: "completed" | "failed",
    lastError: string | null,
    options: SettleOptions,
  ): boolean {
    const now = options.now ?? new Date().toISOString();
    return settleWithMessage(
      () => options.claimToken
        ? settleByClaimStmt.run(status, lastError, now, id, options.claimToken)
        : settleByIdStmt.run(status, lastError, now, id),
      options.message,
      now,
    );
  }

  /** Mark the work done, optionally queuing its result for the chat in the same transaction. */
  function complete(id: string, options: SettleOptions = {}): boolean {
    return settle(id, "completed", null, options);
  }

  /** Mark the work failed for good, optionally queuing a notice for the chat in the same transaction. */
  function fail(id: string, lastError: string, options: SettleOptions = {}): boolean {
    return settle(id, "failed", lastError, options);
  }

  /**
   * Return a failed (or cancelled) deferral to the pending queue with a fresh
   * attempt budget, due at `runAt` (now by default).
   */
  function reactivate(id: string, runAt = new Date().toISOString()): boolean {
    const result = reactivateStmt.run(runAt, new Date().toISOString(), id);
    return (result as any).changes > 0;
  }

  /**
   * Withdraw a defer's final messages that have not reached the chat, waiting or failed. Used when
   * the defer is restarted: what they say (that it stopped) is no longer true. Updates from a
   * recurring defer that was still active when it sent them are kept; they report something real.
   */
  function retireUndeliveredFinalMessagesForSource(sessionId: string, sourceDeferId: string): number {
    const now = new Date().toISOString();
    let retired = 0;
    for (const row of selectUndeliveredForSource.all(sessionId, sourceDeferId) as Array<{ id: string; prompt: string }>) {
      if (parseReturnedDeferPrompt(row.prompt)?.continues) continue;
      retired += (retireDeliveryStmt.run(now, row.id) as any).changes as number;
    }
    return retired;
  }

  /**
   * Give a claimed prompt back to the queue. With `retryAt` the try counts and the prompt is
   * due again then; without it the try is not counted and the prompt stays due.
   */
  function release(
    id: string,
    claimToken: string,
    options: { error?: string; retryAt?: string } = {},
  ): boolean {
    const now = new Date().toISOString();
    const result = options.retryAt
      ? retryStmt.run(options.retryAt, options.error ?? null, now, id, claimToken)
      : waitStmt.run(options.error ?? null, now, id, claimToken);
    return (result as any).changes > 0;
  }

  /** Record why a due prompt is not being started; cleared when it completes. */
  function noteWait(id: string, reason: string): void {
    noteWaitStmt.run(reason, id, reason);
  }

  function reactivateFailedDeliveryForSource(
    sessionId: string,
    sourceDeferId: string,
  ): number {
    const now = new Date().toISOString();
    return (reactivateFailedDeliveryStmt.run(
      now,
      now,
      sessionId,
      sourceDeferId,
    ) as any).changes as number;
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

  /**
   * Withdraw management job results still waiting for a session that is archived or gone.
   * Returned defer results keep their own delivery rules and are not touched.
   */
  function cancelManagementJobDeliveriesForSession(sessionId: string): number {
    const result = cancelManagementJobDeliveriesStmt.run(new Date().toISOString(), sessionId);
    return (result as any).changes as number;
  }

  /**
   * Hard-delete every row owned by a session. Used when the session itself is
   * deleted, so no orphaned deferral rows survive its owner.
   */
  function deleteForSession(sessionId: string): number {
    const result = deleteForSessionStmt.run(sessionId);
    return (result as any).changes as number;
  }

  /**
   * Bounded hard-delete of terminal rows older than `olderThanIso`. Terminal
   * rows can never run again, so they exist only as history; without pruning
   * the table grows for the lifetime of the install.
   */
  function pruneTerminalRows(olderThanIso: string, limit = DEFAULT_TERMINAL_PRUNE_LIMIT): number {
    const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TERMINAL_PRUNE_LIMIT;
    const result = pruneTerminalStmt.run(olderThanIso, boundedLimit);
    return (result as any).changes as number;
  }

  /** Move rows whose lease ran out back to pending, their try still counted. Returns the chats affected. */
  function reclaimExpiredRunning(now = new Date().toISOString()): string[] {
    const sessionIds = (selectExpiredRunningSessionIds.all(now) as Array<{ sessionId: string }>)
      .map((row) => row.sessionId);
    if (sessionIds.length > 0) reclaimExpiredStmt.run(now, now);
    return sessionIds;
  }

  return {
    create,
    get,
    listForSession,
    listDeliveriesForSession,
    enqueueDelivery,
    listDue,
    getNextWakeAt,
    getSummaryForSession,
    listSummariesBySession,
    hasActiveForSession,
    claimDue,
    complete,
    fail,
    reactivate,
    reactivateFailedDeliveryForSource,
    retireUndeliveredFinalMessagesForSource,
    release,
    noteWait,
    renewClaim,
    cancelById,
    cancelForSession,
    cancelManagementJobDeliveriesForSession,
    deleteForSession,
    pruneTerminalRows,
    reclaimExpiredRunning,
  };
}

export type DeferredPromptStore = ReturnType<typeof createDeferredPromptStore>;
