import { defineTool } from "@github/copilot-sdk";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { ensureChecklistItem, ensureTask } from "./helpers.js";

export function createChecklistTools(ctx: AppContext) {
  return [
  defineTool("checklist_add", {
    description: "Add a checklist item to a task's checklist, or create a global checklist item if no taskId is provided",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID. Omit to create a global (unparented) checklist item." }, text: { type: "string", description: "The checklist item text" }, deadline: { type: "string", description: "Optional deadline date in YYYY-MM-DD format" } }, required: ["text"] },
    handler: async (args: any) => {
      if (args.taskId !== undefined && args.taskId !== null) {
        const task = ensureTask(ctx, args.taskId);
        if (!task.ok) return toolFailure(task.error);
      }
      const checklistItem = ctx.checklistStore.createChecklistItem(args.taskId ?? null, args.text, args.deadline);
      return {
        success: true,
        message: `Checklist item added: "${checklistItem.text}"${checklistItem.deadline ? ` (due ${checklistItem.deadline})` : ""}`,
        checklistItemId: checklistItem.id,
      };
    },
  }),
  defineTool("checklist_list", {
    description: "List all checklist items for a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" } }, required: ["taskId"] },
    handler: async (args: any) => {
      const checklistItems = ctx.checklistStore.listChecklistItems(args.taskId);
      const today = new Date().toISOString().slice(0, 10);
      return {
        checklistItems: checklistItems.map((t) => ({ id: t.id, text: t.text, done: t.done, deadline: t.deadline ?? null, isOverdue: !t.done && !!t.deadline && t.deadline < today })),
        total: checklistItems.length,
        done: checklistItems.filter((t) => t.done).length,
      };
    },
  }),
  defineTool("checklist_update", {
    description: "Update a checklist item's text, done status, or deadline",
    parameters: { type: "object", properties: { checklistItemId: { type: "string", description: "The checklist item ID" }, text: { type: "string", description: "New text" }, done: { type: "boolean", description: "Mark done (true) or not done (false)" }, deadline: { type: "string", description: "Deadline date in YYYY-MM-DD format, or null to clear" } }, required: ["checklistItemId"] },
    handler: async (args: any) => {
      const updates: Record<string, any> = {};
      if (args.text !== undefined) updates.text = args.text;
      if (args.done !== undefined) updates.done = args.done;
      if (args.deadline !== undefined) updates.deadline = args.deadline || undefined;
      if (Object.keys(updates).length === 0) return toolFailure("Provide at least one of: text, done, deadline");
      const checklistItem = ensureChecklistItem(ctx, args.checklistItemId);
      if (!checklistItem.ok) return toolFailure(checklistItem.error);
      const updatedChecklistItem = ctx.checklistStore.updateChecklistItem(args.checklistItemId, updates);
      return { success: true, message: `Checklist item ${args.done ? "completed" : "updated"}: "${updatedChecklistItem.text}"` };
    },
  }),
  defineTool("checklist_remove", {
    description: "Remove a checklist item from a task's checklist",
    parameters: { type: "object", properties: { checklistItemId: { type: "string", description: "The checklist item ID" } }, required: ["checklistItemId"] },
    handler: async (args: any) => {
      ctx.checklistStore.deleteChecklistItem(args.checklistItemId);
      return { success: true, message: "Checklist item removed" };
    },
  }),
  ];
}
