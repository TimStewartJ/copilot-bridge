import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatReasoningEntry, ChatToolEntry, ToolCall } from "../api";
import {
  getReasoningHeadline,
  getReasoningTail,
  groupActivitySegments,
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
