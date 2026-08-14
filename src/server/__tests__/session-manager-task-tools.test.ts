import { describe, expect, it } from "vitest";
import type { AppContext } from "../app-context.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { createTaskToolDefinitions } from "../tools/task-tools.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./test-app.js";

function getTool(ctx: AppContext, name: string) {
  const tool = [
    ...getBridgeToolDefinitions(ctx),
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

    expect(createTool.inputSchema.properties.kind).toEqual({
      type: "string",
      enum: ["task", "ongoing"],
      description: "Task kind. Defaults to task.",
    });
    expect("parameters" in createTool).toBe(false);
    expect(updateTool.inputSchema.properties.kind).toEqual({
      type: "string",
      enum: ["task", "ongoing"],
      description: "Task kind",
    });
    expect(updateTool.inputSchema.properties.status.enum).toEqual(["active", "done", "archived"]);
    expect(updateTool.inputSchema.properties.completionAction.enum).toEqual(["complete-and-archive"]);
    expect(updateTool.inputSchema.properties.priority.type).toBe("integer");
    expect(updateTool.inputSchema.properties.groupId.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(updateTool.inputSchema.properties.nextAction).toBeUndefined();
    expect(updateTool.inputSchema.properties.waitingOn).toBeUndefined();
    expect(updateTool.inputSchema.properties.nextTouchAt).toBeUndefined();
    expect(momentumTool.inputSchema.required).toEqual(["taskId", "followUp"]);
    expect(momentumTool.inputSchema.properties.followUp.properties.mode.enum).toEqual(["set", "keep", "clear"]);
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

  it("task_get_info includes task agent definition summaries without prompts", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Agent info host");
    ctx.taskAgentDefinitionStore?.createTaskAgentDefinition({
      taskId: task.id,
      name: "api-reviewer",
      displayName: "API Reviewer",
      description: "Reviews API compatibility",
      prompt: "Review API changes for compatibility.",
      tools: [],
    });
    const infoTool = getTool(ctx, "task_get_info");

    const info = await infoTool.handler({ taskId: task.id }, createInvocation("task_get_info")) as any;

    expect(info.agentDefinitions).toEqual([{
      name: "api-reviewer",
      displayName: "API Reviewer",
      description: "Reviews API compatibility",
      tools: [],
      infer: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    }]);
    expect(JSON.stringify(info.agentDefinitions)).not.toContain("Review API changes");
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

    const invalidKind: any = await tool.handler({
      taskId: task.id,
      kind: "invalid",
    }, createInvocation("task_update"));
    expect(String(invalidKind.textResultForLlm)).toContain("Invalid arguments for task_update");
    expect(String(invalidKind.textResultForLlm)).toContain("kind must be one of");
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

  it("task_update changes priority and supports status or completionAction", async () => {
    const { ctx } = createTestApp();
    const priorityTask = ctx.taskStore.createTask("Priority update");
    const statusTask = ctx.taskStore.createTask("Status update");
    const completionTask = ctx.taskStore.createTask("Completion update");
    const group = ctx.taskGroupStore.createGroup("Temporary group");
    const groupedTask = ctx.taskStore.createTask("Ungroup update", group.id);
    const tool = getTool(ctx, "task_update");

    await expect(tool.handler({
      taskId: priorityTask.id,
      priority: 7,
    }, createInvocation("task_update"))).resolves.toMatchObject({ success: true });
    expect(ctx.taskStore.getTask(priorityTask.id)?.priority).toBe(7);
    await tool.handler({
      taskId: priorityTask.id,
      priority: 0,
    }, createInvocation("task_update"));
    expect(ctx.taskStore.getTask(priorityTask.id)?.priority).toBe(0);

    await expect(tool.handler({
      taskId: statusTask.id,
      status: "done",
    }, createInvocation("task_update"))).resolves.toMatchObject({ success: true });
    expect(ctx.taskStore.getTask(statusTask.id)).toEqual(expect.objectContaining({
      status: "archived",
      completedAt: expect.any(String),
    }));

    await expect(tool.handler({
      taskId: completionTask.id,
      completionAction: "complete-and-archive",
    }, createInvocation("task_update"))).resolves.toMatchObject({ success: true });
    expect(ctx.taskStore.getTask(completionTask.id)).toEqual(expect.objectContaining({
      status: "archived",
      completedAt: expect.any(String),
    }));

    await expect(tool.handler({
      taskId: groupedTask.id,
      groupId: null,
    }, createInvocation("task_update"))).resolves.toMatchObject({ success: true });
    expect(ctx.taskStore.getTask(groupedTask.id)?.groupId).toBeUndefined();
  });

  it("task_update rejects invalid status combinations, priorities, and group references", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Invalid update");
    const tool = getTool(ctx, "task_update");
    const createTool = getTool(ctx, "task_create");

    await expect(tool.handler({
      taskId: task.id,
      status: "archived",
      completionAction: "complete-and-archive",
    }, createInvocation("task_update"))).resolves.toEqual(
      toolFailure("completionAction cannot be combined with status"),
    );

    const invalidPriority: any = await tool.handler({
      taskId: task.id,
      priority: 1.5,
    }, createInvocation("task_update"));
    expect(String(invalidPriority.textResultForLlm)).toContain("Invalid arguments for task_update");
    expect(String(invalidPriority.textResultForLlm)).toContain("priority must be integer");

    await expect(tool.handler({
      taskId: task.id,
      groupId: "missing-group",
    }, createInvocation("task_update"))).resolves.toEqual(
      toolFailure("Task group missing-group not found"),
    );

    await expect(createTool.handler({
      title: "Invalid group create",
      groupId: "missing-group",
    }, createInvocation("task_create"))).resolves.toEqual(
      toolFailure("Task group missing-group not found"),
    );
    expect(ctx.taskStore.getTask(task.id)).toEqual(expect.objectContaining({
      status: "active",
      priority: 0,
      groupId: undefined,
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
      sessionIds: sessionIds.slice(2),
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

    for (const nextTouchAt of ["not-a-date", "2026-02-31T00:00:00.000Z"]) {
      await expect(tool.handler({
        taskId: task.id,
        followUp: { mode: "set", nextTouchAt },
      }, createInvocation("task_update_momentum"))).resolves.toEqual(
        toolFailure("nextTouchAt must be a valid ISO timestamp with timezone"),
      );
    }

    const wrongType: any = await tool.handler({
      taskId: task.id,
      followUp: { mode: "set", nextTouchAt: JSON.parse("{\"value\":123}").value },
    }, createInvocation("task_update_momentum"));
    expect(String(wrongType.textResultForLlm)).toContain("followUp.nextTouchAt must be string");

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
  it("task_link_pr stores a canonical repo id separate from the display name", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Link PR");
    const tool = getTool(ctx, "task_link_pr");

    await expect(tool.handler({
      taskId: task.id,
      repoName: "https://github.com/octo/widget",
      prId: 12,
      provider: "github",
    }, createInvocation("task_link_pr"))).resolves.toMatchObject({ success: true });

    expect(ctx.taskStore.getTask(task.id)?.pullRequests).toEqual([
      expect.objectContaining({
        repoId: "octo/widget",
        repoName: "https://github.com/octo/widget",
        prId: 12,
        provider: "github",
      }),
    ]);
  });

  it("task_link_pr keeps a durable ADO repository id", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Link ADO PR");
    const tool = getTool(ctx, "task_link_pr");

    await tool.handler({
      taskId: task.id,
      repoId: "3f2b9c62-0d6a-4b73-8a9b-2f4e0d1a5c77",
      repoName: "Widget.Service",
      prId: 8,
      provider: "ado",
    }, createInvocation("task_link_pr"));

    expect(ctx.taskStore.getTask(task.id)?.pullRequests).toEqual([
      expect.objectContaining({
        repoId: "3f2b9c62-0d6a-4b73-8a9b-2f4e0d1a5c77",
        repoName: "Widget.Service",
        provider: "ado",
      }),
    ]);
  });

  it("task_link_pr rejects a non-integer prId through the declared schema", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Bad prId");
    const tool = getTool(ctx, "task_link_pr");

    for (const prId of [1.5, 0, "12"]) {
      const result: any = await tool.handler({
        taskId: task.id,
        repoName: "octo/widget",
        prId,
        provider: "github",
      }, createInvocation("task_link_pr"));
      expect(String(result.textResultForLlm)).toContain("Invalid arguments for task_link_pr");
    }

    expect(ctx.taskStore.getTask(task.id)?.pullRequests).toEqual([]);
  });

  it("task_link_work_item does not fall back to ado for an ambiguous reference", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Ambiguous work item");
    const tool = getTool(ctx, "task_link_work_item");

    const result: any = await tool.handler(
      { taskId: task.id, workItemId: "4242" },
      createInvocation("task_link_work_item"),
    );

    expect(String(result.textResultForLlm)).toContain("Pass provider explicitly");
    expect(ctx.taskStore.getTask(task.id)?.workItems).toEqual([]);
  });

  it("task_link_work_item infers github from a github.com reference and accepts numeric ids", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Inferred work item");
    const tool = getTool(ctx, "task_link_work_item");

    await tool.handler(
      { taskId: task.id, workItemId: "https://github.com/octo/widget/issues/7" },
      createInvocation("task_link_work_item"),
    );
    await tool.handler(
      { taskId: task.id, workItemId: 4242, provider: "ado" },
      createInvocation("task_link_work_item"),
    );

    expect(ctx.taskStore.getTask(task.id)?.workItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "octo/widget#7", provider: "github" }),
      expect.objectContaining({ id: "4242", provider: "ado" }),
    ]));
  });

  it("task_unlink_pr also clears a legacy row keyed by the raw repo reference", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Legacy unlink");
    ctx.taskStore.linkPR(task.id, {
      repoId: "https://github.com/octo/widget",
      repoName: "https://github.com/octo/widget",
      prId: 5,
      provider: "github",
    });

    await getTool(ctx, "task_unlink_pr").handler({
      taskId: task.id,
      repoName: "https://github.com/octo/widget",
      prId: 5,
      provider: "github",
    }, createInvocation("task_unlink_pr"));

    expect(ctx.taskStore.getTask(task.id)?.pullRequests).toEqual([]);
  });
  it("task_unlink_pr without a provider unlinks across providers", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Cross provider unlink");
    ctx.taskStore.linkPR(task.id, { repoId: "repo", repoName: "repo", prId: 1, provider: "ado" });
    ctx.taskStore.linkPR(task.id, { repoId: "repo", repoName: "repo", prId: 1, provider: "linear" });

    const result: any = await getTool(ctx, "task_unlink_pr").handler(
      { taskId: task.id, repoName: "repo", prId: 1 },
      createInvocation("task_unlink_pr"),
    );

    expect(result).toMatchObject({ success: true });
    expect(ctx.taskStore.getTask(task.id)?.pullRequests).toEqual([]);
  });

  it("task_link_pr accepts a durable repoId without a repoName", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("RepoId only");

    await getTool(ctx, "task_link_pr").handler({
      taskId: task.id,
      repoId: "3f2b9c62-0d6a-4b73-8a9b-2f4e0d1a5c77",
      prId: 8,
      provider: "ado",
    }, createInvocation("task_link_pr"));

    expect(ctx.taskStore.getTask(task.id)?.pullRequests).toEqual([
      expect.objectContaining({ repoId: "3f2b9c62-0d6a-4b73-8a9b-2f4e0d1a5c77", prId: 8, provider: "ado" }),
    ]);
  });

  it("task_link_pr still requires some repository reference", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("No repo ref");

    const result: any = await getTool(ctx, "task_link_pr").handler(
      { taskId: task.id, prId: 8, provider: "ado" },
      createInvocation("task_link_pr"),
    );

    expect(String(result.textResultForLlm)).toContain("repoName or repoId is required");
    expect(ctx.taskStore.getTask(task.id)?.pullRequests).toEqual([]);
  });

  it("task_link_work_item rejects a blank work item reference", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Blank work item");

    const result: any = await getTool(ctx, "task_link_work_item").handler(
      { taskId: task.id, workItemId: "   ", provider: "ado" },
      createInvocation("task_link_work_item"),
    );

    expect(String(result.textResultForLlm)).toContain("workItemId is required");
    expect(ctx.taskStore.getTask(task.id)?.workItems).toEqual([]);
  });
});
