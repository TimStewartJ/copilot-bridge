import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatToolEntry, ToolCall, TranscriptAgent } from "../api";
import {
  buildTranscriptAgentDirectory,
  getTopLevelAgentToolCallId,
  getTranscriptAgentActiveMs,
} from "../../shared/transcript-agents.js";
import {
  agentDisplayName,
  attachTranscriptAgents,
  buildAgentPlaceholders,
  describeWaitingOnAgents,
  getWorkingAgents,
  withoutWorkingAgents,
  type AgentAttachmentCache,
} from "./transcript-agents";
import { getOwnToolCallStatus, getToolCallStatus } from "./tool-call-status";

function record(toolCallId: string, partial: Partial<TranscriptAgent> = {}): TranscriptAgent {
  return { toolCallId, name: toolCallId, status: "finished", activeMs: 0, toolCount: 0, failedToolCount: 0, ...partial };
}

function tool(toolCallId: string, partial: Partial<ToolCall> = {}): ChatToolEntry {
  return { id: `entry-${toolCallId}`, type: "tool", toolCall: { toolCallId, name: toolCallId, ...partial } };
}

describe("attachTranscriptAgents", () => {
  it("attaches changed agent records without renaming recognized agents or copying unrelated rows", () => {
    const moves = record("call-moves", { name: "moves-agent", status: "running" });
    const docs = record("call-docs", { name: "docs-agent" });
    const entries: ChatEntry[] = [
      { role: "user", content: "Refactor the engine" },
      // Read back before the agent had reported in: nothing in the entry says it is a delegation.
      tool("call-moves", { name: "task", args: { description: "Refactor move generation" } }),
      tool("call-view", { name: "view" }),
      tool("call-docs", { name: "🤖 Docs agent", isSubAgent: true }),
    ];

    const cache: AgentAttachmentCache = new WeakMap();
    const attached = attachTranscriptAgents(entries, buildTranscriptAgentDirectory([moves, docs]), cache);

    expect(attached[0]).toBe(entries[0]);
    expect(attached[2]).toBe(entries[2]);
    expect(attached[1]).toMatchObject({
      toolCall: { toolCallId: "call-moves", isSubAgent: true, name: "🤖 moves-agent", agent: moves },
    });
    // The entry the history read returned is not changed in place.
    expect(entries[1]).toMatchObject({ toolCall: { name: "task" } });
    expect((entries[1] as ChatToolEntry).toolCall.agent).toBeUndefined();

    const recognized = (attached[3] as ChatToolEntry).toolCall;
    expect(recognized.name).toBe("🤖 Docs agent");
    expect(agentDisplayName(recognized)).toBe("docs-agent");

    const again = attachTranscriptAgents([...entries], buildTranscriptAgentDirectory([moves, docs]), cache);
    expect(again[1]).toBe(attached[1]);

    // The agent moved on: a new record means a new row.
    const finished = { ...moves, status: "finished" as const };
    const later = attachTranscriptAgents(entries, buildTranscriptAgentDirectory([finished, docs]), cache);
    expect(later[1]).not.toBe(attached[1]);
    expect((later[1] as ChatToolEntry).toolCall.agent).toBe(finished);
    expect(later[3]).toBe(attached[3]);
  });
});

describe("buildAgentPlaceholders", () => {
  it("fills the missing launch chain once and removes stand-ins when the launches are loaded", () => {
    const engine = record("call-engine", { name: "engine-agent" });
    const moves = record("call-moves", { parentToolCallId: "call-engine", name: "moves-agent", description: "Refactor move generation", startedAt: "2026-10-01T10:00:00.000Z" });
    const directory = buildTranscriptAgentDirectory([engine, moves]);
    const loaded = [tool("step-1", { parentToolCallId: "call-moves" }).toolCall, tool("step-2", { parentToolCallId: "call-moves" }).toolCall];

    const placeholders = buildAgentPlaceholders(loaded, directory);

    expect(placeholders).toEqual([{
      toolCallId: "call-moves",
      parentToolCallId: "call-engine",
      name: "🤖 moves-agent",
      args: { description: "Refactor move generation" },
      isSubAgent: true,
      startedAt: "2026-10-01T10:00:00.000Z",
      agent: moves,
    }, {
      toolCallId: "call-engine", name: "🤖 engine-agent", isSubAgent: true, agent: engine,
    }]);
    // The same stand-in every time, so the row it backs keeps its identity.
    expect(buildAgentPlaceholders(loaded, directory)[0]).toBe(placeholders[0]);

    const launches = [tool("call-engine", { isSubAgent: true }), tool("call-moves", { isSubAgent: true, parentToolCallId: "call-engine" })];
    expect(buildAgentPlaceholders([...launches.map((entry) => entry.toolCall), ...loaded], directory)).toEqual([]);
  });

  it("still gives a step an agent to sit under when the session's records do not know its parent", () => {
    // An old log, or one whose launch was lost: the step is somebody's, just nobody we can name.
    const placeholders = buildAgentPlaceholders(
      [tool("step", { parentToolCallId: "call-unknown" }).toolCall],
      buildTranscriptAgentDirectory([]),
    );

    expect(placeholders).toEqual([{ toolCallId: "call-unknown", name: "🤖 agent", isSubAgent: true }]);
    expect(agentDisplayName(placeholders[0]!)).toBe("agent");
  });
});

