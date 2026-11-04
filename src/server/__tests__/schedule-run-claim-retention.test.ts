import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createScheduleStore, type ScheduleStore } from "../schedule-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let store: ScheduleStore;

beforeEach(() => {
  db = setupTestDb();
  store = createScheduleStore(db);
});

afterEach(() => {
  db.close();
});

const baseCron = {
  taskId: "task-1",
  name: "Daily standup",
  prompt: "Prep standup notes",
  type: "cron" as const,
  cron: "0 8 * * 1-5",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function countClaims(scheduleId?: string): number {
  const row = scheduleId
    ? db.prepare("SELECT COUNT(*) AS count FROM schedule_run_claims WHERE scheduleId = ?").get(scheduleId) as { count: number }
    : db.prepare("SELECT COUNT(*) AS count FROM schedule_run_claims").get() as { count: number };
  return row.count;
}

/** Run and finish an automatic run at the given instant. */
function runAt(scheduleId: string, at: Date): void {
  const iso = at.toISOString();
  const claimed = store.claimAutomaticRun(scheduleId, iso, "cron", iso);
  if (!claimed.acquired) throw new Error(`expected claim for ${iso}`);
  store.completeAutomaticRun(scheduleId, claimed.claim, `session-${iso}`);
}

describe("schedule_run_claims retention", () => {
  it("converges instead of growing once per fire forever", () => {
    const schedule = store.createSchedule(baseCron);
    const now = new Date("2026-06-01T08:00:00.000Z");

    // 200 daily runs, all well outside the catch-up window.
    for (let i = 200; i >= 1; i--) {
      runAt(schedule.id, new Date(now.getTime() - i * DAY_MS));
    }
    expect(countClaims(schedule.id)).toBe(200);

    const removed = store.pruneFinishedRunClaims(schedule.id, 20, now);
    expect(removed).toBe(180);
    expect(countClaims(schedule.id)).toBe(20);

    // Steady state: more runs then another prune stays at the bound.
    for (let i = 20; i >= 1; i--) {
      runAt(schedule.id, new Date(now.getTime() - (i + 200) * DAY_MS));
    }
    store.pruneFinishedRunClaims(schedule.id, 20, now);
    expect(countClaims(schedule.id)).toBe(20);
  });

  it("prunes only old finished slots for the requested schedule, including skipped slots", () => {
    const schedule = store.createSchedule(baseCron);
    const now = new Date("2026-06-01T08:00:00.000Z");
    const justFinished = new Date(now.getTime() - 60 * 1000);
    const yesterday = new Date(now.getTime() - DAY_MS);
    const longAgo = new Date(now.getTime() - 30 * DAY_MS);

    runAt(schedule.id, longAgo);
    runAt(schedule.id, yesterday);
    runAt(schedule.id, justFinished);
    const other = store.createSchedule({ ...baseCron, name: "Other" });
    runAt(other.id, longAgo);
    const skippedAt = new Date(longAgo.getTime() - DAY_MS).toISOString();
    const skipped = store.claimAutomaticRun(schedule.id, skippedAt, "cron", skippedAt);
    if (!skipped.acquired) throw new Error("expected claim");
    expect(store.skipAutomaticRun(schedule.id, skipped.claim)).toBe(true);

    // keep = 0 removes everything the age floor allows, and nothing more.
    expect(store.pruneFinishedRunClaims(schedule.id, 0, now)).toBe(2);
    expect(countClaims(other.id)).toBe(1);
    expect(countClaims(schedule.id)).toBe(2);

    // Both in-window runs are still deduplicated.
    expect(store.claimAutomaticRun(schedule.id, justFinished.toISOString(), "catchup", now.toISOString()))
      .toMatchObject({ acquired: false });
    expect(store.claimAutomaticRun(schedule.id, yesterday.toISOString(), "catchup", now.toISOString()))
      .toMatchObject({ acquired: false });
  });

  it("never prunes an in-flight claim or the manual trigger lock", () => {
    const schedule = store.createSchedule(baseCron);
    const now = new Date("2026-06-01T08:00:00.000Z");
    const longAgo = new Date(now.getTime() - 30 * DAY_MS).toISOString();

    const inFlight = store.claimAutomaticRun(schedule.id, longAgo, "cron", longAgo);
    expect(inFlight.acquired).toBe(true);
    const lock = store.claimScheduleRun(schedule.id, "manual", longAgo);
    expect(lock.acquired).toBe(true);

    expect(store.pruneFinishedRunClaims(schedule.id, 0, now)).toBe(0);
    expect(countClaims(schedule.id)).toBe(2);
  });

  it("sweeps claims left behind by schedules that no longer exist", () => {
    const schedule = store.createSchedule(baseCron);
    runAt(schedule.id, new Date("2026-05-01T08:00:00.000Z"));
    // Simulate a row orphaned by an older Bridge version that deleted the
    // schedule without cascading its claims.
    db.prepare("DELETE FROM schedules WHERE id = ?").run(schedule.id);
    expect(countClaims()).toBe(1);

    store.deleteRunsForDeletedSchedules();
    expect(countClaims()).toBe(0);
  });

  it("cascades claims when a schedule is deleted normally", () => {
    const schedule = store.createSchedule(baseCron);
    runAt(schedule.id, new Date("2026-05-01T08:00:00.000Z"));
    store.deleteSchedule(schedule.id);
    expect(countClaims()).toBe(0);
  });
});
