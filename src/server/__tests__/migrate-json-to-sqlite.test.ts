import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { migrateJsonToSqlite } from "../migrate-json-to-sqlite.js";
import { createScheduleStore } from "../schedule-store.js";

const UNKNOWN_SCHEDULE_RUN_AT = "0001-01-01T00:00:00.000Z";

describe("JSON schedule migration", () => {
  it("preserves run history from both session metadata and schedules", () => {
    const db = setupTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-migrate-schedules-"));

    writeFileSync(join(dataDir, "tasks.json"), "[]");
    writeFileSync(
      join(dataDir, "schedules.json"),
      JSON.stringify([
        {
          id: "sched-1",
          taskId: "task-1",
          name: "Latest owner",
          prompt: "Continue the conversation",
          type: "cron",
          cron: "0 0 * * *",
          enabled: true,
          reuseSession: true,
          lastSessionId: "session-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          lastRunAt: "2026-01-02T00:00:00.000Z",
          runCount: 1,
        },
        {
          id: "sched-2",
          taskId: "task-1",
          name: "Older owner",
          prompt: "Continue the conversation",
          type: "cron",
          cron: "0 0 * * *",
          enabled: true,
          reuseSession: true,
          lastSessionId: "session-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T12:00:00.000Z",
          lastRunAt: "2026-01-01T12:00:00.000Z",
          runCount: 1,
        },
      ]),
    );
    writeFileSync(
      join(dataDir, "sessions-meta.json"),
      JSON.stringify({
        "session-1": {
          archived: false,
          archivedAt: null,
          triggeredBy: "schedule",
          scheduleId: "sched-1",
          scheduleName: "Latest owner",
        },
      }),
    );

    migrateJsonToSqlite(db, dataDir);

    const schedule = createScheduleStore(db).getSchedule("sched-1");
    expect(schedule).toMatchObject({
      id: "sched-1",
      sessionMode: "reuse-last",
      lastSessionId: "session-1",
    });
    expect(createScheduleStore(db).getSchedule("sched-2")).toMatchObject({
      id: "sched-2",
      sessionMode: "reuse-last",
      lastSessionId: "session-1",
    });

    const runs = db.prepare(
      "SELECT scheduleId, sessionId, recordedAt FROM schedule_runs ORDER BY scheduleId, id",
    ).all() as Array<{ scheduleId: string; sessionId: string; recordedAt: string }>;
    expect(runs).toEqual([
      { scheduleId: "sched-1", sessionId: "session-1", recordedAt: "2026-01-02T00:00:00.000Z" },
      { scheduleId: "sched-2", sessionId: "session-1", recordedAt: "2026-01-01T12:00:00.000Z" },
    ]);
  });

  it("marks unknown migrated run times with a sentinel instead of migration time", () => {
    const db = setupTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-migrate-schedules-unknown-"));

    writeFileSync(join(dataDir, "tasks.json"), "[]");
    writeFileSync(
      join(dataDir, "sessions-meta.json"),
      JSON.stringify({
        "session-legacy": {
          archived: false,
          archivedAt: null,
          triggeredBy: "schedule",
          scheduleId: "sched-legacy",
          scheduleName: "Legacy schedule",
        },
      }),
    );

    migrateJsonToSqlite(db, dataDir);

    const runs = db.prepare(
      "SELECT scheduleId, sessionId, recordedAt FROM schedule_runs ORDER BY id",
    ).all() as Array<{ scheduleId: string; sessionId: string; recordedAt: string }>;
    expect(runs).toEqual([
      { scheduleId: "sched-legacy", sessionId: "session-legacy", recordedAt: UNKNOWN_SCHEDULE_RUN_AT },
    ]);
  });
});
