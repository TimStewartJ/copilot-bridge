import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatBridgeLink } from "../../shared/bridge-links.js";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import { normalizeSessionTitle } from "../../shared/session-title-utils.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";
import { isCanonicalSessionId } from "../outbound-attachments.js";
import { hasActiveDeferredWork } from "../schedule-session-retention.js";
import { setSessionsArchived } from "../session-archive.js";
import { resolveSessionCreationOptions } from "../session-creation-options.js";
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

interface SessionStartArgs {
  prompt: string;
  taskId?: string;
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

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
  defineSessionBridgeTool("session_start", {
    description: "Start a separate, persistent Bridge chat and send its first prompt. "
      + "Use when the user wants work in its own conversation that they can open and continue later. "
      + "For bounded delegation whose answer belongs in this conversation, use the task sub-agent tool instead. "
      + "The new chat does not copy this conversation's history; write a self-contained prompt. "
      + "Returns after the first prompt is accepted, not after the work finishes. "
      + "Results and questions stay in the new chat; no completion report is sent back here. "
      + "Include the returned Markdown link in your reply so the user can open the new chat.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "First message for the new chat, including all context and instructions it needs." },
        taskId: { type: "string", description: "Exact task ID from task_list or task context. Links the new chat before its first prompt, with that task's instructions and workspace. Omit for an unlinked chat using the default workspace; the current task is not inherited." },
        model: { type: "string", description: "Model ID for the new chat. Omit to use the user's default model, not this chat's model." },
        reasoningEffort: { type: "string", description: "Optional reasoning effort supported by the selected model. Omit to use the configured default." },
        contextTier: { type: "string", enum: ["default", "long_context"], description: "Optional context tier supported by the selected model. Omit to use the configured default." },
      },
      required: ["prompt"],
    },
    handler: async (args: SessionStartArgs, invocation) => {
      const prompt = args.prompt.trim();
      if (!prompt) return toolFailure("prompt is required");
      const taskId = args.taskId?.trim();
      if (args.taskId !== undefined && !taskId) return toolFailure("taskId must not be empty");
      if (taskId && !ctx.taskStore.getTask(taskId)) {
        return toolFailure(`Task ${taskId} was not found. Use task_list to find the right task ID.`);
      }

      let sessionId: string | undefined;
      let taskLinked = false;
      let sending = false;
      try {
        invocation.signal?.throwIfAborted();
        const creation = await resolveSessionCreationOptions(ctx, args, { taskId });
        if (creation.error) return toolFailure(creation.error);
        const task = taskId ? ctx.taskStore.getTask(taskId) : undefined;
        if (taskId && !task) return toolFailure(`Task ${taskId} was not found.`);
        invocation.signal?.throwIfAborted();
        const result = task
          ? await ctx.sessionManager.createTaskSession(
            task.id, task.title, task.workItems, task.notes, task.cwd, undefined, creation.options,
          )
          : await ctx.sessionManager.createSession(creation.options);
        sessionId = result.sessionId;
        if (taskId) {
          ctx.taskStore.linkSession(taskId, sessionId);
          taskLinked = true;
        }
        invocation.signal?.throwIfAborted();
        sending = true;
        await ctx.sessionManager.startWorkAndWaitForDelivery(sessionId, prompt);
        const link = formatBridgeLink({ kind: "session", sessionId });
        return {
          success: true,
          sessionId,
          link,
          markdown: `[Open the new chat](${link})`,
          ...(taskId ? { taskId, taskLinked } : {}),
          status: "prompt_accepted",
          message: "The first prompt was accepted. Work continues in the new chat; results and questions stay there, with no completion report back to this chat.",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!sessionId) return toolFailure(message);
        const link = formatBridgeLink({ kind: "session", sessionId });
        const status = sending ? "prompt_acceptance_unconfirmed" : "not_sent";
        return {
          ...toolFailure(message, {
            detail: `Chat created: ${sessionId}\nLink: [Open the created chat](${link})\n`
              + (taskId ? `Task linked: ${taskLinked}.\n` : "")
              + (sending ? "First prompt acceptance was not confirmed." : "The first prompt was not sent.")
              + " Inspect this chat before retrying; do not create another chat for the same work.",
          }),
          sessionId,
          link,
          ...(taskId ? { taskId, taskLinked } : {}),
          status,
        };
      }
    },
  }),
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
