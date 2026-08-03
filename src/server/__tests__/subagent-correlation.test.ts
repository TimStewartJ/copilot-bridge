import { describe, expect, it } from "vitest";
import { transformEventsToMessages } from "../event-transform.js";
import { SubagentCorrelator, resolveToolOutcome } from "../subagent-correlation.js";
import { isHiddenTool } from "../../shared/tool-visibility.js";

const AGENT_TOOL_CALL = "call_parent_tool";
const AGENT_INSTANCE = "subagent_instance_42";

function toolStart(toolCallId: string, timestamp: string, args: unknown = { mode: "sync" }) {
  return {
    type: "tool.execution_start",
    timestamp,
    data: { toolCallId, toolName: "task", arguments: args },
  };
}

function subagentStarted(toolCallId: string, agentId: string | undefined, timestamp: string) {
  return {
    type: "subagent.started",
    ...(agentId ? { agentId } : {}),
    timestamp,
    data: { toolCallId, agentName: "explore", agentDisplayName: "Explore Agent" },
  };
}

function subagentFailed(toolCallId: string, error: unknown, timestamp: string) {
  return { type: "subagent.failed", timestamp, data: { toolCallId, error } };
}

function toolComplete(toolCallId: string, success: boolean, timestamp: string, extra: object = {}) {
  return { type: "tool.execution_complete", timestamp, data: { toolCallId, success, ...extra } };
}

function onlyToolCall(events: any[]) {
  const entries = transformEventsToMessages(events);
  const tools = entries.filter((entry) => entry.type === "tool");
  expect(tools).toHaveLength(1);
  return tools[0].toolCall!;
}

