import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ChatReasoningEntry, ChatToolEntry, ToolCall, TranscriptAgent } from "../../api";
import { buildTranscriptAgentDirectory } from "../../../shared/transcript-agents.js";
import { groupActivitySegments, mapLatestAgentBlocks, type ActivityBlock as ActivityBlockModel } from "../../lib/chat-activity";
import { buildToolCallForest, segmentChatEntries } from "../../lib/tool-call-tree";
import { attachTranscriptAgents, buildAgentPlaceholders } from "../../lib/transcript-agents";
import ActivityBlock, { type ActivityWaitingText } from "./ActivityBlock";
import { ChatRunActiveProvider } from "./chat-run-context";
import { TranscriptAgentsProvider } from "./transcript-agents-context";

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

/** An agent's call. It names the call that launched the agent as its parent. */
function agentTool(id: string, agent: string, toolCall: Partial<ToolCall> & Pick<ToolCall, "name">): ChatToolEntry {
  return { id, type: "tool", toolCall: { toolCallId: `${id}-call`, parentToolCallId: `${agent}-call`, ...toolCall } };
}

function agentRecord(agent: string, partial: Partial<TranscriptAgent> = {}): TranscriptAgent {
  return {
    toolCallId: `${agent}-call`,
    name: agent,
    status: "finished",
    activeMs: 0,
    toolCount: 0,
    failedToolCount: 0,
    ...partial,
  };
}

