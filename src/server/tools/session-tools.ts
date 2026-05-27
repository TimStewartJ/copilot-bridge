import { normalizeSessionTitle } from "../session-title-utils.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";

export interface RegisterSessionToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createSessionToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineBridgeTool("session_rename", {
    scope: "session",
    description: "Rename a chat session. Use this to give a session a more descriptive title.",
    parameters: { type: "object", properties: { sessionId: { type: "string", description: "The session ID to rename" }, title: { type: "string", description: "The new title (3-6 words recommended)" } }, required: ["title"] },
    handler: async (args: any, invocation: any) => {
      const sessionId = normalizeSessionTitle(args.sessionId) || invocation.sessionId;
      const title = normalizeSessionTitle(args.title);

      if (!sessionId) return toolFailure("sessionId is required");
      if (!title) return toolFailure("Title is required");
      if (title.length > 80) return toolFailure("Title is too long");

      try {
        await ctx.sessionManager.setSessionName(sessionId, title);
      } catch (error) {
        return toolFailure(error instanceof Error ? error.message : String(error));
      }
      return { success: true, sessionId, message: `Session renamed to "${title}"` };
    },
  }),
  defineBridgeTool("session_set_workspace", {
    scope: "session",
    description: "Switch the current session's workspace for future turns. Set an explicit cwd or reset back to the linked task's current default workspace snapshot.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID to update. Defaults to the current session." },
        cwd: { type: "string", description: "Explicit working directory to use for future turns." },
        taskId: { type: "string", description: "When resetting, choose which linked task's current default workspace to copy into the session." },
        reset: { type: "boolean", description: "When true, copy the linked task's current default working directory into this session's pinned workspace." },
      },
    },
    handler: async (args: any, invocation: any) => {
      const sessionId = typeof args.sessionId === "string" && args.sessionId.trim()
        ? args.sessionId.trim()
        : invocation.sessionId;
      if (!sessionId) return toolFailure("sessionId is required");

      const hasCwd = typeof args.cwd === "string";
      const cwd = hasCwd ? args.cwd.trim() : undefined;
      const hasTaskId = typeof args.taskId === "string";
      const taskId = hasTaskId ? args.taskId.trim() : undefined;
      const reset = args.reset === true;

      if (reset === hasCwd) {
        return toolFailure("Provide exactly one of: cwd, reset");
      }
      if (hasCwd && !cwd) {
        return toolFailure("cwd is required");
      }
      if (hasTaskId && !taskId) {
        return toolFailure("taskId is required");
      }
      if (taskId && !reset) {
        return toolFailure("taskId can only be used with reset");
      }

      try {
        const allowDuringActiveTurn = invocation.sessionId === sessionId;
        const result = reset
          ? ctx.sessionManager.resetSessionWorkspace(sessionId, { allowDuringActiveTurn, taskId })
          : ctx.sessionManager.setSessionWorkspace(sessionId, cwd!, { allowDuringActiveTurn });
        return {
          success: true,
          sessionId,
          cwd: result.cwd,
          source: result.source,
          message: result.message,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Cannot switch workspace for a busy session") {
          return {
            ...toolFailure(message, {
              detail: "Workspace changes only take effect when the session is idle.",
            }),
            blocked: true,
          };
        }
        return toolFailure(message);
      }
    },
  }),
  ];
}

export function registerSessionTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterSessionToolsOptions = {},
): void {
  const definitions = createSessionToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
