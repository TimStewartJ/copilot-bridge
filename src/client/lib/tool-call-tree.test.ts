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
  it("attaches children even when they arrive before their parent in the flat list", () => {
    const { roots, nodesById } = buildToolCallForest([
      createToolCall("child", { parentToolCallId: "parent" }),
      createToolCall("parent", { isSubAgent: true }),
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.toolCall.toolCallId).toBe("parent");
    expect(roots[0]?.children.map((child) => child.toolCall.toolCallId)).toEqual(["child"]);
    expect(nodesById.get("child")?.rootToolCallId).toBe("parent");
  });

  it("returns only running roots for the live track panel", () => {
    const { roots } = buildToolCallForest([
      createToolCall("running-parent", { isSubAgent: true }),
      createToolCall("done-tool", { completedAt: "2026-04-22T20:00:00.000Z", success: true }),
    ]);

    expect(getActiveToolCallRoots(roots).map((root) => root.toolCall.toolCallId)).toEqual(["running-parent"]);
  });

  it("keeps child tools under the correct root when multiple roots start before their children", () => {
    const { roots } = buildToolCallForest([
      createToolCall("subagent-1", { isSubAgent: true }),
      createToolCall("subagent-2", { isSubAgent: true }),
      createToolCall("subagent-3", { isSubAgent: true }),
      createToolCall("bash-1", { parentToolCallId: "subagent-1" }),
      createToolCall("bash-2", { parentToolCallId: "subagent-2" }),
      createToolCall("bash-3", { parentToolCallId: "subagent-3" }),
    ]);

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

  it("keeps completion entries as their own render segment", () => {
    const entries: ChatEntry[] = [
      { role: "assistant", content: "Starting work" },
      {
        id: "completion-1",
        type: "completion",
        content: "All done",
        completion: {
          content: "All done",
          title: "Task complete",
          status: "success",
          sourceEventType: "session.task_complete",
        },
      },
    ];

    const segments = segmentChatEntries(entries);

    expect(segments).toMatchObject([
      { type: "message", entry: { content: "Starting work" } },
      { type: "completion-segment", entry: { content: "All done" } },
    ]);
  });

  it("keeps skill entries as their own render segment between messages and tools", () => {
    const entries: ChatEntry[] = [
      { role: "user", content: "Use the browser" },
      {
        id: "skill-1",
        type: "skill",
        skill: { id: "skill-browser", label: "browser" },
        content: "<skill-context name=\"browser\"></skill-context>",
      },
      { id: "tool-a", type: "tool", turnId: "turn-1", toolCall: createToolCall("tool-a") },
      { role: "assistant", content: "Done", turnId: "turn-1" },
    ];

    const segments = segmentChatEntries(entries);

    expect(segments).toMatchObject([
      { type: "message", entry: { content: "Use the browser" } },
      { type: "skill-segment", entry: { skill: { label: "browser" } } },
      { type: "tool-segment", turnId: "turn-1" },
      { type: "message", entry: { content: "Done" } },
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

  it("merges root-only subagent launch turns with later descendant tool turns", () => {
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

    const segments = segmentChatEntries(entries);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ type: "message", entry: { content: "Delegating work" } });
    expect(segments[1]).toMatchObject({
      type: "tool-segment",
      turnId: "turn-1",
      entries: [
        { id: "agent-a" },
        { id: "agent-b" },
        { id: "child-a" },
        { id: "read-agent" },
      ],
    });
    expect(segments[2]).toMatchObject({ type: "message", entry: { content: "Agents are running" } });
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

  it("keeps parent context when a later tool segment only contains child rows", () => {
    const allToolCalls = [
      createToolCall("subagent-1", { isSubAgent: true }),
      createToolCall("bash-1", { parentToolCallId: "subagent-1" }),
      createToolCall("bash-2", { parentToolCallId: "subagent-1" }),
    ];
    const fullForest = buildToolCallForest(allToolCalls);
    const laterSegment = [
      { id: "tool-3", type: "tool", toolCall: createToolCall("bash-2", { parentToolCallId: "subagent-1" }) },
    ] as const;

    const roots = buildRenderableSegmentRoots([...laterSegment], fullForest);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.toolCall.toolCallId).toBe("subagent-1");
    expect(roots[0]?.children.map((child) => child.toolCall.toolCallId)).toEqual(["bash-2"]);
  });

  it("does not replay ancestor completion state when only a later child row is visible", () => {
    const fullForest = buildToolCallForest([
      createToolCall("subagent-1", {
        isSubAgent: true,
        result: "Final summary",
        success: true,
        completedAt: "2026-04-23T21:00:00.000Z",
      }),
      createToolCall("bash-2", {
        parentToolCallId: "subagent-1",
        success: true,
        completedAt: "2026-04-23T21:01:00.000Z",
      }),
    ]);

    const roots = buildRenderableSegmentRoots([
      {
        id: "tool-3",
        type: "tool",
        toolCall: createToolCall("bash-2", {
          parentToolCallId: "subagent-1",
          success: true,
          completedAt: "2026-04-23T21:01:00.000Z",
        }),
      },
    ], fullForest);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.toolCall.toolCallId).toBe("subagent-1");
    expect(roots[0]?.isContextOnly).toBe(true);
    expect(roots[0]?.toolCall.result).toBeUndefined();
    expect(roots[0]?.toolCall.success).toBeUndefined();
    expect(roots[0]?.toolCall.completedAt).toBeUndefined();
    expect(roots[0]?.runningCount).toBe(0);
    expect(roots[0]?.doneCount).toBe(1);
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

  it("preserves segment-local sibling order for later child-only segments", () => {
    const fullForest = buildToolCallForest([
      createToolCall("subagent-1", { isSubAgent: true }),
      createToolCall("bash-a", { parentToolCallId: "subagent-1" }),
      createToolCall("bash-b", { parentToolCallId: "subagent-1" }),
    ]);

    const roots = buildRenderableSegmentRoots([
      { id: "tool-b", type: "tool", toolCall: createToolCall("bash-b", { parentToolCallId: "subagent-1" }) },
      { id: "tool-a", type: "tool", toolCall: createToolCall("bash-a", { parentToolCallId: "subagent-1" }) },
    ], fullForest);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.children.map((child) => child.toolCall.toolCallId)).toEqual(["bash-b", "bash-a"]);
  });
});
