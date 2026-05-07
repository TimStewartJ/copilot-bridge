import { defineTool } from "@github/copilot-sdk";
import { InvalidTaskUpdateError } from "../task-store.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import type { TagStore } from "../tag-store.js";
import { ensureTagStore, ensureTask } from "./helpers.js";

function hasOwn(args: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function normalizeFollowUpMode(value: unknown): "set" | "keep" | "clear" | undefined {
  return value === "set" || value === "keep" || value === "clear" ? value : undefined;
}

export function createTaskTools(ctx: AppContext) {
  return [
  defineTool("task_link_work_item", {
    description: "Link a work item to a task by its ID",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "string", description: "The work item ID" }, provider: { type: "string", enum: ["ado", "github", "linear"], description: "The provider (ado or github). Defaults to ado." } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      const task = ensureTask(ctx, args.taskId);
      if (!task.ok) return toolFailure(task.error);
      ctx.taskStore.linkWorkItem(args.taskId, String(args.workItemId), args.provider ?? "ado");
      return { success: true, message: `Work item ${args.workItemId} (${args.provider ?? "ado"}) linked to task` };
    },
  }),
  defineTool("task_unlink_work_item", {
    description: "Remove a work item from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "string", description: "The work item ID" }, provider: { type: "string", enum: ["ado", "github", "linear"], description: "The provider (ado or github)" } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      const task = ensureTask(ctx, args.taskId);
      if (!task.ok) return toolFailure(task.error);
      ctx.taskStore.unlinkWorkItem(args.taskId, String(args.workItemId), args.provider);
      return { success: true, message: `Work item ${args.workItemId} unlinked from task` };
    },
  }),
  defineTool("task_link_pr", {
    description: "Link a pull request to a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" }, provider: { type: "string", enum: ["ado", "github", "linear"], description: "The provider (ado or github). Defaults to ado." } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      const task = ensureTask(ctx, args.taskId);
      if (!task.ok) return toolFailure(task.error);
      ctx.taskStore.linkPR(args.taskId, { repoId: args.repoName, repoName: args.repoName, prId: args.prId, provider: args.provider ?? "ado" });
      return { success: true, message: `PR #${args.prId} from ${args.repoName} linked to task` };
    },
  }),
  defineTool("task_unlink_pr", {
    description: "Remove a pull request from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" }, provider: { type: "string", enum: ["ado", "github", "linear"], description: "The provider (ado or github)" } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      const task = ensureTask(ctx, args.taskId);
      if (!task.ok) return toolFailure(task.error);
      ctx.taskStore.unlinkPR(args.taskId, args.repoName, args.prId, args.provider);
      return { success: true, message: `PR #${args.prId} from ${args.repoName} unlinked from task` };
    },
  }),
  defineTool("task_update", {
    description: "Update a task's title, kind, notes, working directory, group, and/or tags. Only provided fields are changed.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID" },
        title: { type: "string", description: "New title" },
        kind: { type: "string", enum: ["task", "ongoing"], description: "Task kind" },
        notes: { type: "string", description: "New notes content (markdown). Overwrites existing notes." },
        cwd: { type: "string", description: "Working directory path for the task" },
        groupId: { type: "string", description: "Task group ID to assign to (use empty string to ungroup)" },
        doneWhen: { anyOf: [{ type: "string" }, { type: "null" }], description: "Definition of done for this task. Null clears it." },
        tags: { type: "array", items: { type: "string" }, description: "Tag names to set on this task. Creates tags if they don't exist." },
      },
      required: ["taskId"],
    },
    handler: async (args: any) => {
      const updates: Record<string, unknown> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.kind !== undefined) updates.kind = args.kind;
      if (args.notes !== undefined) updates.notes = args.notes;
      if (args.cwd !== undefined) updates.cwd = args.cwd;
      if (args.groupId !== undefined) updates.groupId = args.groupId || "";
      if (args.doneWhen !== undefined) updates.doneWhen = args.doneWhen;
      const hasTags = Array.isArray(args.tags);
      if (Object.keys(updates).length === 0 && !hasTags) return toolFailure("No fields to update. Provide at least one of: title, kind, notes, cwd, groupId, doneWhen, tags");
      const task = ensureTask(ctx, args.taskId);
      if (!task.ok) return toolFailure(task.error);
      let tagStore: TagStore | undefined;
      if (hasTags) {
        const tagStoreResult = ensureTagStore(ctx);
        if (!tagStoreResult.ok) return toolFailure(tagStoreResult.error);
        tagStore = tagStoreResult.value;
      }
      let updatedTask = task.value;
      if (Object.keys(updates).length > 0) {
        try {
          updatedTask = ctx.taskStore.updateTask(args.taskId, updates as any);
        } catch (error) {
          if (error instanceof InvalidTaskUpdateError) return toolFailure(error.message);
          throw error;
        }
      }
      if (hasTags && tagStore) {
        const tagIds = args.tags.map((name: string) => {
          const existing = tagStore.getTagByName(name);
          if (existing) return existing.id;
          return tagStore.createTag(name).id;
        });
        tagStore.setEntityTags("task", args.taskId, tagIds);
      }
      const fields = [...Object.keys(updates), ...(hasTags ? ["tags"] : [])].join(", ");
      return { success: true, message: `Task updated (${fields})`, kind: updatedTask.kind };
    },
  }),
  defineTool("task_update_momentum", {
    description: "Update a task's momentum: next action, waiting on, and follow-up. Always provide an explicit followUp decision so stale follow-up dates are not left behind.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID" },
        nextAction: { anyOf: [{ type: "string" }, { type: "null" }], description: "The next concrete action for this task. Null clears it." },
        waitingOn: { anyOf: [{ type: "string" }, { type: "null" }], description: "What this task is waiting on. Null clears it." },
        followUp: {
          type: "object",
          description: "Explicit follow-up decision. Use set to set nextTouchAt, keep to preserve it while changing nextAction or waitingOn, or clear to clear it.",
          properties: {
            mode: { type: "string", enum: ["set", "keep", "clear"], description: "Follow-up decision for nextTouchAt" },
            nextTouchAt: { type: "string", description: "ISO timestamp with timezone. Required when mode is set." },
          },
          required: ["mode"],
        },
      },
      required: ["taskId", "followUp"],
    },
    handler: async (args: any) => {
      const followUp = args.followUp;
      if (!followUp || typeof followUp !== "object" || Array.isArray(followUp)) {
        return toolFailure("followUp is required and must include mode: set, keep, or clear");
      }

      const mode = normalizeFollowUpMode(followUp.mode);
      if (!mode) return toolFailure("followUp.mode must be one of: set, keep, clear");

      const hasNextActionUpdate = hasOwn(args, "nextAction");
      const hasWaitingOnUpdate = hasOwn(args, "waitingOn");
      const hasNextTouchAtInput = hasOwn(followUp, "nextTouchAt");
      if (mode === "keep" && !hasNextActionUpdate && !hasWaitingOnUpdate) {
        return toolFailure("followUp.mode 'keep' must be paired with nextAction or waitingOn. Use mode 'set' or 'clear' to update only the follow-up date.");
      }
      if (mode === "set" && !hasNextTouchAtInput) {
        return toolFailure("followUp.nextTouchAt is required when followUp.mode is 'set'");
      }
      if (mode !== "set" && hasNextTouchAtInput) {
        return toolFailure("followUp.nextTouchAt is only allowed when followUp.mode is 'set'");
      }

      const task = ensureTask(ctx, args.taskId);
      if (!task.ok) return toolFailure(task.error);
      if (task.value.status !== "active") {
        return toolFailure("task_update_momentum can only be used on active tasks");
      }

      const updates: Record<string, unknown> = {};
      if (hasNextActionUpdate) updates.nextAction = args.nextAction;
      if (hasWaitingOnUpdate) updates.waitingOn = args.waitingOn;
      if (mode === "set") updates.nextTouchAt = followUp.nextTouchAt;
      if (mode === "clear") updates.nextTouchAt = null;

      let updatedTask = task.value;
      try {
        updatedTask = ctx.taskStore.updateTask(args.taskId, updates as any);
      } catch (error) {
        if (error instanceof InvalidTaskUpdateError) return toolFailure(error.message);
        throw error;
      }

      const fields = [
        ...(hasNextActionUpdate ? ["nextAction"] : []),
        ...(hasWaitingOnUpdate ? ["waitingOn"] : []),
        ...(mode === "set" || mode === "clear" ? ["nextTouchAt"] : ["nextTouchAt kept"]),
      ].join(", ");
      return {
        success: true,
        message: `Task momentum updated (${fields})`,
        nextAction: updatedTask.nextAction ?? null,
        waitingOn: updatedTask.waitingOn ?? null,
        nextTouchAt: updatedTask.nextTouchAt ?? null,
        kind: updatedTask.kind,
      };
    },
  }),
  defineTool("task_get_info", {
    description: "Get task details including title, kind, status, linked work items, PRs, and notes",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" } }, required: ["taskId"] },
    handler: async (args: any) => {
      const task = ensureTask(ctx, args.taskId);
      if (!task.ok) return toolFailure(task.error);
      const checklistItems = ctx.checklistStore.listChecklistItems(args.taskId);
      return {
        ...task.value,
        checklistItems: checklistItems.map((t) => ({ id: t.id, text: t.text, done: t.done, deadline: t.deadline ?? null })),
      };
    },
  }),
  defineTool("task_list", {
    description: "List all tasks with their IDs, titles, kinds, statuses, and group IDs",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { tasks: ctx.taskStore.listTasks().map((t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status, groupId: t.groupId })) };
    },
  }),
  defineTool("task_create", {
    description: "Create a new task",
    parameters: { type: "object", properties: { title: { type: "string", description: "The task title" }, kind: { type: "string", enum: ["task", "ongoing"], description: "Task kind. Defaults to task." }, tags: { type: "array", items: { type: "string" }, description: "Tag names to set on this task. Creates tags if they don't exist." }, groupId: { type: "string", description: "Optional task group ID to create the task in" } }, required: ["title"] },
    handler: async (args: any) => {
      let tagStore: TagStore | undefined;
      if (Array.isArray(args.tags) && args.tags.length > 0) {
        const tagStoreResult = ensureTagStore(ctx);
        if (!tagStoreResult.ok) return toolFailure(tagStoreResult.error);
        tagStore = tagStoreResult.value;
      }
      let task;
      try {
        task = ctx.taskStore.createTask(args.title, args.groupId, args.kind);
      } catch (error) {
        if (error instanceof InvalidTaskUpdateError) return toolFailure(error.message);
        throw error;
      }
      if (Array.isArray(args.tags) && args.tags.length > 0 && tagStore) {
        const tagIds = args.tags.map((name: string) => {
          const existing = tagStore.getTagByName(name);
          if (existing) return existing.id;
          return tagStore.createTag(name).id;
        });
        tagStore.setEntityTags("task", task.id, tagIds);
      }
      return { success: true, message: `Task "${task.title}" created`, taskId: task.id, kind: task.kind };
    },
  }),
  ];
}
