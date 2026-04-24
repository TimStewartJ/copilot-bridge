import { describe, expect, it } from "vitest";
import type { AppContext } from "../app-context.js";
import { createBridgeTools } from "../session-manager.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./helpers.js";

function getTool(ctx: AppContext, name: string) {
  const tool = createBridgeTools(ctx).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

function createInvocation(toolName: string) {
  return {
    sessionId: "session-1",
    toolCallId: `tool-${toolName}`,
    toolName,
    arguments: {},
  };
}

describe("session manager task tools", () => {
  it("task_update stores nullable momentum fields", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum host");
    const tool = getTool(ctx, "task_update");

    await expect(tool.handler({
      taskId: task.id,
      doneWhen: "Merged and deployed",
      nextAction: "Check the release dashboard",
      waitingOn: "Customer validation",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    }, createInvocation("task_update"))).resolves.toMatchObject({ success: true });

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      doneWhen: "Merged and deployed",
      nextAction: "Check the release dashboard",
      waitingOn: "Customer validation",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    }));

    await expect(tool.handler({
      taskId: task.id,
      doneWhen: null,
      nextAction: null,
      waitingOn: null,
      nextTouchAt: null,
    }, createInvocation("task_update"))).resolves.toMatchObject({ success: true });

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      doneWhen: undefined,
      nextAction: undefined,
      waitingOn: undefined,
      nextTouchAt: undefined,
    }));
  });

  it("task_get_info includes momentum fields", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum info");
    ctx.taskStore.updateTask(task.id, {
      doneWhen: "QA signs off",
      nextAction: "Message QA",
      waitingOn: "QA sign-off",
      nextTouchAt: "2026-05-03T11:00:00.000Z",
    });

    const tool = getTool(ctx, "task_get_info");
    const result = await tool.handler({ taskId: task.id }, createInvocation("task_get_info"));

    expect(result).toEqual(expect.objectContaining({
      id: task.id,
      doneWhen: "QA signs off",
      nextAction: "Message QA",
      waitingOn: "QA sign-off",
      nextTouchAt: "2026-05-03T11:00:00.000Z",
    }));
  });

  it("task_update rejects invalid nextTouchAt values", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum invalid");
    const tool = getTool(ctx, "task_update");

    for (const nextTouchAt of ["not-a-date", "2026-02-31T00:00:00.000Z", JSON.parse("{\"value\":123}").value]) {
      await expect(tool.handler({
        taskId: task.id,
        nextTouchAt,
      }, createInvocation("task_update"))).resolves.toEqual(
        toolFailure("nextTouchAt must be a valid ISO timestamp with timezone"),
      );
    }

    expect(ctx.taskStore.getTask(task.id)?.nextTouchAt).toBeUndefined();
  });
});
