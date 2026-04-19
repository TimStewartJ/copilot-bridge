import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRestartPending, RESTART_PENDING_MESSAGE, triggerRestartPending } from "../session-manager.js";
import * as scheduler from "../scheduler.js";
import { computeNextRunAt, matchesCron, matchesField } from "../scheduler.js";
import { createTestApp } from "./helpers.js";

// ── Cron math tests ──────────────────────────────────────────────

describe("matchesField", () => {
  it("matches wildcard", () => {
    expect(matchesField(5, "*")).toBe(true);
  });
  it("matches exact number", () => {
    expect(matchesField(8, "8")).toBe(true);
    expect(matchesField(9, "8")).toBe(false);
  });
  it("matches range", () => {
    expect(matchesField(3, "1-5")).toBe(true);
    expect(matchesField(6, "1-5")).toBe(false);
    expect(matchesField(1, "1-5")).toBe(true);
    expect(matchesField(5, "1-5")).toBe(true);
  });
  it("matches list", () => {
    expect(matchesField(15, "0,15,30,45")).toBe(true);
    expect(matchesField(10, "0,15,30,45")).toBe(false);
  });
  it("matches step */N", () => {
    expect(matchesField(0, "*/5")).toBe(true);
    expect(matchesField(5, "*/5")).toBe(true);
    expect(matchesField(3, "*/5")).toBe(false);
  });
  it("matches range with step N-M/S", () => {
    expect(matchesField(2, "2-10/2")).toBe(true);
    expect(matchesField(4, "2-10/2")).toBe(true);
    expect(matchesField(3, "2-10/2")).toBe(false);
    expect(matchesField(12, "2-10/2")).toBe(false);
  });
});

describe("matchesCron", () => {
  it("matches a specific time", () => {
    const date = new Date("2026-04-14T08:00:00Z");
    expect(matchesCron("0 8 * * *", date, "UTC")).toBe(true);
    expect(matchesCron("0 9 * * *", date, "UTC")).toBe(false);
  });
  it("matches weekday range", () => {
    // 2026-04-14 is a Tuesday (day 2)
    const tue = new Date("2026-04-14T08:00:00Z");
    expect(matchesCron("0 8 * * 1-5", tue, "UTC")).toBe(true);
    // 2026-04-12 is a Sunday (day 0)
    const sun = new Date("2026-04-12T08:00:00Z");
    expect(matchesCron("0 8 * * 1-5", sun, "UTC")).toBe(false);
  });
  it("rejects invalid cron (fewer than 5 fields)", () => {
    expect(matchesCron("0 8 * *", new Date())).toBe(false);
  });
  it("respects timezone", () => {
    // 2026-04-14T15:00:00Z = 8:00 AM in America/Los_Angeles (PDT = UTC-7)
    const date = new Date("2026-04-14T15:00:00Z");
    expect(matchesCron("0 8 * * *", date, "America/Los_Angeles")).toBe(true);
    expect(matchesCron("0 15 * * *", date, "America/Los_Angeles")).toBe(false);
    expect(matchesCron("0 15 * * *", date, "UTC")).toBe(true);
  });
});

describe("computeNextRunAt", () => {
  it("computes next run for daily cron", () => {
    const after = new Date("2026-04-14T07:30:00Z");
    const next = computeNextRunAt("0 8 * * *", "UTC", after);
    expect(next).toBe("2026-04-14T08:00:00.000Z");
  });
  it("wraps to next day when past today's time", () => {
    const after = new Date("2026-04-14T08:30:00Z");
    const next = computeNextRunAt("0 8 * * *", "UTC", after);
    expect(next).toBe("2026-04-15T08:00:00.000Z");
  });
  it("respects timezone for next run", () => {
    // After 7:30 AM LA time, next run of "0 8 * * *" should be 8 AM LA time
    const after = new Date("2026-04-14T14:30:00Z"); // 7:30 AM PDT
    const next = computeNextRunAt("0 8 * * *", "America/Los_Angeles", after);
    expect(next).toBe("2026-04-14T15:00:00.000Z"); // 8:00 AM PDT
  });
  it("returns undefined for invalid cron", () => {
    expect(computeNextRunAt("invalid", "UTC")).toBeUndefined();
  });
  it("skips to next matching day of week", () => {
    // 2026-04-16 is a Thursday, "0 8 * * 5" = only Fridays
    // next Friday is 2026-04-17 (only ~23 hours gap)
    const after = new Date("2026-04-16T09:00:00Z");
    const next = computeNextRunAt("0 8 * * 5", "UTC", after);
    expect(next).toBe("2026-04-17T08:00:00.000Z");
  });
});

describe("scheduler restart gating", () => {
  beforeEach(() => {
    clearRestartPending();
  });

  afterEach(() => {
    clearRestartPending();
    scheduler.shutdown();
  });

  it("skips triggering schedules while restart is pending", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "sched-session" }),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const task = ctx.taskStore.createTask("Scheduled Task");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Restart gated schedule",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });

    triggerRestartPending();
    const result = await scheduler.triggerSchedule(schedule.id);

    expect(result).toEqual({ skipped: RESTART_PENDING_MESSAGE });
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    expect(sessionManager.startWork).not.toHaveBeenCalled();
  });

  it("rolls back a newly created schedule session if restart pending flips before startWork", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "sched-session" }),
      startWork: vi.fn(() => {
        throw new Error(RESTART_PENDING_MESSAGE);
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const task = ctx.taskStore.createTask("Scheduled Task");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Rollback schedule session",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });

    const result = await scheduler.triggerSchedule(schedule.id);

    expect(result).toEqual({ skipped: RESTART_PENDING_MESSAGE });
    expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
    expect(sessionManager.deleteSession).toHaveBeenCalledWith("sched-session");
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).not.toContain("sched-session");
    expect(ctx.sessionMetaStore.getMeta("sched-session")).toBeUndefined();
  });

  it("reuses the configured target session for reuse-target schedules", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn(),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const task = ctx.taskStore.createTask("Scheduled Task");
    ctx.taskStore.linkSession(task.id, "target-session");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Targeted schedule",
      prompt: "continue work",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "target-session",
    });

    const result = await scheduler.triggerSchedule(schedule.id);

    expect(result).toEqual({ sessionId: "target-session" });
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    expect(sessionManager.startWork).toHaveBeenCalledWith("target-session", "continue work");
    expect(ctx.sessionMetaStore.getMeta("target-session")).toMatchObject({
      triggeredBy: "schedule",
      scheduleId: schedule.id,
      scheduleName: "Targeted schedule",
    });
  });

  it("skips reuse-target schedules when the target session is busy", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockImplementation((sessionId: string) => sessionId === "target-session"),
      createTaskSession: vi.fn(),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const task = ctx.taskStore.createTask("Scheduled Task");
    ctx.taskStore.linkSession(task.id, "target-session");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Busy target schedule",
      prompt: "continue work",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "target-session",
    });

    const result = await scheduler.triggerSchedule(schedule.id);

    expect(result).toEqual({ skipped: "Target session is busy" });
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    expect(sessionManager.startWork).not.toHaveBeenCalled();
  });
});
