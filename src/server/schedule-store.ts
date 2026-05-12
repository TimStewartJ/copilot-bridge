// Schedule store — SQLite persistence

import type { DatabaseSync } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────

/** Get server's IANA timezone. Shared across schedule creation paths. */
export function getServerTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export type ScheduleTriggerSource = "manual" | "cron" | "once" | "catchup";
export type AutomaticScheduleTriggerSource = Exclude<ScheduleTriggerSource, "manual">;
export interface AutomaticRunClaim {
  runKey: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface DeletedScheduleRunGroup {
  scheduleId: string;
  runs: number;
}

const SCHEDULE_RUN_CLAIM_TTL_MS = 2 * 60 * 1000;
const SCHEDULE_LOCK_RUN_KEY = "__schedule_active__";

export interface Schedule {
  id: string;
  taskId: string;
  name: string;
  prompt: string;

  // Timing
  type: "cron" | "once";
  cron?: string;
  runAt?: string;
  timezone?: string;

  // Behavior
  enabled: boolean;
  lastSessionId?: string;

  // Lifecycle
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;

  // Limits
  maxRuns?: number;
  expiresAt?: string;
  autoArchiveKeep?: number;
}

export type ScheduleCreate = Pick<Schedule, "taskId" | "name" | "prompt" | "type"> &
  Partial<Pick<Schedule, "cron" | "runAt" | "timezone" | "maxRuns" | "expiresAt" | "autoArchiveKeep">>;

export type ScheduleUpdate = Partial<Pick<Schedule,
  "name" | "prompt" | "cron" | "runAt" | "timezone" | "enabled" | "maxRuns" | "expiresAt"
>> & {
  autoArchiveKeep?: number | null;
};

// ── Factory ───────────────────────────────────────────────────────

export function createScheduleStore(db: DatabaseSync) {
  const insertAutomaticRunClaim = db.prepare(`
    INSERT INTO schedule_run_claims (scheduleId, runKey, source, status, claimedAt, leaseExpiresAt)
    VALUES (?, ?, ?, 'claimed', ?, ?)
  `);
  const getAutomaticRunClaim = db.prepare(`
    SELECT status, claimedAt, leaseExpiresAt
    FROM schedule_run_claims
    WHERE scheduleId = ? AND runKey = ?
  `);
  const reclaimAutomaticRunClaim = db.prepare(`
    UPDATE schedule_run_claims
    SET source = ?, status = 'claimed', claimedAt = ?, leaseExpiresAt = ?, finishedAt = NULL, sessionId = NULL
    WHERE scheduleId = ? AND runKey = ? AND status = 'claimed' AND claimedAt = ? AND leaseExpiresAt = ?
  `);
  const renewAutomaticRunClaim = db.prepare(`
    UPDATE schedule_run_claims
    SET leaseExpiresAt = ?
    WHERE scheduleId = ? AND runKey = ? AND status = 'claimed' AND claimedAt = ? AND leaseExpiresAt = ?
  `);
  const releaseAutomaticRunClaim = db.prepare(`
    DELETE FROM schedule_run_claims
    WHERE scheduleId = ? AND runKey = ? AND status = 'claimed' AND claimedAt = ? AND leaseExpiresAt = ?
  `);
  const finishAutomaticRunClaim = db.prepare(`
    UPDATE schedule_run_claims
    SET status = ?, sessionId = ?, finishedAt = ?, leaseExpiresAt = ?
    WHERE scheduleId = ? AND runKey = ? AND status = 'claimed' AND claimedAt = ? AND leaseExpiresAt = ?
  `);

  function hydrate(row: any): Schedule {
    return {
      id: row.id,
      taskId: row.taskId,
      name: row.name,
      prompt: row.prompt,
      type: row.type as "cron" | "once",
      cron: row.cron ?? undefined,
      runAt: row.runAt ?? undefined,
      timezone: row.timezone ?? undefined,
      enabled: row.enabled === 1,
      lastSessionId: row.lastSessionId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastRunAt: row.lastRunAt ?? undefined,
      nextRunAt: row.nextRunAt ?? undefined,
      runCount: row.runCount,
      maxRuns: row.maxRuns ?? undefined,
      expiresAt: row.expiresAt ?? undefined,
      autoArchiveKeep: row.autoArchiveKeep ?? undefined,
    };
  }

  function listSchedules(taskId?: string): Schedule[] {
    const rows = taskId
      ? db.prepare("SELECT * FROM schedules WHERE taskId = ? ORDER BY updatedAt DESC").all(taskId) as any[]
      : db.prepare("SELECT * FROM schedules ORDER BY updatedAt DESC").all() as any[];
    return rows.map(hydrate);
  }

  function getSchedule(id: string): Schedule | undefined {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function createSchedule(input: ScheduleCreate): Schedule {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO schedules (id, taskId, name, prompt, type, cron, runAt, timezone,
        enabled, createdAt, updatedAt, runCount, maxRuns, expiresAt, autoArchiveKeep)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?)
    `).run(
      id, input.taskId, input.name, input.prompt, input.type,
      input.cron ?? null, input.runAt ?? null, input.timezone ?? getServerTimezone(),
      now, now,
      input.maxRuns ?? null, input.expiresAt ?? null, input.autoArchiveKeep ?? null,
    );

    return getSchedule(id)!;
  }

  function updateSchedule(id: string, updates: ScheduleUpdate): Schedule {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Schedule ${id} not found`);

    const fields: string[] = ["updatedAt = ?"];
    const values: any[] = [new Date().toISOString()];

    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.prompt !== undefined) { fields.push("prompt = ?"); values.push(updates.prompt); }
    if (updates.cron !== undefined) { fields.push("cron = ?"); values.push(updates.cron); }
    if (updates.runAt !== undefined) { fields.push("runAt = ?"); values.push(updates.runAt); }
    if (updates.timezone !== undefined) { fields.push("timezone = ?"); values.push(updates.timezone); }
    if (updates.enabled !== undefined) { fields.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
    if (updates.maxRuns !== undefined) { fields.push("maxRuns = ?"); values.push(updates.maxRuns); }
    if (updates.expiresAt !== undefined) { fields.push("expiresAt = ?"); values.push(updates.expiresAt); }
    if (updates.autoArchiveKeep !== undefined) { fields.push("autoArchiveKeep = ?"); values.push(updates.autoArchiveKeep); }

    values.push(id);
    db.prepare(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return getSchedule(id)!;
  }

  function deleteSchedule(id: string): void {
    db.prepare("DELETE FROM schedule_run_claims WHERE scheduleId = ?").run(id);
    db.prepare("DELETE FROM schedule_runs WHERE scheduleId = ?").run(id);
    db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  function applyRecordedRun(schedule: Schedule, sessionId: string, nextRunAt?: string, now = new Date().toISOString()): void {
    const newRunCount = schedule.runCount + 1;
    let enabled = schedule.enabled;
    if (schedule.type === "once") enabled = false;
    if (schedule.maxRuns && newRunCount >= schedule.maxRuns) enabled = false;
    if (schedule.expiresAt && new Date(now) >= new Date(schedule.expiresAt)) enabled = false;

    db.prepare(`
      UPDATE schedules SET lastRunAt = ?, lastSessionId = ?, runCount = ?,
        nextRunAt = ?, updatedAt = ?, enabled = ?
      WHERE id = ?
    `).run(now, sessionId, newRunCount, nextRunAt ?? null, now, enabled ? 1 : 0, schedule.id);
  }

  function recordRun(id: string, sessionId: string, nextRunAt?: string): void {
    const schedule = getSchedule(id);
    if (!schedule) return;
    applyRecordedRun(schedule, sessionId, nextRunAt);
  }

  function claimRun(
    id: string,
    runKey: string,
    source: ScheduleTriggerSource,
    claimedAt = new Date().toISOString(),
  ): { acquired: true; claim: AutomaticRunClaim } | { acquired: false; runKey: string; reason: string } {
    const normalizedRunKey = runKey === SCHEDULE_LOCK_RUN_KEY ? SCHEDULE_LOCK_RUN_KEY : new Date(runKey).toISOString();
    const normalizedClaimedAt = new Date(claimedAt).toISOString();
    const leaseExpiresAt = new Date(Date.parse(normalizedClaimedAt) + SCHEDULE_RUN_CLAIM_TTL_MS).toISOString();

    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = getAutomaticRunClaim.get(id, normalizedRunKey) as
        | { status: "claimed" | "triggered" | "skipped"; claimedAt: string; leaseExpiresAt: string }
        | undefined;
      if (!existing) {
        insertAutomaticRunClaim.run(id, normalizedRunKey, source, normalizedClaimedAt, leaseExpiresAt);
        db.exec("COMMIT");
        return {
          acquired: true,
          claim: { runKey: normalizedRunKey, claimedAt: normalizedClaimedAt, leaseExpiresAt },
        };
      }

      if (existing.status === "claimed" && Date.parse(existing.leaseExpiresAt) <= Date.parse(normalizedClaimedAt)) {
        const result = reclaimAutomaticRunClaim.run(
          source,
          normalizedClaimedAt,
          leaseExpiresAt,
          id,
          normalizedRunKey,
          existing.claimedAt,
          existing.leaseExpiresAt,
        ) as { changes?: number };
        if ((result.changes ?? 0) > 0) {
          db.exec("COMMIT");
          return {
            acquired: true,
            claim: { runKey: normalizedRunKey, claimedAt: normalizedClaimedAt, leaseExpiresAt },
          };
        }
      }

      db.exec("COMMIT");
      return {
        acquired: false,
        runKey: normalizedRunKey,
        reason: existing.status === "claimed"
          ? "This scheduled slot is already being processed"
          : "This scheduled slot already ran",
      };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function claimAutomaticRun(
    id: string,
    runKey: string,
    source: AutomaticScheduleTriggerSource,
    claimedAt = new Date().toISOString(),
  ): { acquired: true; claim: AutomaticRunClaim } | { acquired: false; runKey: string; reason: string } {
    return claimRun(id, runKey, source, claimedAt);
  }

  function claimScheduleRun(
    id: string,
    source: ScheduleTriggerSource,
    claimedAt = new Date().toISOString(),
  ): { acquired: true; claim: AutomaticRunClaim } | { acquired: false; runKey: string; reason: string } {
    return claimRun(id, SCHEDULE_LOCK_RUN_KEY, source, claimedAt);
  }

  function completeAutomaticRun(id: string, claim: AutomaticRunClaim, sessionId: string, nextRunAt?: string): boolean {
    const finishedAt = new Date().toISOString();

    db.exec("BEGIN");
    try {
      const result = finishAutomaticRunClaim.run(
        "triggered",
        sessionId,
        finishedAt,
        finishedAt,
        id,
        claim.runKey,
        claim.claimedAt,
        claim.leaseExpiresAt,
      ) as { changes?: number };
      if ((result.changes ?? 0) === 0) {
        db.exec("COMMIT");
        return false;
      }
      const schedule = getSchedule(id);
      if (schedule) {
        applyRecordedRun(schedule, sessionId, nextRunAt, finishedAt);
      }
      db.exec("COMMIT");
      return true;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function skipAutomaticRun(id: string, claim: AutomaticRunClaim): boolean {
    const finishedAt = new Date().toISOString();

    db.exec("BEGIN");
    try {
      const result = finishAutomaticRunClaim.run(
        "skipped",
        null,
        finishedAt,
        finishedAt,
        id,
        claim.runKey,
        claim.claimedAt,
        claim.leaseExpiresAt,
      ) as { changes?: number };
      if ((result.changes ?? 0) === 0) {
        db.exec("COMMIT");
        return false;
      }
      const schedule = getSchedule(id);
      if (schedule?.type === "once") {
        db.prepare(`
          UPDATE schedules
          SET nextRunAt = NULL, enabled = 0, updatedAt = ?
          WHERE id = ?
        `).run(finishedAt, schedule.id);
      }
      db.exec("COMMIT");
      return true;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function releaseClaimedAutomaticRun(id: string, claim: AutomaticRunClaim): boolean {
    const result = releaseAutomaticRunClaim.run(
      id,
      claim.runKey,
      claim.claimedAt,
      claim.leaseExpiresAt,
    ) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  function renewClaimedAutomaticRun(id: string, claim: AutomaticRunClaim, renewedAt = new Date().toISOString()): boolean {
    const newLeaseExpiresAt = new Date(Date.parse(renewedAt) + SCHEDULE_RUN_CLAIM_TTL_MS).toISOString();
    const result = renewAutomaticRunClaim.run(
      newLeaseExpiresAt,
      id,
      claim.runKey,
      claim.claimedAt,
      claim.leaseExpiresAt,
    ) as { changes?: number };
    if ((result.changes ?? 0) === 0) return false;
    claim.leaseExpiresAt = newLeaseExpiresAt;
    return true;
  }

  function updateNextRunAt(id: string, nextRunAt: string): void {
    db.prepare("UPDATE schedules SET nextRunAt = ? WHERE id = ?").run(nextRunAt, id);
  }

  function getSchedulesForTask(taskId: string): Schedule[] {
    return (db.prepare("SELECT * FROM schedules WHERE taskId = ?").all(taskId) as any[]).map(hydrate);
  }

  function getEnabledSchedules(): Schedule[] {
    return (db.prepare("SELECT * FROM schedules WHERE enabled = 1").all() as any[]).map(hydrate);
  }

  function listClaimedSessionIds(): string[] {
    const automaticRunClaims = db.prepare(`
      SELECT sessionId
      FROM schedule_run_claims
      WHERE sessionId IS NOT NULL
    `).all() as Array<{ sessionId: string }>;
    return [...new Set(automaticRunClaims.map((row) => row.sessionId))];
  }

  function listScheduleRunSessionIds(): string[] {
    const rows = db.prepare("SELECT DISTINCT sessionId FROM schedule_runs").all() as Array<{ sessionId: string }>;
    return rows.map((row) => row.sessionId);
  }

  function listDeletedScheduleRunGroups(): DeletedScheduleRunGroup[] {
    return (db.prepare(`
      SELECT sr.scheduleId, COUNT(*) AS runs
      FROM schedule_runs sr
      LEFT JOIN schedules s ON s.id = sr.scheduleId
      WHERE s.id IS NULL
      GROUP BY sr.scheduleId
      ORDER BY runs DESC, sr.scheduleId ASC
    `).all() as Array<{ scheduleId: string; runs: number }>).map((row) => ({
      scheduleId: row.scheduleId,
      runs: Number(row.runs),
    }));
  }

  function deleteRunsForDeletedSchedules(): number {
    const result = db.prepare(`
      DELETE FROM schedule_runs
      WHERE scheduleId NOT IN (SELECT id FROM schedules)
    `).run() as { changes?: number };
    return result.changes ?? 0;
  }

  return {
    listSchedules, getSchedule, createSchedule, updateSchedule, deleteSchedule,
    recordRun, claimScheduleRun, claimAutomaticRun,
    completeAutomaticRun, skipAutomaticRun,
    releaseClaimedAutomaticRun, renewClaimedAutomaticRun,
    updateNextRunAt, getSchedulesForTask, getEnabledSchedules,
    listClaimedSessionIds, listScheduleRunSessionIds, listDeletedScheduleRunGroups, deleteRunsForDeletedSchedules,
  };
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>;
