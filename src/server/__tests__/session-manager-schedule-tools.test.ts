import { afterEach, describe, expect, it } from "vitest";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import * as scheduler from "../scheduler.js";
import { createScheduleToolDefinitions } from "../tools/schedule-tools.js";
import { createMockSessionManager, createTestApp } from "./helpers.js";

function getTool(ctx: ReturnType<typeof createTestApp>["ctx"], name: string) {
  const tool = [
    ...getBridgeToolDefinitions(ctx),
    ...createScheduleToolDefinitions(ctx),
  ].find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool as any;
}

describe("schedule tools", () => {
  afterEach(() => {
    scheduler.shutdown();
  });

  it("rejects unknown fields for schedule_create", async () => {
    const sessionManager = createMockSessionManager();
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    scheduler.initialize(sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const tool = getTool(ctx, "schedule_create");

    const result = await tool.handler(
      {
        taskId: task.id,
        name: "Invalid target",
        prompt: "continue working",
        type: "cron",
        cron: "0 0 * * *",
        unexpectedField: true,
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-target-create",
        toolName: "schedule_create",
        arguments: {},
      },
    );

    expect(result).toMatchObject({ resultType: "failure" });
    expect((result as any).textResultForLlm).toContain("unexpectedField");
    expect(ctx.scheduleStore.listSchedules(task.id)).toHaveLength(0);
  });

  it("rejects unknown fields for schedule_update", async () => {
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

    const tool = getTool(ctx, "schedule_update");

    const result = await tool.handler(
      {
        scheduleId: schedule.id,
        name: "Retargeted name",
        unexpectedField: false,
      },
      {
        sessionId: "session-1",
        toolCallId: "tool-target-update",
        toolName: "schedule_update",
        arguments: {},
      },
    );

    expect(result).toMatchObject({ resultType: "failure" });
    expect((result as any).textResultForLlm).toContain("unexpectedField");
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.name).toBe("Retarget me");
  });

  it("lists schedules with current schedule fields", async () => {
    const sessionManager = createMockSessionManager();
    const { ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Schedule Host");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Current metadata",
      prompt: "continue working",
      type: "cron",
      cron: "0 0 * * *",
    });
    const tool = getTool(ctx, "schedule_list");

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
      name: "Current metadata",
    });
    expect(result.schedules[0]).not.toHaveProperty("sessionMode");
  });
});
