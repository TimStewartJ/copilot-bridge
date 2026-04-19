import { afterEach, describe, expect, it } from "vitest";
import { createBridgeTools } from "../session-manager.js";
import * as scheduler from "../scheduler.js";
import { createMockSessionManager, createTestApp } from "./helpers.js";

describe("schedule tools", () => {
  afterEach(() => {
    scheduler.shutdown();
  });

  it("defaults schedule_create reuse-target mode to the invoking session", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = async () => [{ sessionId: "session-1" }];
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    ctx.taskStore.linkSession(task.id, "session-1");
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
        name: "Target current session",
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

    expect(result).toMatchObject({ success: true });
    const [schedule] = ctx.scheduleStore.listSchedules(task.id);
    expect(schedule.sessionMode).toBe("reuse-target");
    expect(schedule.targetSessionId).toBe("session-1");
  });

  it("defaults schedule_update reuse-target mode to the invoking session", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = async () => [{ sessionId: "session-1" }];
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    ctx.taskStore.linkSession(task.id, "session-1");
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

    expect(result).toMatchObject({ success: true });
    expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
      sessionMode: "reuse-target",
      targetSessionId: "session-1",
    });
  });

  it("preserves an existing target when schedule_update keeps reuse-target mode", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = async () => [{ sessionId: "session-1" }, { sessionId: "session-2" }];
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    ctx.taskStore.linkSession(task.id, "session-1");
    ctx.taskStore.linkSession(task.id, "session-2");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Keep target",
      prompt: "continue working",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "session-1",
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
        sessionId: "session-2",
        toolCallId: "tool-4",
        toolName: "schedule_update",
        arguments: {},
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
      sessionMode: "reuse-target",
      targetSessionId: "session-1",
    });
  });

  it("preserves a missing existing target when schedule_update keeps reuse-target mode", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = async () => [{ sessionId: "session-2" }];
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    ctx.taskStore.linkSession(task.id, "session-1");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Keep missing target",
      prompt: "continue working",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "session-1",
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
      { scheduleId: schedule.id, sessionMode: "reuse-target", name: "Renamed" },
      {
        sessionId: "session-2",
        toolCallId: "tool-5",
        toolName: "schedule_update",
        arguments: {},
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({
      name: "Renamed",
      sessionMode: "reuse-target",
      targetSessionId: "session-1",
    });
  });

  it("rejects preserving a reuse-target session that is no longer linked to the task", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = async () => [];
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    ctx.taskStore.linkSession(task.id, "session-1");
    ctx.taskStore.unlinkSession(task.id, "session-1");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Broken target",
      prompt: "continue working",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "session-1",
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
      { scheduleId: schedule.id, sessionMode: "reuse-target", name: "Renamed" },
      {
        sessionId: "session-2",
        toolCallId: "tool-6",
        toolName: "schedule_update",
        arguments: {},
      },
    );

    expect(result).toEqual({ error: "Target session must already be linked to the same task" });
  });

  it("rejects schedule_create reuse-target mode when the invoking session is not on the task", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = async () => [{ sessionId: "session-1" }];
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
        name: "Target current session",
        prompt: "continue working",
        type: "cron",
        cron: "0 0 * * *",
        sessionMode: "reuse-target",
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-3",
        toolName: "schedule_create",
        arguments: {},
      },
    );

    expect(result).toEqual({ error: "Target session must already be linked to the same task" });
  });
});
