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

    const stillRunning = [working()];
    expect(settleTranscriptAgents(stillRunning, { tasks: [task()], refreshedAt: at(500) })).toBe(stillRunning);
  });

  it("marks an agent the runtime no longer tracks as stopped", () => {
    // The process that ran it was killed, so the log never recorded an end.
    const [settled] = settleTranscriptAgents([working()], { tasks: [], refreshedAt: at(500) });

    expect(settled).toMatchObject({ status: "stopped", activeMs: 40_000, toolCount: 12 });
    expect(settled).not.toHaveProperty("activeSince");
    expect(settled).not.toHaveProperty("endedAt");
  });

  it("takes the runtime's word for how an agent it still tracks ended", () => {
    const settle = (partial: Partial<SessionAgentTask>) =>
      settleTranscriptAgents([working()], { tasks: [task(partial)], refreshedAt: at(500) })[0];

    // A follow-up turn that ended without the log being able to tell.
    expect(settle({ status: "idle", idleSince: at(180), activeTimeMs: 120_000 }))
      .toMatchObject({ status: "finished", endedAt: at(180), activeMs: 120_000 });
    expect(settle({ status: "completed", completedAt: at(190) })).toMatchObject({ status: "finished", endedAt: at(190), activeMs: 40_000 });
    expect(settle({ status: "failed", completedAt: at(190) })).toMatchObject({ status: "failed", endedAt: at(190) });
    expect(settle({ status: "cancelled" })).toMatchObject({ status: "stopped" });
  });

  it("finds the agent by its runtime id when the runtime does not name the launching call", () => {
    const [settled] = settleTranscriptAgents(
      [working()],
      { tasks: [task({ toolCallId: undefined, status: "idle", idleSince: at(170) })], refreshedAt: at(500) },
    );

    expect(settled).toMatchObject({ status: "finished", endedAt: at(170) });
  });

  it("does not overrule a turn that began after the list was read", () => {
    // The list says idle, but it was read before the agent was sent its follow-up.
    const before = [working()];
    expect(settleTranscriptAgents(before, { tasks: [task({ status: "idle" })], refreshedAt: at(90) })).toBe(before);

    // Read a moment after the turn began: too close to call.
    expect(settleTranscriptAgents(before, { tasks: [task({ status: "idle" })], refreshedAt: at(101) })).toBe(before);
    expect(settleTranscriptAgents(before, { tasks: [], refreshedAt: at(101) })).toBe(before);
  });

  it("leaves an agent another agent launched to the log", () => {
    const nested = [working({ toolCallId: "call-inner", agentId: "agent-inner", parentToolCallId: "call-moves" })];

    expect(settleTranscriptAgents(nested, { tasks: [], refreshedAt: at(500) })).toBe(nested);
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
