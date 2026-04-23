import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ChatEntry } from "./api";
import {
  appendLiveEntries,
  getCachedChatSnapshot,
  hasClientGeneratedEntries,
  hasOptimisticTail,
  mergeTailMessages,
  normalizeCommittedClientEntries,
  resetCachedChatSnapshotState,
  setCachedChatSnapshot,
  type ChatHistorySnapshot,
} from "./chat-cache";

function createMessage(id: string): ChatEntry {
  return {
    id,
    role: "assistant",
    content: id,
  };
}

function createUserMessage(id: string, content = id): ChatEntry {
  return {
    id,
    role: "user",
    content,
  };
}

function createToolEntry(toolCallId: string): ChatEntry {
  return {
    id: `tool-${toolCallId}`,
    type: "tool",
    toolCall: {
      toolCallId,
      name: "view",
    },
  };
}

function createSnapshot(sessionId: string, entryIds: string[]): ChatHistorySnapshot {
  return {
    sessionId,
    entries: entryIds.map((entryId) => createMessage(entryId)),
    firstItemIndex: 0,
    total: entryIds.length,
    hasMore: false,
    fetchedAt: Date.now(),
    isCanonical: true,
  };
}

describe("chat cache", () => {
  beforeEach(() => {
    resetCachedChatSnapshotState();
  });

  it("returns cloned snapshots and evicts the least recently used session", () => {
    const queryClient = new QueryClient();

    for (let index = 1; index <= 5; index += 1) {
      setCachedChatSnapshot(queryClient, createSnapshot(`session-${index}`, [`entry-${index}`]));
    }

    // Touch session-1 so session-2 becomes the oldest.
    expect(getCachedChatSnapshot(queryClient, "session-1")?.entries[0]?.content).toBe("entry-1");

    setCachedChatSnapshot(queryClient, createSnapshot("session-6", ["entry-6"]));

    expect(getCachedChatSnapshot(queryClient, "session-2")).toBeUndefined();
    expect(getCachedChatSnapshot(queryClient, "session-1")).toBeDefined();
    expect(getCachedChatSnapshot(queryClient, "session-6")).toBeDefined();

    const mutated = getCachedChatSnapshot(queryClient, "session-1");
    expect(mutated).toBeDefined();
    mutated!.entries[0] = { id: "mutated", role: "assistant", content: "mutated" };

    expect(getCachedChatSnapshot(queryClient, "session-1")?.entries[0]?.content).toBe("entry-1");
  });

  it("does not replace a canonical snapshot with optimistic state", () => {
    const queryClient = new QueryClient();

    setCachedChatSnapshot(queryClient, createSnapshot("session-1", ["canonical-entry"]));
    setCachedChatSnapshot(queryClient, {
      ...createSnapshot("session-1", ["optimistic-entry"]),
      isCanonical: false,
    });

    expect(getCachedChatSnapshot(queryClient, "session-1")?.entries[0]?.content).toBe("canonical-entry");
  });
});

