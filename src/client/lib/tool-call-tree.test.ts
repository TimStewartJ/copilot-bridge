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
});