describe("agents at work", () => {
  const moves = record("call-moves", { name: "moves-agent", status: "running", activeSince: "2026-10-01T10:00:00.000Z", activeMs: 30_000 });
  const inner = record("call-inner", { name: "inner-agent", status: "running", parentToolCallId: "call-moves" });
  const docs = record("call-docs", { name: "docs-agent", status: "finished", activeMs: 45_000 });

  it("lists the agents the main agent launched that are working, in launch order", () => {
    const directory = buildTranscriptAgentDirectory([docs, moves, inner]);

    // An agent another agent launched is that agent's business.
    expect(getWorkingAgents(directory)).toEqual([moves]);
  });

  it("stops showing agents as working once nothing can be running them", () => {
    const agents = [docs, moves];

    const settled = withoutWorkingAgents(agents);

    expect(settled[0]).toBe(docs);
    expect(settled[1]).toMatchObject({ toolCallId: "call-moves", status: "stopped", activeMs: 30_000 });
    expect(settled[1]).not.toHaveProperty("activeSince");
    // Nothing to settle is nothing to copy.
    expect(withoutWorkingAgents([docs])).toEqual([docs]);
    expect(getWorkingAgents(buildTranscriptAgentDirectory(settled))).toEqual([]);
  });

  it("counts the turn in flight into the time an agent has worked", () => {
    const now = Date.parse("2026-10-01T10:01:00.000Z");

    expect(getTranscriptAgentActiveMs(moves, now)).toBe(90_000);
    // Without a clock, only the turns that have ended.
    expect(getTranscriptAgentActiveMs(moves)).toBe(30_000);
    expect(getTranscriptAgentActiveMs(docs, now)).toBe(45_000);
  });

  it("follows an agent up to the one the main agent launched", () => {
    const directory = buildTranscriptAgentDirectory([moves, inner]);

    expect(getTopLevelAgentToolCallId("call-inner", directory)).toBe("call-moves");
    expect(getTopLevelAgentToolCallId("call-moves", directory)).toBe("call-moves");
    expect(getTopLevelAgentToolCallId("call-unknown", directory)).toBe("call-unknown");
  });

  it("says who the main agent is waiting on: one by name, several by count", () => {
    expect(describeWaitingOnAgents([{ name: "moves-agent", description: "Refactor move generation" }])).toEqual({
      label: "Waiting on moves-agent",
      detail: "Refactor move generation",
      count: 1,
    });
    expect(describeWaitingOnAgents([{ name: "moves-agent" }])).toEqual({ label: "Waiting on moves-agent", count: 1 });
    expect(describeWaitingOnAgents([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }])).toEqual({
      label: "Waiting on 5 agents",
      detail: "a, b, c and 2 more",
      count: 5,
    });
  });
});

describe("where a launching call stands", () => {
  it("stands where its agent does, not where the call that launched it does", () => {
    // A background agent's launching call returns the moment the agent starts.
    const launched = { completedAt: "2026-10-01T10:00:00.020Z", success: true };

    expect(getToolCallStatus({ ...launched, agent: record("a", { status: "running" }) })).toBe("running");
    expect(getToolCallStatus({ ...launched, agent: record("a", { status: "finished" }) })).toBe("done");
    expect(getToolCallStatus({ ...launched, agent: record("a", { status: "stopped" }) })).toBe("done");
    expect(getToolCallStatus({ ...launched, agent: record("a", { status: "failed" }) })).toBe("failed");
    // The call itself failed, so no agent ever ran.
    expect(getToolCallStatus({ success: false, agent: record("a", { status: "finished" }) })).toBe("failed");

    expect(getOwnToolCallStatus({ ...launched })).toBe("done");
  });
});