describe("mergeTailMessages", () => {
  it("detects when loaded entries extend past the canonical server total", () => {
    expect(hasOptimisticTail(50, 51, 100)).toBe(true);
    expect(hasOptimisticTail(50, 50, 100)).toBe(false);
  });

  it("detects client-generated entries by their local cache ids", () => {
    expect(hasClientGeneratedEntries([createMessage("entry-1"), createMessage("local-2")])).toBe(true);
    expect(hasClientGeneratedEntries([createMessage("entry-1"), createMessage("entry-2")])).toBe(false);
  });

  it("normalizes committed local user entries once they are inside the canonical range", () => {
    const normalized = normalizeCommittedClientEntries(
      [
        { id: "entry-1", role: "assistant", content: "entry-1" },
        { id: "local-2", role: "user", content: "prompt" },
      ],
      0,
      2,
    );

    expect(normalized[0]?.id).toBe("entry-1");
    expect(normalized[1]?.id).toBeUndefined();
    expect(hasClientGeneratedEntries(normalized)).toBe(false);
  });

  it("preserves interrupted terminal placeholders inside the canonical range", () => {
    const normalized = normalizeCommittedClientEntries(
      [
        { id: "local-1", role: "assistant", content: "Partial answer\n\n*(interrupted)*" },
      ],
      0,
      1,
    );

    expect(normalized[0]?.id).toBe("local-1");
    expect(hasClientGeneratedEntries(normalized)).toBe(true);
  });

  it("preserves older loaded messages when the refreshed tail overlaps", () => {
    const previousEntries = Array.from({ length: 50 }, (_, index) => createMessage(`old-${index + 51}`));
    const nextWindow = Array.from({ length: 50 }, (_, index) => createMessage(`new-${index + 71}`));

    const merged = mergeTailMessages(previousEntries, 50, 120, nextWindow);

    expect(merged.firstItemIndex).toBe(50);
    expect(merged.total).toBe(120);
    expect(merged.hasOptimisticTail).toBe(false);
    expect(merged.hasClientGeneratedEntries).toBe(false);
    expect(merged.entries).toHaveLength(70);
    expect(merged.entries.slice(0, 20).map((entry) => entry.content)).toEqual(
      Array.from({ length: 20 }, (_, index) => `old-${index + 51}`),
    );
    expect(merged.entries.slice(20).map((entry) => entry.content)).toEqual(
      Array.from({ length: 50 }, (_, index) => `new-${index + 71}`),
    );
  });

  it("replaces the window when the refreshed tail no longer overlaps", () => {
    const previousEntries = Array.from({ length: 50 }, (_, index) => createMessage(`old-${index + 1}`));
    const nextWindow = Array.from({ length: 50 }, (_, index) => createMessage(`new-${index + 151}`));

    const merged = mergeTailMessages(previousEntries, 0, 200, nextWindow);

    expect(merged.firstItemIndex).toBe(150);
    expect(merged.total).toBe(200);
    expect(merged.hasOptimisticTail).toBe(false);
    expect(merged.hasClientGeneratedEntries).toBe(false);
    expect(merged.entries.map((entry) => entry.content)).toEqual(
      Array.from({ length: 50 }, (_, index) => `new-${index + 151}`),
    );
  });

  it("preserves optimistic tail entries during a stale background refresh", () => {
    const previousEntries = [
      ...Array.from({ length: 50 }, (_, index) => createMessage(`canonical-${index + 51}`)),
      createMessage("local-101"),
    ];
    const nextWindow = Array.from({ length: 50 }, (_, index) => createMessage(`canonical-${index + 51}`));

    const merged = mergeTailMessages(previousEntries, 50, 100, nextWindow);

    expect(merged.firstItemIndex).toBe(50);
    expect(merged.total).toBe(101);
    expect(merged.hasOptimisticTail).toBe(true);
    expect(merged.hasClientGeneratedEntries).toBe(true);
    expect(merged.entries).toHaveLength(51);
    expect(merged.entries.at(-1)?.content).toBe("local-101");
  });

  it("drops committed local ids once the refreshed window makes them canonical", () => {
    const previousEntries = [
      ...Array.from({ length: 50 }, (_, index) => createMessage(`canonical-${index + 51}`)),
      { id: "local-101", role: "user", content: "prompt" } satisfies ChatEntry,
    ];
    const nextWindow = Array.from({ length: 50 }, (_, index) => createMessage(`canonical-${index + 102}`));

    const merged = mergeTailMessages(previousEntries, 50, 151, nextWindow);

    expect(merged.firstItemIndex).toBe(50);
    expect(merged.total).toBe(151);
    expect(merged.hasOptimisticTail).toBe(false);
    expect(merged.hasClientGeneratedEntries).toBe(false);
    expect(merged.entries[50]?.content).toBe("prompt");
    expect(merged.entries[50]?.id).toBeUndefined();
  });
});

describe("appendLiveEntries", () => {
  it("skips a reconnect assistant message when history already ends with the same text", () => {
    const previousEntries = [{ id: "entry-1", role: "assistant", content: "All set" } satisfies ChatEntry];

    const merged = appendLiveEntries(previousEntries, [{ id: "stream-1", role: "assistant", content: "All set" } satisfies ChatEntry]);

    expect(merged).toEqual(previousEntries);
  });

  it("ignores trailing tool entries when deduplicating a reconnect assistant message", () => {
    const previousEntries = [
      { id: "entry-1", role: "assistant", content: "All set" } satisfies ChatEntry,
      createToolEntry("tool-1"),
    ];

    const merged = appendLiveEntries(previousEntries, [{ id: "stream-1", role: "assistant", content: "All set" } satisfies ChatEntry]);

    expect(merged).toEqual(previousEntries);
  });

  it("preserves repeated assistant text when a new turn intervened", () => {
    const previousEntries = [
      { id: "entry-1", role: "assistant", content: "All set" } satisfies ChatEntry,
      createUserMessage("entry-2", "Say that again"),
    ];

    const merged = appendLiveEntries(previousEntries, [{ id: "stream-1", role: "assistant", content: "All set" } satisfies ChatEntry]);

    expect(merged).toHaveLength(3);
    expect(merged[2]?.content).toBe("All set");
  });

  it("skips duplicate tool completions that were already hydrated from history", () => {
    const previousEntries = [createToolEntry("tool-1")];

    const merged = appendLiveEntries(previousEntries, [
      {
        id: "stream-tool-1",
        type: "tool",
        toolCall: {
          toolCallId: "tool-1",
          name: "view",
          result: "done",
          success: true,
          completedAt: "2026-04-21T17:00:00.000Z",
        },
      } satisfies ChatEntry,
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "tool-tool-1",
      type: "tool",
      toolCall: {
        toolCallId: "tool-1",
        name: "view",
        result: "done",
        success: true,
        completedAt: "2026-04-21T17:00:00.000Z",
      },
    });
  });
});
