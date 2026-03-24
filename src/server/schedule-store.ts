// Schedule store — JSON persistence in data/schedules.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  taskId: string;
  name: string;
  prompt: string;

  // Timing
  type: "cron" | "once";
  cron?: string;        // cron expression (e.g. "0 8 * * 1-5")
  runAt?: string;       // ISO timestamp for one-shot schedules
  timezone?: string;    // IANA timezone (default: system local)

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
  maxRuns?: number;     // auto-disable after N runs (null = unlimited)
  expiresAt?: string;   // auto-disable after this date
}

export type ScheduleCreate = Pick<Schedule, "taskId" | "name" | "prompt" | "type"> &
  Partial<Pick<Schedule, "cron" | "runAt" | "timezone" | "reuseSession" | "maxRuns" | "expiresAt">>;

export type ScheduleUpdate = Partial<Pick<Schedule,
  "name" | "prompt" | "cron" | "runAt" | "timezone" | "enabled" | "reuseSession" | "maxRuns" | "expiresAt"
>>;

// ── Factory ───────────────────────────────────────────────────────

export function createScheduleStore(dataDir: string) {
  const SCHEDULES_FILE = join(dataDir, "schedules.json");

  function load(): Schedule[] {
    if (!existsSync(SCHEDULES_FILE)) return [];
    try {
      return JSON.parse(readFileSync(SCHEDULES_FILE, "utf-8"));
    } catch {
      return [];
    }
  }

  function save(schedules: Schedule[]): void {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  }

  function listSchedules(taskId?: string): Schedule[] {
    const all = load();
    const filtered = taskId ? all.filter((s) => s.taskId === taskId) : all;
    return filtered.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  function getSchedule(id: string): Schedule | undefined {
    return load().find((s) => s.id === id);
  }

  function createSchedule(input: ScheduleCreate): Schedule {
    const schedules = load();
    const now = new Date().toISOString();

    const schedule: Schedule = {
      id: crypto.randomUUID(),
      taskId: input.taskId,
      name: input.name,
      prompt: input.prompt,
      type: input.type,
      cron: input.cron,
      runAt: input.runAt,
      timezone: input.timezone,
      enabled: true,
      reuseSession: input.reuseSession ?? false,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      maxRuns: input.maxRuns,
      expiresAt: input.expiresAt,
    };

    schedules.push(schedule);
    save(schedules);
    return schedule;
  }

  function updateSchedule(id: string, updates: ScheduleUpdate): Schedule {
    const schedules = load();
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Schedule ${id} not found`);

    const schedule = schedules[idx];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        (schedule as any)[key] = value;
      }
    }
    schedule.updatedAt = new Date().toISOString();

    schedules[idx] = schedule;
    save(schedules);
    return schedule;
  }

  function deleteSchedule(id: string): void {
    const schedules = load().filter((s) => s.id !== id);
    save(schedules);
  }

  function recordRun(id: string, sessionId: string, nextRunAt?: string): void {
    const schedules = load();
    const schedule = schedules.find((s) => s.id === id);
    if (!schedule) return;

    schedule.lastRunAt = new Date().toISOString();
    schedule.lastSessionId = sessionId;
    schedule.runCount += 1;
    if (nextRunAt) schedule.nextRunAt = nextRunAt;
    schedule.updatedAt = new Date().toISOString();

    // Auto-disable one-shot schedules
    if (schedule.type === "once") {
      schedule.enabled = false;
    }

    // Auto-disable if maxRuns reached
    if (schedule.maxRuns && schedule.runCount >= schedule.maxRuns) {
      schedule.enabled = false;
    }

    // Auto-disable if expired
    if (schedule.expiresAt && new Date() >= new Date(schedule.expiresAt)) {
      schedule.enabled = false;
    }

    save(schedules);
  }

  function updateNextRunAt(id: string, nextRunAt: string): void {
    const schedules = load();
    const schedule = schedules.find((s) => s.id === id);
    if (!schedule) return;
    schedule.nextRunAt = nextRunAt;
    save(schedules);
  }

  function getSchedulesForTask(taskId: string): Schedule[] {
    return load().filter((s) => s.taskId === taskId);
  }

  function getEnabledSchedules(): Schedule[] {
    return load().filter((s) => s.enabled);
  }

  return {
    listSchedules, getSchedule, createSchedule, updateSchedule, deleteSchedule,
    recordRun, updateNextRunAt, getSchedulesForTask, getEnabledSchedules,
  };
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>;

// ── Default instance (backward compat) ────────────────────────────

const _defaultDataDir = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const _default = createScheduleStore(_defaultDataDir);
export const listSchedules = _default.listSchedules;
export const getSchedule = _default.getSchedule;
export const createSchedule = _default.createSchedule;
export const updateSchedule = _default.updateSchedule;
export const deleteSchedule = _default.deleteSchedule;
export const recordRun = _default.recordRun;
export const updateNextRunAt = _default.updateNextRunAt;
export const getSchedulesForTask = _default.getSchedulesForTask;
export const getEnabledSchedules = _default.getEnabledSchedules;
