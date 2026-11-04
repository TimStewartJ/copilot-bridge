import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolCall } from "../api";
import { buildRenderableSegmentRoots, buildToolCallForest, getActiveToolCallRoots, segmentChatEntries } from "./tool-call-tree";

function createToolCall(toolCallId: string, partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId,
    name: partial.name ?? toolCallId,
    ...partial,
  };
}

describe("tool call tree helpers", () => {
  it("returns only running roots for the live track panel", () => {
    const { roots } = buildToolCallForest([
      createToolCall("running-parent", { isSubAgent: true }),
      createToolCall("done-tool", { completedAt: "2026-04-22T20:00:00.000Z", success: true }),
    ]);

    expect(getActiveToolCallRoots(roots).map((root) => root.toolCall.toolCallId)).toEqual(["running-parent"]);
  });

  it("keeps child tools under the correct root regardless of arrival order", () => {
    const { roots, nodesById } = buildToolCallForest([
      createToolCall("bash-1", { parentToolCallId: "subagent-1" }),
      createToolCall("subagent-1", { isSubAgent: true }),
      createToolCall("subagent-2", { isSubAgent: true }),
      createToolCall("subagent-3", { isSubAgent: true }),
      createToolCall("bash-2", { parentToolCallId: "subagent-2" }),
      createToolCall("bash-3", { parentToolCallId: "subagent-3" }),
    ]);

    expect(nodesById.get("bash-1")?.rootToolCallId).toBe("subagent-1");
    expect(roots.map((root) => root.toolCall.toolCallId)).toEqual(["subagent-1", "subagent-2", "subagent-3"]);
    expect(roots[0]?.children.map((child) => child.toolCall.toolCallId)).toEqual(["bash-1"]);
    expect(roots[1]?.children.map((child) => child.toolCall.toolCallId)).toEqual(["bash-2"]);
    expect(roots[2]?.children.map((child) => child.toolCall.toolCallId)).toEqual(["bash-3"]);
  });

  it("splits tool rendering into contiguous tool segments without crossing messages", () => {
    const entries: ChatEntry[] = [
      { role: "assistant", content: "Starting work" },
      { id: "tool-1", type: "tool", toolCall: createToolCall("subagent-1", { isSubAgent: true }) },
      { id: "tool-2", type: "tool", toolCall: createToolCall("bash-1", { parentToolCallId: "subagent-1" }) },
      { role: "assistant", content: "Checkpoint" },
      { id: "tool-3", type: "tool", toolCall: createToolCall("bash-2", { parentToolCallId: "subagent-1" }) },
    ];

    const segments = segmentChatEntries(entries);

    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({ type: "message", entry: { content: "Starting work" } });
    expect(segments[1]).toMatchObject({
      type: "tool-segment",
      entries: [
        { toolCall: { toolCallId: "subagent-1" } },
        { toolCall: { toolCallId: "bash-1" } },
      ],
    });
    expect(segments[2]).toMatchObject({ type: "message", entry: { content: "Checkpoint" } });
    expect(segments[3]).toMatchObject({
      type: "tool-segment",
      entries: [
        { toolCall: { toolCallId: "bash-2" } },
      ],
    });
  });

  it("keeps a skill and the reasoning it led to ahead of the grouped tools", () => {
    const entries: ChatEntry[] = [
      { role: "user", content: "Use the browser" },
      {
        id: "skill-1", type: "skill", skill: { id: "skill-browser", label: "browser" },
        content: "<skill-context name=\"browser\"></skill-context>",
      },
      { id: "open", type: "tool", turnId: "open-page", toolCall: createToolCall("open") },
      {
        id: "thought-1",
        type: "reasoning",
        turnId: "turn-1",
        content: "I should inspect the page before following the link.",
        reasoning: { messageEventId: "assistant-message-1" },
      },
      { id: "tool-a", type: "tool", turnId: "turn-1", toolCall: createToolCall("tool-a") },
      { id: "tool-b", type: "tool", turnId: "turn-1", toolCall: createToolCall("tool-b") },
      { id: "thought-2", type: "reasoning", turnId: "turn-2", content: "   ", reasoning: {} },
      { role: "assistant", content: "Here it is", turnId: "turn-2" },
    ];

    expect(segmentChatEntries(entries)).toMatchObject([
      { type: "message", entry: { content: "Use the browser" } },
      { type: "skill-segment", entry: { skill: { label: "browser" } } },
      { type: "tool-segment", turnId: "open-page", entries: [{ id: "open" }] },
      { type: "reasoning-segment", entry: { id: "thought-1" } },
      { type: "tool-segment", turnId: "turn-1", entries: [{ id: "tool-a" }, { id: "tool-b" }] },
      { type: "message", entry: { content: "Here it is" } },
    ]);
  });

  it("groups same-turn tools once even when assistant text is interleaved", () => {
    const entries: ChatEntry[] = [
      { role: "assistant", content: "Starting work", turnId: "turn-1" },
      { id: "tool-a-start", type: "tool", turnId: "turn-1", toolCall: createToolCall("tool-a", { progressText: "Running" }) },
      { role: "assistant", content: "Checkpoint", turnId: "turn-1" },
      { id: "tool-b", type: "tool", turnId: "turn-1", toolCall: createToolCall("tool-b") },
      { id: "tool-a-done", type: "tool", turnId: "turn-1", toolCall: createToolCall("tool-a", { result: "Done", success: true }) },
      { role: "assistant", content: "Finished", turnId: "turn-1" },
    ];

    const segments = segmentChatEntries(entries);

    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({ type: "message", entry: { content: "Starting work" } });
    expect(segments[1]).toMatchObject({
      type: "tool-segment",
      turnId: "turn-1",
      entries: [
        { id: "tool-a-start", toolCall: { toolCallId: "tool-a", progressText: "Running" } },
        { id: "tool-b", toolCall: { toolCallId: "tool-b" } },
        { id: "tool-a-done", toolCall: { toolCallId: "tool-a", result: "Done" } },
      ],
    });
    expect(segments[2]).toMatchObject({ type: "message", entry: { content: "Checkpoint" } });
    expect(segments[3]).toMatchObject({ type: "message", entry: { content: "Finished" } });
  });

  it("does not merge reused turn IDs across user-message boundaries", () => {
    const entries: ChatEntry[] = [
      { role: "assistant", content: "Previous reply", turnId: "turn-1" },
      { id: "old-tool", type: "tool", turnId: "turn-1", toolCall: createToolCall("old-tool") },
      { role: "user", content: "Next question" },
      { id: "new-tool", type: "tool", turnId: "turn-1", toolCall: createToolCall("new-tool") },
      { role: "assistant", content: "Current reply", turnId: "turn-1" },
    ];

    const segments = segmentChatEntries(entries);

    expect(segments).toMatchObject([
      { type: "message", entry: { content: "Previous reply" } },
      {
        type: "tool-segment",
        entries: [{ toolCall: { toolCallId: "old-tool" } }],
      },
      { type: "message", entry: { content: "Next question" } },
      {
        type: "tool-segment",
        entries: [{ toolCall: { toolCallId: "new-tool" } }],
      },
      { type: "message", entry: { content: "Current reply" } },
    ]);
  });

  it("keeps nonconsecutive and consecutive reused turn ids in their own instances", () => {
    const entries: ChatEntry[] = [
      { role: "assistant", content: "First pass", turnId: "0", turnInstanceId: "turn-start-a" },
      {
        id: "tool-a",
        type: "tool",
        turnId: "0",
        turnInstanceId: "turn-start-a",
        toolCall: createToolCall("tool-a"),
      },
      { role: "assistant", content: "Second turn", turnId: "1", turnInstanceId: "turn-start-b" },
      {
        id: "tool-b",
        type: "tool",
        turnId: "1",
        turnInstanceId: "turn-start-b",
        toolCall: createToolCall("tool-b"),
      },
      { role: "assistant", content: "Resumed pass", turnId: "0", turnInstanceId: "turn-start-c" },
      {
        id: "tool-c",
        type: "tool",
        turnId: "0",
        turnInstanceId: "turn-start-c",
        toolCall: createToolCall("tool-c"),
      },
      {
        id: "completion-c",
        type: "completion",
        turnId: "0",
        turnInstanceId: "turn-start-c",
        content: "Paused",
        completion: {
          content: "Paused",
          title: "Task complete",
          status: "success",
          sourceEventType: "session.task_complete",
        },
      },
      {
        id: "tool-resumed",
        type: "tool",
        turnId: "0",
        turnInstanceId: "turn-start-resumed",
        toolCall: createToolCall("tool-resumed"),
      },
      { role: "assistant", content: "Finished", turnId: "0", turnInstanceId: "turn-start-resumed" },
    ];

    expect(segmentChatEntries(entries)).toMatchObject([
      { type: "message", entry: { content: "First pass" } },
      { type: "tool-segment", turnInstanceId: "turn-start-a", entries: [{ id: "tool-a" }] },
      { type: "message", entry: { content: "Second turn" } },
      { type: "tool-segment", turnInstanceId: "turn-start-b", entries: [{ id: "tool-b" }] },
      { type: "message", entry: { content: "Resumed pass" } },
      { type: "tool-segment", turnInstanceId: "turn-start-c", entries: [{ id: "tool-c" }] },
      { type: "completion-segment", entry: { content: "Paused" } },
      {
        type: "tool-segment",
        turnInstanceId: "turn-start-resumed",
        entries: [{ id: "tool-resumed" }],
      },
      { type: "message", entry: { content: "Finished" } },
    ]);
  });

  it("keeps a sub-agent's calls where they happened, apart from the main agent's turn groups", () => {
    const entries: ChatEntry[] = [
      { role: "assistant", content: "Delegating work", turnId: "turn-1" },
      {
        id: "agent-a",
        type: "tool",
        turnId: "turn-1",
        toolCall: createToolCall("agent-a", { isSubAgent: true }),
      },
      {
        id: "agent-b",
        type: "tool",
        turnId: "turn-1",
        toolCall: createToolCall("agent-b", { isSubAgent: true }),
      },
      {
        id: "child-a",
        type: "tool",
        turnId: "turn-2",
        toolCall: createToolCall("child-a", { parentToolCallId: "agent-a" }),
      },
      { role: "assistant", content: "Agents are running", turnId: "turn-2" },
      {
        id: "read-agent",
        type: "tool",
        turnId: "turn-2",
        toolCall: createToolCall("read-agent"),
      },
    ];

    // The agent's call shares a turn id with the main agent's later call, and must not pull that
    // call up above the reply it followed.
    expect(segmentChatEntries(entries)).toMatchObject([
      { type: "message", entry: { content: "Delegating work" } },
      { type: "tool-segment", turnId: "turn-1", entries: [{ id: "agent-a" }, { id: "agent-b" }] },
      { type: "tool-segment", entries: [{ id: "child-a" }] },
      { type: "message", entry: { content: "Agents are running" } },
      { type: "tool-segment", turnId: "turn-2", entries: [{ id: "read-agent" }] },
    ]);
    expect(segmentChatEntries(entries)[2]).not.toHaveProperty("turnId");
  });

  it("keeps the main agent's turns apart by turn instance when provider ids repeat", () => {
    const entries: ChatEntry[] = [
      { role: "assistant", content: "Delegating first", turnId: "0", turnInstanceId: "turn-root-a" },
      {
        id: "agent-a",
        type: "tool",
        turnId: "0",
        turnInstanceId: "turn-root-a",
        toolCall: createToolCall("agent-a", { isSubAgent: true }),
      },
      {
        id: "child-a",
        type: "tool",
        turnId: "1",
        turnInstanceId: "turn-child-a",
        toolCall: createToolCall("child-a", { parentToolCallId: "agent-a" }),
      },
      { role: "assistant", content: "First agent done", turnId: "1", turnInstanceId: "turn-child-a" },
      { role: "assistant", content: "Delegating resumed", turnId: "0", turnInstanceId: "turn-root-b" },
      {
        id: "agent-b",
        type: "tool",
        turnId: "0",
        turnInstanceId: "turn-root-b",
        toolCall: createToolCall("agent-b", { isSubAgent: true }),
      },
      {
        id: "child-b",
        type: "tool",
        turnId: "1",
        turnInstanceId: "turn-child-b",
        toolCall: createToolCall("child-b", { parentToolCallId: "agent-b" }),
      },
      { role: "assistant", content: "Second agent done", turnId: "1", turnInstanceId: "turn-child-b" },
    ];

    expect(segmentChatEntries(entries)).toMatchObject([
      { type: "message", entry: { content: "Delegating first" } },
      { type: "tool-segment", turnInstanceId: "turn-root-a", entries: [{ id: "agent-a" }] },
      { type: "tool-segment", entries: [{ id: "child-a" }] },
      { type: "message", entry: { content: "First agent done" } },
      { type: "message", entry: { content: "Delegating resumed" } },
      { type: "tool-segment", turnInstanceId: "turn-root-b", entries: [{ id: "agent-b" }] },
      { type: "tool-segment", entries: [{ id: "child-b" }] },
      { type: "message", entry: { content: "Second agent done" } },
    ]);
  });

  it("leaves a run of sub-agent calls as one segment, whatever turns the agents were in", () => {
    // The entries a real run produced: two agents side by side. Agent one finished a turn while
    // agent two was mid-turn, so agent two's next two calls carry no turn of their own.
    const child = (id: string, parent: string, turnInstanceId?: string): ChatEntry => ({
      id,
      type: "tool",
      ...(turnInstanceId ? { turnInstanceId } : {}),
      toolCall: createToolCall(id, { parentToolCallId: parent, completedAt: "2026-09-20T16:50:00.000Z", success: true }),
    });
    const entries: ChatEntry[] = [
      { role: "user", content: "Launch two agents" },
      { id: "agent-one", type: "tool", turnInstanceId: "turn-launch", toolCall: createToolCall("agent-one", { isSubAgent: true }) },
      { id: "agent-two", type: "tool", turnInstanceId: "turn-launch", toolCall: createToolCall("agent-two", { isSubAgent: true }) },
      child("one-a", "agent-one", "sub-turn-1"),
      child("two-a", "agent-two", "sub-turn-1"),
      child("two-b", "agent-two", "sub-turn-1"),
      child("one-b", "agent-one", "sub-turn-2"),
      child("two-c", "agent-two", "sub-turn-2"),
      child("two-d", "agent-two"),
      child("two-e", "agent-two"),
      child("two-f", "agent-two", "sub-turn-3"),
      { role: "assistant", content: "Both agents reported back." },
    ];

    const toolSegments = segmentChatEntries(entries).filter((segment) => segment.type === "tool-segment");
    // The launches are the main agent's turn; the agents' calls follow in the order they were made.
    expect(toolSegments.map((segment) => segment.entries.map((entry) => entry.id))).toEqual([
      ["agent-one", "agent-two"],
      ["one-a", "two-a", "two-b", "one-b", "two-c", "two-d", "two-e", "two-f"],
    ]);
    // Rendered together, as the stretch of work they belong to renders them, each agent is one row.
    const forest = buildToolCallForest(entries.flatMap((entry) => entry.type === "tool" ? [entry.toolCall] : []));
    const roots = buildRenderableSegmentRoots(toolSegments.flatMap((segment) => segment.entries), forest);
    expect(roots.map((root) => [root.toolCall.toolCallId, root.isContextOnly, root.children.length])).toEqual([
      ["agent-one", false, 2],
      ["agent-two", false, 6],
    ]);
  });

  it("collapses repeated same-turn snapshots into one renderable root", () => {
    const running = createToolCall("agent-1", {
      name: "🤖 Explore agent",
      isSubAgent: true,
      progressText: "Running",
    });
    const complete = createToolCall("agent-1", {
      name: "🤖 Explore agent",
      isSubAgent: true,
      result: "Done",
      success: true,
      completedAt: "2026-04-23T21:00:05.000Z",
    });
    const fullForest = buildToolCallForest([running, complete]);

    const roots = buildRenderableSegmentRoots([
      { id: "agent-running", type: "tool", turnId: "turn-1", toolCall: running },
      { id: "agent-complete", type: "tool", turnId: "turn-1", toolCall: complete },
    ], fullForest);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.toolCall.toolCallId).toBe("agent-1");
    expect(roots[0]?.toolCall.progressText).toBeUndefined();
    expect(roots[0]?.toolCall.result).toBe("Done");
  });

  it("shows only this stretch’s children in their local order without replaying their parent’s result", () => {
    const parent = createToolCall("agent", { isSubAgent: true, result: "Final summary", success: true, completedAt: "2026-04-23T21:00:00.000Z" });
    const read = createToolCall("read", { parentToolCallId: "agent", success: true, completedAt: "2026-04-23T21:01:00.000Z" });
    const check = createToolCall("check", { parentToolCallId: "agent", success: false });
    const outside = createToolCall("outside", { parentToolCallId: "agent" });
    const forest = buildToolCallForest([parent, read, check, outside]);

    const roots = buildRenderableSegmentRoots([
      { id: "check-finished", type: "tool", toolCall: check },
      { id: "read-finished", type: "tool", toolCall: read },
    ], forest);

    expect(roots).toMatchObject([{
      toolCall: { toolCallId: "agent" }, isContextOnly: true, loadedChildCount: 3,
      runningCount: 0, doneCount: 1, failedCount: 1,
      children: [{ toolCall: { toolCallId: "check" } }, { toolCall: { toolCallId: "read" } }],
    }]);
    expect(roots[0]?.toolCall.result).toBeUndefined();
    expect(roots[0]?.toolCall.success).toBeUndefined();
    expect(roots[0]?.toolCall.completedAt).toBeUndefined();
    expect(forest.nodesById.get("agent")?.loadedChildCount).toBe(3);
  });

  it("uses the segment-local tool snapshot when the same tool appears again later", () => {
    const earlyTool = createToolCall("tool-1", {
      startedAt: "2026-04-23T21:00:00.000Z",
      progressText: "Running",
    });
    const lateTool = createToolCall("tool-1", {
      startedAt: "2026-04-23T21:00:00.000Z",
      result: "Done",
      success: true,
      completedAt: "2026-04-23T21:00:05.000Z",
    });
    const fullForest = buildToolCallForest([earlyTool, lateTool]);

    const earlyRoots = buildRenderableSegmentRoots([
      { id: "tool-1-early", type: "tool", toolCall: earlyTool },
    ], fullForest);
    const lateRoots = buildRenderableSegmentRoots([
      { id: "tool-1-late", type: "tool", toolCall: lateTool },
    ], fullForest);

    expect(earlyRoots[0]?.toolCall.progressText).toBe("Running");
    expect(earlyRoots[0]?.toolCall.completedAt).toBeUndefined();
    expect(lateRoots[0]?.toolCall.result).toBe("Done");
    expect(lateRoots[0]?.toolCall.completedAt).toBe("2026-04-23T21:00:05.000Z");
  });
});

