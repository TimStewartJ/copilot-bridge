import { describe, expect, it, vi } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { AppContext } from "../app-context.js";
import { validateToolArguments } from "../agent-tools-mcp/validate-args.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { createTaskToolDefinitions } from "../tools/task-tools.js";
import { buildBridgeContextSections } from "../session-context-block.js";
import { TASK_NOTES_MAX_LENGTH } from "../task-note-pages.js";
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
  it("validates the emitted momentum contract with AJV and the Bridge validator", () => {
    const { ctx } = createTestApp();
    const tool = getTool(ctx, "task_update_momentum");
    const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const date = "2026-05-02T10:00:00.000Z";
    const cases: Array<{ valid: boolean; args: Record<string, unknown> }> = [
      { valid: false, args: { followUp: { mode: "keep" } } },
      { valid: true, args: { deferred: true, followUp: { mode: "keep" } } },
      { valid: true, args: { deferred: false, followUp: { mode: "clear" } } },
      { valid: false, args: { deferred: null, followUp: { mode: "keep" } } },
      { valid: false, args: { deferred: "true", followUp: { mode: "keep" } } },
      { valid: false, args: { followUp: { mode: "set" } } },
      { valid: false, args: { followUp: { mode: "clear", nextTouchAt: date } } },
      { valid: false, args: { nextAction: "Review", followUp: { mode: "keep", nextTouchAt: date } } },
      { valid: false, args: { nextAction: null, followUp: { mode: "keep", nextTouchAt: null } } },
      { valid: false, args: { followUp: {} } },
      { valid: false, args: { followUp: null } },
      { valid: false, args: { followUp: [] } },
      { valid: false, args: { followUp: "clear" } },
      { valid: false, args: { followUp: { mode: "invalid" } } },
      { valid: false, args: {} },
      { valid: false, args: { followUp: { mode: "set", nextTouchAt: null } } },
      { valid: true, args: { followUp: { mode: "set", nextTouchAt: date } } },
      { valid: true, args: { followUp: { mode: "set", nextTouchAt: "not-a-date" } } },
      { valid: true, args: { nextAction: "Review", followUp: { mode: "keep" } } },
      { valid: true, args: { nextAction: null, followUp: { mode: "keep" } } },
      { valid: true, args: { waitingOn: "QA", followUp: { mode: "keep" } } },
      { valid: true, args: { waitingOn: null, followUp: { mode: "keep" } } },
      { valid: true, args: { nextAction: null, waitingOn: null, followUp: { mode: "keep" } } },
      { valid: true, args: { followUp: { mode: "clear" } } },
      { valid: true, args: { followUp: { mode: "clear", extra: true } } },
    ];
    for (const { args, valid } of cases) {
      const input = { taskId: "task-1", ...args };
      expect(validate(input).valid, JSON.stringify(input)).toBe(valid);
      expect(validateToolArguments(tool.inputSchema, input) === undefined, JSON.stringify(input)).toBe(valid);
    }
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

  it.each(["task", "group"] as const)("only replaces long %s notes for an agent that read them to the end", async (source) => {
    const { ctx } = createTestApp();
    const group = ctx.taskGroupStore.createGroup("Review");
    const task = ctx.taskStore.createTask("Release review", group.id);
    const info = (args: Record<string, unknown>) => getTool(ctx, "task_get_info").handler({ taskId: task.id, notesSource: source, ...args }, createInvocation("task_get_info"));
    const write = (args: Record<string, unknown>) => source === "task"
      ? getTool(ctx, "task_update").handler({ taskId: task.id, ...args }, createInvocation("task_update"))
      : getTool(ctx, "task_group_update").handler({ groupId: group.id, ...args }, createInvocation("task_group_update"));
    const saved = () => (source === "task" ? ctx.taskStore.getTask(task.id)!.notes : ctx.taskGroupStore.getGroup(group.id)!.notes);
    const set = (notes: string) => (source === "task" ? ctx.taskStore.updateTask(task.id, { notes }) : ctx.taskGroupStore.updateGroup(group.id, { notes }));
    const long = `${"Keep this context. ".repeat(1000)}Rule at the end.`;

    set(long);
    const first = await info({});
    expect(first.nextOffset).not.toBeNull();
    expect(first).not.toHaveProperty("notesWriteToken");
    expect(await write({ notes: "New" })).toMatchObject({ resultType: "failure" });
    expect(await write({ notes: "New", notesWriteToken: first.revision })).toMatchObject({ resultType: "failure" });
    expect(saved()).toBe(long);

    const { notesWriteToken } = await info({ offset: first.nextOffset, revision: first.revision });
    expect(notesWriteToken).toEqual(expect.any(String));
    // Someone else's edit makes the token stale, and a fresh read gets a new one.
    set(`${long} Edited.`);
    expect(await write({ notes: "New", notesWriteToken })).toMatchObject({ resultType: "failure" });
    expect(saved()).toBe(`${long} Edited.`);

    const restart = await info({});
    const reread = await info({ offset: restart.nextOffset, revision: restart.revision });
    const rewritten = await write({ notes: long.replace("Rule at the end.", "Rule kept."), notesWriteToken: reread.notesWriteToken });
    expect(rewritten).toMatchObject({ success: true, notesWriteToken: expect.any(String) });
    expect(await write({ notes: "Short again", notesWriteToken: rewritten.notesWriteToken })).toMatchObject({ success: true });
    expect(saved()).toBe("Short again");
    expect(await write({ notes: "No token needed" })).toMatchObject({ success: true });
  });

  it("refuses agent writes that grow task notes past the limit, but lets over-limit notes be corrected and shrunk", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Trip plan");
    const update = (args: Record<string, unknown>) => getTool(ctx, "task_update").handler({ taskId: task.id, ...args }, createInvocation("task_update"));
    const saved = () => ctx.taskStore.getTask(task.id)!.notes;
    const atLimit = `Open: visa.\n${"x".repeat(TASK_NOTES_MAX_LENGTH - "Open: visa.\n".length)}`;

    expect(await update({ notes: atLimit })).toMatchObject({ success: true });
    for (const growing of [{ notes: `${atLimit}y` }, { notesEdit: { old_str: "Open: visa.", new_str: "Open: visa, insurance." } }]) {
      const refused = await update(growing);
      expect(refused).toMatchObject({ resultType: "failure" });
      expect(JSON.stringify(refused)).toContain("task_history_add");
    }
    expect(saved()).toBe(atLimit);

    // Notes saved over the limit before it existed, or by the user in the app.
    const legacy = `Booked: hotel.\n${"Old story. ".repeat(1000)}`;
    ctx.taskStore.updateTask(task.id, { notes: legacy });
    expect(await update({ notesEdit: { old_str: "Booked: hotel.", new_str: "Booked: motel." } })).toMatchObject({ success: true });
    expect(await update({ notesEdit: { old_str: "Booked: motel.", new_str: "Booked: motel, with parking." } })).toMatchObject({ resultType: "failure" });
    expect(await update({ notesEdit: { old_str: "Booked: motel.\n", new_str: "" } })).toMatchObject({ success: true });
    expect(saved()).toBe(legacy.slice("Booked: hotel.\n".length));
  });

  it("changes one passage of long notes without a read, and only when it is unambiguous", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Release review");
    const long = `Current: comparing vendors.\n${"Keep this context. ".repeat(1000)}Rule at the end.`;
    ctx.taskStore.updateTask(task.id, { notes: long });
    const update = (args: Record<string, unknown>) => getTool(ctx, "task_update").handler({ taskId: task.id, ...args }, createInvocation("task_update"));
    const notesEdit = (old_str: string, new_str: string) => ({ notesEdit: { old_str, new_str } });

    for (const refused of [notesEdit("Not in the notes", "x"), notesEdit("Keep this context.", "x"), notesEdit("", "x"), { notes: "x", ...notesEdit("Current", "x") }]) {
      expect(await update(refused)).toMatchObject({ resultType: "failure" });
    }
    expect(ctx.taskStore.getTask(task.id)!.notes).toBe(long);

    expect(await update(notesEdit("comparing vendors", "picked Acme"))).toMatchObject({ success: true, message: "Task updated (notes)" });
    expect(ctx.taskStore.getTask(task.id)!.notes).toBe(long.replace("comparing vendors", "picked Acme"));
  });

  it("a full read of long task notes also unlocks replacing them", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Release review");
    ctx.taskStore.updateTask(task.id, { notes: "Keep this context. ".repeat(1000) });
    const { notesWriteToken } = await getTool(ctx, "task_get_info").handler({ taskId: task.id }, createInvocation("task_get_info"));
    expect(await getTool(ctx, "task_update").handler({ taskId: task.id, notes: "New", notesWriteToken }, createInvocation("task_update"))).toMatchObject({ success: true });
  });

  it("task_get_info includes direct task tag summaries and an empty list when untagged", async () => {
    const { ctx } = createTestApp();
    const taggedTask = ctx.taskStore.createTask("Tagged info");
    const untaggedTask = ctx.taskStore.createTask("Untagged info");
    const tag = ctx.tagStore!.createTag("release", "purple");
    ctx.tagStore!.setEntityTags("task", taggedTask.id, [tag.id]);
    const infoTool = getTool(ctx, "task_get_info");

    const taggedInfo = await infoTool.handler(
      { taskId: taggedTask.id },
      createInvocation("task_get_info"),
    ) as any;
    const untaggedInfo = await infoTool.handler(
      { taskId: untaggedTask.id },
      createInvocation("task_get_info"),
    ) as any;

    expect(taggedInfo.tags).toEqual([{
      id: tag.id,
      name: "release",
      color: "purple",
    }]);
    expect(untaggedInfo.tags).toEqual([]);
  });

  it("pages the current task or group notes without returning unrelated notes or task details", async () => {
    const { ctx } = createTestApp();
    const group = ctx.taskGroupStore.createGroup("Review");
    const task = ctx.taskStore.createTask("Release review", group.id);
    const prefix = `   ${"🔎 ".repeat(6000)}`;
    const info = getTool(ctx, "task_get_info");
    const read = (args: Record<string, unknown>) => info.handler({ taskId: task.id, ...args }, createInvocation("task_get_info"));
    ctx.taskStore.updateTask(task.id, { notes: `${prefix}Use the blue sample.` });
    ctx.taskGroupStore.updateGroup(group.id, { notes: `${prefix}Wait for approval.` });
    expect(await read({})).toMatchObject({ id: task.id, notes: `${prefix}Use the blue sample.`, checklistItems: [] });
    for (const [source, oldTail, newTail] of [["task", "Use the blue sample.", "Use the gold sample."], ["group", "Wait for approval.", "Wait for sign-off."]] as const) {
      const first = await read({ notesSource: source });
      const brief = buildBridgeContextSections(ctx, ctx.taskStore.getTask(task.id), {
        groupName: group.name, notes: ctx.taskGroupStore.getGroup(group.id)!.notes,
      }).find((section) => section.name === "task_notes");
      expect(brief?.content).toContain(`revision ${first.revision}, notesSource: "${source}"`);
      // Notes with leading space still continue exactly where the excerpt stopped.
      const shownTo = Number(/nextOffset: (\d+)/.exec(brief!.content)![1]);
      expect(brief?.content).toContain(`${prefix.slice(3, shownTo).trim()}…`);
      expect((await read({ notesSource: source, offset: shownTo, revision: first.revision })).text.startsWith(prefix.slice(shownTo, shownTo + 40))).toBe(true);
      expect(first).toMatchObject({ taskId: task.id, notesSource: source, nextOffset: first.text.length });
      expect(first).not.toHaveProperty("checklistItems");
      expect(first).not.toHaveProperty("notes");
      expect(first.text).not.toContain(oldTail);
      expect(first.text).not.toMatch(/[\ud800-\udbff]$/u);
      const last = await read({ notesSource: source, offset: first.nextOffset, revision: first.revision });
      expect(last).toMatchObject({ revision: first.revision, nextOffset: null });
      expect(first.text + last.text).toBe(prefix + oldTail);

      if (source === "task") ctx.taskStore.updateTask(task.id, { notes: prefix + newTail });
      else ctx.taskGroupStore.updateGroup(group.id, { notes: prefix + newTail });
      // Continuing across someone's edit is refused, so a reader can't stitch two versions together.
      expect(await read({ notesSource: source, offset: first.nextOffset, revision: first.revision })).toMatchObject({ resultType: "failure" });
      expect(await read({ notesSource: source, offset: 999_999, revision: (await read({ notesSource: source })).revision })).toMatchObject({ resultType: "failure" });
      const edited = await read({ notesSource: source });
      expect(edited.revision).not.toBe(first.revision);
      expect(edited.text + (await read({ notesSource: source, offset: edited.nextOffset, revision: edited.revision })).text).toContain(newTail);
    }
    ctx.taskStore.updateTask(task.id, { groupId: null });
    expect(await read({ notesSource: "group" })).toMatchObject({ groupId: null, text: "", nextOffset: null });
    expect(await read({ offset: 1 })).toMatchObject({ resultType: "failure" });
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
    ctx.taskStore.updateTask(task.id, { doneWhen: "Merged and deployed" });
    ctx.taskStore.updateTask(task.id, { completionAction: "complete-and-archive" });
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

  it("task_update changes priority and group", async () => {
    const { ctx } = createTestApp();
    const priorityTask = ctx.taskStore.createTask("Priority update");
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
      taskId: groupedTask.id,
      groupId: null,
    }, createInvocation("task_update"))).resolves.toMatchObject({ success: true });
    expect(ctx.taskStore.getTask(groupedTask.id)?.groupId).toBeUndefined();
  });

  it("task_update rejects task lifecycle fields that are reserved for the UI", async () => {
    const { ctx } = createTestApp();
    const statusTask = ctx.taskStore.createTask("Status archive guard");
    const completionTask = ctx.taskStore.createTask("Completion archive guard");
    const tool = getTool(ctx, "task_update");

    await expect(tool.handler({
      taskId: statusTask.id,
      status: "archived",
    }, createInvocation("task_update"))).resolves.toEqual(
      toolFailure("Task completion and archival are controlled by the UI."),
    );
    await expect(tool.handler({
      taskId: completionTask.id,
      completionAction: "complete-and-archive",
    }, createInvocation("task_update"))).resolves.toEqual(
      toolFailure("Task completion and archival are controlled by the UI."),
    );

    expect(ctx.taskStore.getTask(statusTask.id)?.status).toBe("active");
    expect(ctx.taskStore.getTask(completionTask.id)?.status).toBe("active");
  });

  it("task_update rejects invalid priorities and group references", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Invalid update");
    const tool = getTool(ctx, "task_update");
    const createTool = getTool(ctx, "task_create");

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

  it("task_update_momentum defers with keep, reports no-ops, and resumes without losing context", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Visibility only");
    ctx.taskStore.updateTask(task.id, { waitingOn: "A reply", nextTouchAt: "2030-01-01T00:00:00Z" });
    const tool = getTool(ctx, "task_update_momentum");
    const input = { taskId: task.id, deferred: true, followUp: { mode: "keep" } };
    await expect(tool.handler(input, createInvocation(tool.name))).resolves.toMatchObject({
      success: true, deferred: true, waitingOn: "A reply", nextTouchAt: "2030-01-01T00:00:00.000Z",
    });
    await expect(tool.handler(input, createInvocation(tool.name))).resolves.toMatchObject({ success: true, changed: false, deferred: true });
    expect(ctx.taskStore.getTask(task.id)).toMatchObject({ deferred: true, status: "active", muted: false });
    await expect(getTool(ctx, "task_list").handler({}, createInvocation("task_list"))).resolves.toMatchObject({
      tasks: [expect.objectContaining({ id: task.id, deferred: true })],
    });
    await expect(tool.handler({ taskId: task.id, deferred: false, followUp: { mode: "clear" } }, createInvocation(tool.name)))
      .resolves.toMatchObject({ success: true, deferred: false, waitingOn: "A reply", nextTouchAt: null });
  });

  it("task_update_momentum and task_update record agent attribution with the session's schedule", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Attributed");
    ctx.sessionMetaStore.setScheduleMeta("session-1", "sched-1", "Daily rental search");

    await getTool(ctx, "task_update_momentum").handler({
      taskId: task.id,
      nextAction: "Verify the listing",
      followUp: { mode: "keep" },
    }, createInvocation("task_update_momentum"));
    await getTool(ctx, "task_update").handler({ taskId: task.id, doneWhen: "Lease signed" }, { ...createInvocation("task_update"), sessionId: "session-2" });

    const [doneWhenEvent, momentumEvent] = ctx.taskStore.listMomentumEvents(task.id);
    expect(momentumEvent).toMatchObject({
      source: "agent", sessionId: "session-1", scheduleId: "sched-1", scheduleName: "Daily rental search",
      changes: [{ field: "nextAction", before: null, after: "Verify the listing" }],
    });
    expect(doneWhenEvent).toMatchObject({ source: "agent", sessionId: "session-2", changes: [{ field: "doneWhen", after: "Lease signed" }] });
    expect(doneWhenEvent.scheduleName).toBeUndefined();
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

    const stored = { nextAction: "Check the release dashboard", waitingOn: "Customer validation", nextTouchAt: "2026-05-02T10:00:00.000Z" };
    await expect(tool.handler({
      taskId: task.id, nextAction: stored.nextAction, waitingOn: stored.waitingOn,
      followUp: { mode: "set", nextTouchAt: "2026-05-02T03:00:00-07:00" },
    }, createInvocation("task_update_momentum"))).resolves.toMatchObject({
      success: true, changed: false, message: "Task momentum is already current; no changes were applied.", ...stored,
    });
    expect(ctx.taskStore.getTask(task.id)).toMatchObject(stored);

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

    await expect(tool.handler({ taskId: task.id, nextAction: null, waitingOn: null, followUp: { mode: "clear" } },
      createInvocation("task_update_momentum"))).resolves.toMatchObject({
      success: true, changed: false, nextAction: null, waitingOn: null, nextTouchAt: null,
    });
  });

  it("task_history_add records attributed entries that task_history_list pages and searches", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("History tools");
    ctx.sessionMetaStore.setScheduleMeta("session-1", "sched-1", "Daily rental search");
    const add = getTool(ctx, "task_history_add");
    const list = getTool(ctx, "task_history_list");

    const first = await add.handler({ taskId: task.id, text: "Toured 2040 Main" }, createInvocation("task_history_add"));
    expect(first).toMatchObject({ success: true, id: expect.any(Number) });
    await add.handler({ taskId: task.id, text: "Applied for 2040 Main" }, { ...createInvocation("task_history_add"), sessionId: "session-2" });
    expect(await add.handler({ taskId: task.id, text: "  " }, createInvocation("task_history_add"))).toEqual(toolFailure("text must not be empty"));
    expect(await add.handler({ taskId: "missing", text: "x" }, createInvocation("task_history_add"))).toMatchObject({ resultType: "failure" });

    const all = await list.handler({ taskId: task.id }, createInvocation("task_history_list"));
    expect(all.total).toBe(2);
    expect(all.entries).toEqual([
      expect.objectContaining({ text: "Applied for 2040 Main", source: "agent", sessionId: "session-2" }),
      expect.objectContaining({ text: "Toured 2040 Main", sessionId: "session-1", scheduleId: "sched-1", scheduleName: "Daily rental search" }),
    ]);
    expect(all.entries[0].scheduleId).toBeUndefined();
    expect((await list.handler({ taskId: task.id, query: "toured" }, createInvocation("task_history_list"))).entries).toHaveLength(1);
    expect((await list.handler({ taskId: task.id, before: all.entries[0].id }, createInvocation("task_history_list"))).entries)
      .toEqual([expect.objectContaining({ text: "Toured 2040 Main" })]);
    expect(await list.handler({ taskId: task.id, limit: 0 }, createInvocation("task_history_list"))).toMatchObject({ resultType: "failure" });

    const info = await getTool(ctx, "task_get_info").handler({ taskId: task.id }, createInvocation("task_get_info"));
    expect(info.historyCount).toBe(2);
    expect(info).not.toHaveProperty("recentHistory");
  });

  it("task_update saves an agent's change to the instructions and rebuilds the task's chats", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Instruction tools");
    const invalidate = vi.spyOn(ctx.sessionManager, "invalidateTaskSessionConfig");
    const update = getTool(ctx, "task_update");

    await update.handler({ taskId: task.id, instructions: "Ask before emailing anyone." }, createInvocation("task_update"));
    expect(ctx.taskStore.getTask(task.id)?.instructions).toBe("Ask before emailing anyone.");
    expect(invalidate).toHaveBeenCalledWith(task.id, "task instructions changed");

    invalidate.mockClear();
    await update.handler({ taskId: task.id, notes: "Just state" }, createInvocation("task_update"));
    expect(invalidate).not.toHaveBeenCalled();
    await update.handler({ taskId: task.id, instructions: "" }, createInvocation("task_update"));
    expect(ctx.taskStore.getTask(task.id)?.instructions).toBe("");
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(ctx.taskHistoryStore!.countEntries(task.id)).toBe(0);
  });

  it("task_get_info reports momentum and the newest linked sessions as the task grows", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Short session info");
    ctx.taskStore.updateTask(task.id, {
      doneWhen: "QA signs off",
      nextAction: "Message QA",
      waitingOn: "QA sign-off",
      nextTouchAt: "2026-05-03T11:00:00.000Z",
    });
    const sessionIds = Array.from({ length: 12 }, (_unused, i) => `session-${String(i + 1).padStart(2, "0")}`);
    const firstTwo = sessionIds.slice(0, 2);
    for (const sessionId of firstTwo) ctx.taskStore.linkSession(task.id, sessionId);

    const tool = getTool(ctx, "task_get_info");
    const result = await tool.handler({ taskId: task.id }, createInvocation("task_get_info"));

    expect(result).toEqual(expect.objectContaining({
      id: task.id,
      doneWhen: "QA signs off",
      nextAction: "Message QA",
      waitingOn: "QA sign-off",
      nextTouchAt: "2026-05-03T11:00:00.000Z",
      sessionIds: firstTwo,
      sessionCount: 2,
      omittedSessionCount: 0,
    }));

    for (const sessionId of sessionIds.slice(2)) ctx.taskStore.linkSession(task.id, sessionId);
    const expanded = await tool.handler({ taskId: task.id }, createInvocation("task_get_info"));
    expect(expanded).toMatchObject({ id: task.id, sessionIds: sessionIds.slice(2), sessionCount: 12, omittedSessionCount: 2 });
  });

  it("task_update_momentum rejects invalid follow-up inputs", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Momentum invalid");
    const tool = getTool(ctx, "task_update_momentum");

    const before = ctx.taskStore.getTask(task.id);
    for (const args of [
      { followUp: { mode: "keep" } },
      { followUp: { mode: "set" } },
      { followUp: { mode: "clear", nextTouchAt: "2026-05-02T10:00:00.000Z" } },
      { nextAction: "Do not persist", followUp: { mode: "keep", nextTouchAt: "2026-05-02T10:00:00.000Z" } },
    ]) {
      await expect(tool.handler({
        taskId: task.id,
        ...args,
      }, createInvocation("task_update_momentum"))).resolves.toMatchObject({
        resultType: "failure",
        textResultForLlm: expect.stringContaining("Invalid arguments for task_update_momentum:"),
      });
      expect(ctx.taskStore.getTask(task.id)).toEqual(before);
    }

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
    ctx.taskStore.updateTask(task.id, { completionAction: "complete-and-archive" });
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

  it("task_link_pr rejects an ADO link without a repository GUID", async () => {
    const { ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Name-only ADO PR");

    const result: any = await getTool(ctx, "task_link_pr").handler({
      taskId: task.id,
      repoName: "Widget.Service",
      prId: 8,
      provider: "ado",
    }, createInvocation("task_link_pr"));

    expect(String(result.textResultForLlm)).toContain("Pass the pull request's repository.id as repoId");
    expect(ctx.taskStore.getTask(task.id)?.pullRequests).toEqual([]);
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
