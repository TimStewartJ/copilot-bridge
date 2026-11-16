// Trigger store: SQLite persistence for triggers and the chats and tasks they started.
// Every state change that hands work to a runner is guarded by the row's claim token.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "../db.js";
import { parseDeferCheckpointJson, serializeDeferCheckpoint, type DeferCheckpoint } from "../defer-checkpoint.js";
import { DEFAULT_TERMINAL_PRUNE_LIMIT, prepareTriggerDeliveryInsert } from "../deferred-prompt-store.js";
import { parseTriggerCheckSpecJson, type TriggerCheckOutcome, type TriggerCheckResult } from "./check.js";
import type { TriggerDelivery } from "./messages.js";
import {
  EMPTY_TRIGGER_SUMMARY,
  triggerLane,
  type TerminalTriggerStatus,
  type Trigger,
  type TriggerAction,
  type TriggerCreate,
  type TriggerLane,
  type TriggerLastCheck,
  type TriggerPendingCheck,
  type TriggerRun,
  type TriggerStatus,
  type TriggerSummary,
  type TriggerWhen,
} from "./types.js";
import type { TriggerCheckSpec } from "./check.js";

/** After a reactivation the trigger gets at least this long before a passed expiry stops it again. */
const REACTIVATED_EXPIRY_MIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TriggerListFilter {
  sessionId?: string;
  taskId?: string;
  /** Include stopped triggers (completed, cancelled, expired, failed). */
  includeInactive?: boolean;
}

export interface TriggerUpdate {
  name?: string | null;
  prompt?: string;
  when?: TriggerWhen;
  /** null removes the check. */
  check?: TriggerCheckSpec | null;
  action?: TriggerAction;
  nextRunAt?: string;
  maxRuns?: number | null;
  expiresAt?: string | null;
}

export interface SettleOptions {
  /** Next occurrence; undefined means there is none and the trigger completes. */
  nextRunAt?: string;
  /** Force a stopped status instead of the one maxRuns/expiresAt/nextRunAt imply. */
  status?: Exclude<TerminalTriggerStatus, "cancelled">;
  fired?: boolean;
  /** Chat the fire started (or woke, for message triggers it is the owner). */
  sessionId?: string;
  taskId?: string;
  delivery?: TriggerDelivery;
  checkpoint?: DeferCheckpoint;
  /** The occurrence failed: it still counts, and the failure streak in attempts is kept. */
  error?: string;
  /** The check result this occurrence settles; becomes the baseline for the next check. */
  check?: { result: TriggerCheckResult; at: string; outcome: TriggerCheckOutcome };
  /** Keep a firing result that could not act yet, so the next occurrence acts on it. */
  keepPending?: boolean;
}

