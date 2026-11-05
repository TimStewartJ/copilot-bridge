import type { AppContext } from "../app-context.js";
import type { ChecklistItemUpdate } from "../checklist-store.js";
import { createActionHandlers, type ChecklistAddArgs } from "./action-tools.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type BridgeToolDefinition,
  type BridgeToolsMcpServer,
} from "../agent-tools-mcp/index.js";

export interface RegisterChecklistToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createChecklistToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  const actions = createActionHandlers(ctx);
  return [
  defineBridgeTool("checklist_add", {
    description: "Compatibility alias for action_add. Prefer action_add for new work.",
    parameters: { type: "object", properties: { taskId: { type: ["string", "null"], description: "The task ID. Omit to create a global (unparented) checklist item." }, text: { type: "string", description: "The checklist item text" }, deadline: { type: "string", description: "Optional deadline date in YYYY-MM-DD format" } }, required: ["text"] },
    handler: ({ taskId, text, deadline }: ChecklistAddArgs) => {
      const result = actions.add({ taskId, text, deadline });
      if (!("action" in result)) return result;
      const item = result.action;
      return { success: true, message: `Checklist item added: "${item.text}"${item.deadline ? ` (due ${item.deadline})` : ""}`, checklistItemId: item.id };
    },
  }),
  defineBridgeTool("checklist_list", {
    description: "Compatibility alias for action_list. Prefer action_list for new work.",
    parameters: { type: "object", properties: { taskId: { type: ["string", "null"], description: "The task ID. Omit or pass null to list global checklist items." } } },
    handler: (args: { taskId?: string | null }) => {
      const { actions: checklistItems } = actions.list(args);
      const today = new Date().toISOString().slice(0, 10);
      return {
        checklistItems: checklistItems.map((t) => ({ id: t.id, text: t.text, done: t.done, deadline: t.deadline ?? null, isOverdue: !t.done && !!t.deadline && t.deadline < today })),
        total: checklistItems.length,
        done: checklistItems.filter((t) => t.done).length,
      };
    },
  }),
  defineBridgeTool("checklist_update", {
    description: "Compatibility alias for action_update. Prefer action_update for new work.",
    parameters: { type: "object", properties: { checklistItemId: { type: "string", description: "The checklist item ID" }, text: { type: "string", description: "New text" }, done: { type: "boolean", description: "Mark done (true) or not done (false)" }, deadline: { type: ["string", "null"], description: "Deadline date in YYYY-MM-DD format, or null to clear" } }, required: ["checklistItemId"] },
    handler: ({ checklistItemId, text, done, deadline }: ChecklistItemUpdate & { checklistItemId: string }) => {
      const result = actions.update({ actionId: checklistItemId, text, done, deadline });
      return "action" in result
        ? { success: true, message: `Checklist item ${done ? "completed" : "updated"}: "${result.action.text}"` }
        : result;
    },
  }),
  defineBridgeTool("checklist_remove", {
    description: "Compatibility alias for action_remove. Prefer action_remove for new work.",
    parameters: { type: "object", properties: { checklistItemId: { type: "string", description: "The checklist item ID" } }, required: ["checklistItemId"] },
    handler: ({ checklistItemId }: { checklistItemId: string }) => {
      const result = actions.remove({ actionId: checklistItemId });
      return "success" in result ? { success: true, message: "Checklist item removed" } : result;
    },
  }),
  ];
}

export function registerChecklistTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterChecklistToolsOptions = {},
): void {
  const definitions = createChecklistToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