describe("subagent failure correlation (replay fold)", () => {
  it("surfaces the real subagent.failed reason instead of the generic tool error", () => {
    // Real shape observed in session d060dead: the runtime reports a useless generic message
    // on the tool completion while the actual cause rides on subagent.failed.
    const toolCall = onlyToolCall([
      toolStart(AGENT_TOOL_CALL, "2026-08-01T10:00:00.000Z"),
      subagentStarted(AGENT_TOOL_CALL, AGENT_INSTANCE, "2026-08-01T10:00:00.100Z"),
      subagentFailed(
        AGENT_TOOL_CALL,
        "CAPIError: 400 messages: at least one message is required",
        "2026-08-01T10:00:04.000Z",
      ),
      toolComplete(AGENT_TOOL_CALL, false, "2026-08-01T10:00:04.100Z", {
        error: { message: "Agent completed but produced no response.", code: "failure" },
      }),
    ]);

    expect(toolCall.success).toBe(false);
    expect(toolCall.isSubAgent).toBe(true);
    expect(toolCall.name).toBe("🤖 Explore Agent");
    expect(toolCall.result).toBe("CAPIError: 400 messages: at least one message is required");
  });

  it("accepts an object-shaped subagent failure error", () => {
    const toolCall = onlyToolCall([
      toolStart(AGENT_TOOL_CALL, "2026-08-01T10:00:00.000Z"),
      subagentStarted(AGENT_TOOL_CALL, AGENT_INSTANCE, "2026-08-01T10:00:00.100Z"),
      subagentFailed(AGENT_TOOL_CALL, { message: "model unavailable" }, "2026-08-01T10:00:01.000Z"),
      toolComplete(AGENT_TOOL_CALL, false, "2026-08-01T10:00:01.100Z"),
    ]);

    expect(toolCall.result).toBe("model unavailable");
  });

  it("treats subagent.failed.toolCallId as authoritative without a subagent.started", () => {
    const toolCall = onlyToolCall([
      toolStart(AGENT_TOOL_CALL, "2026-08-01T10:00:00.000Z"),
      subagentFailed(AGENT_TOOL_CALL, "CAPIError: 404", "2026-08-01T10:00:01.000Z"),
      toolComplete(AGENT_TOOL_CALL, true, "2026-08-01T10:00:01.100Z"),
    ]);

    expect(toolCall.success).toBe(false);
    expect(toolCall.isSubAgent).toBe(true);
    // No subagent.started means no display name was ever announced.
    expect(toolCall.name).toBe("🤖 agent");
    expect(toolCall.result).toBe("CAPIError: 404");
  });

  it("does not retroactively fail a background launch that already completed", () => {
    // Real shape observed in sessions b00ff146 / da61e0da: `mode: background` completes the launch
    // successfully, then the agent fails much later. The launch genuinely succeeded, and the live
    // fold has no look-ahead, so replay must agree.
    const toolCall = onlyToolCall([
      toolStart(AGENT_TOOL_CALL, "2026-08-01T10:00:00.000Z", { mode: "background" }),
      subagentStarted(AGENT_TOOL_CALL, AGENT_INSTANCE, "2026-08-01T10:00:00.100Z"),
      toolComplete(AGENT_TOOL_CALL, true, "2026-08-01T10:00:00.200Z", {
        result: { content: "Agent started in background" },
      }),
      subagentFailed(AGENT_TOOL_CALL, "CAPIError: 404 Not Found", "2026-08-01T10:20:00.000Z"),
    ]);

    expect(toolCall.success).toBe(true);
    expect(toolCall.result).toBe("Agent started in background");
  });

  it("ignores a session.error whose agent id maps to no known subagent", () => {
    const toolCall = onlyToolCall([
      {
        type: "tool.execution_start",
        timestamp: "2026-08-01T10:00:00.000Z",
        data: { toolCallId: "plain-tool", toolName: "bash", arguments: {} },
      },
      {
        type: "session.error",
        agentId: "unrelated-agent",
        timestamp: "2026-08-01T10:00:01.000Z",
        data: { message: "some unrelated subagent blew up" },
      },
      toolComplete("plain-tool", true, "2026-08-01T10:00:02.000Z", {
        result: { content: "ok" },
      }),
    ]);

    expect(toolCall.name).toBe("bash");
    expect(toolCall.isSubAgent).toBeUndefined();
    expect(toolCall.success).toBe(true);
    expect(toolCall.result).toBe("ok");
  });

  it("lets a real completion win over turn-terminal synthesis", () => {
    // assistant.turn_end is a terminal turn event, but tool activity can still land after it,
    // so the synthesized failure must stay provisional.
    const toolCall = onlyToolCall([
      toolStart(AGENT_TOOL_CALL, "2026-08-01T10:00:00.000Z"),
      subagentStarted(AGENT_TOOL_CALL, AGENT_INSTANCE, "2026-08-01T10:00:00.100Z"),
      { type: "assistant.turn_end", timestamp: "2026-08-01T10:00:01.000Z", data: {} },
      toolComplete(AGENT_TOOL_CALL, true, "2026-08-01T10:00:02.000Z", {
        result: { content: "finished after turn end" },
      }),
    ]);

    expect(toolCall.success).toBe(true);
    expect(toolCall.result).toBe("finished after turn end");
  });

  it("keeps a synthesized failure when the turn aborts with no completion", () => {
    const toolCall = onlyToolCall([
      toolStart(AGENT_TOOL_CALL, "2026-08-01T10:00:00.000Z"),
      subagentStarted(AGENT_TOOL_CALL, AGENT_INSTANCE, "2026-08-01T10:00:00.100Z"),
      { type: "abort", timestamp: "2026-08-01T10:00:01.000Z", data: { reason: "user initiated" } },
    ]);

    expect(toolCall.success).toBe(false);
  });
});

