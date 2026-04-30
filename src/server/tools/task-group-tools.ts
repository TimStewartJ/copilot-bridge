import { defineTool } from "@github/copilot-sdk";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { ensureTaskGroup } from "./helpers.js";

export function createTaskGroupTools(ctx: AppContext) {
  return [
  defineTool("task_group_create", {
    description: "Create a new task group for organizing related tasks",
    parameters: { type: "object", properties: { name: { type: "string", description: "Group name (e.g., 'Frontend App', 'Backend API')" }, color: { type: "string", description: "Optional color: blue, purple, amber, rose, cyan, orange, slate" }, notes: { type: "string", description: "Optional markdown notes for the group" } }, required: ["name"] },
    handler: async (args: any) => {
      const group = ctx.taskGroupStore.createGroup(args.name, args.color);
      if (args.notes) ctx.taskGroupStore.updateGroup(group.id, { notes: args.notes });
      return { success: true, message: `Group "${group.name}" created`, groupId: group.id };
    },
  }),
  defineTool("task_group_list", {
    description: "List all task groups with their IDs, names, and notes",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { groups: ctx.taskGroupStore.listGroups().map((g) => ({ id: g.id, name: g.name, color: g.color, notes: g.notes || undefined })) };
    },
  }),
  defineTool("task_group_delete", {
    description: "Delete a task group. Tasks in the group become ungrouped.",
    parameters: { type: "object", properties: { groupId: { type: "string", description: "The group ID to delete" } }, required: ["groupId"] },
    handler: async (args: any) => {
      const tasks = ctx.taskStore.listTasks().filter((t) => t.groupId === args.groupId);
      for (const t of tasks) ctx.taskStore.updateTask(t.id, { groupId: undefined });
      ctx.tagStore?.setEntityTags("task_group", args.groupId, []);
      ctx.taskGroupStore.deleteGroup(args.groupId);
      return { success: true, message: `Group deleted, ${tasks.length} task(s) ungrouped` };
    },
  }),
  defineTool("task_group_update", {
    description: "Update a task group's name, color, and/or notes. Only provided fields are changed.",
    parameters: { type: "object", properties: { groupId: { type: "string", description: "The group ID to update" }, name: { type: "string", description: "New group name" }, color: { type: "string", description: "New color: blue, purple, amber, rose, cyan, orange, slate" }, notes: { type: "string", description: "New notes content (markdown). Overwrites existing notes." } }, required: ["groupId"] },
    handler: async (args: any) => {
      const group = ensureTaskGroup(ctx, args.groupId);
      if (!group.ok) return toolFailure(group.error);
      const updates: any = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.color !== undefined) updates.color = args.color;
      if (args.notes !== undefined) updates.notes = args.notes;
      const updatedGroup = ctx.taskGroupStore.updateGroup(args.groupId, updates);
      return { success: true, message: `Group "${updatedGroup.name}" updated`, groupId: updatedGroup.id };
    },
  }),
  ];
}
