import { describe, expect, it } from "vitest";
import type { SessionAgentTask } from "../../shared/session-agents.js";
import type { TranscriptAgent } from "../../shared/transcript-agents.js";
import { settleTranscriptAgents } from "../transcript-agent-settle.js";

const BASE_MS = Date.parse("2026-10-01T10:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

/** An agent the log shows working since `at(100)`: nothing in it says the turn ended. */
function working(partial: Partial<TranscriptAgent> = {}): TranscriptAgent {
  return {
    toolCallId: "call-moves",
    agentId: "agent-moves",
    name: "moves-agent",
    background: true,
    status: "running",
    startedAt: at(0),
    activeSince: at(100),
    activeMs: 40_000,
    toolCount: 12,
    failedToolCount: 0,
    ...partial,
  };
}

function task(partial: Partial<SessionAgentTask> = {}): SessionAgentTask {
  return { id: "agent-moves", toolCallId: "call-moves", status: "running", executionMode: "background", ...partial };
}

describe("settleTranscriptAgents", () => {
  it("leaves the log's word alone when the runtime's list was never read", () => {
    const agents = [working()];

    expect(settleTranscriptAgents(agents, { tasks: [] })).toBe(agents);
  });

  it("returns the same records when nothing needs correcting", () => {
    const finished = [working({ status: "finished", activeSince: undefined, endedAt: at(150) })];
    expect(settleTranscriptAgents(finished, { tasks: [], refreshedAt: at(500) })).toBe(finished);

    const stillRunning = [working(), working({ toolCallId: "call-child", agentId: "agent-child", parentToolCallId: "call-moves" })];
    expect(settleTranscriptAgents(stillRunning, { tasks: [task()], refreshedAt: at(500) })).toBe(stillRunning);
  });

  it("stops a missing top-level agent but leaves its nested agent to the log", () => {
    const parent = working();
    const nested = working({ toolCallId: "call-inner", agentId: "agent-inner", parentToolCallId: parent.toolCallId });
    const settled = settleTranscriptAgents([parent, nested], { tasks: [], refreshedAt: at(500) });

    expect(settled.map((agent) => [agent.toolCallId, agent.status])).toEqual([["call-moves", "stopped"], ["call-inner", "running"]]);
    expect(settled[0]).toMatchObject({ activeMs: 40_000, toolCount: 12 });
    expect(settled[0]).not.toHaveProperty("activeSince");
    expect(settled[0]).not.toHaveProperty("endedAt");
    expect(settled[1]).toBe(nested);
  });

  it("settles tracked agents by launch or runtime ID without mixing their outcomes", () => {
    const named = (name: string) => working({ toolCallId: `call-${name}`, agentId: `agent-${name}`, name });
    const agents = [named("docs"), named("tests"), named("review"), named("index")];
    const settled = settleTranscriptAgents(agents, {
      refreshedAt: at(500),
      tasks: [
        task({ id: "agent-index", toolCallId: "call-index", status: "cancelled" }),
        task({ id: "agent-review", toolCallId: "call-review", status: "failed", completedAt: at(200) }),
        // The registry can know only the runtime id, or only the call that launched the agent.
        task({ id: "agent-docs", toolCallId: undefined, status: "idle", idleSince: at(180), activeTimeMs: 120_000 }),
        task({ id: "runtime-tests", toolCallId: "call-tests", status: "completed", completedAt: at(190) }),
      ],
    });

    expect(settled.map(({ toolCallId, status, endedAt, activeMs }) => [toolCallId, status, endedAt, activeMs])).toEqual([
      ["call-docs", "finished", at(180), 120_000],
      ["call-tests", "finished", at(190), 40_000],
      ["call-review", "failed", at(200), 40_000],
      ["call-index", "stopped", undefined, 40_000],
    ]);
  });

  it("does not overrule a turn that began after the list was read", () => {
    // The list says idle, but it was read before the agent was sent its follow-up.
    const before = [working()];
    expect(settleTranscriptAgents(before, { tasks: [task({ status: "idle" })], refreshedAt: at(90) })).toBe(before);

    // Read a moment after the turn began: too close to call.
    expect(settleTranscriptAgents(before, { tasks: [task({ status: "idle" })], refreshedAt: at(101) })).toBe(before);
    expect(settleTranscriptAgents(before, { tasks: [], refreshedAt: at(101) })).toBe(before);
  });


  it("corrects only the agents that need it", () => {
    const docs = working({ toolCallId: "call-docs", agentId: "agent-docs", name: "docs-agent" });
    const moves = working();

    const settled = settleTranscriptAgents(
      [docs, moves],
      { tasks: [task()], refreshedAt: at(500) },
    );

    expect(settled.map((agent) => agent.status)).toEqual(["stopped", "running"]);
    expect(settled[1]).toBe(moves);
  });
});
