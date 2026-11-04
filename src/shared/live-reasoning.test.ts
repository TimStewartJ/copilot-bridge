import { describe, expect, it } from "vitest";
import {
  appendReasoningDelta,
  closeOpenReasoning,
  commitReasoning,
  completeReasoningBlock,
  keepCommittedReasoning,
  type LiveReasoningBlock,
} from "./live-reasoning.js";

const T0 = "2026-09-20T08:00:00.000Z";
const T1 = "2026-09-20T08:00:04.000Z";
const T2 = "2026-09-20T08:00:05.000Z";

function stream(blocks: LiveReasoningBlock[], reasoningId: string, ...chunks: string[]): LiveReasoningBlock[] {
  return chunks.reduce(
    (current, content) => appendReasoningDelta(current, { reasoningId, content, timestamp: T0 }),
    blocks,
  );
}

describe("live reasoning fold", () => {
  it("ignores an empty delta without allocating a new list", () => {
    const blocks = stream([], "r-1", "text");

    expect(appendReasoningDelta(blocks, { reasoningId: "r-1", content: "" })).toBe(blocks);
  });

  it("closes the previous thought on a new id and folds both into the one persisted message", () => {
    const first = stream([], "r-1", "first thought");
    const second = appendReasoningDelta(first, { reasoningId: "r-2", content: "second thought", timestamp: T1 });

    expect(second.map((block) => [block.id, Boolean(block.completedAt)])).toEqual([
      ["r-1", true],
      ["r-2", false],
    ]);

    const committed = commitReasoning(second, { content: "first\n\nsecond", sourceEventId: "assistant-message-1" });

    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ id: "r-1", content: "first\n\nsecond", sourceEventId: "assistant-message-1" });
  });

  it("closes a thought once and reopens it when more text arrives", () => {
    const open = stream([], "r-1", "part one");
    const closed = closeOpenReasoning(open, T1);

    expect(closed[0]?.completedAt).toBe(T1);
    expect(closeOpenReasoning(closed, T2)).toBe(closed);

    const resumed = appendReasoningDelta(closed, { reasoningId: "r-1", content: ", part two" });

    expect(resumed[0]).toMatchObject({ content: "part one, part two" });
    expect(resumed[0]?.completedAt).toBeUndefined();
  });

  it("keeps the persisted thought and ignores its late streaming echoes", () => {
    const streamed = closeOpenReasoning(stream([], "r-1", "streamed text"), T1);
    const committed = commitReasoning(streamed, {
      content: "persisted text",
      sourceEventId: "assistant-message-1",
      timestamp: T2,
    });

    // The persisted text is what a reload will show, so it replaces what was streamed.
    expect(committed).toEqual([{
      id: "r-1",
      content: "persisted text",
      sourceEventId: "assistant-message-1",
      startedAt: T0,
      completedAt: T1,
      committedAt: T2,
    }]);

    const afterDelta = appendReasoningDelta(committed, { reasoningId: "r-1", content: " echo" });
    expect(afterDelta).toBe(committed);
    const afterComplete = completeReasoningBlock(afterDelta, { reasoningId: "r-1", content: "persisted text" });
    expect(afterComplete).toBe(committed);
    expect(completeReasoningBlock(afterComplete, { reasoningId: "unknown", content: "persisted  text\n" })).toBe(committed);
  });

  it("creates a thought from the persisted message without deltas and ignores a duplicate copy", () => {
    const message = {
      content: "thinking from a model that does not stream it",
      sourceEventId: "assistant-message-1",
      timestamp: T2,
    };
    const committed = commitReasoning([], message);

    expect(committed).toMatchObject([{
      id: "reasoning-assistant-message-1",
      sourceEventId: "assistant-message-1",
      startedAt: T2,
      completedAt: T2,
    }]);
    expect(commitReasoning(committed, message)).toBe(committed);
  });

  it("keeps separate blocks for separate assistant messages in one model call", () => {
    const first = commitReasoning(stream([], "r-1", "a"), { content: "a", sourceEventId: "message-1" });
    const second = commitReasoning(stream(first, "r-2", "b"), { content: "b", sourceEventId: "message-2" });

    expect(second.map((block) => [block.content, block.sourceEventId])).toEqual([
      ["a", "message-1"],
      ["b", "message-2"],
    ]);
  });

  it("repairs a block whose deltas were missed from the complete text", () => {
    const partial = stream([], "r-1", "only the tail");
    const repaired = completeReasoningBlock(partial, {
      reasoningId: "r-1",
      content: "the whole thought, including only the tail",
      timestamp: T1,
    });

    expect(repaired[0]).toMatchObject({
      content: "the whole thought, including only the tail",
      completedAt: T1,
    });
  });

  it("adds a finished block when the complete text is all that arrived", () => {
    const blocks = completeReasoningBlock([], { reasoningId: "r-1", content: "whole thought", timestamp: T1 });

    expect(blocks).toEqual([{ id: "r-1", content: "whole thought", startedAt: T1, completedAt: T1 }]);
  });

  it("keeps only blocks with a disk counterpart when the run ends", () => {
    const committed = commitReasoning(stream([], "r-1", "kept"), { content: "kept", sourceEventId: "message-1" });
    const withOpen = appendReasoningDelta(committed, { reasoningId: "r-2", content: "cut short" });

    expect(keepCommittedReasoning(withOpen).map((block) => block.id)).toEqual(["r-1"]);
    expect(keepCommittedReasoning(committed)).toBe(committed);
  });
});