function parseJson<T>(json: unknown): T | undefined {
  if (typeof json !== "string" || !json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

/** Status a settled occurrence leaves the trigger in, from its limits and whether another occurrence exists. */
export function occurrenceStatus(
  trigger: Pick<Trigger, "maxRuns" | "expiresAt">,
  runCount: number,
  nextRunAt: string | undefined,
): "active" | "completed" | "expired" {
  if (nextRunAt === undefined) return "completed";
  if (trigger.maxRuns !== undefined && runCount >= trigger.maxRuns) return "completed";
  if (trigger.expiresAt && Date.parse(nextRunAt) >= Date.parse(trigger.expiresAt)) return "expired";
  return "active";
}

export function createTriggerStore(db: DatabaseSync) {
  const insertDelivery = prepareTriggerDeliveryInsert(db);

  const insertRow = db.prepare(`
    INSERT INTO triggers
      (id, name, prompt, sessionId, taskId, lane, whenJson, checkJson, actionJson, status, nextRunAt,
       runNow, runCount, fireCount, maxRuns, expiresAt, attempts, createdBySessionId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, ?, ?, ?)
  `);
  const selectById = db.prepare("SELECT * FROM triggers WHERE id = ?");
  // A trigger is due when its time came, it was asked to run now, or its expiry passed (to end it).
  const selectDue = db.prepare(`
    SELECT * FROM triggers
    WHERE lane = ? AND status = 'active'
      AND (runNow = 1 OR nextRunAt <= ? OR expiresAt <= ?)
    ORDER BY runNow DESC, nextRunAt ASC, createdAt ASC
  `);
  const selectNextWakeAt = db.prepare(`
    SELECT MIN(wakeAt) AS wakeAt FROM (
      SELECT MIN(nextRunAt) AS wakeAt FROM triggers WHERE lane = ? AND status = 'active' AND nextRunAt > ?
      UNION ALL
      SELECT MIN(expiresAt) AS wakeAt FROM triggers WHERE lane = ? AND status = 'active' AND expiresAt > ?
      UNION ALL
      SELECT MIN(leaseExpiresAt) AS wakeAt FROM triggers WHERE lane = ? AND status = 'running'
    )
  `);
  const selectExpiredRunning = db.prepare(`
    SELECT * FROM triggers
    WHERE lane = ? AND status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
  `);
  const claimStmt = db.prepare(`
    UPDATE triggers
    SET status = 'running', claimToken = ?, leaseExpiresAt = ?, attempts = attempts + 1, updatedAt = ?
    WHERE id = ? AND status = 'active' AND (runNow = 1 OR nextRunAt <= ? OR expiresAt <= ?)
  `);
  const renewStmt = db.prepare(`
    UPDATE triggers SET leaseExpiresAt = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const releaseStmt = db.prepare(`
    UPDATE triggers
    SET status = 'active', claimToken = NULL, leaseExpiresAt = NULL,
        attempts = MAX(attempts - 1, 0), lastError = COALESCE(?, lastError), updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const retryStmt = db.prepare(`
    UPDATE triggers
    SET status = 'active', claimToken = NULL, leaseExpiresAt = NULL, nextRunAt = ?, lastError = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const noteWaitStmt = db.prepare(`
    UPDATE triggers SET lastError = ? WHERE id = ? AND status = 'active' AND lastError IS NOT ?
  `);
  const savePendingStmt = db.prepare(`
    UPDATE triggers SET checkPendingJson = ?, updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const settleStmt = db.prepare(`
    UPDATE triggers
    SET status = ?, runCount = ?, fireCount = ?, nextRunAt = ?, runNow = 0,
        checkpoint = COALESCE(?, checkpoint),
        attempts = CASE WHEN ? IS NULL THEN 0 ELSE attempts END,
        claimToken = NULL, leaseExpiresAt = NULL, lastError = ?,
        lastRunAt = ?, lastFiredAt = COALESCE(?, lastFiredAt),
        lastSessionId = COALESCE(?, lastSessionId), lastTaskId = COALESCE(?, lastTaskId),
        lastCheckJson = COALESCE(?, lastCheckJson),
        checkPendingJson = CASE WHEN ? = 1 THEN checkPendingJson ELSE NULL END,
        updatedAt = ?
    WHERE id = ? AND status = 'running' AND claimToken = ?
  `);
  const endActiveStmt = db.prepare(`
    UPDATE triggers
    SET status = ?, attempts = 0, claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
    WHERE id = ? AND status = 'active'
  `);
  const insertRun = db.prepare(`
    INSERT OR IGNORE INTO trigger_runs (triggerId, sessionId, taskId, occurrence, recordedAt) VALUES (?, ?, ?, ?, ?)
  `);
  const selectRunByOccurrence = db.prepare("SELECT * FROM trigger_runs WHERE triggerId = ? AND occurrence = ?");

  function toTrigger(raw: any): Trigger {
    const when = parseJson<TriggerWhen>(raw.whenJson) ?? { kind: "at", at: raw.createdAt };
    const action = parseJson<TriggerAction>(raw.actionJson) ?? { kind: "chat", via: "worker" };
    const check = raw.checkJson ? parseTriggerCheckSpecJson(raw.checkJson) : undefined;
    const lastCheck = parseJson<TriggerLastCheck>(raw.lastCheckJson);
    const checkPending = parseJson<TriggerPendingCheck>(raw.checkPendingJson);
    let checkpoint: DeferCheckpoint | undefined;
    if (raw.checkpoint) {
      try {
        checkpoint = parseDeferCheckpointJson(raw.checkpoint);
      } catch {
        checkpoint = undefined;
      }
    }
    return {
      id: raw.id,
      ...(raw.name ? { name: raw.name } : {}),
      prompt: raw.prompt,
      ...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
      ...(raw.taskId ? { taskId: raw.taskId } : {}),
      when,
      ...(check ? { check } : {}),
      action,
      status: raw.status as TriggerStatus,
      ...(raw.nextRunAt ? { nextRunAt: raw.nextRunAt } : {}),
      runNow: raw.runNow === 1,
      runCount: raw.runCount,
      fireCount: raw.fireCount,
      ...(raw.maxRuns !== null && raw.maxRuns !== undefined ? { maxRuns: raw.maxRuns } : {}),
      ...(raw.expiresAt ? { expiresAt: raw.expiresAt } : {}),
      attempts: raw.attempts,
      ...(raw.claimToken ? { claimToken: raw.claimToken } : {}),
      ...(raw.leaseExpiresAt ? { leaseExpiresAt: raw.leaseExpiresAt } : {}),
      ...(raw.lastError ? { lastError: raw.lastError } : {}),
      ...(raw.lastRunAt ? { lastRunAt: raw.lastRunAt } : {}),
      ...(raw.lastFiredAt ? { lastFiredAt: raw.lastFiredAt } : {}),
      ...(raw.lastSessionId ? { lastSessionId: raw.lastSessionId } : {}),
      ...(raw.lastTaskId ? { lastTaskId: raw.lastTaskId } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(check && lastCheck ? { lastCheck } : {}),
      ...(checkPending ? { checkPending } : {}),
      ...(raw.createdBySessionId ? { createdBySessionId: raw.createdBySessionId } : {}),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  function toRun(raw: any): TriggerRun {
    return {
      id: raw.id,
      triggerId: raw.triggerId,
      sessionId: raw.sessionId,
      ...(raw.taskId ? { taskId: raw.taskId } : {}),
      ...(raw.occurrence ? { occurrence: raw.occurrence } : {}),
      recordedAt: raw.recordedAt,
    };
  }

  function changed(result: unknown): boolean {
    return ((result as { changes?: number | bigint }).changes ?? 0) > 0;
  }

  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function queueDelivery(delivery: TriggerDelivery, now: string): void {
    if (!insertDelivery(delivery, now)) throw new Error(`Trigger delivery ${delivery.id} already exists.`);
  }

  // ── Reading ──────────────────────────────────────────────────────

  function get(id: string): Trigger | undefined {
    const row = selectById.get(id);
    return row ? toTrigger(row) : undefined;
  }

  function list(filter: TriggerListFilter = {}): Trigger[] {
    const where: string[] = [];
    const values: string[] = [];
    if (filter.sessionId !== undefined) { where.push("sessionId = ?"); values.push(filter.sessionId); }
    if (filter.taskId !== undefined) { where.push("taskId = ?"); values.push(filter.taskId); }
    if (!filter.includeInactive) where.push("status IN ('active', 'running', 'paused')");
    const sql = `SELECT * FROM triggers${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE WHEN status IN ('active', 'running', 'paused') THEN 0 ELSE 1 END,
               COALESCE(nextRunAt, updatedAt) ASC, createdAt ASC`;
    return (db.prepare(sql).all(...values) as any[]).map(toTrigger);
  }

  function listDue(lane: TriggerLane, now = new Date().toISOString()): Trigger[] {
    return (selectDue.all(lane, now, now) as any[]).map(toTrigger);
  }

  function getNextWakeAt(lane: TriggerLane, now = new Date().toISOString()): string | undefined {
    return (selectNextWakeAt.get(lane, now, lane, now, lane) as { wakeAt: string | null }).wakeAt ?? undefined;
  }

  /** Triggers whose claim outlived its lease: the server stopped while they ran. */
  function listExpiredRunning(lane: TriggerLane, now = new Date().toISOString()): Trigger[] {
    return (selectExpiredRunning.all(lane, now) as any[]).map(toTrigger);
  }

  function getSummaryForSession(sessionId: string): TriggerSummary {
    const row = db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount,
             MIN(CASE WHEN status = 'active' THEN nextRunAt END) AS nextRunAt
      FROM triggers WHERE sessionId = ? AND status IN ('active', 'running', 'paused')
    `).get(sessionId) as { count: number; runningCount: number | null; nextRunAt: string | null } | undefined;
    return {
      count: Number(row?.count ?? 0),
      runningCount: Number(row?.runningCount ?? 0),
      nextRunAt: row?.nextRunAt ?? null,
    };
  }

  /** One query for every chat with triggers; chats absent from the map have none. */
  function listSummariesBySession(): Map<string, TriggerSummary> {
    const rows = db.prepare(`
      SELECT sessionId, COUNT(*) AS count,
             SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount,
             MIN(CASE WHEN status = 'active' THEN nextRunAt END) AS nextRunAt
      FROM triggers WHERE sessionId IS NOT NULL AND status IN ('active', 'running', 'paused')
      GROUP BY sessionId
    `).all() as Array<{ sessionId: string; count: number; runningCount: number | null; nextRunAt: string | null }>;
    return new Map(rows.map((row) => [row.sessionId, {
      count: Number(row.count),
      runningCount: Number(row.runningCount ?? 0),
      nextRunAt: row.nextRunAt ?? null,
    }]));
  }

  /** Active task-owned triggers per task. */
  function countActiveByTask(): Map<string, number> {
    const rows = db.prepare(`
      SELECT taskId, COUNT(*) AS count FROM triggers
      WHERE taskId IS NOT NULL AND status IN ('active', 'running') GROUP BY taskId
    `).all() as Array<{ taskId: string; count: number }>;
    return new Map(rows.map((row) => [row.taskId, Number(row.count)]));
  }

  function hasActiveForSession(sessionId: string): boolean {
    return getSummaryForSession(sessionId).count > 0;
  }

  // ── Creating and editing ─────────────────────────────────────────

  function create(input: TriggerCreate, now = new Date().toISOString()): Trigger {
    const id = input.id ?? randomUUID();
    insertRow.run(
      id,
      input.name ?? null,
      input.prompt,
      input.sessionId ?? null,
      input.taskId ?? null,
      triggerLane(input.action),
      JSON.stringify(input.when),
      input.check ? JSON.stringify(input.check) : null,
      JSON.stringify(input.action),
      input.status ?? "active",
      input.nextRunAt,
      input.maxRuns ?? null,
      input.expiresAt ?? null,
      input.createdBySessionId ?? null,
      now,
      now,
    );
    return get(id)!;
  }

  /** Change a trigger's definition. Refused while it runs, so a run never settles on a definition it did not use. */
  function update(id: string, patch: TriggerUpdate, now = new Date().toISOString()): Trigger | undefined {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => { fields.push(`${column} = ?`); values.push(value); };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.prompt !== undefined) set("prompt", patch.prompt);
    if (patch.when !== undefined) set("whenJson", JSON.stringify(patch.when));
    if (patch.check !== undefined) {
      set("checkJson", patch.check ? JSON.stringify(patch.check) : null);
      // A new command is compared with its own results only.
      set("lastCheckJson", null);
      set("checkPendingJson", null);
    }
    if (patch.action !== undefined) { set("actionJson", JSON.stringify(patch.action)); set("lane", triggerLane(patch.action)); }
    if (patch.nextRunAt !== undefined) set("nextRunAt", patch.nextRunAt);
    if (patch.maxRuns !== undefined) set("maxRuns", patch.maxRuns);
    if (patch.expiresAt !== undefined) set("expiresAt", patch.expiresAt);
    if (fields.length === 0) return get(id);
    set("updatedAt", now);
    const result = db.prepare(`UPDATE triggers SET ${fields.join(", ")} WHERE id = ? AND status != 'running'`).run(...values, id);
    return changed(result) ? get(id) : undefined;
  }

  function pause(id: string, now = new Date().toISOString()): boolean {
    return changed(db.prepare(`
      UPDATE triggers SET status = 'paused', runNow = 0, updatedAt = ? WHERE id = ? AND status = 'active'
    `).run(now, id));
  }

  function resume(id: string, nextRunAt: string, now = new Date().toISOString()): boolean {
    return changed(db.prepare(`
      UPDATE triggers SET status = 'active', nextRunAt = ?, attempts = 0, lastError = NULL, updatedAt = ?
      WHERE id = ? AND status = 'paused'
    `).run(nextRunAt, now, id));
  }

  /** Return a stopped trigger to the queue with a fresh failure budget, extending a passed expiry. */
  function reactivate(id: string, nextRunAt: string, now = new Date().toISOString()): boolean {
    const existing = get(id);
    if (!existing) return false;
    const expiry = existing.expiresAt && Date.parse(existing.expiresAt) <= Date.parse(nextRunAt)
      ? new Date(Date.parse(nextRunAt) + REACTIVATED_EXPIRY_MIN_WINDOW_MS).toISOString()
      : existing.expiresAt ?? null;
    // A run limit already reached would end it again at once.
    const maxRuns = existing.maxRuns !== undefined && existing.runCount >= existing.maxRuns
      ? existing.runCount + 1
      : existing.maxRuns ?? null;
    return changed(db.prepare(`
      UPDATE triggers
      SET status = 'active', claimToken = NULL, leaseExpiresAt = NULL, attempts = 0, lastError = NULL,
          nextRunAt = ?, expiresAt = ?, maxRuns = ?, runNow = 0, updatedAt = ?
      WHERE id = ? AND status IN ('completed', 'failed', 'cancelled', 'expired')
    `).run(nextRunAt, expiry, maxRuns, now, id));
  }

  function requestRunNow(id: string, now = new Date().toISOString()): boolean {
    return changed(db.prepare(`
      UPDATE triggers SET runNow = 1, updatedAt = ? WHERE id = ? AND status = 'active'
    `).run(now, id));
  }

  function cancel(id: string, now = new Date().toISOString()): boolean {
    return changed(db.prepare(`
      UPDATE triggers SET status = 'cancelled', claimToken = NULL, leaseExpiresAt = NULL, runNow = 0, updatedAt = ?
      WHERE id = ? AND status IN ('active', 'running', 'paused')
    `).run(now, id));
  }

  function remove(id: string): boolean {
    return transaction(() => {
      db.prepare("DELETE FROM trigger_runs WHERE triggerId = ?").run(id);
      return changed(db.prepare("DELETE FROM triggers WHERE id = ?").run(id));
    });
  }

  function cancelForSession(sessionId: string, now = new Date().toISOString()): number {
    const result = db.prepare(`
      UPDATE triggers SET status = 'cancelled', claimToken = NULL, leaseExpiresAt = NULL, runNow = 0, updatedAt = ?
      WHERE sessionId = ? AND status IN ('active', 'running', 'paused')
    `).run(now, sessionId) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  /** Hard-delete every trigger a chat owns, when the chat itself is deleted. */
  function deleteForSession(sessionId: string): number {
    return transaction(() => {
      db.prepare("DELETE FROM trigger_runs WHERE triggerId IN (SELECT id FROM triggers WHERE sessionId = ?)").run(sessionId);
      return Number((db.prepare("DELETE FROM triggers WHERE sessionId = ?").run(sessionId) as { changes?: number }).changes ?? 0);
    });
  }

  /** Hard-delete every trigger a task owns, when the task is deleted. Chats and tasks they started stay. */
  function deleteForTask(taskId: string): string[] {
    return transaction(() => {
      const ids = (db.prepare("SELECT id FROM triggers WHERE taskId = ?").all(taskId) as Array<{ id: string }>).map((row) => row.id);
      db.prepare("DELETE FROM trigger_runs WHERE triggerId IN (SELECT id FROM triggers WHERE taskId = ?)").run(taskId);
      db.prepare("DELETE FROM triggers WHERE taskId = ?").run(taskId);
      return ids;
    });
  }

  // ── Running ──────────────────────────────────────────────────────

  function claimDue(id: string, leaseMs: number, now = new Date().toISOString()): { trigger: Trigger; claimToken: string } | undefined {
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    if (!changed(claimStmt.run(claimToken, leaseExpiresAt, now, id, now, now))) return undefined;
    const trigger = get(id);
    return trigger ? { trigger, claimToken } : undefined;
  }

  function renewClaim(id: string, claimToken: string, leaseMs: number): boolean {
    const now = new Date();
    return changed(renewStmt.run(new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), id, claimToken));
  }

  /** Give a claim back without counting the try; the trigger stays due. */
  function release(id: string, claimToken: string, options: { error?: string } = {}): boolean {
    return changed(releaseStmt.run(options.error ?? null, new Date().toISOString(), id, claimToken));
  }

  /** A one-time trigger's try failed: keep the counted try and run again at `retryAt`. */
  function retryLater(id: string, claimToken: string, retryAt: string, error: string): boolean {
    return changed(retryStmt.run(retryAt, error, new Date().toISOString(), id, claimToken));
  }

  /** Record why a due trigger is not being started; cleared by its next successful run. */
  function noteWait(id: string, reason: string): void {
    noteWaitStmt.run(reason, id, reason);
  }

  /** Keep a firing check result for the action that will run for it. False when the claim was lost. */
  function savePendingCheck(id: string, claimToken: string, pending: TriggerPendingCheck): boolean {
    return changed(savePendingStmt.run(JSON.stringify(pending), new Date().toISOString(), id, claimToken));
  }

  /** Record one finished occurrence and schedule the next, with an optional message for the owning chat. */
  function settleOccurrence(id: string, claimToken: string, options: SettleOptions, now = new Date().toISOString()): Trigger | undefined {
    return transaction(() => {
      const row = selectById.get(id) as any;
      if (!row || row.status !== "running" || row.claimToken !== claimToken) return undefined;
      const current = toTrigger(row);
      const runCount = current.runCount + 1;
      const status = options.status ?? occurrenceStatus(current, runCount, options.nextRunAt);
      const error = options.error ?? null;
      const lastCheck: TriggerLastCheck | undefined = options.check
        ? {
            at: options.check.at,
            outcome: options.check.outcome,
            fingerprint: options.check.result.fingerprint,
            output: { exitCode: options.check.result.exitCode, stdout: options.check.result.stdout, stderr: options.check.result.stderr },
          }
        : undefined;
      settleStmt.run(
        status,
        runCount,
        current.fireCount + (options.fired ? 1 : 0),
        options.nextRunAt ?? null,
        options.checkpoint === undefined ? null : serializeDeferCheckpoint(options.checkpoint),
        error,
        error,
        now,
        options.fired ? now : null,
        options.sessionId ?? null,
        options.taskId ?? null,
        lastCheck ? JSON.stringify(lastCheck) : null,
        options.keepPending ? 1 : 0,
        now,
        id,
        claimToken,
      );
      if (options.delivery) queueDelivery(options.delivery, now);
      return get(id);
    });
  }

  /** End a trigger that is waiting (limit or expiry reached, or its owner is gone), with an optional message. */
  function endWaiting(
    id: string,
    status: Exclude<TerminalTriggerStatus, "cancelled"> | "cancelled",
    options: { delivery?: TriggerDelivery; error?: string } = {},
    now = new Date().toISOString(),
  ): boolean {
    return transaction(() => {
      if (!changed(endActiveStmt.run(status, options.error ?? null, now, id))) return false;
      if (options.delivery) queueDelivery(options.delivery, now);
      return true;
    });
  }

  // ── Runs (chats and tasks a trigger started) ─────────────────────

  /** Record a chat a fire started. False when this occurrence already recorded one. */
  function recordRun(run: { triggerId: string; sessionId: string; taskId?: string; occurrence?: string }, now = new Date().toISOString()): boolean {
    return changed(insertRun.run(run.triggerId, run.sessionId, run.taskId ?? null, run.occurrence ?? null, now));
  }

  function findRunByOccurrence(triggerId: string, occurrence: string): TriggerRun | undefined {
    const row = selectRunByOccurrence.get(triggerId, occurrence);
    return row ? toRun(row) : undefined;
  }

  /** Forget a run whose chat was rolled back because its launch failed. */
  function deleteRunByOccurrence(triggerId: string, occurrence: string): boolean {
    return changed(db.prepare("DELETE FROM trigger_runs WHERE triggerId = ? AND occurrence = ?").run(triggerId, occurrence));
  }

  /** Whether a trigger created this task (a new_task run recorded it). */
  function isTriggerMadeTask(taskId: string): boolean {
    return Boolean(db.prepare("SELECT 1 FROM trigger_runs WHERE taskId = ? LIMIT 1").get(taskId));
  }

  function listRuns(triggerId: string, options: { limit?: number; offset?: number } = {}): { runs: TriggerRun[]; total: number } {
    const total = Number((db.prepare("SELECT COUNT(*) AS n FROM trigger_runs WHERE triggerId = ?").get(triggerId) as { n: number }).n);
    const limit = options.limit ?? -1;
    const rows = db.prepare(`
      SELECT * FROM trigger_runs WHERE triggerId = ? ORDER BY recordedAt DESC, id DESC LIMIT ? OFFSET ?
    `).all(triggerId, limit, options.offset ?? 0) as any[];
    return { runs: rows.map(toRun), total };
  }

  /** Keep the newest `keep` run rows of a trigger, plus rows for chats still in use. */
  function pruneRuns(triggerId: string, keep: number, retainSessionIds: string[] = []): number {
    const retained = retainSessionIds.length ? ` AND sessionId NOT IN (${retainSessionIds.map(() => "?").join(", ")})` : "";
    const result = db.prepare(`
      DELETE FROM trigger_runs
      WHERE triggerId = ? AND id NOT IN (
        SELECT id FROM trigger_runs WHERE triggerId = ? ORDER BY recordedAt DESC, id DESC LIMIT ?
      )${retained}
    `).run(triggerId, triggerId, keep, ...retainSessionIds) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  /** Every chat any trigger started, so maintenance does not treat them as strays. */
  function listRunSessionIds(): string[] {
    return (db.prepare("SELECT DISTINCT sessionId FROM trigger_runs").all() as Array<{ sessionId: string }>).map((row) => row.sessionId);
  }

  function countRunsForDeletedTriggers(): number {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM trigger_runs WHERE triggerId NOT IN (SELECT id FROM triggers)").get() as { n: number }).n);
  }

  function deleteRunsForDeletedTriggers(): number {
    const result = db.prepare("DELETE FROM trigger_runs WHERE triggerId NOT IN (SELECT id FROM triggers)").run() as { changes?: number };
    return Number(result.changes ?? 0);
  }

  /** Bounded hard-delete of stopped triggers older than `olderThanIso`. Task triggers are kept until deleted. */
  function pruneTerminal(olderThanIso: string, limit = DEFAULT_TERMINAL_PRUNE_LIMIT): number {
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TERMINAL_PRUNE_LIMIT;
    const result = db.prepare(`
      DELETE FROM triggers WHERE id IN (
        SELECT id FROM triggers
        WHERE lane = 'chat' AND status IN ('completed', 'cancelled', 'expired', 'failed') AND updatedAt < ?
        ORDER BY updatedAt ASC LIMIT ?
      )
    `).run(olderThanIso, bounded) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  return {
    get, list, listDue, getNextWakeAt, listExpiredRunning,
    getSummaryForSession, listSummariesBySession, countActiveByTask, hasActiveForSession,
    create, update, pause, resume, reactivate, requestRunNow, cancel, remove,
    cancelForSession, deleteForSession, deleteForTask,
    claimDue, renewClaim, release, retryLater, noteWait, savePendingCheck, settleOccurrence, endWaiting,
    recordRun, findRunByOccurrence, deleteRunByOccurrence, isTriggerMadeTask, listRuns, pruneRuns, listRunSessionIds, countRunsForDeletedTriggers, deleteRunsForDeletedTriggers,
    pruneTerminal,
  };
}

export type TriggerStore = ReturnType<typeof createTriggerStore>;

export { EMPTY_TRIGGER_SUMMARY };
