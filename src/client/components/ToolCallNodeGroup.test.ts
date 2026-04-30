import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../api";
import { buildToolCallForest } from "../lib/tool-call-tree";
import ToolCallNodeGroup, { ToolCallTree } from "./ToolCallNodeGroup";

const BASE_MS = Date.parse("2026-04-23T20:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

function toolCall(toolCallId: string, partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId,
    name: partial.name ?? toolCallId,
    ...partial,
  };
}

function completedToolCall(
  toolCallId: string,
  startSeconds: number,
  endSeconds: number,
  partial: Partial<ToolCall> = {},
): ToolCall {
  return toolCall(toolCallId, {
    startedAt: at(startSeconds),
    completedAt: at(endSeconds),
    success: true,
    ...partial,
  });
}

describe("ToolCallNodeGroup", () => {
  it("renders five sequential sibling roots as compact tool rows", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("first", 0, 2),
      completedToolCall("second", 3, 5),
      completedToolCall("third", 6, 8),
      completedToolCall("fourth", 9, 11),
      completedToolCall("fifth", 12, 14),
    ]);

    const html = renderToStaticMarkup(createElement(ToolCallNodeGroup, { nodes: roots }));

    expect(html).toContain("first");
    expect(html).toContain("fifth");
    expect(html).not.toContain("Track 1");
    expect(html).not.toContain('role="group"');
  });

  it("renders overlapping sibling nodes as labeled lanes", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("long", 0, 10),
      completedToolCall("overlap", 5, 15),
      completedToolCall("later", 15, 20),
    ]);

    const html = renderToStaticMarkup(createElement(ToolCallNodeGroup, { nodes: roots }));

    expect(html).toContain("Track 1");
    expect(html).toContain("Track 2");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Track 1, 2 tools"');
    expect(html).toContain('aria-label="Track 2, 1 tool"');
  });

  it("renders parallel top-level subagents as separate accessible lanes", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("agent-a", 0, 12, { name: "🤖 Research agent", isSubAgent: true }),
      completedToolCall("agent-b", 2, 10, { name: "🤖 Test agent", isSubAgent: true }),
    ]);

    const html = renderToStaticMarkup(createElement(ToolCallNodeGroup, { nodes: roots }));

    expect(html).toContain("Research agent");
    expect(html).toContain("Test agent");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Track 1, 1 tool"');
    expect(html).toContain('aria-label="Track 2, 1 tool"');
  });

  it("renders nested parallel child nodes through the tree renderer", () => {
    const { roots } = buildToolCallForest([
      toolCall("agent", { name: "🤖 analyzer", isSubAgent: true }),
      completedToolCall("child-a", 0, 10, { parentToolCallId: "agent" }),
      completedToolCall("child-b", 5, 8, { parentToolCallId: "agent" }),
    ]);

    const html = renderToStaticMarkup(
      createElement(ToolCallTree, { node: roots[0]!, defaultExpanded: true }),
    );

    expect(html).toContain("analyzer");
    expect(html).toContain("Track 1");
    expect(html).toContain("Track 2");
    expect(html).toContain('aria-label="Track 2, 1 tool"');
  });

  it("recurses into child subagents when their tools need nested lanes", () => {
    const { roots } = buildToolCallForest([
      toolCall("root-agent", { name: "🤖 Root agent", isSubAgent: true }),
      toolCall("child-agent", { name: "🤖 Child agent", isSubAgent: true, parentToolCallId: "root-agent" }),
      completedToolCall("grandchild-a", 0, 10, { parentToolCallId: "child-agent" }),
      completedToolCall("grandchild-b", 1, 8, { parentToolCallId: "child-agent" }),
    ]);

    const html = renderToStaticMarkup(
      createElement(ToolCallTree, { node: roots[0]!, defaultExpanded: true }),
    );

    expect(html).toContain("Root agent");
    expect(html).toContain("Child agent");
    expect(html).toContain("grandchild-a");
    expect(html).toContain("grandchild-b");
    expect(html).toContain('aria-label="Track 1, 1 tool"');
    expect(html).toContain('aria-label="Track 2, 1 tool"');
  });
});
