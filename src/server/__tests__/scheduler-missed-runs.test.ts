import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schedule } from "../schedule-store.js";
import { computeNextRunAt } from "../cron-next-run.js";
import { createMissedRunCatchUpController } from "../scheduler-missed-runs.js";

const NOW = "2026-04-16T17:30:00.000Z";

function schedule(overrides: Partial<Schedule>): Schedule {
  return {
    id: "schedule-1",
    taskId: "task-1",
    name: "Test schedule",
    prompt: "run",
    type: "cron",
    cron: "30 * * * *",
    timezone: "UTC",
    enabled: true,
    createdAt: "2026-04-16T15:00:00.000Z",
    updatedAt: "2026-04-16T15:00:00.000Z",
    runCount: 1,
    ...overrides,
  };
}

function fakeStore(schedules: Schedule[]) {
  const byId = new Map(schedules.map((item) => [item.id, item]));
  return {
    listDueSchedules: vi.fn(() => schedules),
    getSchedule: vi.fn((id: string) => byId.get(id)),
    updateSchedule: vi.fn((id: string, updates: Partial<Schedule>) => {
      const existing = byId.get(id);
      if (!existing) throw new Error(`Schedule ${id} not found`);
      Object.assign(existing, updates);
      return existing;
    }),
    updateNextRunAt: vi.fn((id: string, nextRunAt: string) => {
      const existing = byId.get(id);
      if (existing) existing.nextRunAt = nextRunAt;
    }),
    getEnabledSchedules: vi.fn(() => {
      throw new Error("missed-run catch-up should not scan all enabled schedules");
    }),
  };
}

describe("scheduler missed-run catch-up", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects cron catch-up work from due schedules without scanning all schedules", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00.000Z"));

    const due = schedule({
      id: "cron-1",
      lastRunAt: "2026-04-16T15:00:00.000Z",
      nextRunAt: "2026-04-16T15:30:00.000Z",
    });
    const store = fakeStore([due]);
    const triggerSchedule = vi.fn().mockResolvedValue({ sessionId: "catch-up-session" });
    const computeNextRunAt = vi.fn(() => "2026-04-16T16:30:00.000Z");
    const controller = createMissedRunCatchUpController({
      scheduleStore: () => store as any,
      computeNextRunAt,
      unregisterSchedule: vi.fn(),
      triggerSchedule,

    });

    controller.check();
    await controller.waitForIdle();

    expect(triggerSchedule).toHaveBeenCalledTimes(1);
    expect(store.listDueSchedules).toHaveBeenCalledTimes(1);
    const listDueSchedulesCalls = store.listDueSchedules.mock.calls as string[][];
    expect(listDueSchedulesCalls[0]?.[0]).toMatch(/^2026-04-16T16:00:00\.\d{3}Z$/);
    expect(store.getEnabledSchedules).not.toHaveBeenCalled();
    expect(computeNextRunAt).not.toHaveBeenCalled();
    expect(triggerSchedule).toHaveBeenCalledWith("cron-1", {
      source: "catchup",
      scheduledFor: "2026-04-16T15:30:00.000Z",
    });
  });

  it("derives catch-up slots for supported zero-second six-field crons", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:11:00.000Z"));

    const due = schedule({
      id: "cron-six",
      cron: "0 */5 * * * *",
      lastRunAt: "2026-04-16T16:00:00.000Z",
      nextRunAt: undefined,
    });
    const store = fakeStore([due]);
    const triggerSchedule = vi.fn().mockResolvedValue({ sessionId: "catch-up-session" });
    const controller = createMissedRunCatchUpController({
      scheduleStore: () => store as any,
      computeNextRunAt,
      unregisterSchedule: vi.fn(),
      triggerSchedule,

    });

    controller.check();
    await controller.waitForIdle();

    expect(triggerSchedule).toHaveBeenCalledTimes(1);
    expect(triggerSchedule).toHaveBeenCalledWith("cron-six", {
      source: "catchup",
      scheduledFor: "2026-04-16T16:05:00.000Z",
    });
  });

  it("advances stale cron slots without replaying or disabling the schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const stale = schedule({
      id: "cron-stale",
      lastRunAt: "2026-04-16T14:00:00.000Z",
      nextRunAt: "2026-04-16T14:30:00.000Z",
    });
    const store = fakeStore([stale]);
    const triggerSchedule = vi.fn().mockResolvedValue({ sessionId: "should-not-run" });
    const unregisterSchedule = vi.fn();
    const controller = createMissedRunCatchUpController({
      scheduleStore: () => store as any,
      computeNextRunAt: vi.fn().mockReturnValue("2026-04-16T18:30:00.000Z"),
      unregisterSchedule,
      triggerSchedule,

    });

    controller.check();
    await controller.waitForIdle();

    expect(triggerSchedule).not.toHaveBeenCalled();
    expect(store.updateNextRunAt).toHaveBeenCalledWith("cron-stale", "2026-04-16T18:30:00.000Z");
    expect(store.getSchedule("cron-stale")).toMatchObject({ enabled: true });
    expect(unregisterSchedule).not.toHaveBeenCalled();
  });
});
