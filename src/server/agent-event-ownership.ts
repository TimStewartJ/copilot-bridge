import { getSdkAgentId } from "./sdk-event-identity.js";

// Whose event is it?
//
// Sub-agents share the session's event stream with the main agent. A tool call made by an agent
// has always named the call that launched the agent (`data.parentToolCallId`), but for a long time
// nothing said whose turn an `assistant.turn_start` or `assistant.turn_end` was: through Copilot
// CLI 1.0.82 they carry no owner at all, and the folds guessed that any turn starting while an
// agent was running belonged to an agent. With several agents working beside the main agent that
// guess is wrong most of the time, and the main agent's own steps ended up filed under an agent's
// turn.
//
// Later runtimes stamp an agent's turn events with the agent (an envelope `agentId`, and since
// 1.0.87 the launching call as well). Once a stream has shown that it does, a turn event with no
// stamp is known to be the main agent's. The guess is kept only for streams that never have.
//
// The first stamped turn comes too late to settle the turn that matters most: the main agent
// starts its next turn a few milliseconds after launching an agent, and the agent begins its own a
// second or two later. What comes in time is `subagent.started`. The runtimes that stamp turns are
// the ones that report there how the agent was launched (`executionMode`): the two changes shipped
// together, and in the session logs they were checked against (about 850 agents, April to October
// 2026) no agent has one without the other.

function eventData(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as Record<string, unknown>).data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The launching call an event names as its parent, which is how an agent's own events say whose they are. */
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

/**
 * True for an event that shows the stream stamps its agents' turns: such a turn, or the start of
 * an agent reported the way only those runtimes report it.
 */
export function showsAgentTurnsAreStamped(event: unknown): boolean {
  if (isStampedAgentTurnEvent(event)) return true;
  if (!event || typeof event !== "object") return false;
  return (event as Record<string, unknown>).type === "subagent.started"
    && nonEmptyString(eventData(event)?.executionMode) !== undefined;
}

/**
 * Follows the agents an event stream names, so an event stamped only with an agent's runtime id can
 * still be filed under the call that launched it.
 */
export class AgentEventOwners {
  private readonly toolCallByAgentId = new Map<string, string>();

  /** Learns which launching call an agent id stands for from any event that carries both. */
  learn(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const agentId = getSdkAgentId(event);
    if (!agentId || this.toolCallByAgentId.has(agentId)) return;
    const type = (event as Record<string, unknown>).type;
    // On the events that announce an agent, the launching call is `data.toolCallId`; on the
    // agent's own events it is `data.parentToolCallId`, and `data.toolCallId` is one of its calls.
    const toolCallId = typeof type === "string" && type.startsWith("subagent.")
      ? nonEmptyString(eventData(event)?.toolCallId)
      : getParentToolCallId(event);
    if (toolCallId) this.toolCallByAgentId.set(agentId, toolCallId);
  }

  /**
   * The call that launched the agent an event belongs to, when the stream has said which it is.
   * Nothing for an event of the main agent.
   */
  launchOf(event: unknown): string | undefined {
    const parent = getParentToolCallId(event);
    if (parent) return parent;
    const agentId = getSdkAgentId(event);
    return agentId ? this.toolCallByAgentId.get(agentId) : undefined;
  }

  /**
   * What to file an agent's event under: its launching call, or its runtime id when the stream has
   * not said which call that is. Nothing for an event of the main agent.
   */
  ownerOf(event: unknown): string | undefined {
    return this.launchOf(event) ?? getSdkAgentId(event);
  }
}