// ---------------------------------------------------------------------------
// tool-args helpers (merged from tool-args.test.ts)
// ---------------------------------------------------------------------------
import { formatToolArgsDetails, hasToolArgs } from "./tool-args";

describe("tool arg helpers", () => {
  it("formats detail output for both strings and objects", () => {
    expect(formatToolArgsDetails("line 1\nline 2")).toBe("line 1\nline 2");
    expect(JSON.parse(formatToolArgsDetails({ shellId: "123", delay: 10 }))).toEqual({ shellId: "123", delay: 10 });
  });

  it("detects whether any arguments are present", () => {
    expect(hasToolArgs(undefined)).toBe(false);
    expect(hasToolArgs("")).toBe(false);
    expect(hasToolArgs([])).toBe(false);
    expect(hasToolArgs({})).toBe(false);
    expect(hasToolArgs(false)).toBe(true);
    expect(hasToolArgs("patch")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tool-call-status helpers (merged from tool-call-status.test.ts)
// ---------------------------------------------------------------------------
import { getToolCallStatus, getToolCallStatusLabel } from "./tool-call-status";

describe("tool call status helpers", () => {
  it("maps tool call state to status and label: running, done, failed, partial running", () => {
    // incomplete → running
    expect(getToolCallStatus({})).toBe("running");
    expect(getToolCallStatusLabel("running")).toBe("Running");
    // completedAt or success:true → done
    expect(getToolCallStatus({ completedAt: "2026-04-22T20:00:00.000Z" })).toBe("done");
    expect(getToolCallStatus({ success: true })).toBe("done");
    // success:false → failed (even with completedAt and result)
    expect(getToolCallStatus({ success: false })).toBe("failed");
    expect(getToolCallStatus({ success: false, completedAt: "2026-04-22T20:00:00.000Z", result: "traceback" })).toBe("failed");
    expect(getToolCallStatusLabel("failed")).toBe("Failed");
    // partial output without explicit completion → still running
    expect(getToolCallStatus({ result: "Agent summary" })).toBe("running");
  });
});

describe("segmentChatEntries autopilot continuations", () => {
  it("gives continuations their own segment and merges ones with nothing between them", () => {
    const segments = segmentChatEntries([
      { type: "message", role: "user", content: "go", agentMode: "autopilot", id: "u1" },
      { type: "message", role: "assistant", content: "step one", id: "a1" },
      { type: "continuation", id: "c1" },
      { type: "continuation", id: "c2" },
      { type: "message", role: "assistant", content: "step two", id: "a2" },
      { type: "continuation", id: "c3" },
    ]);
    expect(segments.map((segment) => segment.type)).toEqual([
      "message", "message", "continuation-segment", "message", "continuation-segment",
    ]);
    expect(segments[2]).toMatchObject({ count: 2, entry: { id: "c1" } });
    expect(segments[4]).toMatchObject({ count: 1, entry: { id: "c3" } });
  });
});
