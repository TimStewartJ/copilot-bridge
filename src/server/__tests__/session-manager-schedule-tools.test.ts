import { afterEach, describe, expect, it } from "vitest";
import { createBridgeTools } from "../session-manager.js";
import * as scheduler from "../scheduler.js";
import { toolFailure } from "../tool-results.js";
import { createMockSessionManager, createTestApp } from "./helpers.js";

describe("schedule tools", () => {
  afterEach(() => {
    scheduler.shutdown();
  });

  it("rejects legacy targetSessionId for schedule_create", async () => {
    const sessionManager = createMockSessionManager();
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    scheduler.initialize(sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "schedule_create");
    if (!tool) throw new Error("schedule_create tool not found");

    const result = await tool.handler(
      {
        taskId: task.id,
        name: "Invalid target",
        prompt: "continue working",
        type: "cron",
        cron: "0 0 * * *",
        targetSessionId: "session-1",
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-target-create",
        toolName: "schedule_create",
        arguments: {},
      },
    );

    expect(result).toEqual(toolFailure("targetSessionId is no longer supported for schedules; use defer_session for same-session follow-ups"));
    expect(ctx.scheduleStore.listSchedules(task.id)).toHaveLength(0);
  });

  it("rejects invalid sessionMode for schedule_create", async () => {
    const sessionManager = createMockSessionManager();
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    scheduler.initialize(sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "schedule_create");
    if (!tool) throw new Error("schedule_create tool not found");

    const result = await tool.handler(
      {
        taskId: task.id,
        name: "Invalid mode",
        prompt: "continue working",
        type: "cron",
        cron: "0 0 * * *",
        sessionMode: "reuse-target",
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "schedule_create",
        arguments: {},
      },
    );

    expect(result).toEqual(toolFailure("Invalid sessionMode: reuse-target"));
  });

  it("rejects legacy targetSessionId for schedule_update", async () => {
    const sessionManager = createMockSessionManager();
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Retarget me",
      prompt: "continue working",
      type: "cron",
      cron: "0 0 * * *",
    });
    scheduler.initialize(sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "schedule_update");
    if (!tool) throw new Error("schedule_update tool not found");

    const result = await tool.handler(
      { scheduleId: schedule.id, targetSessionId: "session-1" },
      {
        sessionId: "session-1",
        toolCallId: "tool-target-update",
        toolName: "schedule_update",
        arguments: {},
      },
    );

    expect(result).toEqual(toolFailure("targetSessionId is no longer supported for schedules; use defer_session for same-session follow-ups"));
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.name).toBe("Retarget me");
  });

  it("rejects invalid sessionMode for schedule_update", async () => {
    const sessionManager = createMockSessionManager();
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Retarget me",
      prompt: "continue working",
      type: "cron",
      cron: "0 0 * * *",
    });
    scheduler.initialize(sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "schedule_update");
    if (!tool) throw new Error("schedule_update tool not found");

    const result = await tool.handler(
      { scheduleId: schedule.id, sessionMode: "reuse-target" },
      {
        sessionId: "session-1",
        toolCallId: "tool-2",
        toolName: "schedule_update",
        arguments: {},
      },
    );

    expect(result).toEqual(toolFailure("Invalid sessionMode: reuse-target"));
  });

  it("accepts supported session modes", async () => {
    const sessionManager = createMockSessionManager();
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    scheduler.initialize(sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "schedule_create");
    if (!tool) throw new Error("schedule_create tool not found");

    const result = await tool.handler(
      {
        taskId: task.id,
        name: "Reuse last",
        prompt: "continue working",
        type: "cron",
        cron: "0 0 * * *",
        sessionMode: "reuse-last",
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-3",
        toolName: "schedule_create",
        arguments: {},
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(ctx.scheduleStore.listSchedules(task.id)[0]?.sessionMode).toBe("reuse-last");
  });
});
