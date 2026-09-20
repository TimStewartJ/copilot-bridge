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

/** Text a reader sees, without the markup around it. */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("ToolCallNodeGroup", () => {
  it("renders sibling calls as one row each, in the order they started", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("first", 0, 2),
      completedToolCall("second", 3, 5),
      completedToolCall("third", 6, 8),
    ]);

    const text = visibleText(renderToStaticMarkup(createElement(ToolCallNodeGroup, { nodes: roots })));

    expect(text.indexOf("First")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Second")).toBeGreaterThan(text.indexOf("First"));
    expect(text.indexOf("Third")).toBeGreaterThan(text.indexOf("Second"));
  });

  it("keeps calls that ran in parallel as plain adjacent rows", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("long", 0, 10),
      completedToolCall("overlap", 5, 15),
      completedToolCall("later", 15, 20),
    ]);

    const html = renderToStaticMarkup(createElement(ToolCallNodeGroup, { nodes: roots }));

    expect(html).not.toContain("Track 1");
    expect(html).not.toContain('role="group"');
    expect(html.match(/data-tool-status="done"/g)).toHaveLength(3);
  });

  it("describes a call by what it did instead of by its tool name", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("shell", 0, 3, {
        name: "powershell",
        args: { command: "git --no-pager status --short", description: "Check the working tree" },
      }),
      completedToolCall("read", 3, 4, {
        name: "view",
        args: { path: "E:\\repo\\src\\client\\App.tsx", view_range: [10, 40] },
      }),
      toolCall("search", { name: "grep", args: { pattern: "useSessionStream" }, startedAt: at(4) }),
    ]);

    const text = visibleText(renderToStaticMarkup(createElement(ToolCallNodeGroup, { nodes: roots })));

    expect(text).toContain("Check the working tree git --no-pager status --short");
    expect(text).toContain("Read client/App.tsx · lines 10–40");
    // Still in flight, so the verb is in the present tense.
    expect(text).toContain("Searching useSessionStream");
    expect(text).not.toContain("powershell");
  });

  it("shows how long a call took once that is worth a glance", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("instant", 0, 0.2),
      completedToolCall("slow", 1, 75),
    ]);

    const text = visibleText(renderToStaticMarkup(createElement(ToolCallNodeGroup, { nodes: roots })));

    expect(text).toContain("1m 14s");
    expect(text).not.toContain("200ms");
  });

  it("marks a failed call and a running call without colouring the finished ones", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("fine", 0, 1),
      completedToolCall("broken", 1, 2, { success: false, result: "exit code 1" }),
      toolCall("pending", { startedAt: at(2) }),
    ]);

    const html = renderToStaticMarkup(createElement(ToolCallNodeGroup, { nodes: roots }));

    expect(html).toContain('data-tool-status="failed"');
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain('data-tool-status="running"');
    expect(html).toContain('aria-label="Running"');
    expect(html).not.toContain("text-success");
  });

  it("nests an agent's own tool calls beneath its row", () => {
    const { roots } = buildToolCallForest([
      toolCall("agent", { name: "🤖 analyzer", isSubAgent: true }),
      completedToolCall("child-a", 0, 10, { parentToolCallId: "agent" }),
      completedToolCall("child-b", 5, 8, { parentToolCallId: "agent" }),
    ]);

    const text = visibleText(renderToStaticMarkup(
      createElement(ToolCallTree, { node: roots[0]!, defaultExpanded: true }),
    ));

    expect(text).toContain("analyzer");
    expect(text).toContain("2 tools");
    expect(text).toContain("Child a");
    expect(text).toContain("Child b");
  });

  it("renders delegated tasks and follow-ups inside the expanded agent row", () => {
    const { roots } = buildToolCallForest([
      toolCall("agent", {
        name: "🤖 Explore agent",
        isSubAgent: true,
        args: {
          description: "Investigate scheduler race",
          prompt: "Inspect the scheduler tests.",
        },
        agentInstructions: [
          { kind: "task", content: "Inspect the scheduler tests." },
          { kind: "follow_up", content: "Also verify Windows behavior." },
        ],
      }),
      completedToolCall("child", 0, 2, { parentToolCallId: "agent" }),
    ]);

    const html = renderToStaticMarkup(
      createElement(ToolCallTree, { node: roots[0]!, defaultExpanded: true }),
    );

    expect(html).toContain("Investigate scheduler race");
    expect(html).toContain("Task delegated by Copilot");
    expect(html).toContain("Inspect the scheduler tests.");
    expect(html).toContain("Follow-up from Copilot");
    expect(html).toContain("Also verify Windows behavior.");
  });

  it("keeps full instructions collapsed while showing a concise task summary", () => {
    const { roots } = buildToolCallForest([
      toolCall("agent", {
        name: "🤖 Explore agent",
        isSubAgent: true,
        args: { description: "Investigate scheduler race" },
        agentInstructions: [
          { kind: "task", content: "Long internal task instructions that should stay collapsed." },
        ],
      }),
    ]);

    const html = renderToStaticMarkup(createElement(ToolCallTree, { node: roots[0]! }));

    expect(html).toContain("Investigate scheduler race");
    expect(html).not.toContain("Long internal task instructions that should stay collapsed.");
  });

  it("says on the collapsed agent row when calls inside it failed", () => {
    const { roots } = buildToolCallForest([
      completedToolCall("agent", 0, 60, { name: "🤖 Explore agent", isSubAgent: true, args: { description: "Read the sources" } }),
      completedToolCall("ok", 1, 2, { name: "view", parentToolCallId: "agent" }),
      completedToolCall("missing-a", 2, 3, { name: "view", parentToolCallId: "agent", success: false, result: "not found" }),
      completedToolCall("missing-b", 3, 4, { name: "view", parentToolCallId: "agent", success: false, result: "not found" }),
    ]);

    // Collapsed: the failed rows themselves are not rendered, so the row has to carry the count.
    const text = visibleText(renderToStaticMarkup(createElement(ToolCallTree, { node: roots[0]! })));

    expect(text).toContain("3 tools");
    expect(text).toContain("2 failed");
  });

  it("recurses into an agent launched by another agent", () => {
    const { roots } = buildToolCallForest([
      toolCall("root-agent", { name: "🤖 Root agent", isSubAgent: true }),
      toolCall("child-agent", { name: "🤖 Child agent", isSubAgent: true, parentToolCallId: "root-agent" }),
      completedToolCall("grandchild-a", 0, 10, { parentToolCallId: "child-agent" }),
      completedToolCall("grandchild-b", 1, 8, { parentToolCallId: "child-agent" }),
    ]);

    const text = visibleText(renderToStaticMarkup(
      createElement(ToolCallTree, { node: roots[0]!, defaultExpanded: true }),
    ));

    expect(text).toContain("Root agent");
    expect(text).toContain("Child agent");
    expect(text).toContain("Grandchild a");
    expect(text).toContain("Grandchild b");
  });
});
