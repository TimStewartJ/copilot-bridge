// Schedule store — SQLite persistence

import type { DatabaseSync } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────

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
  reuseSession: boolean;
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
}

export type ScheduleCreate = Pick<Schedule, "taskId" | "name" | "prompt" | "type"> &
  Partial<Pick<Schedule, "cron" | "runAt" | "timezone" | "reuseSession" | "maxRuns" | "expiresAt">>;

export type ScheduleUpdate = Partial<Pick<Schedule,
  "name" | "prompt" | "cron" | "runAt" | "timezone" | "enabled" | "reuseSession" | "maxRuns" | "expiresAt"
>>;

// ── Factory ───────────────────────────────────────────────────────

export function createScheduleStore(db: DatabaseSync) {
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
      reuseSession: row.reuseSession === 1,
      lastSessionId: row.lastSessionId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastRunAt: row.lastRunAt ?? undefined,
      nextRunAt: row.nextRunAt ?? undefined,
      runCount: row.runCount,
      maxRuns: row.maxRuns ?? undefined,
      expiresAt: row.expiresAt ?? undefined,
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
        enabled, reuseSession, createdAt, updatedAt, runCount, maxRuns, expiresAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)
    `).run(
      id, input.taskId, input.name, input.prompt, input.type,
      input.cron ?? null, input.runAt ?? null, input.timezone ?? null,
      input.reuseSession ? 1 : 0, now, now,
      input.maxRuns ?? null, input.expiresAt ?? null,
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
    if (updates.reuseSession !== undefined) { fields.push("reuseSession = ?"); values.push(updates.reuseSession ? 1 : 0); }
    if (updates.maxRuns !== undefined) { fields.push("maxRuns = ?"); values.push(updates.maxRuns); }
    if (updates.expiresAt !== undefined) { fields.push("expiresAt = ?"); values.push(updates.expiresAt); }

    values.push(id);
    db.prepare(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return getSchedule(id)!;
  }

  function deleteSchedule(id: string): void {
    db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  function recordRun(id: string, sessionId: string, nextRunAt?: string): void {
    const schedule = getSchedule(id);
    if (!schedule) return;

    const now = new Date().toISOString();
    const newRunCount = schedule.runCount + 1;

    let enabled = schedule.enabled;
    // Auto-disable one-shot schedules
    if (schedule.type === "once") enabled = false;
    // Auto-disable if maxRuns reached
    if (schedule.maxRuns && newRunCount >= schedule.maxRuns) enabled = false;
    // Auto-disable if expired
    if (schedule.expiresAt && new Date() >= new Date(schedule.expiresAt)) enabled = false;

    db.prepare(`
      UPDATE schedules SET lastRunAt = ?, lastSessionId = ?, runCount = ?,
        nextRunAt = ?, updatedAt = ?, enabled = ?
      WHERE id = ?
    `).run(now, sessionId, newRunCount, nextRunAt ?? null, now, enabled ? 1 : 0, id);
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

  return {
    listSchedules, getSchedule, createSchedule, updateSchedule, deleteSchedule,
    recordRun, updateNextRunAt, getSchedulesForTask, getEnabledSchedules,
  };
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>;
