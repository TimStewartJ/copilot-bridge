import { describe, expect, it } from "vitest";
import type { ChatEntry } from "./api";
import { appendLiveEntries } from "./chat-cache";

function createCompletionEntry(
  id: string,
  content = id,
  options: { turnId?: string; liveSource?: "snapshot" | "event"; sourceEventType?: string } = {},
): ChatEntry {
  return {
    id,
    type: "completion",
    content,
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.liveSource ? { liveSource: options.liveSource } : {}),
    completion: {
      content,
      title: "Task complete",
      status: "success",
      sourceEventType: options.sourceEventType ?? "session.task_complete",
    },
  };
}

function createMessageEntry(id: string, role: "user" | "assistant", content: string): ChatEntry {
  return { id, role, content };
}

describe("appendLiveEntries completion entries", () => {
  it("skips snapshot-replayed terminal completion duplicating the trailing completion", () => {
    // Canonical disk history ends with a completion that uses the disk turn-id scheme; the live
    // reconnect snapshot replays the same logical completion with a live turn-id scheme.
    const previousEntries = [createCompletionEntry("entry-1", "All done", { turnId: "turn-5" })];

    const merged = appendLiveEntries(previousEntries, [
      createCompletionEntry("stream-1", "All done", { turnId: "turn-abc123", liveSource: "snapshot" }),
    ]);

    expect(merged).toEqual(previousEntries);
  });

  it("skips a live reconnect completion that repeats the trailing turn id", () => {
    const previousEntries = [createCompletionEntry("entry-1", "All done", { turnId: "turn-abc123" })];

    const merged = appendLiveEntries(previousEntries, [
      createCompletionEntry("stream-1", "All done", { turnId: "turn-abc123" }),
    ]);

    expect(merged).toEqual(previousEntries);
  });

  it("keeps distinct consecutive turns that share an identical summary", () => {
    const previousEntries = [
      createCompletionEntry("entry-1", "Done", { turnId: "turn-1" }),
      createMessageEntry("entry-2", "user", "do it again"),
      createMessageEntry("entry-3", "assistant", "working on it"),
    ];

    const merged = appendLiveEntries(previousEntries, [
      createCompletionEntry("stream-1", "Done", { turnId: "turn-2" }),
    ]);

    expect(merged).toHaveLength(4);
    expect(merged[3]).toMatchObject({ type: "completion", content: "Done", turnId: "turn-2" });
  });

  it("keeps consecutive completion-only live turns with identical summaries", () => {
    // No intervening message/tool entries: distinguished purely by being live (not snapshot) events
    // with distinct turn ids.
    const previousEntries = [createCompletionEntry("entry-1", "Done", { turnId: "turn-1", liveSource: "event" })];

    const merged = appendLiveEntries(previousEntries, [
      createCompletionEntry("stream-1", "Done", { turnId: "turn-2", liveSource: "event" }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ type: "completion", turnId: "turn-2" });
  });

  it("does not treat a snapshot completion as duplicate when the tail is not a completion", () => {
    const previousEntries = [
      createCompletionEntry("entry-1", "Done", { turnId: "turn-1" }),
      createMessageEntry("entry-2", "assistant", "more work"),
    ];

    const merged = appendLiveEntries(previousEntries, [
      createCompletionEntry("stream-1", "Done", { turnId: "turn-9", liveSource: "snapshot" }),
    ]);

    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({ type: "completion", turnId: "turn-9" });
  });
});
