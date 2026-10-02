import { describe, expect, it } from "vitest";
import {
  TranscriptAgentFold,
  cloneTranscriptAgentFoldState,
  type AgentLifecycleChange,
} from "../transcript-agent-fold.js";

const BASE_MS = Date.parse("2026-10-01T10:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

type Event = Record<string, unknown>;

/** The main agent, or the agent `byAgent`, handing work to an agent with a `task` call. */
function launch(toolCallId: string, seconds: number, args: Record<string, unknown> = {}, byAgent?: { agentId: string; toolCallId: string }): Event {
  return {
    type: "tool.execution_start",
    timestamp: at(seconds),
    ...(byAgent ? { agentId: byAgent.agentId } : {}),
    data: {
      toolCallId,
      toolName: "task",
      arguments: args,
      ...(byAgent ? { parentToolCallId: byAgent.toolCallId } : {}),
    },
  };
}

function started(toolCallId: string, agentId: string, seconds: number, data: Record<string, unknown> = {}): Event {
  return {
    type: "subagent.started",
    agentId,
    timestamp: at(seconds),
    data: { toolCallId, agentName: "general-purpose", ...data },
  };
}

/** An event of an agent's own: the runtime stamps it with the agent and the call that launched it. */
function own(type: string, agent: { agentId: string; toolCallId: string }, seconds: number, data: Record<string, unknown> = {}): Event {
  return { type, agentId: agent.agentId, timestamp: at(seconds), data: { parentToolCallId: agent.toolCallId, ...data } };
}

function observeAll(fold: TranscriptAgentFold, events: Event[]): Array<AgentLifecycleChange | undefined> {
  return events.map((event) => fold.observe(event));
}

const MOVES = { agentId: "agent-moves", toolCallId: "call-moves" };

/** A background agent launched by the main agent, through the end of its first turn at 90s. */
const firstTurn: Event[] = [
  launch(MOVES.toolCallId, 0, { name: "moves-agent", agent_type: "general-purpose", description: "Refactor move generation", mode: "background" }),
  started(MOVES.toolCallId, MOVES.agentId, 0, { agentDisplayName: "moves-agent", executionMode: "background" }),
  own("assistant.turn_start", MOVES, 1),
  own("assistant.message", MOVES, 5, { toolRequests: [{ toolCallId: "moves-view" }] }),
  own("tool.execution_start", MOVES, 5, { toolCallId: "moves-view", toolName: "view" }),
  own("tool.execution_complete", MOVES, 6, { toolCallId: "moves-view", success: true }),
  own("assistant.turn_end", MOVES, 6),
  own("assistant.turn_start", MOVES, 6),
  own("assistant.message", MOVES, 90, { content: "Done with the first pass.", toolRequests: [] }),
  { type: "subagent.completed", agentId: MOVES.agentId, timestamp: at(90), data: { toolCallId: MOVES.toolCallId } },
  own("assistant.turn_end", MOVES, 90),
];

describe("TranscriptAgentFold", () => {
  it("records an agent from its launch, under the name and brief it was given", () => {
    const fold = new TranscriptAgentFold();

    expect(observeAll(fold, firstTurn.slice(0, 2))).toEqual([undefined, "started"]);
    expect(fold.list()).toEqual([{
      toolCallId: "call-moves",
      agentId: "agent-moves",
      name: "moves-agent",
      agentType: "general-purpose",
      description: "Refactor move generation",
      background: true,
      status: "running",
      startedAt: at(0),
      activeSince: at(0),
      activeMs: 0,
      toolCount: 0,
      failedToolCount: 0,
    }]);
    expect(fold.getToolCallIdForAgent("agent-moves")).toBe("call-moves");
  });

  it("falls back to the agent's type when it was launched without a name", () => {
    const fold = new TranscriptAgentFold();
    observeAll(fold, [launch("call-review", 0, { agent_type: "code-review" }), started("call-review", "agent-review", 0, { agentName: "code-review" })]);

    expect(fold.get("call-review")).toMatchObject({ name: "code-review", agentType: "code-review" });
    expect(fold.get("call-review")).not.toHaveProperty("background");
  });

  it("lists agents in the order they were launched, not the order they reported in", () => {
    const fold = new TranscriptAgentFold();
    observeAll(fold, [
      launch("call-alpha", 0, { name: "alpha-agent" }),
      launch("call-beta", 1, { name: "beta-agent" }),
      launch("call-gamma", 2, { name: "gamma-agent" }),
      // Three launched side by side start in whichever order the runtime gets to them.
      started("call-gamma", "agent-gamma", 3),
      started("call-alpha", "agent-alpha", 4),
      started("call-beta", "agent-beta", 5),
    ]);

    expect(fold.list().map((agent) => agent.name)).toEqual(["alpha-agent", "beta-agent", "gamma-agent"]);
    // Its run began with the call that launched it; its work, when it reported in.
    expect(fold.get("call-alpha")).toMatchObject({ startedAt: at(0), activeSince: at(4) });
  });

  it("ends the first turn when the runtime says so, and counts the time worked", () => {
    const fold = new TranscriptAgentFold();
    const changes = observeAll(fold, firstTurn);

    // A turn that ended with the model asking for a tool is not the end of the work.
    expect(changes.filter(Boolean)).toEqual(["started", "finished"]);
    expect(fold.get("call-moves")).toMatchObject({ status: "finished", endedAt: at(90), activeMs: 90_000, toolCount: 1 });
    expect(fold.get("call-moves")).not.toHaveProperty("activeSince");
  });

  it("takes a follow-up as work again, and reads its end from the agent's own turn", () => {
    const fold = new TranscriptAgentFold();
    observeAll(fold, firstTurn);

    // The runtime writes nothing when a later turn ends; the last model call asking for no tool does.
    const followUp: Event[] = [
      { type: "user.message", agentId: MOVES.agentId, timestamp: at(200), data: { content: "Also cover castling.", source: "agent-session-1" } },
      own("assistant.turn_start", MOVES, 200),
      own("assistant.message", MOVES, 210, { toolRequests: [{ toolCallId: "moves-edit" }] }),
      own("tool.execution_start", MOVES, 210, { toolCallId: "moves-edit", toolName: "edit" }),
      own("tool.execution_complete", MOVES, 215, { toolCallId: "moves-edit", success: true }),
      own("assistant.turn_end", MOVES, 215),
      own("assistant.turn_start", MOVES, 215),
      own("assistant.message", MOVES, 260, { content: "Castling is covered.", toolRequests: [] }),
      own("assistant.turn_end", MOVES, 260),
    ];
    const changes = observeAll(fold, followUp);

    expect(changes.filter(Boolean)).toEqual(["resumed", "finished"]);
    expect(changes.indexOf("resumed")).toBe(0);
    expect(fold.get("call-moves")).toMatchObject({ status: "finished", endedAt: at(260), activeMs: 150_000, toolCount: 2 });
  });

  it("ignores the runtime repeating an agent's end when the session shuts down", () => {
    const fold = new TranscriptAgentFold();
    observeAll(fold, firstTurn);
    const before = fold.get("call-moves");

    // The runtime lets every agent go at shutdown and marks the event cancelled, working or not.
    const changes = observeAll(fold, [
      { type: "subagent.completed", agentId: MOVES.agentId, timestamp: at(500), data: { toolCallId: MOVES.toolCallId, cancelled: true } },
      { type: "session.shutdown", timestamp: at(500), data: { shutdownType: "routine" } },
    ]);

    expect(changes).toEqual([undefined, undefined]);
    expect(fold.get("call-moves")).toEqual(before);
  });

  it("marks an agent the runtime let go in the middle of its work as stopped, not finished", () => {
    const fold = new TranscriptAgentFold();
    // Six seconds in, with a model call in flight.
    observeAll(fold, firstTurn.slice(0, 8));

    // What the runtime writes at shutdown and after an abort: the agent's end, cancelled, then the shutdown.
    const changes = observeAll(fold, [
      { type: "subagent.completed", agentId: MOVES.agentId, timestamp: at(30), data: { toolCallId: MOVES.toolCallId, cancelled: true } },
      { type: "session.shutdown", timestamp: at(30), data: { shutdownType: "routine" } },
    ]);

    expect(changes).toEqual(["stopped", undefined]);
    expect(fold.get("call-moves")).toMatchObject({ status: "stopped", endedAt: at(30), activeMs: 30_000 });
  });

  it("marks an agent that was working when the session shut down as stopped", () => {
    const fold = new TranscriptAgentFold();
    observeAll(fold, firstTurn.slice(0, 6));

    // An agent's own shutdown event is not the session's.
    expect(fold.observe({ type: "session.shutdown", agentId: MOVES.agentId, timestamp: at(20), data: {} })).toBeUndefined();
    expect(fold.get("call-moves")?.status).toBe("running");

    expect(fold.observe({ type: "session.shutdown", timestamp: at(30), data: { shutdownType: "routine" } })).toBe("stopped");
    expect(fold.get("call-moves")).toMatchObject({ status: "stopped", endedAt: at(30), activeMs: 30_000 });
  });

  it("records a failure, whether the runtime reports the agent or its session failing", () => {
    const failedLaunch = new TranscriptAgentFold();
    observeAll(failedLaunch, firstTurn.slice(0, 3));
    expect(failedLaunch.observe({ type: "subagent.failed", agentId: MOVES.agentId, timestamp: at(12), data: { toolCallId: MOVES.toolCallId, error: "model unavailable" } }))
      .toBe("failed");
    expect(failedLaunch.get("call-moves")).toMatchObject({ status: "failed", endedAt: at(12), activeMs: 12_000 });

    const failedSession = new TranscriptAgentFold();
    observeAll(failedSession, firstTurn.slice(0, 3));
    expect(failedSession.observe(own("session.error", MOVES, 8, { message: "rate limited" }))).toBe("failed");
    expect(failedSession.get("call-moves")?.status).toBe("failed");
  });

  it("keeps the time the work ended when the failure is reported afterwards", () => {
    const fold = new TranscriptAgentFold();
    observeAll(fold, firstTurn);

    expect(fold.observe({ type: "subagent.failed", agentId: MOVES.agentId, timestamp: at(400), data: { toolCallId: MOVES.toolCallId } }))
      .toBe("failed");
    expect(fold.get("call-moves")).toMatchObject({ status: "failed", endedAt: at(90), activeMs: 90_000 });
  });

  it("counts an agent's own visible steps and failures, not those of an agent it launched", () => {
    const fold = new TranscriptAgentFold();
    const inner = { agentId: "agent-inner", toolCallId: "call-inner" };
    observeAll(fold, [
      ...firstTurn.slice(0, 3),
      // Reporting intent is bookkeeping the transcript never shows.
      own("tool.execution_start", MOVES, 2, { toolCallId: "moves-intent", toolName: "report_intent" }),
      own("tool.execution_start", MOVES, 3, { toolCallId: "moves-grep", toolName: "grep" }),
      own("tool.execution_complete", MOVES, 4, { toolCallId: "moves-grep", success: false }),
      launch(inner.toolCallId, 5, { name: "inner-agent", description: "Check the edge cases" }, MOVES),
      started(inner.toolCallId, inner.agentId, 5, { agentDisplayName: "inner-agent" }),
      own("tool.execution_start", inner, 6, { toolCallId: "inner-view", toolName: "view" }),
      own("tool.execution_start", inner, 7, { toolCallId: "inner-bash", toolName: "bash" }),
      own("tool.execution_complete", inner, 8, { toolCallId: "inner-bash", success: false }),
    ]);

    // Handing work on is one of the outer agent's steps.
    expect(fold.get("call-moves")).toMatchObject({ toolCount: 2, failedToolCount: 1 });
    expect(fold.get("call-moves")).not.toHaveProperty("parentToolCallId");
    expect(fold.get("call-inner")).toMatchObject({
      name: "inner-agent",
      description: "Check the edge cases",
      parentToolCallId: "call-moves",
      toolCount: 2,
      failedToolCount: 1,
    });
  });

  it("takes on an agent whose launch was lost only on the runtime's word that it is one", () => {
    const fold = new TranscriptAgentFold();

    // A parent named by an ordinary call says nothing about what that parent is.
    fold.observe({ type: "tool.execution_start", timestamp: at(0), data: { toolCallId: "t1", toolName: "view", parentToolCallId: "call-unknown" } });
    expect(fold.list()).toEqual([]);

    fold.observe({ type: "tool.execution_start", agentId: "agent-lost", timestamp: at(1), data: { toolCallId: "t2", toolName: "view", parentToolCallId: "call-lost" } });
    expect(fold.list()).toMatchObject([{ toolCallId: "call-lost", agentId: "agent-lost", name: "agent", status: "running", toolCount: 1 }]);
  });

  it("reports an agent going back to work when it was launched before the fold began", () => {
    // A run keeps a fold of its own, so a follow-up to an agent an earlier run launched is the
    // first the fold hears of it. The follow-up itself does not name the launching call.
    const fold = new TranscriptAgentFold();

    const changes = observeAll(fold, [
      { type: "user.message", agentId: MOVES.agentId, timestamp: at(200), data: { content: "Also cover castling." } },
      own("assistant.turn_start", MOVES, 200),
      own("assistant.message", MOVES, 260, { content: "Castling is covered.", toolRequests: [] }),
      own("assistant.turn_end", MOVES, 260),
    ]);

    // Without the first, nothing would be told that the agent is working until it had stopped.
    expect(changes).toEqual([undefined, "resumed", undefined, "finished"]);
  });

  it("picks up from a saved state exactly where it left off", () => {
    const followUp: Event[] = [
      { type: "user.message", agentId: MOVES.agentId, timestamp: at(200), data: { content: "Also cover castling." } },
      own("assistant.turn_start", MOVES, 200),
      own("assistant.message", MOVES, 260, { content: "Castling is covered.", toolRequests: [] }),
      own("assistant.turn_end", MOVES, 260),
    ];
    const events = [...firstTurn, ...followUp];
    const whole = new TranscriptAgentFold();
    observeAll(whole, events);

    for (let cut = 0; cut <= events.length; cut += 1) {
      const first = new TranscriptAgentFold();
      observeAll(first, events.slice(0, cut));
      // The state crosses a JSON boundary when the scan that owns it is persisted.
      const resumed = new TranscriptAgentFold(JSON.parse(JSON.stringify(first.getState())));
      observeAll(resumed, events.slice(cut));
      expect(resumed.list(), `cut at ${cut}`).toEqual(whole.list());
    }
  });

  it("copies a state without sharing its records", () => {
    const fold = new TranscriptAgentFold();
    observeAll(fold, [launch("call-pending", 0, { name: "pending-agent" }), ...firstTurn.slice(0, 2)]);
    const state = fold.getState();
    const copy = cloneTranscriptAgentFoldState(state);

    copy.agents[0]!.name = "renamed";
    copy.pending[0]!.name = "renamed";

    expect(state.agents[0]!.name).toBe("moves-agent");
    expect(state.pending[0]!.name).toBe("pending-agent");
  });
});
