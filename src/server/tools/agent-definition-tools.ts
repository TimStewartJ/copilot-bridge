import type { AppContext } from "../app-context.js";
import {
  TaskAgentDefinitionAlreadyExistsError,
  TaskAgentDefinitionValidationError,
} from "../task-agent-definition-store.js";
import { bridgeToolResult, toolFailure } from "../tool-results.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type BridgeToolDefinition,
  type BridgeToolsMcpServer,
} from "../agent-tools-mcp/index.js";
import { ensureTask } from "./helpers.js";

export interface RegisterAgentDefinitionToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createAgentDefinitionToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineBridgeTool("agent_definition_create", {
      description:
        "Create a durable custom-agent definition scoped to a Bridge task. "
        + "Only use this when the user explicitly asks to persist a reusable specialist. "
        + "The agent becomes available to sessions linked to the task after the current turn refreshes.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The exact Bridge task ID that should own this agent definition.",
          },
          name: {
            type: "string",
            description: "Stable lowercase identifier using letters, numbers, and hyphens.",
          },
          displayName: {
            type: "string",
            description: "Optional human-readable display name.",
          },
          description: {
            type: "string",
            description: "What the specialist does and when another agent should call it.",
          },
          prompt: {
            type: "string",
            description: "The specialist's durable instructions. Do not copy changing task notes into this prompt.",
          },
          tools: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
            description: "Allowed tool names. Omit or pass null for all tools; pass [] for no tools.",
          },
          infer: {
            type: "boolean",
            description:
              "Allow automatic model invocation. Defaults to false; set true only when the user wants auto-delegation.",
          },
        },
        required: ["taskId", "name", "description", "prompt"],
      },
      handler: async (args: any, invocation) => {
        if (!ctx.taskAgentDefinitionStore) {
          return toolFailure("Task agent definitions are not available");
        }
        const task = ensureTask(ctx, args.taskId);
        if (!task.ok) return toolFailure(task.error);
        try {
          const definition = ctx.taskAgentDefinitionStore.createTaskAgentDefinition({
            taskId: args.taskId,
            name: args.name,
            displayName: args.displayName,
            description: args.description,
            prompt: args.prompt,
            ...("tools" in args ? { tools: args.tools } : {}),
            ...("infer" in args ? { infer: args.infer } : {}),
            createdBySessionId: invocation.sessionId,
          });
          const invalidatedSessions = ctx.sessionManager.invalidateTaskSessionConfig(
            definition.taskId,
            `task agent definition "${definition.name}" was created`,
          );
          ctx.globalBus.emit({ type: "task:changed", taskId: definition.taskId });
          return bridgeToolResult({
            success: true,
            changed: true,
            terminal: true,
            toolNextAction: "respond",
            retryable: false,
            summary:
              `Created task agent definition "${definition.name}". `
              + "It will be available after this turn when linked sessions resume with fresh configuration.",
            taskId: definition.taskId,
            agentName: definition.name,
            infer: definition.infer,
            invalidatedSessions,
          });
        } catch (error) {
          if (
            error instanceof TaskAgentDefinitionValidationError
            || error instanceof TaskAgentDefinitionAlreadyExistsError
          ) {
            return toolFailure(error.message);
          }
          throw error;
        }
      },
    }),
    defineBridgeTool("agent_definition_remove", {
      description:
        "Remove a task-scoped custom-agent definition. "
        + "Use the exact task ID and agent name shown in task_get_info or the task's injected context.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The exact Bridge task ID." },
          name: { type: "string", description: "The exact task agent definition name." },
        },
        required: ["taskId", "name"],
      },
      handler: async (args: any) => {
        if (!ctx.taskAgentDefinitionStore) {
          return toolFailure("Task agent definitions are not available");
        }
        const task = ensureTask(ctx, args.taskId);
        if (!task.ok) return toolFailure(task.error);
        try {
          const removed = ctx.taskAgentDefinitionStore.removeTaskAgentDefinition(args.taskId, args.name);
          if (!removed) {
            return toolFailure(`Agent definition "${args.name}" is not associated with task ${args.taskId}`);
          }
          const invalidatedSessions = ctx.sessionManager.invalidateTaskSessionConfig(
            args.taskId,
            `task agent definition "${args.name}" was removed`,
          );
          ctx.globalBus.emit({ type: "task:changed", taskId: args.taskId });
          return bridgeToolResult({
            success: true,
            changed: true,
            terminal: true,
            toolNextAction: "respond",
            retryable: false,
            summary:
              `Removed task agent definition "${args.name}". `
              + "Linked sessions will drop it after their current turn completes.",
            taskId: args.taskId,
            agentName: args.name,
            invalidatedSessions,
          });
        } catch (error) {
          if (error instanceof TaskAgentDefinitionValidationError) {
            return toolFailure(error.message);
          }
          throw error;
        }
      },
    }),
  ];
}

export function registerAgentDefinitionTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterAgentDefinitionToolsOptions = {},
): void {
  const definitions = createAgentDefinitionToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
