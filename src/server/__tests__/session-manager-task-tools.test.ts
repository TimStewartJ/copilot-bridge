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
  it("tool metadata exposes kind on task create, update, list, and info", () => {
    const { ctx } = createTestApp();
    const createTool = getTool(ctx, "task_create") as any;
    const updateTool = getTool(ctx, "task_update") as any;
    const listTool = getTool(ctx, "task_list") as any;
    const infoTool = getTool(ctx, "task_get_info") as any;

    expect(createTool.parameters.properties.kind).toEqual({
      type: "string",
      enum: ["task", "ongoing"],
      description: "Task kind. Defaults to task.",
    });
    expect(updateTool.parameters.properties.kind).toEqual({
      type: "string",
      enum: ["task", "ongoing"],
      description: "Task kind",
    });
    expect(listTool.description).toContain("kinds");
    expect(infoTool.description).toContain("kind");
  });

  it("task_create accepts kind and task list/info include it", async () => {
    const { ctx } = createTestApp();
    const createTool = getTool(ctx, "task_create");
    const listTool = getTool(ctx, "task_list");
    const infoTool = getTool(ctx, "task_get_info");

    const created = await createTool.handler({
      title: "Keep bridge healthy",
      kind: "ongoing",
    }, createInvocation("task_create")) as {
      success: boolean;
      taskId: string;
      kind: string;
    };

    expect(created).toEqual(expect.objectContaining({
      success: true,
      taskId: expect.any(String),
      kind: "ongoing",
    }));

    const list = await listTool.handler({}, createInvocation("task_list"));
    expect(list).toEqual({
      tasks: [
        expect.objectContaining({
          id: created.taskId,
          title: "Keep bridge healthy",
          kind: "ongoing",
          status: "active",
        }),
      ],
    });

    const info = await infoTool.handler({ taskId: created.taskId }, createInvocation("task_get_info"));
    expect(info).toEqual(expect.objectContaining({
      id: created.taskId,
      kind: "ongoing",
    }));
  });

  it("task_update can change kind and rejects invalid kinds", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Kind update");
    const tool = getTool(ctx, "task_update");

    await expect(tool.handler({
      taskId: task.id,
      kind: "ongoing",
    }, createInvocation("task_update"))).resolves.toEqual(expect.objectContaining({
      success: true,
      kind: "ongoing",
    }));

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({ kind: "ongoing" }));

    await expect(tool.handler({
      taskId: task.id,
      kind: "invalid",
    }, createInvocation("task_update"))).resolves.toEqual(
      toolFailure("kind must be either 'task' or 'ongoing'"),
    );
  });

  it("task_update normalizes kind-only switches to ongoing", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Kind update normalize");
    ctx.taskStore.updateTask(task.id, { status: "done", doneWhen: "Merged and deployed" });
    const tool = getTool(ctx, "task_update");
    const infoTool = getTool(ctx, "task_get_info");

    await expect(tool.handler({
      taskId: task.id,
      kind: "ongoing",
    }, createInvocation("task_update"))).resolves.toEqual(expect.objectContaining({
      success: true,
      kind: "ongoing",
    }));

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      kind: "ongoing",
      status: "active",
      doneWhen: undefined,
    }));

    await expect(infoTool.handler({ taskId: task.id }, createInvocation("task_get_info"))).resolves.toEqual(
      expect.objectContaining({
        id: task.id,
        kind: "ongoing",
        status: "active",
        doneWhen: undefined,
      }),
    );
  });

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

  it("task_update rejects parked momentum updates for done tasks", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum closed");
    ctx.taskStore.updateTask(task.id, { status: "done" });
    const tool = getTool(ctx, "task_update");

    await expect(tool.handler({
      taskId: task.id,
      nextAction: "Take another pass",
    }, createInvocation("task_update"))).resolves.toEqual(
      toolFailure("nextAction, waitingOn, and nextTouchAt can only be set on active tasks"),
    );

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      status: "done",
      nextAction: undefined,
      waitingOn: undefined,
      nextTouchAt: undefined,
    }));
  });
});
