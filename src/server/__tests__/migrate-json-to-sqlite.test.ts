import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { migrateJsonToSqlite } from "../migrate-json-to-sqlite.js";
import { createScheduleStore } from "../schedule-store.js";

const UNKNOWN_SCHEDULE_RUN_AT = "0001-01-01T00:00:00.000Z";

describe("JSON task migration", () => {
  it("normalizes paused tasks to active and clears parked momentum from non-active tasks", () => {
    const db = setupTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-migrate-tasks-"));

    writeFileSync(
      join(dataDir, "tasks.json"),
      JSON.stringify([
        {
          id: "task-paused",
          title: "Paused task",
          status: "paused",
          notes: "",
          doneWhen: "Release is fully rolled out",
          nextAction: "Review production metrics",
          waitingOn: "Customer confirmation",
          nextTouchAt: "2026-03-01T12:00:00.000Z",
          pinned: true,
          order: 1,
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-02T00:00:00.000Z",
        },
        {
          id: "task-done",
          title: "Done task",
          status: "done",
          notes: "",
          doneWhen: "Release is fully rolled out",
          nextAction: "Should be cleared",
          waitingOn: "Should be cleared",
          nextTouchAt: "2026-03-02T12:00:00.000Z",
          pinned: false,
          order: 2,
          createdAt: "2026-02-03T00:00:00.000Z",
          updatedAt: "2026-02-04T00:00:00.000Z",
        },
        {
          id: "task-archived",
          title: "Archived task",
          status: "archived",
          notes: "",
          doneWhen: "Release is fully rolled out",
          nextAction: "Should be cleared",
          waitingOn: "Should be cleared",
          nextTouchAt: "2026-03-03T12:00:00.000Z",
          pinned: false,
          order: 3,
          createdAt: "2026-02-05T00:00:00.000Z",
          updatedAt: "2026-02-06T00:00:00.000Z",
        },
      ]),
    );

    migrateJsonToSqlite(db, dataDir);

    const rows = db.prepare(`
      SELECT id, kind, status, doneWhen, nextAction, waitingOn, nextTouchAt
      FROM tasks
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        id: "task-archived",
        kind: "task",
        status: "archived",
        doneWhen: "Release is fully rolled out",
        nextAction: null,
        waitingOn: null,
        nextTouchAt: null,
      },
      {
        id: "task-done",
        kind: "task",
        status: "done",
        doneWhen: "Release is fully rolled out",
        nextAction: null,
        waitingOn: null,
        nextTouchAt: null,
      },
      {
        id: "task-paused",
        kind: "ongoing",
        status: "active",
        doneWhen: null,
        nextAction: "Review production metrics",
        waitingOn: "Customer confirmation",
        nextTouchAt: "2026-03-01T12:00:00.000Z",
      },
    ]);
  });
});

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
