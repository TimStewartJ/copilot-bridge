import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatReasoningEntry, ChatToolEntry, ToolCall, TranscriptAgent } from "../api";
import { buildTranscriptAgentDirectory } from "../../shared/transcript-agents.js";
import {
  getReasoningHeadline,
  getReasoningTail,
  getStepStatus,
  groupActivitySegments,
  mapLatestAgentBlocks,
  summarizeActivity,
  type ActivityBlock,
  type ActivityStep,
} from "./chat-activity";
import { segmentChatEntries } from "./tool-call-tree";

const BASE_MS = Date.parse("2026-09-20T08:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

function thought(id: string, turnInstanceId: string, partial: Partial<ChatReasoningEntry> = {}): ChatReasoningEntry {
  return {
    id,
    type: "reasoning",
    content: `${id} thinking`,
    turnInstanceId,
    reasoning: { messageEventId: `${id}-message` },
    ...partial,
  };
}

function tool(id: string, turnInstanceId: string, partial: Partial<ToolCall> = {}): ChatToolEntry {
  return {
    id,
    type: "tool",
    turnInstanceId,
    toolCall: { toolCallId: `${id}-call`, name: id, ...partial },
  };
}

function blocksOf(entries: ChatEntry[]) {
  return groupActivitySegments(segmentChatEntries(entries));
}

function activity(blocks: ReturnType<typeof blocksOf>): ActivityBlock[] {
  return blocks.filter((block): block is ActivityBlock => block.type === "activity");
}

describe("groupActivitySegments", () => {
  it("lifts an answered question out of the steps, splitting the block around it", () => {
    const question = { message: "Which one?", requestedSchema: { properties: { pick: { type: "string", enum: ["a", "b"] } } } };
    const blocks = blocksOf([
      { role: "user", content: "Go" },
      tool("read", "turn-a"),
      tool("ask_user", "turn-b", { args: question, success: true, completedAt: at(30), result: "User responded:\npick: a" }),
      tool("edit", "turn-c"),
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["message", "activity", "question", "activity"]);
    expect(blocks[2]).toMatchObject({ type: "question", key: "question:ask_user-call" });
    expect(activity(blocks)[1]?.steps).toMatchObject([{ kind: "tools", entries: [{ id: "edit" }] }]);
  });

  it("keeps an open question in the steps until the run is over", () => {
    const entries: ChatEntry[] = [tool("ask_user", "turn-a", { args: { message: "Which one?" } })];

    expect(groupActivitySegments(segmentChatEntries(entries)).map((block) => block.type)).toEqual(["activity"]);
    expect(groupActivitySegments(segmentChatEntries(entries), { includeUnfinishedQuestions: true }).map((block) => block.type))
      .toEqual(["question"]);
  });

  it("uses the completed copy of a question that appears twice and shows it once", () => {
    const args = { message: "Which one?" };
    const blocks = blocksOf([
      { ...tool("ask_user", "turn-a", { args }), id: "start" },
      { ...tool("ask_user", "turn-a", { args, success: true, result: "User responded: this one" }), id: "done" },
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["question"]);
    expect(blocks[0]).toMatchObject({ toolCall: { result: "User responded: this one" } });
  });

  it("leaves a question a sub-agent asked inside its agent", () => {
    const blocks = blocksOf([
      tool("agent", "turn-a", { isSubAgent: true }),
      tool("ask_user", "turn-a", { args: { message: "Which?" }, parentToolCallId: "agent-call", success: true, result: "User responded: x" }),
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["activity"]);
  });

  it("folds the thinking and tool calls of consecutive turns into one block", () => {
    const blocks = blocksOf([
      { role: "user", content: "Fix the bug" },
      thought("t1", "turn-a"),
      tool("read", "turn-a"),
      thought("t2", "turn-b"),
      tool("edit", "turn-b"),
      tool("test", "turn-b"),
      thought("t3", "turn-c"),
      { role: "assistant", content: "Fixed.", turnInstanceId: "turn-c" },
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["message", "activity", "message"]);
    const [block] = activity(blocks);
    expect(block?.steps.map((step) => step.kind)).toEqual(["reasoning", "tools", "reasoning", "tools", "reasoning"]);
    expect(block?.steps[3]).toMatchObject({ kind: "tools", entries: [{ id: "edit" }, { id: "test" }] });
  });

  it("splits at anything the agent said or showed", () => {
    const blocks = blocksOf([
      thought("t1", "turn-a"),
      { role: "assistant", content: "Let me check the tests.", turnInstanceId: "turn-a" },
      tool("test", "turn-a"),
      {
        id: "done",
        type: "completion",
        content: "All done",
        completion: { content: "All done", title: "Task complete", status: "success", sourceEventType: "session.task_complete" },
      },
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["activity", "message", "activity", "completion-segment"]);
  });

  it("keys a block by the turn that opened it, identically for live and committed entries", () => {
    const live = activity(blocksOf([
      thought("live-reasoning-r1", "turn-a", { reasoning: { streaming: true } }),
    ]));
    const committed = activity(blocksOf([
      thought("entry-12", "turn-a"),
      tool("entry-13", "turn-a"),
      thought("entry-14", "turn-b"),
    ]));

    expect(live[0]?.key).toBe("activity:turn-a:0");
    expect(committed[0]?.key).toBe(live[0]?.key);
  });

  it("numbers the blocks one turn opens so their keys stay unique", () => {
    const blocks = activity(blocksOf([
      thought("t1", "turn-a"),
      { role: "assistant", content: "Narration", turnInstanceId: "turn-a" },
      tool("read", "turn-a"),
    ]));

    expect(blocks.map((block) => block.key)).toEqual(["activity:turn-a:0", "activity:turn-a:1"]);
  });

  it("falls back to entry identity for logs that carry no turn ids", () => {
    const blocks = activity(blocksOf([
      { id: "tool-1", type: "tool", toolCall: { toolCallId: "call-1", name: "bash" } },
    ]));

    expect(blocks[0]?.key).toBe("activity:call-1:0");
  });

  it("drops blank thinking instead of rendering an empty step", () => {
    expect(blocksOf([thought("blank", "turn-a", { content: "  \n" })])).toEqual([]);
  });
});

describe("agents in a stretch of work", () => {
  /** A call an agent made. It names the call that launched the agent as its parent. */
  function agentCall(id: string, agent: string, partial: Partial<ToolCall> = {}): ChatToolEntry {
    return {
      id,
      type: "tool",
      toolCall: { toolCallId: `${id}-call`, name: id, parentToolCallId: `${agent}-call`, ...partial },
    };
  }

  function record(agent: string, partial: Partial<TranscriptAgent> = {}): TranscriptAgent {
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

  it("puts what an agent did beneath the call that launched it, after the main agent's calls of the turn", () => {
    const [block] = activity(blocksOf([
      tool("moves", "turn-a", { isSubAgent: true }),
      tool("saves", "turn-a", { isSubAgent: true }),
      agentCall("moves-1", "moves"),
      agentCall("saves-1", "saves"),
      agentCall("moves-2", "moves"),
    ]));

    expect(block?.steps).toMatchObject([
      {
        kind: "tools",
        entries: [{ id: "moves" }, { id: "saves" }, { id: "moves-1" }, { id: "saves-1" }, { id: "moves-2" }],
      },
    ]);
  });

  it("gives an agent launched earlier one step per stretch, however its calls were interleaved", () => {
    const blocks = activity(blocksOf([
      tool("moves", "turn-a", { isSubAgent: true }),
      tool("saves", "turn-a", { isSubAgent: true }),
      agentCall("moves-1", "moves"),
      { role: "assistant", content: "Both are running.", turnInstanceId: "turn-b" },
      agentCall("moves-2", "moves"),
      agentCall("saves-1", "saves"),
      tool("read_agent", "turn-c"),
      agentCall("moves-3", "moves"),
      agentCall("saves-2", "saves"),
    ]));

    expect(blocks).toHaveLength(2);
    // The stretch after the reply: each agent once, where it first acted, around the main agent's call.
    expect(blocks[1]?.steps).toMatchObject([
      { kind: "agent", agentToolCallId: "moves-call", entries: [{ id: "moves-2" }, { id: "moves-3" }] },
      { kind: "agent", agentToolCallId: "saves-call", entries: [{ id: "saves-1" }, { id: "saves-2" }] },
      { kind: "tools", entries: [{ id: "read_agent" }] },
    ]);
  });

  it("keys a stretch that opens with an agent's step by that step, so it stays put as history loads", () => {
    const blocks = activity(blocksOf([
      { role: "assistant", content: "Waiting on the agents." },
      agentCall("moves-7", "moves"),
      agentCall("moves-8", "moves"),
    ]));

    expect(blocks[0]?.key).toBe("activity:moves-7-call:0");
  });

  it("follows an agent another agent launched up to the one the main agent launched", () => {
    const entries: ChatEntry[] = [
      { role: "assistant", content: "Waiting on the agents." },
      agentCall("inner-1", "inner"),
      agentCall("outer-1", "outer"),
    ];
    // The launching calls are above the loaded history; only the session's records link them.
    const agents = buildTranscriptAgentDirectory([
      record("outer"),
      record("inner", { parentToolCallId: "outer-call" }),
    ]);

    const [block] = activity(groupActivitySegments(segmentChatEntries(entries), { agents }));

    expect(block?.steps).toMatchObject([
      { kind: "agent", agentToolCallId: "outer-call", entries: [{ id: "inner-1" }, { id: "outer-1" }] },
    ]);
    // Without the records the two cannot be known to be one agent's work.
    expect(activity(blocksOf(entries))[0]?.steps).toHaveLength(2);
  });

  it("counts the main agent's steps apart from the agents'", () => {
    const [block] = activity(blocksOf([
      tool("moves", "turn-a", { isSubAgent: true, startedAt: at(0), completedAt: at(0), success: true }),
      tool("read", "turn-a", { startedAt: at(1), completedAt: at(2), success: true }),
      agentCall("moves-1", "moves", { startedAt: at(1), completedAt: at(4), success: true }),
      agentCall("moves-2", "moves", { startedAt: at(4), completedAt: at(9), success: false }),
      agentCall("earlier-1", "earlier", { startedAt: at(2), completedAt: at(3), success: true }),
    ]));

    expect(summarizeActivity(block!.steps)).toMatchObject({
      toolCount: 2,
      failedCount: 0,
      agentCount: 2,
      agentToolCount: 3,
      agentFailedCount: 1,
      runningCount: 0,
      durationMs: 9_000,
    });
  });

  it("does not count a delegation whose agent has done nothing yet as an agent at work", () => {
    const [block] = activity(blocksOf([
      tool("moves", "turn-a", { isSubAgent: true, completedAt: at(0), success: true }),
    ]));

    expect(summarizeActivity(block!.steps)).toMatchObject({ toolCount: 1, agentCount: 0, agentToolCount: 0 });
  });

  it("treats handing work to a background agent as done once the agent has started", () => {
    const background = record("moves", { status: "running", background: true });
    const blocking = record("review", { status: "running" });
    const launched: ToolCall = { toolCallId: "moves-call", name: "moves", isSubAgent: true, completedAt: at(0), success: true, agent: background };
    const waitedOn: ToolCall = { toolCallId: "review-call", name: "review", isSubAgent: true, agent: blocking };

    // The agent's own rows show it working; the stretch that launched it is finished.
    expect(getStepStatus(launched)).toBe("done");
    // The main agent is still inside the call that runs this one.
    expect(getStepStatus(waitedOn)).toBe("running");
  });

  it("finds the newest stretch that has a row for each agent", () => {
    const blocks = blocksOf([
      tool("moves", "turn-a", { isSubAgent: true }),
      tool("saves", "turn-a", { isSubAgent: true }),
      agentCall("saves-1", "saves"),
      { role: "assistant", content: "Both are running.", turnInstanceId: "turn-b" },
      agentCall("moves-1", "moves"),
    ]);
    const [first, second] = activity(blocks);

    expect(Object.fromEntries(mapLatestAgentBlocks(blocks))).toEqual({
      "moves-call": second!.key,
      "saves-call": first!.key,
    });
  });

  it("hands back the answer it gave before while no agent has moved to a newer stretch", () => {
    const entries: ChatEntry[] = [
      tool("moves", "turn-a", { isSubAgent: true }),
      agentCall("moves-1", "moves"),
      { role: "assistant", content: "It is running.", turnInstanceId: "turn-b" },
      agentCall("moves-2", "moves"),
    ];
    const before = mapLatestAgentBlocks(blocksOf(entries));

    // Another step in the same stretch: the rows that read this are not told it changed.
    const sameStretch = mapLatestAgentBlocks(blocksOf([...entries, agentCall("moves-3", "moves")]), before);
    expect(sameStretch).toBe(before);

    // The agent carries on after the next reply, so its newest row is now a different one.
    const moved = mapLatestAgentBlocks(blocksOf([
      ...entries,
      { role: "assistant", content: "Still running.", turnInstanceId: "turn-c" },
      agentCall("moves-4", "moves"),
    ]), before);
    expect(moved).not.toBe(before);
    expect(moved.get("moves-call")).not.toBe(before.get("moves-call"));
  });

  it("does not stretch the launching block for as long as a background agent keeps reporting", () => {
    const background = record("moves", { status: "running", background: true });
    const [block] = activity(blocksOf([
      thought("t1", "turn-a", { timestamp: at(2), reasoning: { startedAt: at(0) } }),
      // While the agent works, the stream moves the end of the call that launched it to its latest word.
      tool("moves", "turn-a", { isSubAgent: true, startedAt: at(2), completedAt: at(95), success: true, agent: background }),
      tool("read", "turn-a", { startedAt: at(3), completedAt: at(35), success: true }),
    ]));

    expect(summarizeActivity(block!.steps)).toMatchObject({ toolCount: 2, runningCount: 0, durationMs: 35_000 });

    // Before the session's records name the agent, the call's own arguments say it runs in the background.
    const [unnamed] = activity(blocksOf([
      tool("moves", "turn-a", { isSubAgent: true, args: { mode: "background" }, startedAt: at(2), completedAt: at(95), success: true }),
      tool("read", "turn-a", { startedAt: at(3), completedAt: at(35), success: true }),
    ]));
    expect(summarizeActivity(unnamed!.steps).durationMs).toBe(33_000);

    // An agent the main agent waits for does take the stretch's time.
    const [blocking] = activity(blocksOf([
      tool("review", "turn-a", { isSubAgent: true, startedAt: at(2), completedAt: at(95), success: true, agent: record("review") }),
    ]));
    expect(summarizeActivity(blocking!.steps).durationMs).toBe(93_000);
  });
});

describe("summarizeActivity", () => {
  function stepsOf(entries: ChatEntry[]): ActivityStep[] {
    return activity(blocksOf(entries))[0]?.steps ?? [];
  }

  it("counts tools once and measures the block from its first start to its last finish", () => {
    const summary = summarizeActivity(stepsOf([
      thought("t1", "turn-a", { timestamp: at(3), reasoning: { startedAt: at(0) } }),
      tool("read", "turn-a", { startedAt: at(3), completedAt: at(5), success: true }),
      tool("broken", "turn-a", { startedAt: at(4), completedAt: at(9), success: false }),
    ]));

    expect(summary).toMatchObject({
      toolCount: 2,
      thoughtCount: 1,
      runningCount: 0,
      failedCount: 1,
      streamingThought: false,
      durationMs: 9_000,
    });
  });

  it("does not bill the final reply's writing time to the work before it", () => {
    // The last model call ended at 40s because it also wrote a long answer; it began at 10s.
    const summary = summarizeActivity(stepsOf([
      tool("read", "turn-a", { startedAt: at(0), completedAt: at(8), success: true }),
      thought("t2", "turn-b", { timestamp: at(40), reasoning: { startedAt: at(10) } }),
    ]));

    expect(summary.durationMs).toBe(10_000);
  });

  it("keeps the clock running while a tool or a thought is still in flight", () => {
    const running = summarizeActivity(stepsOf([
      tool("test", "turn-a", { startedAt: at(0) }),
    ]), BASE_MS + 12_000);
    const thinking = summarizeActivity(stepsOf([
      thought("t1", "turn-a", { reasoning: { startedAt: at(0), streaming: true } }),
    ]), BASE_MS + 4_000);

    expect(running).toMatchObject({ runningCount: 1, durationMs: 12_000 });
    expect(thinking).toMatchObject({ streamingThought: true, durationMs: 4_000 });
  });

  it("reports no duration when the entries carry no usable times", () => {
    expect(summarizeActivity(stepsOf([tool("read", "turn-a", { success: true })])).durationMs).toBeUndefined();
  });
});

describe("reasoning text helpers", () => {
  it("prefers a heading, then the first sentence, as the one-line stand-in", () => {
    expect(getReasoningHeadline("**Calculating total sheep**\n\nI need to come up with an answer.")).toBe("Calculating total sheep");
    expect(getReasoningHeadline("The scanner counts entries. It must agree with the transform.")).toBe("The scanner counts entries.");
    expect(getReasoningHeadline("   ")).toBe("");
  });

  it("cuts an over-long headline at a word", () => {
    const headline = getReasoningHeadline(`${"considering ".repeat(30)}`, 40);

    expect(headline.length).toBeLessThanOrEqual(40);
    expect(headline.endsWith("…")).toBe(true);
    expect(headline).not.toContain("considering consi…");
  });

  it("returns the newest stretch of streaming text on one line, starting at a word", () => {
    const content = `first paragraph\n\n${"word ".repeat(200)}final`;
    const tail = getReasoningTail(content, 60);

    expect(tail.length).toBeLessThanOrEqual(60);
    expect(tail.endsWith("final")).toBe(true);
    expect(tail.startsWith("word")).toBe(true);
    expect(tail).not.toContain("\n");
    expect(getReasoningTail("short **thought**")).toBe("short thought");
  });
});
