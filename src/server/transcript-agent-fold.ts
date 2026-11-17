import { getSdkAgentId, isSdkAgentUserMessage } from "./sdk-event-identity.js";
import { isHiddenTool } from "../shared/tool-visibility.js";
import type { TranscriptAgent, TranscriptAgentStatus } from "../shared/transcript-agents.js";

/** Enough for every agent a long session realistically runs; older finished ones are let go. */
const MAX_TRACKED_AGENTS = 200;
/** Launching calls seen whose agent has not reported in yet. */
const MAX_PENDING_LAUNCHES = 32;

export type AgentLifecycleChange = "started" | "resumed" | "finished" | "failed" | "stopped";

interface FoldAgent extends TranscriptAgent {
  /** Whether the agent's latest model call asked for tools; unknown until it makes one. */
  lastCallAskedForTools?: boolean;
}

interface PendingLaunch {
  toolCallId: string;
  /** When the launching call was made. */
  at?: string;
  name?: string;
  agentType?: string;
  description?: string;
  background?: boolean;
  parentToolCallId?: string;
}

/** Serializable, so the event-log scan that owns a fold can stop and resume. */
export interface TranscriptAgentFoldState {
  agents: FoldAgent[];
  pending: PendingLaunch[];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timeOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toPublicAgent(agent: FoldAgent): TranscriptAgent {
  const { lastCallAskedForTools: _lastCallAskedForTools, ...record } = agent;
  return record;
}

export function createTranscriptAgentFoldState(): TranscriptAgentFoldState {
  return { agents: [], pending: [] };
}

export function cloneTranscriptAgentFoldState(state: TranscriptAgentFoldState): TranscriptAgentFoldState {
  return {
    agents: state.agents.map((agent) => ({ ...agent })),
    pending: state.pending.map((launch) => ({ ...launch })),
  };
}

export class TranscriptAgentFold {
  /** Keyed by launching tool call, in launch order. */
  private readonly agents = new Map<string, FoldAgent>();
  private readonly toolCallByAgentId = new Map<string, string>();
  private readonly pending = new Map<string, PendingLaunch>();
  /** Whether the event being observed is the first this fold has seen of its agent. */
  private tookOnAgent = false;

  constructor(state?: TranscriptAgentFoldState) {
    for (const agent of state?.agents ?? []) {
      if (!agent || typeof agent.toolCallId !== "string") continue;
      this.agents.set(agent.toolCallId, { ...agent });
      if (agent.agentId) this.toolCallByAgentId.set(agent.agentId, agent.toolCallId);
    }
    for (const launch of state?.pending ?? []) {
      if (launch && typeof launch.toolCallId === "string") this.pending.set(launch.toolCallId, { ...launch });
    }
  }

  getState(): TranscriptAgentFoldState {
    return {
      agents: [...this.agents.values()].map((agent) => ({ ...agent })),
      pending: [...this.pending.values()].map((launch) => ({ ...launch })),
    };
  }

