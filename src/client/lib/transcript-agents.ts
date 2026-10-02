import type { ChatEntry, ToolCall } from "../api";
import {
  type TranscriptAgent,
  type TranscriptAgentDirectory,
} from "../../shared/transcript-agents.js";

/**
 * What the transcript needs from the session's agent records (shared/transcript-agents.ts): the
 * agent behind each launching call, a stand-in for a launching call that is above the loaded
 * window, and which agents are working now.
 */

const AGENT_ROW_PREFIX = "🤖 ";

/** A launching call is named for its agent, marked the way the server marks one it recognised. */
export function agentRowName(agent: Pick<TranscriptAgent, "name">): string {
  return `${AGENT_ROW_PREFIX}${agent.name}`;
}

/** The agent's name as a person reads it, without the marker. */
export function agentDisplayName(toolCall: Pick<ToolCall, "name" | "agent">): string {
  return toolCall.agent?.name ?? (toolCall.name.replace(/^🤖\s*/, "") || "Agent");
}

/** Entries the previous pass already built, so a row whose entry and agent are unchanged keeps its object. */
export type AgentAttachmentCache = WeakMap<ChatEntry, { agent: TranscriptAgent; entry: ChatEntry }>;

/**
 * Gives every launching call in `entries` its agent record. A call the loaded history could not
 * yet tell was a delegation (its agent reported in above the part that was read) becomes an agent
 * row here.
 */
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

/**
 * Stand-ins for launching calls that are not loaded. A step names the call that launched its
 * agent, and the loaded window usually begins long after that call, so without a stand-in the step
 * would have nothing to sit under and would read as the main agent's. A parent the session's
 * records do not know either is still an agent, just an unnamed one.
 */
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

/**
 * The agents as they stand once nothing can still be running them: the run is over and no
 * background agent is alive. One the records still show working never recorded that it stopped,
 * because the session shut down or its process went away; it did not finish.
 */
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

/**
 * The line for a run whose main agent has nothing of its own in flight and is waiting for agents
 * to report back. It names how many, not what each is doing this second, so it holds still.
 */
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
