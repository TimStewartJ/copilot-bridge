import type { AppContext } from "../app-context.js";
import { isTerminalAgentStatus, type SessionAgentTask } from "../../shared/session-agents.js";
import { toolFailure } from "../tool-results.js";
import {
  defineSessionBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";

// The runtime gives an agent tools to launch, read and message other agents, and none to end one.
// An agent that was replaced kept working through messages queued for it, and every agent the
// runtime lists counts as a live context whether it works or not. These two tools let the agent
// that launched the others end them.

const LISTED_AGENTS_IN_FAILURE = 12;
const AGENT_PARAMETER = {
  type: "string",
  description: "The agent's ID, as used with read_agent and write_agent, or the name it was launched under.",
} as const;

export interface RegisterSessionAgentToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

function label(task: SessionAgentTask): string {
  return task.name ? `${task.name} (${task.id})` : task.id;
}

async function findAgent(
  ctx: AppContext,
  sessionId: string,
  rawAgent: unknown,
  whenMissing = "",
): Promise<{ task: SessionAgentTask } | { failure: ReturnType<typeof toolFailure> }> {
  const wanted = typeof rawAgent === "string" ? rawAgent.trim() : "";
  if (!wanted) return { failure: toolFailure("agent_id must be a non-empty string.") };

  const { tasks, source } = await ctx.sessionManager.listSessionAgents(sessionId);
  if (source !== "live") {
    return { failure: toolFailure("This session's agents cannot be read right now. Try again in a moment.") };
  }
  const byId = tasks.find((task) => task.id === wanted);
  if (byId) return { task: byId };
  const byName = tasks.filter((task) => task.name === wanted);
  if (byName.length === 1) return { task: byName[0] };
  if (byName.length > 1) {
    return {
      failure: toolFailure(`${byName.length} agents are named "${wanted}". Pass the agent ID instead.`, {
        detail: byName.map((task) => `${task.id} (${task.status})`).join(", "),
      }),
    };
  }
  const listed = tasks.slice(0, LISTED_AGENTS_IN_FAILURE).map((task) => `${label(task)}: ${task.status}`);
  const more = tasks.length - listed.length;
  const tracked = tasks.length === 0
    ? "This session has no tracked agents."
    : `Tracked agents: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
  return {
    failure: toolFailure(`No agent with the ID or name "${wanted}" is tracked for this session.`, {
      detail: whenMissing ? `${whenMissing} ${tracked}` : tracked,
    }),
  };
}

/**
 * The runtime drops an agent that has ended once its result was read, so an agent that was
 * stopped and then read is often gone before anyone dismisses it.
 */
const ALREADY_GONE_HINT = "An agent that had ended leaves the list by itself once it is read, and then needs no dismissal.";

export function createSessionAgentToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineSessionBridgeTool("agent_stop", {
      description: "Stop a background agent you launched in this session: one you have replaced, or whose work you no longer want. Its work ends at once, the command it is running is stopped, and messages queued for it with write_agent are discarded. An agent does not stop by itself when you start a replacement or remove its files, and it cannot learn that from anything you send while it works. Read what you need from it first: after a stop, read_agent may report only that it was cancelled. A stopped agent cannot be started again, and it still counts as a live agent while it stays listed; call agent_dismiss to take it off the list.",
      parameters: {
        type: "object",
        properties: { agent_id: AGENT_PARAMETER },
        required: ["agent_id"],
      },
      handler: async (args: any, invocation) => {
        const sessionId = invocation.sessionId;
        const found = await findAgent(ctx, sessionId, args.agent_id);
        if ("failure" in found) return found.failure;
        const { task } = found;
        if (isTerminalAgentStatus(task.status)) {
          return {
            success: true,
            changed: false,
            agentId: task.id,
            status: task.status,
            message: `${label(task)} had already ended (${task.status}). Call agent_dismiss to take it off the list.`,
          };
        }

        let result: { cancelled: boolean } | undefined;
        try {
          result = await ctx.sessionManager.cancelSessionAgent(sessionId, task.id);
        } catch (error) {
          return toolFailure(`Could not stop ${label(task)}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!result) return toolFailure("This session's agents cannot be stopped right now. Try again in a moment.");
        if (!result.cancelled) {
          return toolFailure(`The runtime did not stop ${label(task)}.`, {
            detail: "It may have ended in the meantime. Check with list_agents before trying again.",
          });
        }
        return {
          success: true,
          changed: true,
          agentId: task.id,
          status: "cancelled",
          message: `Stopped ${label(task)}. It still counts as a live agent while it stays listed; call agent_dismiss to take it off the list.`,
        };
      },
    }),

    defineSessionBridgeTool("agent_dismiss", {
      description: "Take a background agent that is not working off this session's list for good: one that is idle, finished, failed or stopped. Every listed agent counts against the limit on live agents that this Bridge shares between all chats, even while idle, so dismiss an agent once you have its result and will not message it again. An idle agent is ended first. Afterwards read_agent and write_agent no longer find it, so read what you need from it before dismissing. A working agent is refused: stop it with agent_stop first, or wait until it is idle. What the agent did stays in the transcript.",
      parameters: {
        type: "object",
        properties: { agent_id: AGENT_PARAMETER },
        required: ["agent_id"],
      },
      handler: async (args: any, invocation) => {
        const sessionId = invocation.sessionId;
        const found = await findAgent(ctx, sessionId, args.agent_id, ALREADY_GONE_HINT);
        if ("failure" in found) return found.failure;
        const { task } = found;

        let result: Awaited<ReturnType<AppContext["sessionManager"]["dismissSessionAgent"]>>;
        try {
          result = await ctx.sessionManager.dismissSessionAgent(sessionId, task.id);
        } catch (error) {
          return toolFailure(`Could not dismiss ${label(task)}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (result.dismissed) {
          return {
            success: true,
            agentId: task.id,
            message: `Dismissed ${label(task)}. It no longer counts as a live agent, and read_agent and write_agent can no longer reach it.`,
          };
        }
        switch (result.reason) {
          case "running":
            return toolFailure(`${label(task)} is working.`, {
              detail: "Stop it with agent_stop first, or wait until it is idle, then dismiss it.",
            });
          case "not-found":
            return {
              success: true,
              changed: false,
              agentId: task.id,
              message: `${label(task)} is no longer on this session's list.`,
            };
          case "refused":
            return toolFailure(`The runtime kept ${label(task)} on its list.`, {
              detail: "Try again in a moment.",
            });
          default:
            return toolFailure("This session's agents cannot be dismissed right now. Try again in a moment.");
        }
      },
    }),
  ];
}

export function registerSessionAgentTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterSessionAgentToolsOptions = {},
): void {
  const definitions = createSessionAgentToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
