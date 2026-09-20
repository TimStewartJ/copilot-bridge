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
  it("accumulates deltas into the block they name", () => {
    const blocks = stream([], "r-1", "The scanner ", "counts entries.");

    expect(blocks).toEqual([{ id: "r-1", content: "The scanner counts entries.", startedAt: T0 }]);
  });

  it("stamps a new block with the turn it belongs to", () => {
    const blocks = appendReasoningDelta([], {
      reasoningId: "r-1",
      content: "Thinking",
      turnId: "turn-1",
      turnInstanceId: "turn-start-event",
    });

    expect(blocks[0]).toMatchObject({ turnId: "turn-1", turnInstanceId: "turn-start-event" });
  });

  it("ignores an empty delta without allocating a new list", () => {
    const blocks = stream([], "r-1", "text");

    expect(appendReasoningDelta(blocks, { reasoningId: "r-1", content: "" })).toBe(blocks);
  });

  it("closes the previous block when a different one starts", () => {
    const first = stream([], "r-1", "first thought");
    const second = appendReasoningDelta(first, { reasoningId: "r-2", content: "second thought", timestamp: T1 });

    expect(second.map((block) => [block.id, Boolean(block.completedAt)])).toEqual([
      ["r-1", true],
      ["r-2", false],
    ]);
  });

  it("closes open blocks once, and leaves an already closed list untouched", () => {
    const open = stream([], "r-1", "thought");
    const closed = closeOpenReasoning(open, T1);

    expect(closed[0]?.completedAt).toBe(T1);
    expect(closeOpenReasoning(closed, T2)).toBe(closed);
  });

  it("reopens a block that receives more text after it was closed", () => {
    const closed = closeOpenReasoning(stream([], "r-1", "part one"), T1);
    const resumed = appendReasoningDelta(closed, { reasoningId: "r-1", content: ", part two" });

    expect(resumed[0]).toMatchObject({ content: "part one, part two" });
    expect(resumed[0]?.completedAt).toBeUndefined();
  });

  it("commits a streamed block under the assistant message that persisted it", () => {
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
  });

  it("folds every uncommitted block into one, matching the single disk entry", () => {
    const two = appendReasoningDelta(stream([], "r-1", "first"), { reasoningId: "r-2", content: "second" });
    const committed = commitReasoning(two, { content: "first\n\nsecond", sourceEventId: "assistant-message-1" });

    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ id: "r-1", content: "first\n\nsecond", sourceEventId: "assistant-message-1" });
  });

  it("creates a committed block when no deltas were seen", () => {
    const committed = commitReasoning([], {
      content: "thinking from a model that does not stream it",
      sourceEventId: "assistant-message-1",
      timestamp: T2,
    });

    expect(committed).toMatchObject([{
      id: "reasoning-assistant-message-1",
      sourceEventId: "assistant-message-1",
      startedAt: T2,
      completedAt: T2,
    }]);
  });

  it("keeps separate blocks for separate assistant messages in one model call", () => {
    const first = commitReasoning(stream([], "r-1", "a"), { content: "a", sourceEventId: "message-1" });
    const second = commitReasoning(stream(first, "r-2", "b"), { content: "b", sourceEventId: "message-2" });

    expect(second.map((block) => [block.content, block.sourceEventId])).toEqual([
      ["a", "message-1"],
      ["b", "message-2"],
    ]);
  });

  it("does not commit the same assistant message twice", () => {
    const committed = commitReasoning([], { content: "once", sourceEventId: "message-1" });

    expect(commitReasoning(committed, { content: "once", sourceEventId: "message-1" })).toBe(committed);
  });

  it("drops a late delta for a block the disk already owns", () => {
    const committed = commitReasoning(stream([], "r-1", "text"), { content: "text", sourceEventId: "message-1" });

    expect(appendReasoningDelta(committed, { reasoningId: "r-1", content: " echo" })).toBe(committed);
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

  it("ignores the complete text once it is already represented", () => {
    // The SDK sends `assistant.reasoning` after the `assistant.message` that commits the block.
    const committed = commitReasoning(stream([], "r-1", "text"), { content: "the text", sourceEventId: "message-1" });

    expect(completeReasoningBlock(committed, { reasoningId: "r-1", content: "the text" })).toBe(committed);
    expect(completeReasoningBlock(committed, { reasoningId: "unknown", content: "the  text\n" })).toBe(committed);
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
