import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { toolFailure } from "../tool-results.js";
import { createChecklistToolDefinitions } from "../tools/checklist-tools.js";
import { createDocsToolDefinitions } from "../tools/docs-tools.js";
import { createTagToolDefinitions } from "../tools/tag-tools.js";
import { createTaskGroupToolDefinitions } from "../tools/task-group-tools.js";
import { createTaskToolDefinitions } from "../tools/task-tools.js";
import { createTestApp } from "./test-app.js";

const TAGGED_DOC_DESCRIPTION_ERROR = "Tagged docs must include a non-empty frontmatter description";

function getTool(ctx: AppContext, name: string) {
  const tool = [
    ...getBridgeToolDefinitions(ctx),
    ...createTaskToolDefinitions(ctx),
    ...createChecklistToolDefinitions(ctx),
    ...createTaskGroupToolDefinitions(ctx),
    ...createTagToolDefinitions(ctx),
    ...createDocsToolDefinitions(ctx),
  ].find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool as any;
}

function actionCaller(ctx: AppContext) {
  const tools = new Map(getBridgeToolDefinitions(ctx).map(({ name, handler }) => [name, handler]));
  return (name: string, args: Record<string, unknown> = {}) => tools.get(name)!(args, {});
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

    const call = actionCaller(ctx);
    const missingTask = { taskId: "missing-task", text: "Ship it", extra: true };
    for (const name of ["action_add", "checklist_add"]) {
      expect(await call(name, missingTask)).toEqual(toolFailure("Task missing-task not found"));
    }
    expect(await call("action_add", { text: "Ship it", b: true, a: true })).toEqual(toolFailure("Unknown field(s): b, a"));
    expect(await call("action_update", { actionId: "missing" })).toEqual(toolFailure("Checklist item missing not found"));
    expect(await call("checklist_update", { checklistItemId: "missing", extra: true }))
      .toEqual(toolFailure("Checklist item missing not found"));
  });

  it("edits the same global item through both tool families without changing their projections", async ({ onTestFinished }) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2030-01-02T00:15:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const { ctx } = createTestApp();
    const call = actionCaller(ctx);
    const task = ctx.taskStore.createTask("Checklist host");
    const local = ctx.checklistStore.createChecklistItem(task.id, "Task-specific");
    const added = await call("checklist_add", { text: "Global", deadline: "2030-01-01", key: "ignored", sourceUrl: "ignored" });
    expect(added).toEqual({ success: true, message: 'Checklist item added: "Global" (due 2030-01-01)', checklistItemId: expect.any(String) });
    const { checklistItemId: id } = added as { checklistItemId: string };
    const action = { id, taskId: null, text: "Global", done: false, order: 0, createdAt: "2030-01-02T00:15:00.000Z", deadline: "2030-01-01" };
    expect(await call("action_list")).toEqual({ actions: [action] });
    const legacy = { id, text: "Global", done: false, deadline: "2030-01-01", isOverdue: true };
    for (const args of [{}, { taskId: null }]) {
      expect(await call("checklist_list", args)).toEqual({ checklistItems: [legacy], total: 1, done: 0 });
    }
    expect(await call("action_update", { actionId: id, done: true, extra: true })).toEqual({
      success: true, action: { ...action, done: true, completedAt: action.createdAt },
    });
    expect(await call("checklist_list")).toEqual({ checklistItems: [{ ...legacy, done: true, isOverdue: false }], total: 1, done: 1 });
    expect(await call("checklist_list", { taskId: task.id })).toEqual({
      checklistItems: [{ id: local.id, text: "Task-specific", done: false, deadline: null, isOverdue: false }], total: 1, done: 0,
    });
    expect(await call("checklist_remove", { checklistItemId: id })).toEqual({ success: true, message: "Checklist item removed" });
    expect(await call("action_list")).toEqual({ actions: [] });
  });

  it("returns the same sourced Action on a keyed retry without creating a duplicate", async () => {
    const { ctx } = createTestApp();
    const call = actionCaller(ctx);
    const args = { text: "Send report", key: "report", sourceUrl: "https://example.com/report" };
    const first = await call("action_add", args) as { action: { id: string } };
    expect(first).toMatchObject({ success: true, action: { taskId: null, stableKey: args.key, sourceUrl: args.sourceUrl } });
    expect(await call("action_add", { ...args, taskId: null, text: "Retry" })).toEqual(first);
    expect(await call("action_list", { taskId: null })).toEqual({ actions: [first.action] });
    expect(await call("action_add", { ...args, taskId: ctx.taskStore.createTask("Other").id }))
      .toEqual(toolFailure("key belongs to an Action in a different task"));
    const checklistItemId = first.action.id;
    expect(await call("checklist_update", { checklistItemId, done: true })).toEqual({ success: true, message: 'Checklist item completed: "Send report"' });
    expect(await call("checklist_update", { checklistItemId, deadline: null })).toEqual({ success: true, message: 'Checklist item updated: "Send report"' });
    expect(await call("action_remove", { actionId: checklistItemId })).toEqual({ success: true });
    expect(await call("checklist_remove", { checklistItemId })).toEqual(toolFailure(`Checklist item ${checklistItemId} not found`));
  });

  it("task_group_delete uses the atomic store operation and reports failures", async () => {
    const { ctx } = createTestApp();
    const group = ctx.taskGroupStore.createGroup("Delete me");
    const task = ctx.taskStore.createTask("Grouped", group.id);
    const tag = ctx.tagStore!.createTag("group-tag");
    ctx.tagStore!.setEntityTags("task_group", group.id, [tag.id]);
    const deleteTool = getTool(ctx, "task_group_delete");

    await expect(deleteTool.handler({
      groupId: group.id,
    }, createInvocation("task_group_delete"))).resolves.toEqual({
      success: true,
      message: "Group deleted, 1 task(s) ungrouped",
    });
    expect(ctx.taskStore.getTask(task.id)?.groupId).toBeUndefined();
    expect(ctx.taskGroupStore.getGroup(group.id)).toBeUndefined();
    expect(ctx.tagStore!.getEntityTags("task_group", group.id)).toEqual([]);
    await expect(deleteTool.handler({
      groupId: group.id,
    }, createInvocation("task_group_delete"))).resolves.toEqual({
      success: true,
      message: "Group already absent; no changes were needed",
    });

    const preserved = ctx.taskGroupStore.createGroup("Preserved");
    vi.spyOn(ctx.taskGroupStore, "deleteGroup").mockImplementationOnce(() => {
      throw new Error("injected delete failure");
    });
    await expect(deleteTool.handler({
      groupId: preserved.id,
    }, createInvocation("task_group_delete"))).resolves.toEqual(
      toolFailure("injected delete failure"),
    );
    expect(ctx.taskGroupStore.getGroup(preserved.id)?.id).toBe(preserved.id);
  });

  it("normalizes docs path validation failures", async () => {
    const { ctx } = createTestApp();
    const docsReadTool = getTool(ctx, "docs_read");
    const docsDbQueryTool = getTool(ctx, "docs_db_query");

    await expect(docsReadTool.handler({ path: "../escape" }, createInvocation("docs_read")))
      .resolves.toEqual(toolFailure('Invalid page path: directory traversal ("..") is not allowed'));
    await expect(docsReadTool.handler({ path: "C:foo" }, createInvocation("docs_read")))
      .resolves.toMatchObject({
        resultType: "failure",
        error: expect.stringContaining("Invalid page path"),
      });
    await expect(docsDbQueryTool.handler({ folder: "C:foo" }, createInvocation("docs_db_query")))
      .resolves.toMatchObject({
        resultType: "failure",
        error: expect.stringContaining("Invalid folder"),
      });
  });

  it("enforces tagged docs_write/docs_edit description requirements", async () => {
    // rejects tagged docs_write pages without a description
    {
    const { ctx } = createTestApp();
    const docsWriteTool = getTool(ctx, "docs_write");

    await expect(docsWriteTool.handler({
      path: "notes/tagged-without-description",
      content: `---
title: Tagged page
tags:
  - deploy
---

    # Tagged page
`,
    }, createInvocation("docs_write")))
      .resolves.toEqual(toolFailure(TAGGED_DOC_DESCRIPTION_ERROR));
    }

    // allows tagged docs_write pages when a description is present
    {
    const { ctx } = createTestApp();
    const docsWriteTool = getTool(ctx, "docs_write");

    await expect(docsWriteTool.handler({
      path: "notes/tagged-with-description",
      content: `---
title: Tagged page
description: Helpful summary
tags:
  - deploy
---

# Tagged page
`,
    }, createInvocation("docs_write")))
      .resolves.toMatchObject({ path: "notes/tagged-with-description", success: true });
    }

    // rejects docs_edit changes that leave a tagged page without a description
    {
    const { ctx } = createTestApp();
    const docsEditTool = getTool(ctx, "docs_edit");
    ctx.docsStore!.writePage("notes/tagged-edit-without-description", `---
title: Tagged page
description: Helpful summary
tags:
  - deploy
---

# Tagged page
`);

    await expect(docsEditTool.handler({
      path: "notes/tagged-edit-without-description",
      old_str: "description: Helpful summary",
      new_str: "description:   ",
    }, createInvocation("docs_edit")))
      .resolves.toEqual(toolFailure(TAGGED_DOC_DESCRIPTION_ERROR));
    }

    // allows docs_edit changes that preserve a tagged page description
    {
    const { ctx } = createTestApp();
    const docsEditTool = getTool(ctx, "docs_edit");
    ctx.docsStore!.writePage("notes/tagged-edit-with-description", `---
title: Tagged page
description: Helpful summary
tags:
  - deploy
---

Original body
`);

    await expect(docsEditTool.handler({
      path: "notes/tagged-edit-with-description",
      old_str: "Original body",
      new_str: "Updated body",
    }, createInvocation("docs_edit")))
      .resolves.toMatchObject({ path: "notes/tagged-edit-with-description", success: true });
    expect(ctx.docsStore!.readPage("notes/tagged-edit-with-description")?.body).toBe("Updated body");
    }
  });
  it("rejects docs_delete for database entries", async () => {
    const { ctx } = createTestApp();
    const docsDeleteTool = getTool(ctx, "docs_delete");
    ctx.docsStore!.writeSchema("incidents", { name: "Incidents", fields: [] });
    const entry = ctx.docsStore!.addDbEntry("incidents", { title: "Database entry" });

    await expect(docsDeleteTool.handler({ path: entry.path }, createInvocation("docs_delete")))
      .resolves.toEqual(toolFailure(`"${entry.path}" is a database entry. Use docs_db_delete with { folder, slug } to remove it.`));
  });

  it("supports docs snapshot tools and requires restore confirmation", async () => {
    const { ctx } = createTestApp();
    const createTool = getTool(ctx, "docs_snapshot_create");
    const listTool = getTool(ctx, "docs_snapshot_list");
    const restoreTool = getTool(ctx, "docs_snapshot_restore");
    ctx.docsStore!.writePage("notes/snapshotted", "# Snapshotted\n\nOriginal body");

    const created = await createTool.handler({ reason: "tool-test" }, createInvocation("docs_snapshot_create")) as any;
    expect(created).toMatchObject({
      success: true,
      created: true,
      snapshot: { reason: "tool-test" },
    });

    await expect(listTool.handler({}, createInvocation("docs_snapshot_list")))
      .resolves.toMatchObject({ snapshots: [expect.objectContaining({ id: created.snapshot.id })] });

    await expect(restoreTool.handler({ id: created.snapshot.id, confirm: false }, createInvocation("docs_snapshot_restore")))
      .resolves.toEqual(toolFailure("confirm: true is required to restore a docs snapshot"));

    ctx.docsStore!.writePage("notes/snapshotted", "# Snapshotted\n\nChanged body");
    const stalePage = ctx.docsStore!.writePage(
      "notes/stale-after-snapshot",
      "# Stale after snapshot\n\nstalesnapshotmarker",
    );
    ctx.docsIndex!.indexPage(stalePage);
    expect(ctx.docsIndex!.search("stalesnapshotmarker", 20, 0).results.map((result) => result.path))
      .toContain("notes/stale-after-snapshot");

    await expect(restoreTool.handler({ id: created.snapshot.id, confirm: true }, createInvocation("docs_snapshot_restore")))
      .resolves.toMatchObject({
        success: true,
        reindexed: true,
        restoredFrom: { id: created.snapshot.id },
        preRestoreSnapshotId: expect.any(String),
      });
    expect(ctx.docsStore!.readPage("notes/snapshotted")?.body).toContain("Original body");
    expect(ctx.docsIndex!.search("stalesnapshotmarker", 20, 0).results.map((result) => result.path))
      .not.toContain("notes/stale-after-snapshot");
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