describe("SubagentCorrelator sealing", () => {
  it("ignores late failures after a tool call completes", () => {
    const correlator = new SubagentCorrelator();
    correlator.startSubagent(AGENT_TOOL_CALL, AGENT_INSTANCE, { agentDisplayName: "Explore Agent" });
    correlator.completeTool(AGENT_TOOL_CALL);

    correlator.recordSubagentFailure(AGENT_TOOL_CALL, "too late");
    correlator.recordAgentError(AGENT_INSTANCE, "still too late");

    const resolution = correlator.resolve(AGENT_TOOL_CALL);
    expect(resolution.error).toBeUndefined();
    expect(resolution.displayName).toBe("🤖 Explore Agent");
  });

  it("still accepts sub-agent identity and response announced after the launch completes", () => {
    // Background launches complete before `subagent.started` and the agent's answer arrive.
    // Only the failure outcome is frozen.
    const correlator = new SubagentCorrelator();
    correlator.completeTool(AGENT_TOOL_CALL);
    correlator.startSubagent(AGENT_TOOL_CALL, AGENT_INSTANCE, { agentDisplayName: "Explore Agent" });
    correlator.recordResponse(AGENT_TOOL_CALL, "agent answer");

    const resolution = correlator.resolve(AGENT_TOOL_CALL);
    expect(resolution.displayName).toBe("🤖 Explore Agent");
    expect(resolution.response).toBe("agent answer");
    expect(resolution.isSubAgent).toBe(true);

    correlator.recordSubagentFailure(AGENT_TOOL_CALL, "late failure");
    expect(correlator.resolve(AGENT_TOOL_CALL).error).toBeUndefined();
  });

  it("never resurrects a forgotten tool call", () => {
    const correlator = new SubagentCorrelator();
    correlator.startSubagent(AGENT_TOOL_CALL, AGENT_INSTANCE, { agentName: "explore" });
    correlator.completeTool(AGENT_TOOL_CALL);
    correlator.forget(AGENT_TOOL_CALL);

    correlator.recordSubagentFailure(AGENT_TOOL_CALL, "late failure");

    expect(correlator.resolve(AGENT_TOOL_CALL)).toEqual({ isSubAgent: false });
    expect(correlator.isTrackedAgent(AGENT_INSTANCE)).toBe(false);
  });

  it("maps a distinct agent instance id back to its spawning tool call", () => {
    const correlator = new SubagentCorrelator();
    correlator.startSubagent(AGENT_TOOL_CALL, AGENT_INSTANCE, { agentName: "explore" });
    correlator.recordAgentError(AGENT_INSTANCE, "child request failed");

    expect(correlator.resolve(AGENT_TOOL_CALL).error).toBe("child request failed");
    expect(correlator.isTrackedAgent(AGENT_INSTANCE)).toBe(true);
    expect(correlator.isTrackedAgent("never-seen")).toBe(false);
  });

  it("resolves a sub-agent failure into the user-visible outcome", () => {
    const correlator = new SubagentCorrelator();
    correlator.startSubagent(AGENT_TOOL_CALL, AGENT_INSTANCE, { agentDisplayName: "Explore Agent" });
    correlator.recordSubagentFailure(AGENT_TOOL_CALL, "boom");

    const outcome = resolveToolOutcome(
      correlator.resolve(AGENT_TOOL_CALL),
      { success: true, data: { success: true, result: { content: "ignored" } } },
      "task",
    );

    expect(outcome).toEqual({
      isSubAgent: true,
      displayName: "🤖 Explore Agent",
      success: false,
      result: "boom",
    });
  });
});

describe("shared tool visibility", () => {
  // These inputs used to disagree between the server replay fold and the client live fold, so a
  // self-rename rendered live and then vanished on reload.
  it("hides a self-rename whose target id is padded or blank", () => {
    expect(isHiddenTool("session_rename", { sessionId: "  abc  " }, "abc")).toBe(true);
    expect(isHiddenTool("session_rename", { sessionId: "" }, "abc")).toBe(true);
    expect(isHiddenTool("session_rename", {}, "abc")).toBe(true);
    expect(isHiddenTool("session_rename", undefined, "abc")).toBe(true);
  });

  it("normalizes the target id the same way the session_rename handler does", () => {
    // The handler runs the id through normalizeSessionTitle, which also strips surrounding
    // quotes and collapses whitespace, so visibility must use the same normalization.
    expect(isHiddenTool("session_rename", { sessionId: "\"abc\"" }, "abc")).toBe(true);
    expect(isHiddenTool("session_rename", { sessionId: "'abc'" }, "abc")).toBe(true);
  });

  it("keeps a cross-session rename visible", () => {
    expect(isHiddenTool("session_rename", { sessionId: "other" }, "abc")).toBe(false);
  });

  it("always hides bridge control-flow tools", () => {
    expect(isHiddenTool("report_intent", {}, "abc")).toBe(true);
    expect(isHiddenTool("bash", {}, "abc")).toBe(false);
  });
});