/** Renders one stretch of `loaded` the way the chat does: agents attached, stand-ins for launches not loaded. */
function render(
  loaded: ChatEntry[],
  props: {
    expanded?: boolean;
    live?: boolean;
    latest?: boolean;
    liveLabel?: string;
    waiting?: ActivityWaitingText;
    runActive?: boolean;
    /** The session's agent records, as a history read carries them. */
    agents?: TranscriptAgent[];
    /** Which stretch to render; the first by default. */
    stretch?: number;
  } = {},
) {
  const directory = buildTranscriptAgentDirectory(props.agents);
  const entries = attachTranscriptAgents(loaded, directory, new WeakMap());
  const blocks = groupActivitySegments(segmentChatEntries(entries), { agents: directory });
  const block = blocks
    .filter((candidate): candidate is ActivityBlockModel => candidate.type === "activity")[props.stretch ?? 0];
  if (!block) throw new Error("No activity block");
  const toolCalls = entries.flatMap((entry) => entry.type === "tool" ? [entry.toolCall] : []);
  const toolForest = buildToolCallForest([...buildAgentPlaceholders(toolCalls, directory), ...toolCalls]);
  const html = renderToStaticMarkup(createElement(
    ChatRunActiveProvider,
    { value: props.runActive ?? true },
    createElement(
      TranscriptAgentsProvider,
      { value: { directory, latestBlockByAgent: mapLatestAgentBlocks(blocks) } },
      createElement(ActivityBlock, {
        block,
        toolForest,
        expanded: props.expanded ?? false,
        onToggle: () => {},
        live: props.live,
        latest: props.latest,
        liveLabel: props.liveLabel,
        waiting: props.waiting,
      }),
    ),
  ));
  // Text nodes that React renders side by side come out touching, as they do on screen.
  return { html, text: html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/ ,/g, ",").trim() };
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("says how many agents it is waiting on when several are in flight, not what one of them is doing", () => {
    const entries = [
      tool("agent-a", { name: "🤖 Research agent", isSubAgent: true, args: { description: "Read the docs" }, startedAt: at(0) }),
      tool("a-child", { name: "view", args: { path: "/repo/README.md" }, parentToolCallId: "agent-a-call", startedAt: at(1) }),
      tool("agent-b", { name: "🤖 Test agent", isSubAgent: true, args: { description: "Run the tests" }, startedAt: at(0) }),
      tool("b-child", { name: "powershell", args: { command: "npm test", description: "Run the suite" }, parentToolCallId: "agent-b-call", startedAt: at(1) }),
    ];

    const { text } = render(entries, { live: true });

    expect(text).toContain("Waiting on 2 agents");
    expect(text).toContain("Research agent and Test agent");
    // Which agent took the latest step changes many times a minute; the line does not follow it.
    expect(text).not.toContain("Run the suite");
    expect(text).not.toContain("more");
  });

  it("leaves a background agent's steps to its own row instead of naming them on the line", () => {
    const entries = [
      // The launching call came back at once; the agent carries on in the background.
      tool("agent", { name: "🤖 expedition-rewards", isSubAgent: true, args: { description: "Assess rewards" }, startedAt: at(0), completedAt: at(0), success: true }),
      tool("child", { name: "view", args: { path: "/repo/server/FoodSystem.java" }, parentToolCallId: "agent-call", startedAt: at(5) }),
    ];
    const agents = [agentRecord("agent", { name: "expedition-rewards", status: "running", background: true, toolCount: 1 })];

    const collapsed = render(entries, { live: true, liveLabel: "Planning the rewards", agents });
    expect(collapsed.text).toContain("Planning the rewards");
    expect(collapsed.text).not.toContain("Reading server/FoodSystem.java");
    expect(collapsed.html).toContain('data-activity-state="active"');

    // Opened, the step is under the agent that is taking it.
    const expanded = render(entries, { live: true, expanded: true, agents });
    expect(expanded.text).toContain("expedition-rewards Assess rewards");
    expect(expanded.html).toContain('data-agent-row="launch"');
  });

  it("says it is waiting on agents once the main agent has stopped", () => {
    const entries = [
      tool("agent", { name: "🤖 expedition-rewards", isSubAgent: true, startedAt: at(0), completedAt: at(0), success: true }),
      tool("child", { name: "view", args: { path: "/repo/server/FoodSystem.java" }, parentToolCallId: "agent-call", startedAt: at(5) }),
    ];
    const waiting = { label: "Waiting on 3 agents", detail: "moves-agent, saves-agent and docs-agent" };

    const { html, text } = render(entries, { live: true, liveLabel: "Planning the rewards", waiting });

    expect(text).toContain("Waiting on 3 agents moves-agent, saves-agent and docs-agent");
    expect(text).not.toContain("Planning the rewards");
    expect(html).toContain('data-activity-waiting="agents"');
    // A finished stretch is never waiting, whatever it is told.
    expect(render(entries, { waiting, runActive: false }).html).not.toContain("data-activity-waiting");
  });

  it("counts the main agent's steps apart from the agents'", () => {
    const entries = [
      tool("moves", { name: "🤖 moves-agent", isSubAgent: true, startedAt: at(0), completedAt: at(0), success: true }),
      tool("saves", { name: "🤖 saves-agent", isSubAgent: true, startedAt: at(0), completedAt: at(0), success: true }),
      tool("read", { name: "view", args: { path: "/repo/a.ts" }, startedAt: at(1), completedAt: at(2), success: true }),
      agentTool("moves-1", "moves", { name: "view", args: { path: "/repo/moves.ts" }, startedAt: at(1), completedAt: at(2), success: true }),
      agentTool("moves-2", "moves", { name: "bash", args: { command: "npm test" }, startedAt: at(2), completedAt: at(70), success: false }),
      agentTool("saves-1", "saves", { name: "view", args: { path: "/repo/saves.ts" }, startedAt: at(3), completedAt: at(4), success: true }),
    ];

    const { text } = render(entries);

    expect(text).toBe("Worked for 1m 10s 3 steps · 2 agents, 3 steps 1 failed in agents");
  });

  it("names the agents when a stretch holds nothing of the main agent's", () => {
    const loaded: ChatEntry[] = [
      { role: "assistant", content: "Waiting on the agents." },
      agentTool("moves-8", "moves", { name: "view", args: { path: "/repo/moves.ts" }, startedAt: at(0), completedAt: at(65), success: true }),
      agentTool("moves-9", "moves", { name: "bash", args: { command: "npm test" }, startedAt: at(65), completedAt: at(125), success: true }),
    ];
    const moves = agentRecord("moves", { name: "moves-agent", description: "Refactor move generation", background: true, toolCount: 9 });

    // The call that launched the agent is above the loaded history; the session's records name it.
    const one = render(loaded, { agents: [moves] });
    expect(one.text).toBe("moves-agent worked for 2m 05s 2 steps");

    const several = render([
      ...loaded,
      agentTool("saves-3", "saves", { name: "view", args: { path: "/repo/saves.ts" }, startedAt: at(10), completedAt: at(20), success: true }),
    ], { agents: [moves, agentRecord("saves", { name: "saves-agent", background: true })] });
    expect(several.text).toBe("2 agents worked for 2m 05s 3 steps");
  });

  it("counts failures once on a line that is about the agents alone", () => {
    const loaded: ChatEntry[] = [
      { role: "assistant", content: "Waiting on the agents." },
      agentTool("moves-8", "moves", { name: "view", args: { path: "/repo/moves.ts" }, startedAt: at(0), completedAt: at(5), success: true }),
      agentTool("moves-9", "moves", { name: "bash", args: { command: "npm test" }, startedAt: at(5), completedAt: at(65), success: false }),
    ];
    const moves = agentRecord("moves", { name: "moves-agent", background: true, toolCount: 9, failedToolCount: 1 });

    // Every step here is the agent's, so "failed in agents" would only repeat the subject.
    expect(render(loaded, { agents: [moves] }).text).toBe("moves-agent worked for 1m 05s 2 steps 1 failed");

    // Waiting on it, the line gives the agent's steps here and how long the stretch has run.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_MS + 95_000);
    const waiting = render(
      [...loaded, agentTool("moves-10", "moves", { name: "view", args: { path: "/repo/board.ts" }, startedAt: at(65) })],
      {
        live: true,
        waiting: { label: "Waiting on 1 agent", detail: "moves-agent" },
        agents: [{ ...moves, status: "running" }],
      },
    );
    expect(waiting.text).toBe("Waiting on 1 agent moves-agent 3 steps · 1m 35s 1 failed");
  });

  it("says how many agents the steps are from once some of them are no longer being waited on", () => {
    const loaded: ChatEntry[] = [
      { role: "assistant", content: "All three are running." },
      agentTool("moves-1", "moves", { name: "view", args: { path: "/repo/moves.ts" }, startedAt: at(0), completedAt: at(20), success: true }),
      agentTool("saves-1", "saves", { name: "view", args: { path: "/repo/saves.ts" }, startedAt: at(1), completedAt: at(30), success: true }),
      agentTool("docs-1", "docs", { name: "view", args: { path: "/repo/README.md" }, startedAt: at(2), completedAt: at(40), success: true }),
      agentTool("docs-2", "docs", { name: "bash", args: { command: "npm run docs" }, startedAt: at(40) }),
    ];
    const agents = [
      agentRecord("moves", { name: "moves-agent", background: true, toolCount: 1 }),
      agentRecord("saves", { name: "saves-agent", background: true, toolCount: 1 }),
      agentRecord("docs", { name: "docs-agent", description: "Update the docs", status: "running", background: true, toolCount: 2 }),
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_MS + 50_000);

    // Two have reported and one is still out: "4 steps" alone would read as the one agent's.
    const one = render(loaded, {
      live: true,
      waiting: { label: "Waiting on docs-agent", detail: "Update the docs", count: 1 },
      agents,
    });
    expect(one.text).toBe("Waiting on docs-agent Update the docs 3 agents, 4 steps · 50s");

    // While all three are still out, the steps can only be theirs.
    const all = render(loaded, {
      live: true,
      waiting: { label: "Waiting on 3 agents", detail: "moves-agent, saves-agent and docs-agent", count: 3 },
      agents,
    });
    expect(all.text).toBe("Waiting on 3 agents moves-agent, saves-agent and docs-agent 4 steps · 50s");
  });

  it("says whose steps are whose when one call of its own sat among agents at work", () => {
    const loaded: ChatEntry[] = [
      { role: "assistant", content: "Checking on the agents." },
      tool("check", { name: "read_agent", args: { agent_id: "moves-agent" }, startedAt: at(0), completedAt: at(30), success: true }),
      agentTool("moves-8", "moves", { name: "view", args: { path: "/repo/moves.ts" }, startedAt: at(1), completedAt: at(40), success: true }),
      agentTool("saves-3", "saves", { name: "view", args: { path: "/repo/saves.ts" }, startedAt: at(2), completedAt: at(90), success: true }),
      agentTool("saves-4", "saves", { name: "bash", args: { command: "npm test" }, startedAt: at(90), completedAt: at(95), success: true }),
    ];
    const agents = [
      agentRecord("moves", { name: "moves-agent", background: true, toolCount: 9 }),
      agentRecord("saves", { name: "saves-agent", background: true, toolCount: 4 }),
    ];

    // Named after its one call, the line would hand the agents' ninety seconds and three steps to it.
    expect(render(loaded, { agents }).text).toBe("Worked for 1m 35s 1 step · 2 agents, 3 steps");

    // With no agents at work, a lone call still reads as itself.
    expect(render(loaded.slice(0, 2), { agents }).text).not.toContain("step");
  });

  it("says a stretch that only handed work out launched the agents", () => {
    const launch = (agent: string, partial: Partial<ToolCall> = {}) => tool(agent, {
      name: `🤖 ${agent}-agent`,
      isSubAgent: true,
      startedAt: at(5),
      completedAt: at(5),
      success: true,
      ...partial,
    });
    const background = (agent: string, description: string) => (
      agentRecord(agent, { name: `${agent}-agent`, description, background: true, toolCount: 9, activeMs: 65_000 })
    );
    const agents = [
      background("moves", "Refactor move generation"),
      background("saves", "Add the save migration"),
      background("docs", "Update the docs"),
    ];

    // The agents went on to work for a minute each, in the stretches after this one.
    const several = render([
      thought("t1", "Three independent pieces, so three agents.", { startedAt: at(0) }),
      launch("moves"),
      launch("saves"),
      launch("docs"),
    ], { agents });
    expect(several.text).toBe("Launched 3 agents moves-agent, saves-agent and docs-agent");

    const one = render([launch("moves")], { agents });
    expect(one.text).toBe("Launched moves-agent Refactor move generation");

    // A launch that failed started nothing, and reads as the failed call it is.
    const failed = render([launch("moves"), launch("saves", { success: false, result: "No such agent type" })], { agents: [agents[0]!] });
    expect(failed.text).toBe("Worked 2 steps 1 failed");
  });

  it("gives a stretch to the agents when every call in it was a delegation the main agent waited on", () => {
    const entries = [
      tool("research", { name: "🤖 Research agent", isSubAgent: true, args: { description: "Read the docs" }, startedAt: at(0), completedAt: at(125), success: true }),
      tool("r-1", { name: "view", args: { path: "/repo/README.md" }, parentToolCallId: "research-call", startedAt: at(1), completedAt: at(2), success: true }),
      tool("test", { name: "🤖 Test agent", isSubAgent: true, args: { description: "Run the tests" }, startedAt: at(0), completedAt: at(90), success: true }),
      tool("t-1", { name: "bash", args: { command: "npm test" }, parentToolCallId: "test-call", startedAt: at(1), completedAt: at(80), success: true }),
      tool("t-2", { name: "view", args: { path: "/repo/out.log" }, parentToolCallId: "test-call", startedAt: at(80), completedAt: at(85), success: true }),
    ];

    // Its own "2 steps" would only be the two delegations.
    expect(render(entries).text).toBe("2 agents worked for 2m 05s 3 steps");
  });

  it("opens a later stretch onto one row per agent, holding what the agent did there", () => {
    const loaded: ChatEntry[] = [
      { role: "assistant", content: "Waiting on the agents." },
      agentTool("moves-8", "moves", { name: "view", args: { path: "/repo/moves.ts" }, startedAt: at(0), completedAt: at(1), success: true }),
      agentTool("saves-3", "saves", { name: "view", args: { path: "/repo/saves.ts" }, startedAt: at(1), completedAt: at(2), success: true }),
      agentTool("moves-9", "moves", { name: "bash", args: { command: "npm test" }, startedAt: at(2), completedAt: at(3), success: true }),
    ];
    const agents = [
      agentRecord("moves", { name: "moves-agent", description: "Refactor move generation", background: true, toolCount: 9 }),
      agentRecord("saves", { name: "saves-agent", description: "Add the save migration", background: true, toolCount: 3 }),
    ];

    const { html, text } = render(loaded, { expanded: true, agents });

    expect(html.match(/data-agent-row="continued"/g)).toHaveLength(2);
    // Each row counts the steps of this stretch, not of the agent's whole run.
    expect(text).toContain("moves-agent Refactor move generation 2 steps");
    expect(text).toContain("saves-agent Add the save migration 1 step");
    // The steps themselves stay folded under their agent until its row is opened.
    expect(text).not.toContain("repo/moves.ts");
  });

  it("keeps an earlier stretch still while an agent's step in it is in flight", () => {
    const loaded: ChatEntry[] = [
      tool("moves", { name: "🤖 moves-agent", isSubAgent: true, startedAt: at(0), completedAt: at(0), success: true }),
      agentTool("moves-1", "moves", { name: "bash", args: { command: "npm test" }, startedAt: at(1) }),
      { role: "assistant", content: "The agent is running the tests." },
    ];
    const agents = [agentRecord("moves", { name: "moves-agent", status: "running", background: true, toolCount: 1 })];

    const earlier = render(loaded, { latest: false, agents });
    expect(earlier.html).toContain('data-activity-state="done"');
    expect(earlier.html).not.toContain("shimmer-text");

    // Opened, the agent's row shows it working: this is where its newest step is.
    const opened = render(loaded, { latest: false, expanded: true, agents });
    expect(opened.html).toContain('data-tool-status="running"');
    expect(opened.html).toContain("animate-spin");
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
