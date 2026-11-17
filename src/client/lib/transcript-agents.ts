import type { ChatEntry, ToolCall } from "../api";
import {
  type TranscriptAgent,
  type TranscriptAgentDirectory,
} from "../../shared/transcript-agents.js";


const AGENT_ROW_PREFIX = "🤖 ";

/** A launching call is named for its agent, marked the way the server marks one it recognised. */
export function agentRowName(agent: Pick<TranscriptAgent, "name">): string {
  return `${AGENT_ROW_PREFIX}${agent.name}`;
}

/** The agent's name as a person reads it, without the marker. */
export function agentDisplayName(toolCall: Pick<ToolCall, "name" | "agent">): string {
  return toolCall.agent?.name ?? (toolCall.name.replace(/^🤖\s*/, "") || "Agent");
}

/** Entries from the previous pass, so an unchanged row keeps its object. */
export type AgentAttachmentCache = WeakMap<ChatEntry, { agent: TranscriptAgent; entry: ChatEntry }>;

/** Gives launching calls their agent; calls not yet known as delegations become agent rows. */
export function attachTranscriptAgents(
  entries: ChatEntry[],
  directory: TranscriptAgentDirectory,
  cache: AgentAttachmentCache,
): ChatEntry[] {
  if (directory.all.length === 0) return entries;
  let attachedAny = false;
  const next = entries.map((entry) => {
    if (entry.type !== "tool") return entry;
    const agent = directory.byToolCallId.get(entry.toolCall.toolCallId);
    if (!agent) return entry;
    attachedAny = true;
    const cached = cache.get(entry);
    if (cached?.agent === agent) return cached.entry;
    const attached: ChatEntry = {
      ...entry,
      toolCall: {
        ...entry.toolCall,
        agent,
        isSubAgent: true,
        name: entry.toolCall.isSubAgent ? entry.toolCall.name : agentRowName(agent),
      },
    };
    cache.set(entry, { agent, entry: attached });
    return attached;
  });
  return attachedAny ? next : entries;
}

const placeholderByAgent = new WeakMap<TranscriptAgent, ToolCall>();

function placeholderFor(agent: TranscriptAgent): ToolCall {
  const known = placeholderByAgent.get(agent);
  if (known) return known;
  const placeholder: ToolCall = {
    toolCallId: agent.toolCallId,
    name: agentRowName(agent),
    ...(agent.description ? { args: { description: agent.description } } : {}),
    isSubAgent: true,
    ...(agent.parentToolCallId ? { parentToolCallId: agent.parentToolCallId } : {}),
    ...(agent.startedAt ? { startedAt: agent.startedAt } : {}),
    agent,
  };
  placeholderByAgent.set(agent, placeholder);
  return placeholder;
}

/** Stand-ins for unloaded launching calls, so agents' steps don't read as the main agent's. */
export function buildAgentPlaceholders(
  toolCalls: readonly ToolCall[],
  directory: TranscriptAgentDirectory,
): ToolCall[] {
  const loaded = new Set(toolCalls.map((toolCall) => toolCall.toolCallId));
  const placeholders = new Map<string, ToolCall>();
  for (const toolCall of toolCalls) {
    let parentId = toolCall.parentToolCallId;
    while (parentId && !loaded.has(parentId) && !placeholders.has(parentId)) {
      const agent = directory.byToolCallId.get(parentId);
      placeholders.set(parentId, agent
        ? placeholderFor(agent)
        : { toolCallId: parentId, name: `${AGENT_ROW_PREFIX}agent`, isSubAgent: true });
      parentId = agent?.parentToolCallId;
    }
  }
  return [...placeholders.values()];
}

/** Agents the main agent launched that are working now, in launch order. */
export function getWorkingAgents(directory: TranscriptAgentDirectory): TranscriptAgent[] {
  return directory.all.filter((agent) => agent.status === "running" && !agent.parentToolCallId);
}

/** Agents still running after the run lost their process: show them stopped, not finished. */
export function withoutWorkingAgents(agents: readonly TranscriptAgent[]): readonly TranscriptAgent[] {
  if (!agents.some((agent) => agent.status === "running")) return agents;
  return agents.map((agent): TranscriptAgent => {
    if (agent.status !== "running") return agent;
    const { activeSince: _activeSince, ...rest } = agent;
    return { ...rest, status: "stopped" };
  });
}

/** "moves-agent", "moves-agent and saves-agent", "moves-agent, saves-agent and 2 more". */
export function listAgentNames(agents: ReadonlyArray<Pick<TranscriptAgent, "name">>, shown = 3): string {
  const names = agents.map((agent) => agent.name);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= shown) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, shown - 1).join(", ")} and ${names.length - (shown - 1)} more`;
}

/** The line while the main agent only waits on agents; it gives a count so it holds still. */
export function describeWaitingOnAgents(
  agents: ReadonlyArray<Pick<TranscriptAgent, "name" | "description">>,
): { label: string; detail?: string; count: number } {
  if (agents.length === 1) {
    const [agent] = agents;
    return {
      label: `Waiting on ${agent!.name}`,
      ...(agent!.description ? { detail: agent!.description } : {}),
      count: 1,
    };
  }
  return { label: `Waiting on ${agents.length} agents`, detail: listAgentNames(agents, 4), count: agents.length };
}
