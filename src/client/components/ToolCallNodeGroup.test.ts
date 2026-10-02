import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCall, TranscriptAgent } from "../api";
import { buildTranscriptAgentDirectory } from "../../shared/transcript-agents.js";
import { buildRenderableSegmentRoots, buildToolCallForest, type ToolCallTreeNode } from "../lib/tool-call-tree";
import ToolCallNodeGroup, { ToolCallTree } from "./ToolCallNodeGroup";
import { ChatRunActiveProvider } from "./chat/chat-run-context";
import { ActivityBlockKeyProvider, TranscriptAgentsProvider } from "./chat/transcript-agents-context";

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

function agentRecord(partial: Partial<TranscriptAgent> = {}): TranscriptAgent {
  return {
    toolCallId: "agent",
    name: "moves-agent",
    description: "Refactor move generation",
    status: "finished",
    activeMs: 0,
    toolCount: 0,
    failedToolCount: 0,
    ...partial,
  };
}

/**
 * Renders an agent's row as one stretch of a transcript does: `stretch` is the stretch the row is
 * in, and `newestStretch` the newest one that has a row for the agent.
 */
function renderAgentRow(
  node: ToolCallTreeNode,
  options: { runActive?: boolean; stretch?: string; newestStretch?: string; defaultExpanded?: boolean; contextOnly?: boolean } = {},
): string {
  const stretch = options.stretch ?? "stretch-1";
  return renderToStaticMarkup(createElement(
    ChatRunActiveProvider,
    { value: options.runActive ?? true },
    createElement(
      TranscriptAgentsProvider,
      {
        value: {
          directory: buildTranscriptAgentDirectory(node.toolCall.agent ? [node.toolCall.agent] : []),
          latestBlockByAgent: new Map([[node.toolCall.toolCallId, options.newestStretch ?? stretch]]),
        },
      },
      createElement(
        ActivityBlockKeyProvider,
        { value: stretch },
        createElement(ToolCallTree, { node, defaultExpanded: options.defaultExpanded, contextOnly: options.contextOnly }),
      ),
    ),
  ));
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
    expect(text).toContain("2 steps");
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

    expect(text).toContain("3 steps");
    expect(text).toContain("2 failed");
  });

  it("counts a background agent's whole run on the row that launched it, and says where the rest is", () => {
    // The launching call came back in 20ms; the agent then worked for two minutes across later stretches.
    const agent = agentRecord({ background: true, activeMs: 125_000, toolCount: 9, failedToolCount: 2 });
    const { roots } = buildToolCallForest([
      completedToolCall("agent", 0, 0.02, { name: "🤖 moves-agent", isSubAgent: true, agent, result: "All moves refactored." }),
      completedToolCall("child-a", 1, 2, { name: "view", parentToolCallId: "agent" }),
      completedToolCall("child-b", 2, 3, { name: "view", parentToolCallId: "agent" }),
    ]);

    const collapsed = visibleText(renderAgentRow(roots[0]!));
    expect(collapsed).toBe("moves-agent Refactor move generation 9 steps 2 failed 2m 05s");

    const opened = renderAgentRow(roots[0]!, { defaultExpanded: true });
    expect(opened).toContain('data-agent-later-steps="7"');
    expect(visibleText(opened)).toContain("7 more steps in the stretches of work that follow");
    expect(visibleText(opened)).toContain("Response");
  });

  it("counts the steps already on screen when the session's records have not caught up", () => {
    // The records were read after the agent's first step; three are loaded, all in later stretches.
    const agent = agentRecord({ status: "running", background: true, activeMs: 20_000, toolCount: 1 });
    const launch = completedToolCall("agent", 0, 0.02, { name: "🤖 moves-agent", isSubAgent: true, agent });
    const forest = buildToolCallForest([
      launch,
      completedToolCall("child-a", 1, 2, { name: "view", parentToolCallId: "agent" }),
      completedToolCall("child-b", 2, 3, { name: "view", parentToolCallId: "agent" }),
      completedToolCall("child-c", 3, 4, { name: "view", parentToolCallId: "agent" }),
    ]);
    // The stretch that launched the agent holds only the launching call.
    const [launchRow] = buildRenderableSegmentRoots([{ id: "launch", type: "tool", toolCall: launch }], forest);

    const html = renderAgentRow(launchRow!, { newestStretch: "stretch-2", defaultExpanded: true });

    expect(visibleText(html)).toContain("moves-agent Refactor move generation 3 steps");
    expect(html).toContain('data-agent-later-steps="3"');
  });

  it("shows an agent working only on its newest row, with the time it has worked", () => {
    const agent = agentRecord({ status: "running", background: true, activeMs: 60_000, toolCount: 4 });
    const { roots } = buildToolCallForest([
      completedToolCall("agent", 0, 0.02, { name: "🤖 moves-agent", isSubAgent: true, agent, result: "Halfway there." }),
      completedToolCall("child", 1, 2, { name: "view", parentToolCallId: "agent" }),
    ]);

    const newest = renderAgentRow(roots[0]!, { defaultExpanded: true });
    expect(newest).toContain('data-tool-status="running"');
    expect(newest).toContain("animate-spin");
    // What it has said so far is not yet its answer.
    expect(visibleText(newest)).toContain("Latest update");
    expect(visibleText(newest)).not.toContain("Response");

    // The agent has moved on to a later stretch: this row no longer turns.
    const earlier = renderAgentRow(roots[0]!, { newestStretch: "stretch-2" });
    expect(earlier).toContain('data-tool-status="running"');
    expect(earlier).not.toContain("animate-spin");
  });

  it("says an agent did not finish when nothing can still be running it", () => {
    const stopped = agentRecord({ status: "stopped", background: true, activeMs: 30_000, toolCount: 3 });
    const { roots } = buildToolCallForest([
      completedToolCall("agent", 0, 0.02, { name: "🤖 moves-agent", isSubAgent: true, agent: stopped }),
    ]);

    const html = renderAgentRow(roots[0]!, { runActive: false });

    expect(html).toContain('data-tool-status="unfinished"');
    expect(visibleText(html)).toContain("did not finish");
    expect(html).not.toContain("animate-spin");
  });

  it("says what became of an agent where its work ends, not on every stretch in between", () => {
    const rowsFor = (agent: TranscriptAgent) => {
      const { roots } = buildToolCallForest([
        toolCall("agent", { name: "🤖 moves-agent", isSubAgent: true, agent }),
        completedToolCall("child", 1, 2, { name: "view", args: { path: "/repo/moves.ts" }, parentToolCallId: "agent" }),
      ]);
      return {
        between: renderAgentRow(roots[0]!, { contextOnly: true, runActive: false, newestStretch: "stretch-9" }),
        last: renderAgentRow(roots[0]!, { contextOnly: true, runActive: false }),
      };
    };

    // An agent that worked through twenty stretches and was then stopped did not fail twenty times.
    const stopped = rowsFor(agentRecord({ status: "stopped", background: true, toolCount: 40 }));
    expect(stopped.between).toContain('data-tool-status="done"');
    expect(visibleText(stopped.between)).toBe("moves-agent Refactor move generation 1 step");
    expect(stopped.last).toContain('data-tool-status="unfinished"');
    expect(visibleText(stopped.last)).toContain("did not finish");

    const failed = rowsFor(agentRecord({ status: "failed", background: true, toolCount: 40 }));
    expect(failed.between).toContain('data-tool-status="done"');
    expect(failed.between).not.toContain('aria-label="Failed"');
    expect(failed.last).toContain('data-tool-status="failed"');
    expect(failed.last).toContain('aria-label="Failed"');
  });

  it("opens a row for a later stretch onto what the agent did there, without its brief or answer", () => {
    const agent = agentRecord({ background: true, activeMs: 125_000, toolCount: 9 });
    const { roots } = buildToolCallForest([
      toolCall("agent", {
        name: "🤖 moves-agent",
        isSubAgent: true,
        agent,
        agentInstructions: [{ kind: "task", content: "Refactor the move generator end to end." }],
      }),
      completedToolCall("child-a", 1, 2, { name: "view", args: { path: "/repo/moves.ts" }, parentToolCallId: "agent" }),
      completedToolCall("child-b", 2, 3, { name: "view", args: { path: "/repo/board.ts" }, parentToolCallId: "agent" }),
    ]);

    const html = renderAgentRow(roots[0]!, { contextOnly: true, defaultExpanded: true });
    const text = visibleText(html);

    expect(html).toContain('data-agent-row="continued"');
    // The steps of this stretch, not the nine of its whole run, and no time for the whole run.
    expect(text).toContain("moves-agent Refactor move generation 2 steps");
    expect(text).not.toContain("2m 05s");
    expect(text).toContain("Read repo/moves.ts");
    expect(text).not.toContain("Task delegated by Copilot");
    expect(html).not.toContain("data-agent-later-steps");
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
