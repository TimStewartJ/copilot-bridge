import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearRestartPending,
  configureRestartStateStore,
  isRestartPending,
  refreshRestartState,
  RESTART_PENDING_MESSAGE,
  triggerRestartPending,
} from "../session-manager.js";
import { writeRestartState } from "../restart-state.js";
import * as scheduler from "../scheduler.js";
import { computeNextRunAt, matchesCron, matchesField } from "../scheduler.js";
import { createTestApp } from "./helpers.js";

afterEach(() => {
  clearRestartPending();
  scheduler.shutdown();
  vi.useRealTimers();
});

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

  it("skips triggering schedules when restart is pending with waiting sessions", async () => {
    // This verifies the change from isRestartImminent (only when waitingSessions=0) to
    // isRestartPending (any non-idle phase), so schedules are blocked even during the
    // waiting-for-sessions phase.
    const tempDir = mkdtempSync(join(tmpdir(), "restart-state-scheduler-"));
    const { ctx } = createTestApp();
    try {
      configureRestartStateStore({ demoMode: false, dataDir: tempDir, docsDir: tempDir, env: process.env });
      await writeRestartState(join(tempDir, "restart-state.json"), {
        requestId: "req-waiting",
        phase: "waiting-for-sessions",
        requestedAt: new Date().toISOString(),
        waitingSessions: 2,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();
      if (!isRestartPending()) {
        throw new Error(`BUG in test setup: isRestartPending() still false after refreshRestartState()`);
      }

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
        name: "Waiting-sessions gated schedule",
        prompt: "run now",
        type: "cron",
        cron: "0 0 * * *",
      });

      const result = await scheduler.triggerSchedule(schedule.id);

      expect(result).toEqual({ skipped: RESTART_PENDING_MESSAGE });
      expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    } finally {
      clearRestartPending();
      configureRestartStateStore(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  it("allows manual triggers even when the last run was recent", async () => {
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
      name: "Manual rerun",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });
    ctx.scheduleStore.recordRun(schedule.id, "previous-session");

    const result = await scheduler.triggerSchedule(schedule.id, { source: "manual" });

    expect(result).toEqual({ sessionId: "sched-session" });
    expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
    expect(sessionManager.startWork).toHaveBeenCalledWith("sched-session", "run now");
  });

  it("holds the durable schedule lock for reused sessions until the session goes idle", async () => {
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
      name: "Retained reuse-target lock",
      prompt: "continue work",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "target-session",
    });
    const slot = new Date("2026-04-14T15:00:00.000Z").toISOString();

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "manual" }),
    ).resolves.toEqual({ sessionId: "target-session" });

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot }),
    ).resolves.toEqual({ skipped: "Previous run still active" });

    ctx.globalBus.emit({ type: "session:archived", sessionId: "target-session", archived: true });

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "manual" }),
    ).resolves.toEqual({ skipped: "Previous run still active" });

    ctx.globalBus.emit({ type: "session:idle", sessionId: "target-session" });

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "manual" }),
    ).resolves.toEqual({ sessionId: "target-session" });
    expect(sessionManager.startWork).toHaveBeenCalledTimes(2);
  });

  it("blocks different schedules from reusing the same session until it goes idle", async () => {
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
    const firstSchedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "First reused schedule",
      prompt: "continue first",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "target-session",
    });
    const secondSchedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Second reused schedule",
      prompt: "continue second",
      type: "cron",
      cron: "5 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "target-session",
    });

    await expect(
      scheduler.triggerSchedule(firstSchedule.id, { source: "manual" }),
    ).resolves.toEqual({ sessionId: "target-session" });

    await expect(
      scheduler.triggerSchedule(secondSchedule.id, { source: "manual" }),
    ).resolves.toEqual({ skipped: "Target session is busy" });

    ctx.globalBus.emit({ type: "session:idle", sessionId: "target-session" });

    await expect(
      scheduler.triggerSchedule(secondSchedule.id, { source: "manual" }),
    ).resolves.toEqual({ sessionId: "target-session" });
    expect(sessionManager.startWork).toHaveBeenNthCalledWith(1, "target-session", "continue first");
    expect(sessionManager.startWork).toHaveBeenNthCalledWith(2, "target-session", "continue second");
  });

  it("keeps retained schedule locks renewed for reused sessions after the target changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T15:00:00.000Z"));

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
    ctx.taskStore.linkSession(task.id, "target-a");
    ctx.taskStore.linkSession(task.id, "target-b");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Retained schedule lock renewal",
      prompt: "continue work",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "target-a",
    });

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "manual" }),
    ).resolves.toEqual({ sessionId: "target-a" });

    ctx.scheduleStore.updateSchedule(schedule.id, { targetSessionId: "target-b" });
    await vi.advanceTimersByTimeAsync(125_000);

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "manual" }),
    ).resolves.toEqual({ skipped: "Previous run still active" });

    ctx.globalBus.emit({ type: "session:idle", sessionId: "target-a" });

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "manual" }),
    ).resolves.toEqual({ sessionId: "target-b" });
    expect(sessionManager.startWork).toHaveBeenNthCalledWith(1, "target-a", "continue work");
    expect(sessionManager.startWork).toHaveBeenNthCalledWith(2, "target-b", "continue work");
  });

  it("allows an older automatic slot retry even after a newer slot completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T15:01:00.000Z"));

    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn()
        .mockResolvedValueOnce({ sessionId: "slot-b-session" })
        .mockResolvedValueOnce({ sessionId: "slot-a-session" }),
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
      name: "Out-of-order automatic retry",
      prompt: "run now",
      type: "cron",
      cron: "* * * * *",
    });
    const newerSlot = "2026-04-14T15:01:00.000Z";
    const olderSlot = "2026-04-14T15:00:00.000Z";

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: newerSlot }),
    ).resolves.toEqual({ sessionId: "slot-b-session" });

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: olderSlot }),
    ).resolves.toEqual({ sessionId: "slot-a-session" });

    expect(sessionManager.startWork).toHaveBeenNthCalledWith(1, "slot-b-session", "run now");
    expect(sessionManager.startWork).toHaveBeenNthCalledWith(2, "slot-a-session", "run now");
  });

  it("skips disabled automatic schedules while still allowing manual trigger", async () => {
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
      name: "Disabled auto schedule",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });
    ctx.scheduleStore.updateSchedule(schedule.id, { enabled: false });
    const slotDate = new Date();
    slotDate.setSeconds(0, 0);
    const slot = slotDate.toISOString();

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot }),
    ).resolves.toEqual({ skipped: "Schedule is disabled" });
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "manual" }),
    ).resolves.toEqual({ sessionId: "sched-session" });
    expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
    expect(sessionManager.startWork).toHaveBeenCalledWith("sched-session", "run now");
  });

  it("skips automatic runs that are already claimed for the same slot", async () => {
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
      name: "Claimed schedule",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });
    const slotDate = new Date();
    slotDate.setSeconds(0, 0);
    const slot = slotDate.toISOString();
    ctx.scheduleStore.claimAutomaticRun(schedule.id, slot, "cron", new Date(slotDate.getTime() - 30_000).toISOString());

    const result = await scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot });

    expect(result).toEqual({ skipped: "This scheduled slot is already being processed" });
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    expect(sessionManager.startWork).not.toHaveBeenCalled();
  });

  it("allows a one-shot automatic run to retry after a transient busy-target skip", async () => {
    const { ctx } = createTestApp();
    let busy = true;
    const sessionManager = {
      isSessionBusy: vi.fn(() => busy),
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
    const runAt = new Date().toISOString();
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Retryable one-shot",
      prompt: "continue work",
      type: "once",
      runAt,
      sessionMode: "reuse-target",
      targetSessionId: "target-session",
    });

    expect(
      await scheduler.triggerSchedule(schedule.id, { source: "once", scheduledFor: runAt }),
    ).toEqual({ skipped: "Target session is busy" });

    busy = false;

    expect(
      await scheduler.triggerSchedule(schedule.id, { source: "once", scheduledFor: runAt }),
    ).toEqual({ sessionId: "target-session" });
    expect(sessionManager.startWork).toHaveBeenCalledWith("target-session", "continue work");
  });

  it("re-arms a one-shot timer after a transient max-concurrent skip and emits schedule changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx } = createTestApp();
    const events: Array<{ type: string; scheduleId?: string }> = [];
    const unsubscribe = ctx.globalBus.subscribe((event) => {
      if (event.type === "schedule:changed") {
        events.push({ type: event.type, scheduleId: event.scheduleId });
      }
    });

    let createCall = 0;
    const blockers: Array<(value: { sessionId: string }) => void> = [];
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockImplementation(() => {
        const callIndex = createCall++;
        if (callIndex < 3) {
          return new Promise<{ sessionId: string }>((resolve) => {
            blockers.push(resolve);
          });
        }
        return Promise.resolve({ sessionId: `sched-session-${callIndex}` });
      }),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    const slotDate = new Date();
    slotDate.setSeconds(0, 0);
    const slot = slotDate.toISOString();
    const cronSchedules = Array.from({ length: 3 }, (_, index) => ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: `Blocking schedule ${index + 1}`,
      prompt: `block ${index + 1}`,
      type: "cron",
      cron: "0 0 * * *",
    }));
    const oneShot = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Retry after max concurrent",
      prompt: "run once",
      type: "once",
      runAt: new Date(Date.now() + 1_000).toISOString(),
    });

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const blockingRuns = cronSchedules.map((schedule) =>
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot }));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.scheduleStore.getSchedule(oneShot.id)?.nextRunAt).toBe("2026-04-16T16:00:31.000Z");
    expect(events).toContainEqual({ type: "schedule:changed", scheduleId: oneShot.id });

    blockers.forEach((resolve, index) => resolve({ sessionId: `cron-session-${index}` }));
    await Promise.all(blockingRuns);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(sessionManager.startWork).toHaveBeenCalledWith("sched-session-3", "run once");
    unsubscribe();
  });

  it("does not re-arm a one-shot retry for permanent target configuration skips", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx } = createTestApp();
    const events: Array<{ type: string; scheduleId?: string }> = [];
    const unsubscribe = ctx.globalBus.subscribe((event) => {
      if (event.type === "schedule:changed") {
        events.push({ type: event.type, scheduleId: event.scheduleId });
      }
    });
    const claimSpy = vi.spyOn(ctx.scheduleStore, "claimAutomaticRun");
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn(),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    const runAt = new Date(Date.now() + 1_000).toISOString();
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Permanent one-shot skip",
      prompt: "continue work",
      type: "once",
      runAt,
      sessionMode: "reuse-target",
      targetSessionId: "missing-session",
    });

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
      enabled: false,
      runCount: 0,
      nextRunAt: undefined,
    });
    expect(events).toContainEqual({ type: "schedule:changed", scheduleId: schedule.id });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();

    scheduler.shutdown();
    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });
    await Promise.resolve();

    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("releases an automatic claim if creating the session fails before launch", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockRejectedValueOnce(new Error("create failed"))
        .mockResolvedValueOnce({ sessionId: "recovered-session" }),
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
    const runAt = new Date().toISOString();
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "One-shot create failure",
      prompt: "run once",
      type: "once",
      runAt,
    });

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "once", scheduledFor: runAt }),
    ).rejects.toThrow("create failed");

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "once", scheduledFor: runAt }),
    ).resolves.toEqual({ sessionId: "recovered-session" });
  });

  it("retries a cron slot in-process after a transient launch failure releases its claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T15:00:00.000Z"));

    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn()
        .mockRejectedValueOnce(new Error("create failed"))
        .mockResolvedValueOnce({ sessionId: "retried-cron-session" }),
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
      name: "Cron create failure retry",
      prompt: "run now",
      type: "cron",
      cron: "0 15 * * *",
      timezone: "UTC",
    });
    const slot = "2026-04-14T15:00:00.000Z";

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot }),
    ).rejects.toThrow("create failed");

    expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(2);
    expect(sessionManager.startWork).toHaveBeenCalledWith("retried-cron-session", "run now");
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.runCount).toBe(1);
  });

  it("deletes a newly created session and releases the slot if task linking fails before launch", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn()
        .mockResolvedValueOnce({ sessionId: "sched-session-1" })
        .mockResolvedValueOnce({ sessionId: "sched-session-2" }),
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
      name: "Link failure cleanup",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });
    const slotDate = new Date();
    slotDate.setSeconds(0, 0);
    const slot = slotDate.toISOString();

    const linkSpy = vi.spyOn(ctx.taskStore, "linkSession").mockImplementationOnce(() => {
      throw new Error("link failed");
    });

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot }),
    ).rejects.toThrow("link failed");
    expect(sessionManager.deleteSession).toHaveBeenCalledWith("sched-session-1");
    expect(sessionManager.startWork).not.toHaveBeenCalled();

    linkSpy.mockRestore();

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot }),
    ).resolves.toEqual({ sessionId: "sched-session-2" });
    expect(sessionManager.startWork).toHaveBeenCalledWith("sched-session-2", "run now");
  });

  it("rolls back a newly created schedule session when startWork throws synchronously", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "sched-session" }),
      startWork: vi.fn(() => {
        throw new Error("launch failed");
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

    await expect(scheduler.triggerSchedule(schedule.id)).rejects.toThrow("launch failed");
    expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
    expect(sessionManager.deleteSession).toHaveBeenCalledWith("sched-session");
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).not.toContain("sched-session");
  });

  it("surfaces cleanup failures when synchronous launch rejection cannot remove the new session", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "sched-session" }),
      startWork: vi.fn(() => {
        throw new Error("launch failed");
      }),
      deleteSession: vi.fn().mockRejectedValue(new Error("delete failed")),
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
      name: "Rollback cleanup failure",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });

    await expect(scheduler.triggerSchedule(schedule.id)).rejects.toThrow(/Failed to roll back session .*after launch rejection/);
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain("sched-session");
  });

  it("links a newly created scheduled session before startWork runs", async () => {
    const { ctx } = createTestApp();
    const linkStateAtLaunch: boolean[] = [];
    const task = ctx.taskStore.createTask("Scheduled Task");
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "sched-session" }),
      startWork: vi.fn((sessionId: string) => {
        linkStateAtLaunch.push(ctx.taskStore.getTask(task.id)?.sessionIds.includes(sessionId) ?? false);
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Launch ordering",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });

    const result = await scheduler.triggerSchedule(schedule.id);

    expect(result).toEqual({ sessionId: "sched-session" });
    expect(linkStateAtLaunch).toEqual([true]);
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain("sched-session");
  });

  it("aborts and deletes a newly created session if an automatic claim is lost after launch", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Scheduled Task");
    let sessionBusy = false;
    const sessionManager = {
      isSessionBusy: vi.fn(() => sessionBusy),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "sched-session" }),
      startWork: vi.fn(() => {
        sessionBusy = true;
        const slotTime = new Date(Date.now() + 3 * 60_000).toISOString();
        ctx.scheduleStore.claimAutomaticRun(schedule.id, slot, "cron", slotTime);
      }),
      abortSession: vi.fn(async () => {
        sessionBusy = false;
        return true;
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Lost claim cleanup",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });
    const slotDate = new Date();
    slotDate.setSeconds(0, 0);
    const slot = slotDate.toISOString();

    const result = await scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot });

    expect(result).toEqual({ skipped: "This scheduled slot is already being processed" });
    expect(sessionManager.startWork).toHaveBeenCalledWith("sched-session", "run now");
    expect(sessionManager.abortSession).toHaveBeenCalledWith("sched-session");
    expect(sessionManager.deleteSession).toHaveBeenCalledWith("sched-session");
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).not.toContain("sched-session");
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.runCount).toBe(0);
    expect(ctx.sessionMetaStore.getMeta("sched-session")).toBeUndefined();
  });

  it("surfaces a cleanup failure if a lost-claim rollback cannot stop the launched run", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Scheduled Task");
    let sessionBusy = false;
    const sessionManager = {
      isSessionBusy: vi.fn(() => sessionBusy),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "sched-session" }),
      startWork: vi.fn(() => {
        sessionBusy = true;
        const slotTime = new Date(Date.now() + 3 * 60_000).toISOString();
        ctx.scheduleStore.claimAutomaticRun(schedule.id, slot, "cron", slotTime);
      }),
      abortSession: vi.fn(async () => {
        throw new Error("abort failed");
      }),
      deleteSession: vi.fn().mockRejectedValue(new Error("Cannot delete a busy session")),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Lost claim failure",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
    });
    const slotDate = new Date();
    slotDate.setSeconds(0, 0);
    const slot = slotDate.toISOString();

    await expect(scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot })).rejects.toThrow(
      /Failed to roll back session .*lost claim/,
    );
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain("sched-session");
  });

  it("surfaces lost-claim errors on reused sessions without aborting the shared session", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Scheduled Task");
    let busy = false;
    const sessionManager = {
      isSessionBusy: vi.fn(() => busy),
      createTaskSession: vi.fn(),
      startWork: vi.fn(() => {
        busy = true;
        const slotTime = new Date(Date.now() + 3 * 60_000).toISOString();
        ctx.scheduleStore.claimAutomaticRun(schedule.id, slot, "cron", slotTime);
      }),
      abortSession: vi.fn(async () => true),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    ctx.taskStore.linkSession(task.id, "target-session");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Reuse-target lost claim",
      prompt: "continue work",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "target-session",
    });
    const slotDate = new Date();
    slotDate.setSeconds(0, 0);
    const slot = slotDate.toISOString();

    await expect(
      scheduler.triggerSchedule(schedule.id, { source: "cron", scheduledFor: slot }),
    ).rejects.toThrow(/cannot safely roll back shared session state/);
    expect(sessionManager.abortSession).not.toHaveBeenCalled();
    expect(sessionManager.deleteSession).not.toHaveBeenCalled();
  });
});

