// One-time move of defers and schedules into triggers. Runs while the database opens, before any
// runner starts. Rows keep their ids. The old rows are retired in the same transaction, so a release
// from before triggers that opens this database finds nothing left to run instead of running it twice.

import type { DatabaseSync } from "node:sqlite";
import { computeNextRunAt } from "../cron-next-run.js";
import { parseTriggerCheckSpecJson } from "./check.js";
import type { TriggerAction, TriggerLastCheck, TriggerStatus, TriggerWhen } from "./types.js";

const MARKER = "migration:triggers";
const RETIRED = "Moved to triggers";

function parseJson(json: unknown): unknown {
  if (typeof json !== "string" || !json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export interface TriggerMigrationReport {
  loops: number;
  oneShots: number;
  schedules: number;
  runs: number;
}

export function migrateToTriggersOnce(db: DatabaseSync, now = new Date()): TriggerMigrationReport | undefined {
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(MARKER)) return undefined;
  const nowIso = now.toISOString();
  const report: TriggerMigrationReport = { loops: 0, oneShots: 0, schedules: 0, runs: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    // The management job runner opens the same database; whoever inserts the marker does the work.
    const claimed = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(MARKER, nowIso);
    if (Number(claimed.changes) === 0) {
      db.exec("COMMIT");
      return undefined;
    }
    const insert = db.prepare(`
      INSERT OR IGNORE INTO triggers
        (id, name, prompt, sessionId, taskId, lane, whenJson, checkJson, actionJson, status, nextRunAt, runNow,
         runCount, fireCount, maxRuns, expiresAt, attempts, lastError, lastRunAt, lastFiredAt, lastSessionId,
         checkpoint, lastCheckJson, checkPendingJson, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTrigger = (row: {
      id: string; name?: string | null; prompt: string; sessionId?: string; taskId?: string;
      when: TriggerWhen; checkJson?: string | null; action: TriggerAction; status: TriggerStatus;
      nextRunAt?: string | null; runCount: number; fireCount: number; maxRuns?: number | null; expiresAt?: string | null;
      attempts?: number; lastError?: string | null; lastRunAt?: string | null; lastSessionId?: string | null;
      checkpoint?: string | null; lastCheck?: TriggerLastCheck; checkPendingJson?: string | null; createdAt: string;
    }) => Number(insert.run(
      row.id, row.name ?? null, row.prompt, row.sessionId ?? null, row.taskId ?? null,
      row.action.kind === "chat" ? "chat" : "task",
      JSON.stringify(row.when), row.checkJson ?? null, JSON.stringify(row.action), row.status, row.nextRunAt ?? null,
      row.runCount, row.fireCount, row.maxRuns ?? null, row.expiresAt ?? null, row.attempts ?? 0, row.lastError ?? null,
      row.lastRunAt ?? null, row.runCount > 0 ? row.lastRunAt ?? null : null, row.lastSessionId ?? null,
      row.checkpoint ?? null, row.lastCheck ? JSON.stringify(row.lastCheck) : null, row.checkPendingJson ?? null,
      row.createdAt, nowIso,
    ).changes) > 0;

    if (tableExists(db, "defer_loops")) {
      const loops = db.prepare("SELECT * FROM defer_loops WHERE status IN ('active', 'running')").all() as any[];
      for (const loop of loops) {
        const check = loop.checkSpec ? parseTriggerCheckSpecJson(loop.checkSpec) : undefined;
        const output = parseJson(loop.checkOutput) as TriggerLastCheck["output"] | undefined;
        const lastCheck: TriggerLastCheck | undefined = check && loop.lastCheckAt && loop.lastCheckOutcome
          ? {
              at: loop.lastCheckAt,
              outcome: loop.lastCheckOutcome,
              ...(loop.checkFingerprint ? { fingerprint: loop.checkFingerprint } : {}),
              ...(output ? { output } : {}),
            }
          : undefined;
        const moved = insertTrigger({
          id: loop.id, name: loop.name, prompt: loop.prompt, sessionId: loop.sessionId,
          when: { kind: "every", seconds: loop.intervalSeconds },
          checkJson: check ? JSON.stringify(check) : null,
          action: { kind: "chat", via: "worker" },
          // A loop the old release was running when it stopped runs again, as an expired lease would have.
          status: "active",
          nextRunAt: loop.status === "running" ? nowIso : loop.nextRunAt,
          runCount: loop.runCount, fireCount: loop.runCount, maxRuns: loop.maxRuns, expiresAt: loop.expiresAt,
          attempts: loop.status === "running" ? Math.max(0, loop.attempts - 1) : loop.attempts,
          lastError: loop.lastError, checkpoint: loop.checkpoint, lastCheck,
          checkPendingJson: check ? loop.checkPending : null, createdAt: loop.createdAt,
        });
        if (moved) report.loops += 1;
      }
      db.prepare(`
        UPDATE defer_loops SET status = 'cancelled', claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
        WHERE status IN ('active', 'running')
      `).run(RETIRED, nowIso);
    }

    if (tableExists(db, "deferred_prompts")) {
      // Only checks the old release ran in a worker. Restart-recovery messages stay in the outbox.
      const oneShots = db.prepare(`
        SELECT * FROM deferred_prompts
        WHERE purpose = 'defer' AND status IN ('pending', 'running') AND prompt NOT LIKE '<bridge_notice>%'
      `).all() as any[];
      for (const row of oneShots) {
        const moved = insertTrigger({
          id: row.id, prompt: row.prompt, sessionId: row.sessionId,
          when: { kind: "at", at: row.runAt },
          action: { kind: "chat", via: "worker" },
          status: "active",
          nextRunAt: row.status === "running" ? nowIso : row.runAt,
          runCount: 0, fireCount: 0, maxRuns: 1,
          attempts: row.status === "running" ? Math.max(0, row.attempts - 1) : row.attempts,
          lastError: row.lastError, createdAt: row.createdAt,
        });
        if (moved) report.oneShots += 1;
        db.prepare(`
          UPDATE deferred_prompts SET status = 'cancelled', claimToken = NULL, leaseExpiresAt = NULL, lastError = ?, updatedAt = ?
          WHERE id = ?
        `).run(RETIRED, nowIso, row.id);
      }
    }

    if (tableExists(db, "schedules")) {
      const schedules = db.prepare("SELECT * FROM schedules").all() as any[];
      for (const schedule of schedules) {
        const timezone = schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const when: TriggerWhen = schedule.type === "cron" && schedule.cron
          ? { kind: "cron", cron: schedule.cron, timezone }
          : { kind: "at", at: schedule.runAt ?? schedule.createdAt };
        const action: TriggerAction = {
          kind: "new_chat",
          ...(schedule.modelTier ? { modelTier: schedule.modelTier } : {}),
          ...(schedule.playbook ? { playbook: schedule.playbook } : {}),
          ...(schedule.autoArchiveKeep !== null && schedule.autoArchiveKeep !== undefined ? { keepChats: schedule.autoArchiveKeep } : {}),
        };
        const limitReached = schedule.maxRuns && schedule.runCount >= schedule.maxRuns;
        const expired = schedule.expiresAt && Date.parse(schedule.expiresAt) <= now.getTime();
        const status: TriggerStatus = when.kind === "at" && schedule.runCount > 0
          ? "completed"
          : limitReached ? "completed" : expired ? "expired" : schedule.enabled === 1 ? "active" : "paused";
        const nextRunAt = when.kind === "at"
          ? when.at
          : schedule.nextRunAt ?? computeNextRunAt(when.cron, when.timezone, now) ?? null;
        const moved = insertTrigger({
          id: schedule.id, name: schedule.name, prompt: schedule.prompt, taskId: schedule.taskId,
          when, action, status, nextRunAt,
          runCount: schedule.runCount, fireCount: schedule.runCount, maxRuns: schedule.maxRuns, expiresAt: schedule.expiresAt,
          lastRunAt: schedule.lastRunAt, lastSessionId: schedule.lastSessionId, createdAt: schedule.createdAt,
        });
        if (moved) report.schedules += 1;
      }
      db.prepare("UPDATE schedules SET enabled = 0, updatedAt = ? WHERE enabled = 1").run(nowIso);
      if (tableExists(db, "schedule_runs")) {
        report.runs = Number(db.prepare(`
          INSERT INTO trigger_runs (triggerId, sessionId, recordedAt)
          SELECT scheduleId, sessionId, recordedAt FROM schedule_runs
          WHERE scheduleId IN (SELECT id FROM triggers)
          ORDER BY recordedAt ASC, id ASC
        `).run().changes);
      }
    }

    db.exec("COMMIT");
    if (report.loops + report.oneShots + report.schedules > 0 && process.env.NODE_ENV !== "test") {
      console.log(`[triggers] Moved ${report.loops} recurring defer(s), ${report.oneShots} one-time defer(s) and ${report.schedules} schedule(s) to triggers`);
    }
    return report;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
