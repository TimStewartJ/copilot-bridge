import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatReasoningEntry, ChatToolEntry, ToolCall } from "../../api";
import { groupActivitySegments, type ActivityBlock as ActivityBlockModel } from "../../lib/chat-activity";
import { buildToolCallForest, segmentChatEntries } from "../../lib/tool-call-tree";
import ActivityBlock from "./ActivityBlock";
import { ChatRunActiveProvider } from "./chat-run-context";

const BASE_MS = Date.parse("2026-09-20T08:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

function thought(
  id: string,
  content: string,
  partial: Partial<ChatReasoningEntry["reasoning"]> = {},
  turnInstanceId = "turn-a",
): ChatReasoningEntry {
  return { id, type: "reasoning", turnInstanceId, content, reasoning: { messageEventId: `${id}-message`, ...partial } };
}

function tool(
  id: string,
  toolCall: Partial<ToolCall> & Pick<ToolCall, "name">,
  turnInstanceId = "turn-a",
): ChatToolEntry {
  return { id, type: "tool", turnInstanceId, toolCall: { toolCallId: `${id}-call`, ...toolCall } };
}

function render(
  entries: ChatEntry[],
  props: { expanded?: boolean; live?: boolean; liveLabel?: string; runActive?: boolean } = {},
) {
  const block = groupActivitySegments(segmentChatEntries(entries))
    .find((candidate): candidate is ActivityBlockModel => candidate.type === "activity");
  if (!block) throw new Error("No activity block");
  const toolForest = buildToolCallForest(entries.flatMap((entry) => entry.type === "tool" ? [entry.toolCall] : []));
  const html = renderToStaticMarkup(createElement(
    ChatRunActiveProvider,
    { value: props.runActive ?? true },
    createElement(ActivityBlock, {
      block,
      toolForest,
      expanded: props.expanded ?? false,
      onToggle: () => {},
      live: props.live,
      liveLabel: props.liveLabel,
    }),
  ));
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}

// Two model calls: each thinks, then calls a tool.
const finishedRun: ChatEntry[] = [
  thought("t1", "I should read the config before touching it.", { startedAt: at(0) }),
  tool("read", { name: "view", args: { path: "/repo/config.ts" }, startedAt: at(2), completedAt: at(3), success: true }),
  thought("t2", "Now run the tests.", { startedAt: at(3) }, "turn-b"),
  tool("test", {
    name: "powershell",
    args: { command: "npm test", description: "Run the test suite" },
    startedAt: at(5),
    completedAt: at(134),
    success: true,
  }, "turn-b"),
];

describe("ActivityBlock", () => {
  it("collapses finished work into one line that says how long it took", () => {
    const { html, text } = render(finishedRun);

    expect(text).toBe("Worked for 2m 14s 2 steps");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-activity-state="done"');
    // The timeline is not mounted until it is asked for.
    expect(text).not.toContain("Run the test suite");
    expect(html).not.toContain("shimmer-text");
  });

  it("opens into the thinking and tool calls in the order they happened", () => {
    const { text } = render(finishedRun, { expanded: true });

    const order = [
      "I should read the config before touching it.",
      "Read repo/config.ts",
      "Now run the tests.",
      "Run the test suite",
    ].map((needle) => text.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("reads as the thought itself when thinking is all there was", () => {
    const { text } = render([thought("t1", "**Weighing the options**\n\nBoth designs work, but one is simpler.")]);

    expect(text).toBe("Thought Weighing the options");
  });

  it("reads as the tool call when there was only one", () => {
    const { text } = render([
      tool("read", { name: "view", args: { path: "/repo/src/App.tsx" }, startedAt: at(0), completedAt: at(1), success: true }),
    ]);

    expect(text).toBe("Read src/App.tsx");
  });

  it("surfaces failures without opening the block", () => {
    const { text } = render([
      tool("a", { name: "bash", args: { command: "npm test" }, startedAt: at(0), completedAt: at(4), success: false, result: "exit 1" }),
      tool("b", { name: "bash", args: { command: "npm run lint" }, startedAt: at(4), completedAt: at(6), success: true }),
    ]);

    expect(text).toContain("2 steps");
    expect(text).toContain("1 failed");
  });

  it("names the step in flight while a tool is running", () => {
    const { html, text } = render([
      thought("t1", "Run the suite."),
      tool("test", { name: "powershell", args: { command: "npm test", description: "Run the test suite" }, startedAt: at(0) }),
    ], { live: true });

    expect(text).toContain("Run the test suite");
    expect(text).toContain("npm test");
    expect(html).toContain("shimmer-text");
    expect(html).toContain('data-activity-state="active"');
  });

  it("shows streaming thinking in a fixed window while collapsed, and in full once opened", () => {
    const entries = [thought("t1", "First I need to check how the scanner counts entries.", { streaming: true })];

    const collapsed = render(entries, { live: true });
    expect(collapsed.text).toContain("Thinking");
    expect(collapsed.html).toContain("data-thought-window");
    expect(collapsed.text).toContain("how the scanner counts entries.");

    const expanded = render(entries, { live: true, expanded: true });
    expect(expanded.html).not.toContain("data-thought-window");
    expect(expanded.html).toContain('data-thought-state="streaming"');
  });

  it("says what the agent is doing between steps, or just that it is working", () => {
    const entries = [
      tool("read", { name: "view", args: { path: "/repo/a.ts" }, startedAt: at(0), completedAt: at(1), success: true }),
    ];

    expect(render(entries, { live: true, liveLabel: "Exploring the codebase" }).text).toContain("Exploring the codebase");
    expect(render(entries, { live: true }).text).toContain("Working");
    expect(render(entries, { live: true }).html).toContain("shimmer-text");
  });

  it("names a running agent and what it is doing right now, not just its brief", () => {
    const entries = [
      tool("agent", {
        name: "🤖 Explore agent",
        isSubAgent: true,
        args: { description: "Map the streaming code" },
        startedAt: at(0),
      }),
      tool("child-done", { name: "glob", args: { pattern: "*.ts" }, parentToolCallId: "agent-call", startedAt: at(1), completedAt: at(2), success: true }),
      tool("child-now", { name: "rg", args: { pattern: "liveReasoning", paths: "/repo/src/shared" }, parentToolCallId: "agent-call", startedAt: at(2) }),
    ];

    const { text, html } = render(entries, { live: true });

    expect(text).toContain("Explore agent");
    expect(text).toContain("Searching liveReasoning in src/shared");
    // The agent's own calls are its business, not extra steps the reader is waiting on.
    expect(text).not.toContain("more");
    expect(html).toContain("shimmer-text");
  });

  it("counts other agents and own calls as more, but never an agent's inner calls", () => {
    const entries = [
      tool("agent-a", { name: "🤖 Research agent", isSubAgent: true, args: { description: "Read the docs" }, startedAt: at(0) }),
      tool("a-child", { name: "view", args: { path: "/repo/README.md" }, parentToolCallId: "agent-a-call", startedAt: at(1) }),
      tool("agent-b", { name: "🤖 Test agent", isSubAgent: true, args: { description: "Run the tests" }, startedAt: at(0) }),
      tool("b-child", { name: "powershell", args: { command: "npm test", description: "Run the suite" }, parentToolCallId: "agent-b-call", startedAt: at(1) }),
    ];

    const { text } = render(entries, { live: true });

    expect(text).toContain("Test agent");
    expect(text).toContain("Run the suite npm test");
    expect(text).toContain("+1 more");
    expect(text).not.toContain("+3 more");
  });

  it("credits a background agent for calls it is still making after its launch returned", () => {
    const entries = [
      // The launching call came back at once; the agent carries on in the background.
      tool("agent", { name: "🤖 expedition-rewards", isSubAgent: true, args: { description: "Assess rewards" }, startedAt: at(0), completedAt: at(0), success: true }),
      tool("child", { name: "view", args: { path: "/repo/server/FoodSystem.java" }, parentToolCallId: "agent-call", startedAt: at(5) }),
    ];

    const { text } = render(entries, { live: true });

    expect(text).toContain("expedition-rewards");
    expect(text).toContain("Reading server/FoodSystem.java");
  });

  it("does not keep a step spinning after the run that owned it is over", () => {
    // The log ends mid-call: the server restarted, so no completion was ever recorded.
    const entries = [
      tool("read", { name: "view", args: { path: "/repo/a.ts" }, startedAt: at(0), completedAt: at(1), success: true }),
      tool("test", { name: "powershell", args: { command: "npm test", description: "Run the test suite" }, startedAt: at(1) }, "turn-b"),
    ];

    const collapsed = render(entries, { runActive: false });
    expect(collapsed.html).toContain('data-activity-state="done"');
    expect(collapsed.html).not.toContain("shimmer-text");
    expect(collapsed.text).toContain("Worked");

    const expanded = render(entries, { runActive: false, expanded: true });
    expect(expanded.html).toContain('data-tool-status="unfinished"');
    expect(expanded.text).toContain("did not finish");
    expect(expanded.html).not.toContain("animate-spin");

    // While the run is still going, the same entries are simply a call in flight.
    expect(render(entries, { runActive: true }).html).toContain('data-activity-state="active"');
  });
});