describe("scheduler startup recovery", () => {
  it("re-arms enabled one-shot schedules on initialize", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "one-shot-session" }),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Future one-shot",
      prompt: "run later",
      type: "once",
      runAt: new Date(Date.now() + 60_000).toISOString(),
    });

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.startWork).toHaveBeenCalledWith("one-shot-session", "run later");
  });

  it("retries a one-shot timer in-process after a transient pre-launch failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn()
        .mockRejectedValueOnce(new Error("create failed"))
        .mockResolvedValueOnce({ sessionId: "retried-one-shot-session" }),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Retry failing one-shot",
      prompt: "run after retry",
      type: "once",
      runAt: new Date(Date.now() + 1_000).toISOString(),
    });

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.startWork).not.toHaveBeenCalled();
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.nextRunAt).toBe("2026-04-16T16:00:31.000Z");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(2);
    expect(sessionManager.startWork).toHaveBeenCalledWith("retried-one-shot-session", "run after retry");
  });

  it("retries a one-shot timer after linkSession fails but cleanup succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn()
        .mockResolvedValueOnce({ sessionId: "link-fail-session-1" })
        .mockResolvedValueOnce({ sessionId: "link-fail-session-2" }),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Retry one-shot link failure",
      prompt: "run after link retry",
      type: "once",
      runAt: new Date(Date.now() + 1_000).toISOString(),
    });

    const linkSpy = vi.spyOn(ctx.taskStore, "linkSession").mockImplementationOnce(() => {
      throw new Error("link failed");
    });

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.deleteSession).toHaveBeenCalledWith("link-fail-session-1");
    expect(sessionManager.startWork).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(2);
    expect(sessionManager.startWork).toHaveBeenCalledWith("link-fail-session-2", "run after link retry");
    linkSpy.mockRestore();
  });

  it("catches up missed one-shot schedules within the grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "catch-up-session" }),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Missed one-shot",
      prompt: "catch up",
      type: "once",
      runAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    await vi.waitFor(() => {
      expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
    });

    const updated = ctx.scheduleStore.getSchedule(schedule.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.enabled).toBe(false);
  });

  it("disables stale one-shot schedules instead of replaying them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn(),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Stale one-shot",
      prompt: "should stay stale",
      type: "once",
      runAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    await Promise.resolve();

    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.enabled).toBe(false);
  });

  it("processes missed startup catch-up sequentially so all schedules run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx } = createTestApp();
    let nextId = 0;
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockImplementation(async () => ({ sessionId: `catch-up-${nextId++}` })),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    for (let index = 0; index < 4; index += 1) {
      ctx.scheduleStore.createSchedule({
        taskId: task.id,
        name: `Missed schedule ${index + 1}`,
        prompt: `catch up ${index + 1}`,
        type: "once",
        runAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
      });
    }

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    await vi.waitFor(() => {
      expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(4);
    });
    expect(sessionManager.startWork).toHaveBeenCalledTimes(4);
  });
});
