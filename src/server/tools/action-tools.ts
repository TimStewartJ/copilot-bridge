import type { AppContext } from "../app-context.js";
import { ChecklistNotFoundError, ChecklistValidationError } from "../checklist-store.js";
import { toolFailure } from "../tool-results.js";
import { ensureChecklistItem, ensureTask } from "./helpers.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type BridgeToolDefinition,
  type BridgeToolsMcpServer,
} from "../agent-tools-mcp/index.js";

function actionToolFailure(error: unknown) {
  if (error instanceof ChecklistValidationError || error instanceof ChecklistNotFoundError) {
    return toolFailure(error.message);
  }
  throw error;
}

export function createActionToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineBridgeTool("action_add", {
      description: "Create an Action only for accepted executable work: a concrete commitment, not a suggestion, alert, question, narration or routine report. Chat by default. Optional stable key dedupes retries; sourceUrl links evidence. To accept work from a Decision, Alert or Event, prefer its *_promote tool so the source is handed off, not resolved.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: ["string", "null"], description: "Optional parent task ID." },
          text: { type: "string", description: "Concrete action text." },
          deadline: { type: "string", description: "Optional deadline in YYYY-MM-DD format." },
          key: { type: "string", description: "Stable key for this accepted commitment; reuse on retries." },
          sourceUrl: { type: "string", description: "Optional http(s) link to the source." },
        },
        required: ["text"],
      },
      handler: async (args: any) => {
        if (args.taskId !== undefined && args.taskId !== null) {
          const task = ensureTask(ctx, args.taskId);
          if (!task.ok) return toolFailure(task.error);
        }
        try {
          const unknown = Object.keys(args).filter((key) => !["taskId", "text", "deadline", "key", "sourceUrl"].includes(key));
          if (unknown.length) return toolFailure(`Unknown field(s): ${unknown.join(", ")}`);
          const action = ctx.checklistStore.createChecklistItem(args.taskId ?? null, args.text, args.deadline, {
            key: args.key, sourceUrl: args.sourceUrl, actor: "agent",
          });
          return { success: true, action };
        } catch (error) {
          return actionToolFailure(error);
        }
      },
    }),
    defineBridgeTool("action_list", {
      description: "List first-class Actions for a task, or global Actions when taskId is omitted.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: ["string", "null"], description: "Optional parent task ID." },
        },
      },
      handler: async (args: any) => ({
        actions: ctx.checklistStore.listChecklistItems(args.taskId ?? null),
      }),
    }),
    defineBridgeTool("action_update", {
      description: "Update accepted Action work. Set done only after its executable work is actually complete. Completing an Action never resolves a linked Decision or Alert; explicitly record the source's verified outcome separately.",
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
      handler: async (args: any) => {
        const existing = ensureChecklistItem(ctx, args.actionId);
        if (!existing.ok) return toolFailure(existing.error);
        const updates: Record<string, unknown> = {};
        if (args.text !== undefined) updates.text = args.text;
        if (args.done !== undefined) updates.done = args.done;
        if (args.deadline !== undefined) updates.deadline = args.deadline;
        if (Object.keys(updates).length === 0) {
          return toolFailure("Provide at least one of: text, done, deadline");
        }
        try {
          return {
            success: true,
            action: ctx.checklistStore.updateChecklistItem(args.actionId, updates, "agent"),
          };
        } catch (error) {
          return actionToolFailure(error);
        }
      },
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
      handler: async (args: any) => {
        const existing = ensureChecklistItem(ctx, args.actionId);
        if (!existing.ok) return toolFailure(existing.error);
        try {
          ctx.checklistStore.deleteChecklistItem(args.actionId);
          return { success: true };
        } catch (error) {
          return actionToolFailure(error);
        }
      },
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