  /** Agents in launch order; they report in whatever order they happen to start. */
  list(): TranscriptAgent[] {
    return [...this.agents.values()]
      .map((agent, index) => ({ agent, index, launchedAt: timeOf(agent.startedAt) ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => (a.launchedAt === b.launchedAt ? a.index - b.index : a.launchedAt - b.launchedAt))
      .map(({ agent }) => toPublicAgent(agent));
  }

  get(toolCallId: string): TranscriptAgent | undefined {
    const agent = this.agents.get(toolCallId);
    return agent ? toPublicAgent(agent) : undefined;
  }

  /** The launching call of the agent with this runtime id, once it has reported in. */
  getToolCallIdForAgent(agentId: string): string | undefined {
    return this.toolCallByAgentId.get(agentId);
  }

  /** Takes the next event; returns the agent change when it started or ended work, else nothing. */
  observe(event: unknown): AgentLifecycleChange | undefined {
    this.tookOnAgent = false;
    const change = this.apply(event);
    // A fold started mid-session first meets an earlier run's agent when a follow-up resumes it.
    return change ?? (this.tookOnAgent ? "resumed" : undefined);
  }

  private apply(event: unknown): AgentLifecycleChange | undefined {
    if (!isRecord(event) || typeof event.type !== "string") return undefined;
    const type = event.type;
    const data = isRecord(event.data) ? event.data : {};
    const at = nonEmptyString(event.timestamp);

    switch (type) {
      case "subagent.started":
        return this.start(event, data, at);
      case "subagent.completed": {
        const agent = this.agentOfLaunch(data.toolCallId);
        // Fires after turn 1 and again, cancelled, when let go; later turns end on a no-tool call.
        if (!agent || agent.status !== "running") return undefined;
        // Let go while still at work, it was cut short.
        return this.end(agent, at, data.cancelled === true ? "stopped" : "finished");
      }
      case "subagent.failed": {
        const agent = this.agentOfLaunch(data.toolCallId);
        return agent && agent.status !== "failed" ? this.end(agent, at, "failed") : undefined;
      }
      case "session.error": {
        const agent = this.agentOfEvent(event, data);
        return agent && agent.status === "running" ? this.end(agent, at, "failed") : undefined;
      }
      case "session.shutdown": {
        if (getSdkAgentId(event)) return undefined;
        let stopped = false;
        for (const agent of this.agents.values()) {
          if (agent.status !== "running") continue;
          this.end(agent, at, "stopped");
          stopped = true;
        }
        return stopped ? "stopped" : undefined;
      }
      case "user.message": {
        if (!isSdkAgentUserMessage(event)) return undefined;
        const agent = this.agentOfEvent(event, data);
        return agent ? this.resume(agent, at) : undefined;
      }
      case "assistant.turn_start": {
        const agent = this.agentOfEvent(event, data, at);
        if (!agent) return undefined;
        agent.lastCallAskedForTools = undefined;
        return this.resume(agent, at);
      }
      case "assistant.message": {
        const agent = this.agentOfEvent(event, data, at);
        if (!agent) return undefined;
        const change = this.resume(agent, at);
        agent.lastCallAskedForTools = Array.isArray(data.toolRequests) && data.toolRequests.length > 0;
        return change;
      }
      case "assistant.turn_end": {
        const agent = this.agentOfEvent(event, data);
        if (!agent || agent.status !== "running" || agent.lastCallAskedForTools !== false) return undefined;
        return this.end(agent, at, "finished");
      }
      case "tool.execution_start":
        return this.toolStarted(event, data, at);
      case "tool.execution_complete": {
        const agent = this.agentOfEvent(event, data);
        if (agent && data.success === false) agent.failedToolCount += 1;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private start(
    event: Record<string, unknown>,
    data: Record<string, unknown>,
    at: string | undefined,
  ): AgentLifecycleChange | undefined {
    const toolCallId = nonEmptyString(data.toolCallId);
    if (!toolCallId) return undefined;
    const agentId = getSdkAgentId(event);
    const launch = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    const agentType = nonEmptyString(data.agentType) ?? nonEmptyString(data.agentName) ?? launch?.agentType;
    const name = nonEmptyString(data.agentDisplayName) ?? launch?.name ?? agentType ?? "agent";
    const executionMode = nonEmptyString(data.executionMode);
    const background = executionMode ? executionMode === "background" : launch?.background === true;

    const existing = this.agents.get(toolCallId);
    if (existing) {
      // An agent first seen through its own events, or one the runtime announced twice.
      existing.name = name;
      if (agentType) existing.agentType = agentType;
      if (agentId) this.identify(existing, agentId);
      if (launch?.description && !existing.description) existing.description = launch.description;
      if (launch?.parentToolCallId && !existing.parentToolCallId) existing.parentToolCallId = launch.parentToolCallId;
      if (background) existing.background = true;
      return this.resume(existing, at);
    }

    // The agent's run begins with the call that launched it; its work, when it reports in.
    const launchedAt = launch?.at ?? at;
    const agent: FoldAgent = {
      toolCallId,
      name,
      ...(agentType ? { agentType } : {}),
      ...(launch?.description ? { description: launch.description } : {}),
      ...(launch?.parentToolCallId ? { parentToolCallId: launch.parentToolCallId } : {}),
      ...(background ? { background: true } : {}),
      status: "running",
      ...(launchedAt ? { startedAt: launchedAt } : {}),
      ...(at ? { activeSince: at } : {}),
      activeMs: 0,
      toolCount: 0,
      failedToolCount: 0,
    };
    this.agents.set(toolCallId, agent);
    if (agentId) this.identify(agent, agentId);
    this.prune();
    return "started";
  }

  private toolStarted(
    event: Record<string, unknown>,
    data: Record<string, unknown>,
    at: string | undefined,
  ): AgentLifecycleChange | undefined {
    const toolCallId = nonEmptyString(data.toolCallId);
    const toolName = nonEmptyString(data.toolName) ?? nonEmptyString(data.name) ?? "unknown";
    const args = isRecord(data.arguments) ? data.arguments : undefined;
    const owner = this.agentOfEvent(event, data, at);

    // A delegation is remembered until its agent reports in, which is where its name and brief are.
    if (toolCallId && (toolName === "task" || nonEmptyString(args?.agent_type)) && !this.agents.has(toolCallId)) {
      const name = nonEmptyString(args?.name);
      const agentType = nonEmptyString(args?.agent_type);
      const description = nonEmptyString(args?.description);
      this.pending.delete(toolCallId);
      this.pending.set(toolCallId, {
        toolCallId,
        ...(at ? { at } : {}),
        ...(name ? { name } : {}),
        ...(agentType ? { agentType } : {}),
        ...(description ? { description } : {}),
        ...(args?.mode === "background" ? { background: true } : {}),
        ...(owner ? { parentToolCallId: owner.toolCallId } : {}),
      });
      while (this.pending.size > MAX_PENDING_LAUNCHES) {
        const oldest = this.pending.keys().next().value;
        if (oldest === undefined) break;
        this.pending.delete(oldest);
      }
    }

    if (!owner) return undefined;
    if (!isHiddenTool(toolName, data.arguments)) owner.toolCount += 1;
    return this.resume(owner, at);
  }

  private agentOfLaunch(toolCallId: unknown): FoldAgent | undefined {
    const id = nonEmptyString(toolCallId);
    return id ? this.agents.get(id) : undefined;
  }

  /** The event's agent; `firstSeenAt` adopts an unknown one whose `subagent.started` was lost. */
  private agentOfEvent(
    event: Record<string, unknown>,
    data: Record<string, unknown>,
    firstSeenAt?: string,
  ): FoldAgent | undefined {
    const agentId = getSdkAgentId(event);
    const mapped = agentId ? this.toolCallByAgentId.get(agentId) : undefined;
    const toolCallId = mapped ?? nonEmptyString(data.parentToolCallId);
    if (!toolCallId) return undefined;
    const known = this.agents.get(toolCallId);
    if (known) {
      if (agentId && !known.agentId) this.identify(known, agentId);
      return known;
    }
    // Only the runtime's own stamp says an unknown parent is an agent and not an ordinary call.
    if (!agentId || firstSeenAt === undefined) return undefined;
    const agent: FoldAgent = {
      toolCallId,
      name: "agent",
      status: "running",
      startedAt: firstSeenAt,
      activeSince: firstSeenAt,
      activeMs: 0,
      toolCount: 0,
      failedToolCount: 0,
    };
    this.agents.set(toolCallId, agent);
    this.identify(agent, agentId);
    this.tookOnAgent = true;
    this.prune();
    return agent;
  }

  private identify(agent: FoldAgent, agentId: string): void {
    agent.agentId = agentId;
    this.toolCallByAgentId.set(agentId, agent.toolCallId);
  }

  private resume(agent: FoldAgent, at: string | undefined): AgentLifecycleChange | undefined {
    if (agent.status === "running") return undefined;
    agent.status = "running";
    delete agent.endedAt;
    if (at) agent.activeSince = at;
    else delete agent.activeSince;
    agent.lastCallAskedForTools = undefined;
    return "resumed";
  }

  private end(
    agent: FoldAgent,
    at: string | undefined,
    status: Exclude<TranscriptAgentStatus, "running">,
  ): AgentLifecycleChange {
    if (agent.status === "running") {
      const since = timeOf(agent.activeSince);
      const until = timeOf(at);
      if (since !== undefined && until !== undefined) agent.activeMs += Math.max(0, until - since);
      if (at) agent.endedAt = at;
    } else if (at && !agent.endedAt) {
      // A failure reported after the work had already ended keeps the time the work ended.
      agent.endedAt = at;
    }
    delete agent.activeSince;
    agent.status = status;
    return status;
  }

  private prune(): void {
    if (this.agents.size <= MAX_TRACKED_AGENTS) return;
    for (const [toolCallId, agent] of this.agents) {
      if (this.agents.size <= MAX_TRACKED_AGENTS) return;
      if (agent.status === "running") continue;
      this.agents.delete(toolCallId);
      if (agent.agentId) this.toolCallByAgentId.delete(agent.agentId);
    }
  }
}
