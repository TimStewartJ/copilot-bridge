import { describe, expect, it, vi } from "vitest";
import { createAgentDefinitionToolDefinitions } from "../tools/agent-definition-tools.js";
import { createTestApp } from "./test-app.js";

function getTool(name: string, ctx: ReturnType<typeof createTestApp>["ctx"]) {
  const tool = createAgentDefinitionToolDefinitions(ctx).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

function invocation(sessionId = "author-session") {
  return { sessionId, requestId: "tool-call-1" } as any;
}

describe("agent definition tools", () => {
  it("creates a task definition and schedules linked sessions for fresh config", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Agent tool host");
    ctx.taskStore.linkSession(task.id, "author-session");
    ctx.taskStore.linkSession(task.id, "other-session");
    ctx.sessionManager.invalidateTaskSessionConfig = vi.fn().mockReturnValue(2);
    const tool = getTool("agent_definition_create", ctx);

    const result = await tool.handler({
      taskId: task.id,
      name: "migration-reviewer",
      displayName: "Migration Reviewer",
      description: "Reviews migration compatibility",
      prompt: "Review migrations for compatibility regressions.",
      tools: ["view", "grep"],
    }, invocation()) as any;

    expect(result).toMatchObject({
      success: true,
      changed: true,
      terminal: true,
      agentName: "migration-reviewer",
      infer: false,
      invalidatedSessions: 2,
    });
    expect(result.summary).toContain("available after this turn");
    expect(ctx.sessionManager.invalidateTaskSessionConfig).toHaveBeenCalledWith(
      task.id,
      'task agent definition "migration-reviewer" was created',
    );
    expect(ctx.taskAgentDefinitionStore?.listTaskAgentDefinitions(task.id)).toEqual([
      expect.objectContaining({
        name: "migration-reviewer",
        tools: ["view", "grep"],
        infer: false,
        frontmatter: expect.objectContaining({
          metadata: expect.objectContaining({
            "bridge-created-by-session": "author-session",
          }),
        }),
      }),
    ]);
  });

  it("rejects duplicates and removes definitions by exact task/name", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Agent cleanup host");
    ctx.sessionManager.invalidateTaskSessionConfig = vi.fn().mockReturnValue(0);
    const createTool = getTool("agent_definition_create", ctx);
    const removeTool = getTool("agent_definition_remove", ctx);
    const args = {
      taskId: task.id,
      name: "release-verifier",
      description: "Verifies release readiness",
      prompt: "Check release evidence and report blockers.",
    };

    await createTool.handler(args, invocation());
    const duplicate = await createTool.handler(args, invocation()) as any;
    expect(duplicate.resultType).toBe("failure");
    expect(duplicate.textResultForLlm).toContain("already exists");

    const removed = await removeTool.handler({
      taskId: task.id,
      name: "release-verifier",
    }, invocation()) as any;
    expect(removed).toMatchObject({ success: true, changed: true, agentName: "release-verifier" });
    expect(ctx.taskAgentDefinitionStore?.listTaskAgentDefinitions(task.id)).toEqual([]);

    const missing = await removeTool.handler({
      taskId: task.id,
      name: "release-verifier",
    }, invocation()) as any;
    expect(missing.resultType).toBe("failure");
    expect(missing.textResultForLlm).toContain("is not associated");
  });
});
