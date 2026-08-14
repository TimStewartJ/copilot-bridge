import { describe, expect, it, vi } from "vitest";
import request from "./test-http.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestApp } from "./test-app.js";

describe("task agent definition routes", () => {
  it("lists summaries and returns full profile detail", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Agent API host");
    ctx.taskAgentDefinitionStore?.createTaskAgentDefinition({
      taskId: task.id,
      name: "api-reviewer",
      displayName: "API Reviewer",
      description: "Reviews API compatibility",
      prompt: "Review API changes for compatibility.",
      tools: ["view"],
    });

    const list = await request(app).get(`/api/tasks/${task.id}/agent-definitions`);
    expect(list.status).toBe(200);
    expect(list.body.agentDefinitions).toEqual([
      expect.objectContaining({
        name: "api-reviewer",
        displayName: "API Reviewer",
        tools: ["view"],
      }),
    ]);
    expect(list.body.agentDefinitions[0]).not.toHaveProperty("prompt");
    expect(list.body.agentDefinitions[0]).not.toHaveProperty("raw");

    const detail = await request(app)
      .get(`/api/tasks/${task.id}/agent-definitions/api-reviewer`);
    expect(detail.status).toBe(200);
    expect(detail.body.agentDefinition).toEqual(expect.objectContaining({
      name: "api-reviewer",
      prompt: "Review API changes for compatibility.",
      raw: expect.stringContaining("disable-model-invocation: true"),
    }));
  });

  it("validates a selected task agent and forwards it to session creation", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Selected agent host");
    ctx.taskAgentDefinitionStore?.createTaskAgentDefinition({
      taskId: task.id,
      name: "implementation-planner",
      description: "Plans implementation",
      prompt: "Plan the implementation.",
    });
    ctx.sessionManager.createTaskSession = vi.fn().mockResolvedValue({ sessionId: "selected-session" });

    const selected = await request(app)
      .post(`/api/tasks/${task.id}/session`)
      .send({ agent: "implementation-planner" });

    expect(selected.status).toBe(200);
    expect(ctx.sessionManager.createTaskSession).toHaveBeenCalledWith(
      task.id,
      task.title,
      task.workItems,
      [],
      task.notes,
      task.cwd,
      undefined,
      null,
      expect.objectContaining({
        background: true,
        agent: "implementation-planner",
      }),
    );

    const missing = await request(app)
      .post(`/api/tasks/${task.id}/session`)
      .send({ agent: "missing-agent" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("not available for this task");

    const global = await request(app)
      .post("/api/sessions")
      .send({ agent: "implementation-planner" });
    expect(global.status).toBe(400);
    expect(global.body.error).toContain("only available for task sessions");
  });

  it("rejects selection when the matching profile is malformed and skipped", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Malformed selected agent");
    const taskDir = join(ctx.taskAgentDefinitionStore!.root, task.id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "broken-agent.agent.md"),
      "---\ndescription: [broken\n---\nPrompt",
      "utf-8",
    );

    const response = await request(app)
      .post(`/api/tasks/${task.id}/session`)
      .send({ agent: "broken-agent" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("not available for this task");
  });
});
