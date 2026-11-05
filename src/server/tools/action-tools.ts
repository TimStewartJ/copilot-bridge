import type { AppContext } from "../app-context.js";
import { ChecklistNotFoundError, ChecklistValidationError, type ChecklistItemUpdate } from "../checklist-store.js";
import { toolFailure } from "../tool-results.js";
import { ensureChecklistItem, ensureTask } from "./helpers.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type BridgeToolDefinition,
  type BridgeToolsMcpServer,
} from "../agent-tools-mcp/index.js";

export type ChecklistAddArgs = { taskId?: string | null; text: string; deadline?: string };

const addProperties = {
  taskId: { type: ["string", "null"], description: "Optional parent task ID." },
  text: { type: "string", description: "Concrete action text." },
  deadline: { type: "string", description: "Optional deadline in YYYY-MM-DD format." },
  key: { type: "string", description: "Stable key for this accepted commitment; reuse on retries." },
  sourceUrl: { type: "string", description: "Optional http(s) link to the source." },
};

function actionMutation<T>(run: () => T) {
  try {
    return run();
  } catch (error) {
    if (error instanceof ChecklistValidationError || error instanceof ChecklistNotFoundError) return toolFailure(error.message);
    throw error;
  }
}

export function createActionHandlers(ctx: AppContext) {
  const store = ctx.checklistStore;
  return {
    add(args: ChecklistAddArgs & { key?: string; sourceUrl?: string }) {
      if (args.taskId != null) {
        const task = ensureTask(ctx, args.taskId);
        if (!task.ok) return toolFailure(task.error);
      }
      const unknown = Object.keys(args).filter((key) => !Object.hasOwn(addProperties, key));
      if (unknown.length) return toolFailure(`Unknown field(s): ${unknown.join(", ")}`);
      return actionMutation(() => ({
        success: true,
        action: store.createChecklistItem(args.taskId ?? null, args.text, args.deadline, {
          key: args.key, sourceUrl: args.sourceUrl, actor: "agent",
        }),
      }));
    },
    list({ taskId }: { taskId?: string | null }) {
      return { actions: store.listChecklistItems(taskId ?? null) };
    },
    update({ actionId, text, done, deadline }: ChecklistItemUpdate & { actionId: string }) {
      const item = ensureChecklistItem(ctx, actionId);
      if (!item.ok) return toolFailure(item.error);
      const updates: ChecklistItemUpdate = {};
      if (text !== undefined) updates.text = text;
      if (done !== undefined) updates.done = done;
      if (deadline !== undefined) updates.deadline = deadline;
      if (Object.keys(updates).length === 0) return toolFailure("Provide at least one of: text, done, deadline");
      return actionMutation(() => ({ success: true, action: store.updateChecklistItem(actionId, updates, "agent") }));
    },
    remove({ actionId }: { actionId: string }) {
      return actionMutation(() => {
        store.deleteChecklistItem(actionId);
        return { success: true };
      });
    },
  };
}

export function createActionToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  const actions = createActionHandlers(ctx);
  return [
    defineBridgeTool("action_add", {
      description: "Add an existing task or global checklist item only for accepted executable work, not suggestions, questions, narration or routine reports. Chat by default. Optional stable key dedupes retries; sourceUrl links evidence. Home shows this same checklist item, not a second work record.",
      parameters: { type: "object", properties: addProperties, required: ["text"] },
      handler: actions.add,
    }),
    defineBridgeTool("action_list", {
      description: "List first-class Actions for a task, or global Actions when taskId is omitted.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: ["string", "null"], description: "Optional parent task ID." },
        },
      },
      handler: actions.list,
    }),
    defineBridgeTool("action_update", {
      description: "Update an existing checklist item. Set done only after its executable work is actually complete. This never completes its task or an external condition automatically.",
      parameters: {
        type: "object",
        properties: {
          actionId: { type: "string", description: "Action ID." },
          text: { type: "string", description: "New action text." },
          done: { type: "boolean", description: "Whether the action is complete." },
          deadline: { type: ["string", "null"], description: "Deadline or null to clear." },
        },
        required: ["actionId"],
      },
      handler: actions.update,
    }),
    defineBridgeTool("action_remove", {
      description: "Delete a first-class Action.",
      parameters: {
        type: "object",
        properties: {
          actionId: { type: "string", description: "Action ID." },
        },
        required: ["actionId"],
      },
      handler: actions.remove,
    }),
  ];
}

export function registerActionTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: { hiddenTools?: ReadonlySet<string> } = {},
): void {
  registerBridgeToolDefinitions(
    server,
    createActionToolDefinitions(ctx).filter((tool) => !options.hiddenTools?.has(tool.name)),
  );
}
