import { describe, expect, it } from "vitest";
import {
  AgentEventOwners,
  getParentToolCallId,
  isStampedAgentTurnEvent,
  showsAgentTurnsAreStamped,
} from "../agent-event-ownership.js";

describe("agent event ownership", () => {
  it("recognises a turn boundary the runtime says is a sub-agent's", () => {
    // Stamped with the agent, with the call that launched it, or with both.
    expect(isStampedAgentTurnEvent({ type: "assistant.turn_start", agentId: "agent-1", data: {} })).toBe(true);
    expect(isStampedAgentTurnEvent({ type: "assistant.turn_end", data: { parentToolCallId: "call-1" } })).toBe(true);

    // The main agent's turn carries neither.
    expect(isStampedAgentTurnEvent({ type: "assistant.turn_start", data: { turnId: "3" } })).toBe(false);
    // Only turn boundaries were ever unowned; a stamped tool call proves nothing about them.
    expect(isStampedAgentTurnEvent({ type: "tool.execution_start", agentId: "agent-1", data: { parentToolCallId: "call-1" } })).toBe(false);
    expect(isStampedAgentTurnEvent(undefined)).toBe(false);
  });

  it("knows a stream stamps its agents' turns from the first agent it starts", () => {
    // The start of an agent reported with how it was launched: only runtimes that stamp turns do that.
    expect(showsAgentTurnsAreStamped({
      type: "subagent.started",
      agentId: "agent-1",
      data: { toolCallId: "call-1", agentName: "general-purpose", executionMode: "background" },
    })).toBe(true);
    expect(showsAgentTurnsAreStamped({ type: "subagent.started", data: { toolCallId: "call-1", executionMode: "sync" } })).toBe(true);
    // A stamped turn says so too.
    expect(showsAgentTurnsAreStamped({ type: "assistant.turn_start", agentId: "agent-1", data: {} })).toBe(true);

    // An older runtime's report of the same thing, and events that say nothing either way.
    expect(showsAgentTurnsAreStamped({ type: "subagent.started", agentId: "agent-1", data: { toolCallId: "call-1", agentName: "explore" } })).toBe(false);
    expect(showsAgentTurnsAreStamped({ type: "subagent.completed", agentId: "agent-1", data: { toolCallId: "call-1", executionMode: "background" } })).toBe(false);
    expect(showsAgentTurnsAreStamped({ type: "assistant.turn_start", data: { turnId: "3" } })).toBe(false);
    expect(showsAgentTurnsAreStamped(null)).toBe(false);
  });

  it("reads the launching call an agent's event names as its parent", () => {
    expect(getParentToolCallId({ type: "tool.execution_start", data: { parentToolCallId: " call-1 " } })).toBe("call-1");
    expect(getParentToolCallId({ type: "tool.execution_start", data: { parentToolCallId: "" } })).toBeUndefined();
    expect(getParentToolCallId({ type: "tool.execution_start" })).toBeUndefined();
  });

  it("files an event stamped only with an agent under the call that launched it", () => {
    const owners = new AgentEventOwners();
    const turnStart = { type: "assistant.turn_start", agentId: "agent-1", data: {} };

    // Before the stream has said which call the agent is, the agent's id is all there is.
    expect(owners.launchOf(turnStart)).toBeUndefined();
    expect(owners.ownerOf(turnStart)).toBe("agent-1");

    // On the event that announces an agent, the launching call is its own `toolCallId`.
    owners.learn({ type: "subagent.started", agentId: "agent-1", data: { toolCallId: "call-1" } });
    expect(owners.launchOf(turnStart)).toBe("call-1");
    expect(owners.ownerOf(turnStart)).toBe("call-1");
  });

  it("learns an agent from its own events, where `toolCallId` is one of its calls", () => {
    const owners = new AgentEventOwners();

    owners.learn({ type: "tool.execution_start", agentId: "agent-2", data: { toolCallId: "its-view", parentToolCallId: "call-2" } });

    expect(owners.launchOf({ type: "assistant.turn_end", agentId: "agent-2", data: {} })).toBe("call-2");
  });

  it("says nothing for an event of the main agent", () => {
    const owners = new AgentEventOwners();
    owners.learn({ type: "subagent.started", agentId: "agent-1", data: { toolCallId: "call-1" } });

    expect(owners.launchOf({ type: "assistant.turn_start", data: { turnId: "4" } })).toBeUndefined();
    expect(owners.ownerOf({ type: "tool.execution_start", data: { toolCallId: "main-view" } })).toBeUndefined();
  });
});
