import { afterEach, describe, expect, it } from "vitest";
import { createBridgeTools } from "../session-manager.js";
import * as scheduler from "../scheduler.js";
import { createMockSessionManager, createTestApp } from "./helpers.js";

describe("schedule tools", () => {
  afterEach(() => {
    scheduler.shutdown();
  });

  it("ignores legacy reuse fields for schedule_create", async () => {
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
        sessionMode: "reuse-last",
        reuseSession: true,
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-target-create",
        toolName: "schedule_create",
        arguments: {},
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(ctx.scheduleStore.listSchedules(task.id)).toHaveLength(1);
  });

  it("ignores legacy reuse fields for schedule_update", async () => {
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
      {
        scheduleId: schedule.id,
        name: "Retargeted name",
        targetSessionId: "session-1",
        sessionMode: "reuse-last",
        reuseSession: false,
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-target-update",
        toolName: "schedule_update",
        arguments: {},
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.name).toBe("Retargeted name");
  });

  it("omits legacy reuse fields from schedule_list results", async () => {
    const sessionManager = createMockSessionManager();
    const { ctx, db } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Legacy metadata",
      prompt: "continue working",
      type: "cron",
      cron: "0 0 * * *",
    });
    db.prepare(`
      UPDATE schedules
      SET sessionMode = 'reuse-last',
          targetSessionId = 'target-session',
          lastSessionId = 'last-session'
      WHERE id = ?
    `).run(schedule.id);

    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "schedule_list");
    if (!tool) throw new Error("schedule_list tool not found");

    const result = await tool.handler(
      { taskId: task.id },
      {
        sessionId: "session-1",
        toolCallId: "tool-list",
        toolName: "schedule_list",
        arguments: {},
      },
    ) as { schedules: Array<Record<string, unknown>> };

    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]).toMatchObject({
      id: schedule.id,
      taskId: task.id,
      name: "Legacy metadata",
    });
    expect(result.schedules[0]).not.toHaveProperty("sessionMode");
    expect(result.schedules[0]).not.toHaveProperty("reuseSession");
    expect(result.schedules[0]).not.toHaveProperty("targetSessionId");
    expect(result.schedules[0]).not.toHaveProperty("lastSessionId");
  });
});
