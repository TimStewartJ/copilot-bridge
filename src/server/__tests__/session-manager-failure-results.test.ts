import { describe, expect, it, vi } from "vitest";
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

describe("session manager failure results", () => {
  it("normalizes task and checklist not-found failures", async () => {
    const { ctx } = createTestApp();

    const taskLinkTool = getTool(ctx, "task_link_work_item");
    await expect(taskLinkTool.handler({ taskId: "missing-task", workItemId: "123" }, createInvocation("task_link_work_item")))
      .resolves.toEqual(toolFailure("Task missing-task not found"));

    const checklistAddTool = getTool(ctx, "checklist_add");
    await expect(checklistAddTool.handler({ taskId: "missing-task", text: "Ship it" }, createInvocation("checklist_add")))
      .resolves.toEqual(toolFailure("Task missing-task not found"));
  });

  it("does not expose removed todo tools", () => {
    const { ctx } = createTestApp();
    expect(createBridgeTools(ctx).some((tool) => tool.name === "todo_add")).toBe(false);
    expect(createBridgeTools(ctx).some((tool) => tool.name === "todo_list")).toBe(false);
    expect(createBridgeTools(ctx).some((tool) => tool.name === "todo_update")).toBe(false);
    expect(createBridgeTools(ctx).some((tool) => tool.name === "todo_remove")).toBe(false);
  });

  it("normalizes duplicate tag creation failures", async () => {
    const { ctx } = createTestApp();
    const tagCreateTool = getTool(ctx, "tag_create");

    await expect(tagCreateTool.handler({ name: "Urgent" }, createInvocation("tag_create")))
      .resolves.toMatchObject({ success: true });
    await expect(tagCreateTool.handler({ name: "Urgent" }, createInvocation("tag_create")))
      .resolves.toEqual(toolFailure('Tag "Urgent" already exists'));
  });

  it("normalizes docs path validation failures", async () => {
    const { ctx } = createTestApp();
    const docsReadTool = getTool(ctx, "docs_read");

    await expect(docsReadTool.handler({ path: "../escape" }, createInvocation("docs_read")))
      .resolves.toEqual(toolFailure('Invalid page path: directory traversal ("..") is not allowed'));
  });

  it("surfaces unexpected docs tool errors as failure results", async () => {
    const { ctx } = createTestApp();
    const docsReadTool = getTool(ctx, "docs_read");
    vi.spyOn(ctx.docsStore!, "readPage").mockImplementationOnce(() => {
      throw new Error("disk failed");
    });

    await expect(docsReadTool.handler({ path: "notes/test" }, createInvocation("docs_read")))
      .resolves.toEqual(toolFailure("disk failed"));
  });
});
