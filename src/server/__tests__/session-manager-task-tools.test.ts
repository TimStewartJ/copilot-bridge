import { describe, expect, it } from "vitest";
import type { AppContext } from "../app-context.js";
import { createBridgeTools } from "../session-manager.js";
import { createTaskToolDefinitions } from "../tools/task-tools.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./helpers.js";

function getTool(ctx: AppContext, name: string) {
  const tool = [
    ...createBridgeTools(ctx),
    ...createTaskToolDefinitions(ctx),
  ].find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool as any;
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
  it("tool metadata exposes kind on task create/update and dedicated momentum tool", () => {
    const { ctx } = createTestApp();
    const createTool = getTool(ctx, "task_create") as any;
    const updateTool = getTool(ctx, "task_update") as any;
    const momentumTool = getTool(ctx, "task_update_momentum") as any;
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
    expect(updateTool.parameters.properties.nextAction).toBeUndefined();
    expect(updateTool.parameters.properties.waitingOn).toBeUndefined();
    expect(updateTool.parameters.properties.nextTouchAt).toBeUndefined();
    expect(momentumTool.parameters.required).toEqual(["taskId", "followUp"]);
    expect(momentumTool.parameters.properties.followUp.properties.mode.enum).toEqual(["set", "keep", "clear"]);
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

  it("task_update does not expose or handle momentum fields", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum host");
    const tool = getTool(ctx, "task_update");

    await expect(tool.handler({
      taskId: task.id,
      nextAction: "Ignored action",
      waitingOn: "Ignored blocker",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    }, createInvocation("task_update"))).resolves.toEqual(
      toolFailure("No fields to update. Provide at least one of: title, kind, muted, notes, cwd, groupId, doneWhen, tags"),
    );

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      nextAction: undefined,
      waitingOn: undefined,
      nextTouchAt: undefined,
    }));
  });

  it("task_update_momentum sets and clears nullable momentum fields", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum host");
    const tool = getTool(ctx, "task_update_momentum");

    await expect(tool.handler({
      taskId: task.id,
      nextAction: "Check the release dashboard",
      waitingOn: "Customer validation",
      followUp: { mode: "set", nextTouchAt: "2026-05-02T10:00:00.000Z" },
    }, createInvocation("task_update_momentum"))).resolves.toMatchObject({
      success: true,
      nextAction: "Check the release dashboard",
      waitingOn: "Customer validation",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    });

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      nextAction: "Check the release dashboard",
      waitingOn: "Customer validation",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    }));

    await expect(tool.handler({
      taskId: task.id,
      nextAction: null,
      waitingOn: null,
      followUp: { mode: "clear" },
    }, createInvocation("task_update_momentum"))).resolves.toMatchObject({
      success: true,
      nextAction: null,
      waitingOn: null,
      nextTouchAt: null,
    });

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      nextAction: undefined,
      waitingOn: undefined,
      nextTouchAt: undefined,
    }));
  });

  it("task_update_momentum can keep the existing follow-up while changing other momentum", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum keep");
    ctx.taskStore.updateTask(task.id, {
      nextAction: "Check existing review",
      waitingOn: "Initial reviewer",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    });
    const tool = getTool(ctx, "task_update_momentum");

    await expect(tool.handler({
      taskId: task.id,
      waitingOn: "Updated reviewer",
      followUp: { mode: "keep" },
    }, createInvocation("task_update_momentum"))).resolves.toMatchObject({
      success: true,
      nextAction: "Check existing review",
      waitingOn: "Updated reviewer",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    });
  });

  it("task_update_momentum treats no-op updates as successful unchanged requests", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum no-op");
    ctx.taskStore.updateTask(task.id, {
      nextAction: "Check existing review",
      waitingOn: "Initial reviewer",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    });
    const tool = getTool(ctx, "task_update_momentum");

    const noOpArgs = {
      taskId: task.id,
      nextAction: "Check existing review",
      waitingOn: "Initial reviewer",
      followUp: { mode: "set", nextTouchAt: "2026-05-02T03:00:00-07:00" },
    };

    await expect(tool.handler(noOpArgs, createInvocation("task_update_momentum"))).resolves.toMatchObject({
      success: true,
      changed: false,
      message: "Task momentum is already current; no changes were applied.",
      nextAction: "Check existing review",
      waitingOn: "Initial reviewer",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    });

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      nextAction: "Check existing review",
      waitingOn: "Initial reviewer",
      nextTouchAt: "2026-05-02T10:00:00.000Z",
    }));
  });

  it("task_update_momentum treats clear requests as unchanged when momentum is already empty", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum clear no-op");
    const tool = getTool(ctx, "task_update_momentum");

    await expect(tool.handler({
      taskId: task.id,
      nextAction: null,
      waitingOn: null,
      followUp: { mode: "clear" },
    }, createInvocation("task_update_momentum"))).resolves.toMatchObject({
      success: true,
      changed: false,
      message: "Task momentum is already current; no changes were applied.",
      nextAction: null,
      waitingOn: null,
      nextTouchAt: null,
    });

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
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

  it("task_get_info includes complete session metadata for short linked session lists", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Short session info");
    const sessionIds = ["session-1", "session-2"];
    for (const sessionId of sessionIds) ctx.taskStore.linkSession(task.id, sessionId);

    const tool = getTool(ctx, "task_get_info");
    const result = await tool.handler({ taskId: task.id }, createInvocation("task_get_info"));

    expect(result).toEqual(expect.objectContaining({
      id: task.id,
      sessionIds,
      sessionCount: sessionIds.length,
      omittedSessionCount: 0,
    }));
  });

  it("task_get_info compacts long linked session lists", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Long session info");
    const sessionIds = Array.from({ length: 12 }, (_, index) => `session-${String(index + 1).padStart(2, "0")}`);
    for (const sessionId of sessionIds) ctx.taskStore.linkSession(task.id, sessionId);

    const tool = getTool(ctx, "task_get_info");
    const result = await tool.handler({ taskId: task.id }, createInvocation("task_get_info"));

    expect(result).toEqual(expect.objectContaining({
      id: task.id,
      sessionIds: sessionIds.slice(0, 10),
      sessionCount: sessionIds.length,
      omittedSessionCount: 2,
    }));
  });

  it("task_update_momentum rejects invalid follow-up inputs", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum invalid");
    const tool = getTool(ctx, "task_update_momentum");

    await expect(tool.handler({
      taskId: task.id,
      followUp: { mode: "keep" },
    }, createInvocation("task_update_momentum"))).resolves.toEqual(
      toolFailure("followUp.mode 'keep' must be paired with nextAction or waitingOn. Use mode 'set' or 'clear' to update only the follow-up date."),
    );

    await expect(tool.handler({
      taskId: task.id,
      followUp: { mode: "set" },
    }, createInvocation("task_update_momentum"))).resolves.toEqual(
      toolFailure("followUp.nextTouchAt is required when followUp.mode is 'set'"),
    );

    await expect(tool.handler({
      taskId: task.id,
      followUp: { mode: "clear", nextTouchAt: "2026-05-02T10:00:00.000Z" },
    }, createInvocation("task_update_momentum"))).resolves.toEqual(
      toolFailure("followUp.nextTouchAt is only allowed when followUp.mode is 'set'"),
    );

    for (const nextTouchAt of ["not-a-date", "2026-02-31T00:00:00.000Z", JSON.parse("{\"value\":123}").value]) {
      await expect(tool.handler({
        taskId: task.id,
        followUp: { mode: "set", nextTouchAt },
      }, createInvocation("task_update_momentum"))).resolves.toEqual(
        toolFailure("nextTouchAt must be a valid ISO timestamp with timezone"),
      );
    }

    expect(ctx.taskStore.getTask(task.id)?.nextTouchAt).toBeUndefined();
  });

  it("task_update_momentum rejects momentum updates for completed tasks", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum closed");
    ctx.taskStore.updateTask(task.id, { status: "done" });
    const tool = getTool(ctx, "task_update_momentum");

    await expect(tool.handler({
      taskId: task.id,
      nextAction: "Take another pass",
      followUp: { mode: "set", nextTouchAt: "2026-05-02T10:00:00.000Z" },
    }, createInvocation("task_update_momentum"))).resolves.toEqual(
      toolFailure("task_update_momentum can only be used on active tasks"),
    );

    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      status: "archived",
      completedAt: expect.any(String),
      nextAction: undefined,
      waitingOn: undefined,
      nextTouchAt: undefined,
    }));
  });
});
