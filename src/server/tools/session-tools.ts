import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeSessionTitle } from "../../shared/session-title-utils.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";
import { isCanonicalSessionId } from "../outbound-attachments.js";
import { hasActiveDeferredWork } from "../schedule-session-retention.js";
import { setSessionsArchived } from "../session-archive.js";
import {
  defineSessionBridgeTool,
  registerBridgeToolDefinitions,
  type SessionBridgeToolInvocation,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";

export interface RegisterSessionToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export const SESSION_ARCHIVE_MAX_SESSIONS = 500;

/**
 * Session ids are opaque — only trim them. The title normalizer strips quotes
 * and collapses whitespace, which would corrupt an id.
 */
function targetSessionId(args: any, invocation: SessionBridgeToolInvocation): string {
  const explicit = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
  return explicit || invocation.sessionId;
}

export function createSessionToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineSessionBridgeTool("session_rename", {
    description: "Rename a chat session. Use this to give a session a more descriptive title.",
    parameters: { type: "object", properties: { sessionId: { type: "string", description: "The session ID to rename. Defaults to the current session." }, title: { type: "string", description: "The new title (3-6 words recommended)" } }, required: ["title"] },
    handler: async (args: any, invocation) => {
      const sessionId = targetSessionId(args, invocation);
      const title = normalizeSessionTitle(args.title);

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
  defineSessionBridgeTool("session_set_workspace", {
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
    handler: async (args: any, invocation) => {
      const sessionId = targetSessionId(args, invocation);

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
  defineSessionBridgeTool("session_archive", {
    description: "Archive chat sessions to tidy the lists, or restore archived ones. Pass every session in one call. "
      + "A chat that is running, waiting on the user, or has deferred work or a result pending is left as it is and reported. "
      + "Archiving hides a chat and deletes nothing.",
    parameters: {
      type: "object",
      properties: {
        sessionIds: {
          type: "array",
          items: { type: "string" },
          description: `IDs of the sessions to archive or restore, at most ${SESSION_ARCHIVE_MAX_SESSIONS} per call.`,
        },
        archived: { type: "boolean", description: "True archives (default); false restores." },
      },
      required: ["sessionIds"],
    },
    handler: async (args: any) => {
      if (!Array.isArray(args.sessionIds)) return toolFailure("sessionIds must be an array of session IDs");
      const archived = args.archived !== false;
      const sessionIds = [...new Set<string>(
        args.sessionIds
          .filter((sessionId: unknown): sessionId is string => typeof sessionId === "string")
          .map((sessionId: string) => sessionId.trim())
          .filter(Boolean),
      )];
      if (sessionIds.length === 0) return toolFailure("sessionIds is empty");
      if (sessionIds.length > SESSION_ARCHIVE_MAX_SESSIONS) {
        return toolFailure(`At most ${SESSION_ARCHIVE_MAX_SESSIONS} sessions per call`);
      }

      // Writing the flag for an unknown id would leave a row for a session that does not exist.
      const sessionStateDir = join(ctx.copilotHome ?? join(homedir(), ".copilot"), "session-state");
      const exists = await mapWithConcurrency(sessionIds, 32, async (sessionId) =>
        isCanonicalSessionId(sessionId)
        && await stat(join(sessionStateDir, sessionId)).then((stats) => stats.isDirectory(), () => false));

      const hasQueuedResult = (sessionId: string): boolean =>
        ctx.deferredPromptStore?.listDeliveriesForSession(sessionId)
          .some((delivery) => delivery.status === "pending" || delivery.status === "running") ?? false;

      // No await from here to the write, so a chat cannot start a run between its check and the change.
      const skipped: Array<{ sessionId: string; reason: string }> = [];
      const targets: string[] = [];
      let alreadyInState = 0;
      sessionIds.forEach((sessionId, index) => {
        if (!exists[index]) {
          skipped.push({ sessionId, reason: "not found" });
        } else if (ctx.sessionMetaStore.isArchived(sessionId) === archived) {
          alreadyInState += 1;
        } else if (archived && ctx.sessionManager.isSessionBusy(sessionId)) {
          skipped.push({ sessionId, reason: "running" });
        } else if (archived && ctx.sessionManager.getPendingUserInputCount(sessionId) > 0) {
          skipped.push({ sessionId, reason: "waiting on the user" });
        } else if (archived && hasActiveDeferredWork(sessionId, ctx)) {
          // Archiving cancels a chat's deferred work.
          skipped.push({ sessionId, reason: "deferred work pending" });
        } else if (archived && hasQueuedResult(sessionId)) {
          // And withdraws a deploy or update result that has not reached the chat yet.
          skipped.push({ sessionId, reason: "a result is waiting to be delivered" });
        } else {
          targets.push(sessionId);
        }
      });
      const result = setSessionsArchived(ctx, targets, archived);
      for (const [sessionId, error] of Object.entries(result.errors)) skipped.push({ sessionId, reason: error });

      const verb = archived ? "Archived" : "Restored";
      return {
        success: true,
        archived,
        changed: result.sessionIds.length,
        alreadyInState,
        skipped,
        message: `${verb} ${result.sessionIds.length} of ${sessionIds.length} session(s)`
          + (alreadyInState > 0 ? `; ${alreadyInState} already ${archived ? "archived" : "active"}` : "")
          + (skipped.length > 0 ? `; ${skipped.length} skipped` : ""),
      };
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
