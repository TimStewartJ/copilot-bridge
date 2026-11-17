import { getSdkAgentId } from "./sdk-event-identity.js";

// Stamping streams file unstamped turns to main; `executionMode` on subagent.started shows it.

function eventData(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as Record<string, unknown>).data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The launching call an event names as its parent, which marks an agent's own events. */
export function getParentToolCallId(event: unknown): string | undefined {
  return nonEmptyString(eventData(event)?.parentToolCallId);
}

/** True for a turn boundary the runtime says belongs to a sub-agent rather than the main agent. */
export function isStampedAgentTurnEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const type = (event as Record<string, unknown>).type;
  if (type !== "assistant.turn_start" && type !== "assistant.turn_end") return false;
  return getSdkAgentId(event) !== undefined || getParentToolCallId(event) !== undefined;
}

/** True for an event showing the stream stamps agent turns: such a turn or such an agent start. */
export function showsAgentTurnsAreStamped(event: unknown): boolean {
  if (isStampedAgentTurnEvent(event)) return true;
  if (!event || typeof event !== "object") return false;
  return (event as Record<string, unknown>).type === "subagent.started"
    && nonEmptyString(eventData(event)?.executionMode) !== undefined;
}

/** Maps agents' runtime ids to launching calls, so events stamped with just the id can be filed. */
export class AgentEventOwners {
  private readonly toolCallByAgentId: Map<string, string>;

  /** `known` is what an earlier part of the same stream taught, as {@link entries} returned it. */
  constructor(known: Iterable<readonly [string, string]> = []) {
    this.toolCallByAgentId = new Map(known);
  }

  /** Everything learnt so far, for a fold of the stream that stops and resumes. */
  entries(): Array<[string, string]> {
    return [...this.toolCallByAgentId];
  }

  /** Learns which launching call an agent id stands for from any event that carries both. */
  learn(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const agentId = getSdkAgentId(event);
    if (!agentId || this.toolCallByAgentId.has(agentId)) return;
    const type = (event as Record<string, unknown>).type;
    // Announcements name the launch as `toolCallId`; an agent's own events use `parentToolCallId`.
    const toolCallId = typeof type === "string" && type.startsWith("subagent.")
      ? nonEmptyString(eventData(event)?.toolCallId)
      : getParentToolCallId(event);
    if (toolCallId) this.toolCallByAgentId.set(agentId, toolCallId);
  }

  /** The call that launched the event's agent, once known; undefined for the main agent. */
  launchOf(event: unknown): string | undefined {
    const parent = getParentToolCallId(event);
    if (parent) return parent;
    const agentId = getSdkAgentId(event);
    return agentId ? this.toolCallByAgentId.get(agentId) : undefined;
  }

  /** An agent event's launching call, else its runtime id; undefined for the main agent. */
  ownerOf(event: unknown): string | undefined {
    return this.launchOf(event) ?? getSdkAgentId(event);
  }
}
