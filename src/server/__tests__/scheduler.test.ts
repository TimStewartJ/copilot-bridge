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
import { clearRestartState, writeRestartState } from "../restart-state.js";
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

  it("triggers schedules while restart is pending", async () => {
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

    expect(result).toEqual({ sessionId: "sched-session" });
    expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
    expect(sessionManager.startWork).toHaveBeenCalledWith("sched-session", "run now");
  });

  it("triggers schedules when restart is pending with waiting sessions", async () => {
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

      expect(result).toEqual({ sessionId: "sched-session" });
      expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
      expect(sessionManager.startWork).toHaveBeenCalledWith("sched-session", "run now");
    } finally {
      clearRestartPending();
      configureRestartStateStore(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips triggering schedules while launcher restart cutover is in progress", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "restart-state-scheduler-"));
    const { ctx } = createTestApp();
    try {
      configureRestartStateStore({ demoMode: false, dataDir: tempDir, docsDir: tempDir, env: process.env });
      await writeRestartState(join(tempDir, "restart-state.json"), {
        requestId: "req-restarting",
        phase: "restarting",
        requestedAt: new Date().toISOString(),
        waitingSessions: 0,
        launcherHeartbeatAt: new Date().toISOString(),
      });
      await refreshRestartState();

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
        name: "Restart cutover schedule",
        prompt: "run now",
        type: "cron",
        cron: "0 0 * * *",
      });

      const result = await scheduler.triggerSchedule(schedule.id);

      expect(result).toEqual({ skipped: RESTART_PENDING_MESSAGE });
      expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
      expect(sessionManager.startWork).not.toHaveBeenCalled();
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

  it("creates a fresh session even for schedules with legacy reuse metadata", async () => {
    const { ctx, db } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockImplementation((sessionId: string) => sessionId === "last-session"),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "new-session" }),
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
    ctx.taskStore.linkSession(task.id, "last-session");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Legacy reused schedule",
      prompt: "continue work",
      type: "cron",
      cron: "0 0 * * *",
    });
    db.prepare(`
      UPDATE schedules
      SET sessionMode = 'reuse-last',
          lastSessionId = 'last-session',
          reuseLastRequiresExistingSession = 1
      WHERE id = ?
    `).run(schedule.id);

    const result = await scheduler.triggerSchedule(schedule.id);

    expect(result).toEqual({ sessionId: "new-session" });
    expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
    expect(sessionManager.isSessionBusy).not.toHaveBeenCalledWith("last-session");
    expect(sessionManager.startWork).toHaveBeenCalledWith("new-session", "continue work");
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain("new-session");
    expect(ctx.sessionMetaStore.getMeta("new-session")).toMatchObject({
      triggeredBy: "schedule",
      scheduleId: schedule.id,
      scheduleName: "Legacy reused schedule",
    });
  });

  it("archives older schedule sessions after a retained run", async () => {
    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      listSessionsFromDisk: vi.fn().mockResolvedValue([
        { sessionId: "old-session", summary: "Old run" },
        { sessionId: "new-session", summary: "New run" },
      ]),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "new-session" }),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
      deferredPromptStore: ctx.deferredPromptStore,
      deferLoopStore: ctx.deferLoopStore,
    });

    const task = ctx.taskStore.createTask("Scheduled Task");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Retained schedule",
      prompt: "run now",
      type: "cron",
      cron: "0 0 * * *",
      autoArchiveKeep: 1,
    });
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "old-session", "2026-01-01T00:00:00.000Z");

    const result = await scheduler.triggerSchedule(schedule.id);

    expect(result).toEqual({ sessionId: "new-session" });
    expect(ctx.sessionMetaStore.isArchived("new-session")).toBe(false);
    expect(ctx.sessionMetaStore.isArchived("old-session")).toBe(true);
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

  it("creates a fresh session for one-shot schedules with legacy reuse metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const { ctx, db } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(true),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "fresh-one-shot-session" }),
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
      name: "Legacy one-shot",
      prompt: "continue work",
      type: "once",
      runAt,
    });
    db.prepare("UPDATE schedules SET sessionMode = ?, lastSessionId = ? WHERE id = ?")
      .run("reuse-last", "target-session", schedule.id);

    expect(
      await scheduler.triggerSchedule(schedule.id, { source: "once", scheduledFor: runAt }),
    ).toEqual({ sessionId: "fresh-one-shot-session" });
    expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
    expect(sessionManager.startWork).toHaveBeenCalledWith("fresh-one-shot-session", "continue work");
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
  }, 20_000);

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

    await vi.waitFor(() => {
      expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(2);
    });
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

  it("retries missed one-shot catch-up after restart clears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const tempDir = mkdtempSync(join(tmpdir(), "restart-state-scheduler-"));
    const docsDir = join(tempDir, "docs");
    const docsSnapshotsDir = join(tempDir, "docs-snapshots");
    const { ctx } = createTestApp({
      runtimePaths: { demoMode: false, dataDir: tempDir, docsDir, docsSnapshotsDir, env: process.env },
    });
    try {
      configureRestartStateStore({ demoMode: false, dataDir: tempDir, docsDir, docsSnapshotsDir, env: process.env });
      await writeRestartState(join(tempDir, "restart-state.json"), {
        requestId: "req-one-shot-catchup",
        phase: "waiting-for-sessions",
        requestedAt: new Date().toISOString(),
        waitingSessions: 1,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();

      const sessionManager = {
        isSessionBusy: vi.fn().mockReturnValue(false),
        createTaskSession: vi.fn().mockResolvedValue({ sessionId: "restart-cleared-one-shot" }),
        startWork: vi.fn(),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as any;

      const task = ctx.taskStore.createTask("Scheduled Task");
      const schedule = ctx.scheduleStore.createSchedule({
        taskId: task.id,
        name: "Restart deferred one-shot",
        prompt: "catch up later",
        type: "once",
        runAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      });

      scheduler.initialize(sessionManager, {
        scheduleStore: ctx.scheduleStore,
        taskStore: ctx.taskStore,
        sessionMetaStore: ctx.sessionMetaStore,
        globalBus: ctx.globalBus,
      });

      await Promise.resolve();
      expect(sessionManager.createTaskSession).not.toHaveBeenCalled();

      clearRestartPending();
      ctx.globalBus.emit({ type: "server:restart-cleared" });

      await vi.waitFor(() => {
        expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
      });
      expect(sessionManager.startWork).toHaveBeenCalledWith("restart-cleared-one-shot", "catch up later");
      expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
        runCount: 1,
        enabled: false,
      });
    } finally {
      clearRestartPending();
      configureRestartStateStore(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("polls persisted restart state and catches up after launcher-style restart clears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const tempDir = mkdtempSync(join(tmpdir(), "restart-state-scheduler-"));
    const docsDir = join(tempDir, "docs");
    const docsSnapshotsDir = join(tempDir, "docs-snapshots");
    const restartStatePath = join(tempDir, "restart-state.json");
    const { ctx } = createTestApp({
      runtimePaths: { demoMode: false, dataDir: tempDir, docsDir, docsSnapshotsDir, env: process.env },
    });
    try {
      configureRestartStateStore({ demoMode: false, dataDir: tempDir, docsDir, docsSnapshotsDir, env: process.env });
      await writeRestartState(restartStatePath, {
        requestId: "req-launcher-restart-catchup",
        phase: "restarting",
        requestedAt: new Date().toISOString(),
        waitingSessions: 0,
        launcherHeartbeatAt: new Date().toISOString(),
      });
      await refreshRestartState();

      const sessionManager = {
        isSessionBusy: vi.fn().mockReturnValue(false),
        createTaskSession: vi.fn().mockResolvedValue({ sessionId: "launcher-cleared-one-shot" }),
        startWork: vi.fn(),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as any;

      const task = ctx.taskStore.createTask("Scheduled Task");
      const schedule = ctx.scheduleStore.createSchedule({
        taskId: task.id,
        name: "Launcher restart deferred one-shot",
        prompt: "catch up after launcher clears",
        type: "once",
        runAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      });

      scheduler.initialize(sessionManager, {
        scheduleStore: ctx.scheduleStore,
        taskStore: ctx.taskStore,
        sessionMetaStore: ctx.sessionMetaStore,
        globalBus: ctx.globalBus,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(sessionManager.createTaskSession).not.toHaveBeenCalled();

      await clearRestartState(restartStatePath);
      await vi.advanceTimersByTimeAsync(15_000);

      await vi.waitFor(() => {
        expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
      });
      expect(sessionManager.startWork).toHaveBeenCalledWith(
        "launcher-cleared-one-shot",
        "catch up after launcher clears",
      );
      expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
        runCount: 1,
        enabled: false,
      });
    } finally {
      clearRestartPending();
      configureRestartStateStore(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rebuilds aged deferred one-shot eligibility after a launcher-style restart boots mid-restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const tempDir = mkdtempSync(join(tmpdir(), "restart-state-scheduler-"));
    const docsDir = join(tempDir, "docs");
    const docsSnapshotsDir = join(tempDir, "docs-snapshots");
    const restartStatePath = join(tempDir, "restart-state.json");
    const { ctx } = createTestApp({
      runtimePaths: { demoMode: false, dataDir: tempDir, docsDir, docsSnapshotsDir, env: process.env },
    });
    try {
      configureRestartStateStore({ demoMode: false, dataDir: tempDir, docsDir, docsSnapshotsDir, env: process.env });
      const restartRequestedAt = new Date().toISOString();
      await writeRestartState(restartStatePath, {
        requestId: "req-launcher-restart-aged-catchup",
        phase: "restarting",
        requestedAt: restartRequestedAt,
        waitingSessions: 0,
        launcherHeartbeatAt: restartRequestedAt,
      });
      await refreshRestartState();

      const sessionManager = {
        isSessionBusy: vi.fn().mockReturnValue(false),
        createTaskSession: vi.fn().mockResolvedValue({ sessionId: "launcher-aged-one-shot" }),
        startWork: vi.fn(),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as any;

      const task = ctx.taskStore.createTask("Scheduled Task");
      const schedule = ctx.scheduleStore.createSchedule({
        taskId: task.id,
        name: "Launcher aged deferred one-shot",
        prompt: "catch up after long restart",
        type: "once",
        runAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      });

      await vi.advanceTimersByTimeAsync(90 * 60_000);

      scheduler.initialize(sessionManager, {
        scheduleStore: ctx.scheduleStore,
        taskStore: ctx.taskStore,
        sessionMetaStore: ctx.sessionMetaStore,
        globalBus: ctx.globalBus,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
      expect(ctx.scheduleStore.getSchedule(schedule.id)?.enabled).toBe(true);

      await clearRestartState(restartStatePath);
      await vi.advanceTimersByTimeAsync(15_000);

      await vi.waitFor(() => {
        expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
      });
      expect(sessionManager.startWork).toHaveBeenCalledWith(
        "launcher-aged-one-shot",
        "catch up after long restart",
      );
      expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
        runCount: 1,
        enabled: false,
      });
    } finally {
      clearRestartPending();
      configureRestartStateStore(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not replay a deferred one-shot slot after the schedule is rescheduled before restart clears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    triggerRestartPending();

    const { ctx } = createTestApp();
    const sessionManager = {
      isSessionBusy: vi.fn().mockReturnValue(false),
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "rescheduled-one-shot" }),
      startWork: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const task = ctx.taskStore.createTask("Scheduled Task");
    const originalRunAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Deferred rescheduled one-shot",
      prompt: "run after reschedule",
      type: "once",
      runAt: originalRunAt,
    });

    scheduler.initialize(sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    await Promise.resolve();
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();

    const rescheduledRunAt = new Date(Date.now() + 30 * 60_000).toISOString();
    ctx.scheduleStore.updateSchedule(schedule.id, { runAt: rescheduledRunAt });
    scheduler.armOneShot(schedule.id, rescheduledRunAt);
    ctx.scheduleStore.updateNextRunAt(schedule.id, rescheduledRunAt);

    clearRestartPending();
    ctx.globalBus.emit({ type: "server:restart-cleared" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
      enabled: true,
      runCount: 0,
      runAt: rescheduledRunAt,
      nextRunAt: rescheduledRunAt,
    });

    await vi.advanceTimersByTimeAsync(25 * 60_000);
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => {
      expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
    });
    expect(sessionManager.startWork).toHaveBeenCalledWith("rescheduled-one-shot", "run after reschedule");
    expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
      enabled: false,
      runCount: 1,
    });
  });

  it("retries missed cron catch-up after restart clears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T16:00:00Z"));

    const tempDir = mkdtempSync(join(tmpdir(), "restart-state-scheduler-"));
    const docsDir = join(tempDir, "docs");
    const docsSnapshotsDir = join(tempDir, "docs-snapshots");
    const { ctx, db } = createTestApp({
      runtimePaths: { demoMode: false, dataDir: tempDir, docsDir, docsSnapshotsDir, env: process.env },
    });
    try {
      configureRestartStateStore({ demoMode: false, dataDir: tempDir, docsDir, docsSnapshotsDir, env: process.env });
      await writeRestartState(join(tempDir, "restart-state.json"), {
        requestId: "req-cron-catchup",
        phase: "waiting-for-sessions",
        requestedAt: new Date().toISOString(),
        waitingSessions: 1,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();

      const sessionManager = {
        isSessionBusy: vi.fn().mockReturnValue(false),
        createTaskSession: vi.fn().mockResolvedValue({ sessionId: "restart-cleared-cron" }),
        startWork: vi.fn(),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as any;

      const task = ctx.taskStore.createTask("Scheduled Task");
      const schedule = ctx.scheduleStore.createSchedule({
        taskId: task.id,
        name: "Restart deferred cron",
        prompt: "catch up cron",
        type: "cron",
        cron: "30 * * * *",
      });
      db.prepare("UPDATE schedules SET lastRunAt = ?, runCount = ? WHERE id = ?").run(
        "2026-04-16T15:00:00.000Z",
        1,
        schedule.id,
      );

      scheduler.initialize(sessionManager, {
        scheduleStore: ctx.scheduleStore,
        taskStore: ctx.taskStore,
        sessionMetaStore: ctx.sessionMetaStore,
        globalBus: ctx.globalBus,
      });

      await Promise.resolve();
      expect(sessionManager.createTaskSession).not.toHaveBeenCalled();

      clearRestartPending();
      ctx.globalBus.emit({ type: "server:restart-cleared" });

      await vi.waitFor(() => {
        expect(sessionManager.createTaskSession).toHaveBeenCalledTimes(1);
      });
      expect(sessionManager.startWork).toHaveBeenCalledWith("restart-cleared-cron", "catch up cron");
      expect(ctx.scheduleStore.getSchedule(schedule.id)?.runCount).toBe(2);
    } finally {
      clearRestartPending();
      configureRestartStateStore(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
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

    await vi.waitFor(() => {
      expect(ctx.scheduleStore.getSchedule(schedule.id)?.enabled).toBe(false);
    });
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
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
