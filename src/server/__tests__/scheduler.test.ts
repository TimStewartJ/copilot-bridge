import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRestartPending, RESTART_PENDING_MESSAGE, triggerRestartPending } from "../session-manager.js";
import * as scheduler from "../scheduler.js";
import { createTestApp } from "./helpers.js";

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
});
