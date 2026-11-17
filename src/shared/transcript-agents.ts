// Every history read carries all agents, so steps show under their agent after launch scrolls off.

export type TranscriptAgentStatus =
  /** A turn is in flight. */
  | "running"
  /** Its latest turn ended. A background agent can still be sent a follow-up. */
  | "finished"
  | "failed"
  /** The session shut down while the agent was working. */
  | "stopped";

export interface TranscriptAgent {
  /** The tool call that launched the agent. Its own steps name it as their `parentToolCallId`. */
  toolCallId: string;
  /** The runtime's id for the agent; `read_agent` and the task registry use it. */
  agentId?: string;
  /** The name it was launched under ("moves-agent"), or its type when it was given none. */
  name: string;
  /** The kind of agent, such as "code-review" or "general-purpose". */
  agentType?: string;
  /** The one-line brief from the launching call. */
  description?: string;
  /** The launching call of the agent that launched this one; absent when the main agent did. */
  parentToolCallId?: string;
  /** Launched to outlive the turn that launched it. */
  background?: boolean;
  status: TranscriptAgentStatus;
  startedAt?: string;
  /** When the turn in flight began. Set only while the agent is running. */
  activeSince?: string;
  /** When its latest turn ended. Set once the agent is not running. */
  endedAt?: string;
  /** Time spent working, over the turns that have ended. */
  activeMs: number;
  /** Tool calls the agent has made, not counting those of agents it launched. */
  toolCount: number;
  failedToolCount: number;
}

export interface TranscriptAgentDirectory {
  all: readonly TranscriptAgent[];
  byToolCallId: ReadonlyMap<string, TranscriptAgent>;
  byAgentId: ReadonlyMap<string, TranscriptAgent>;
}

export const EMPTY_TRANSCRIPT_AGENT_DIRECTORY: TranscriptAgentDirectory = {
  all: [],
  byToolCallId: new Map(),
  byAgentId: new Map(),
};

export function buildTranscriptAgentDirectory(
  agents: readonly TranscriptAgent[] | undefined,
): TranscriptAgentDirectory {
  if (!agents || agents.length === 0) return EMPTY_TRANSCRIPT_AGENT_DIRECTORY;
  const byToolCallId = new Map<string, TranscriptAgent>();
  const byAgentId = new Map<string, TranscriptAgent>();
  for (const agent of agents) {
    byToolCallId.set(agent.toolCallId, agent);
    if (agent.agentId) byAgentId.set(agent.agentId, agent);
  }
  return { all: agents, byToolCallId, byAgentId };
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** How long the agent has worked: its finished turns, plus the turn in flight up to `nowMs`. */
export function getTranscriptAgentActiveMs(agent: TranscriptAgent, nowMs?: number): number {
  const since = agent.status === "running" ? parseTime(agent.activeSince) : undefined;
  const inFlight = since !== undefined && nowMs !== undefined ? Math.max(0, nowMs - since) : 0;
  return Math.max(0, agent.activeMs) + inFlight;
}

/** Walks `parentToolCallId` up to the main agent's launch call; an unknown id returns itself. */
export function getTopLevelAgentToolCallId(
  toolCallId: string,
  directory: Pick<TranscriptAgentDirectory, "byToolCallId">,
): string {
  const seen = new Set<string>();
  let current = toolCallId;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = directory.byToolCallId.get(current)?.parentToolCallId;
    if (!parent) return current;
    current = parent;
  }
  return current;
}
