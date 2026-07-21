import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEntry } from "./api";
import {
  getCachedChatSnapshot,
  hasClientGeneratedEntries,
  hasOptimisticTail,
  mergeTailMessages,
  normalizeCommittedClientEntries,
  resetCachedChatSnapshotState,
  setCachedChatSnapshot,
} from "./chat-cache";

function message(id: string, content = id): ChatEntry {
  return { id, role: "assistant", content };
}

afterEach(() => {
  resetCachedChatSnapshotState();
});

describe("chat cache", () => {
  it("clones canonical snapshots and evicts least-recently-used sessions", () => {
    const client = new QueryClient();
    for (let index = 0; index < 6; index += 1) {
      setCachedChatSnapshot(client, {
        sessionId: `session-${index}`,
        entries: [message(`entry-${index}`)],
        firstItemIndex: 0,
        total: 1,
        hasMore: false,
        fetchedAt: index,
        isCanonical: true,
      });
    }

    expect(getCachedChatSnapshot(client, "session-0")).toBeUndefined();
    const snapshot = getCachedChatSnapshot(client, "session-5");
    expect(snapshot?.entries).toEqual([message("entry-5")]);
    snapshot!.entries[0] = message("mutated");
    expect(getCachedChatSnapshot(client, "session-5")?.entries).toEqual([message("entry-5")]);
  });

  it("does not replace canonical cache with noncanonical state", () => {
    const client = new QueryClient();
    setCachedChatSnapshot(client, {
      sessionId: "session-1",
      entries: [message("canonical")],
      firstItemIndex: 0,
      total: 1,
      hasMore: false,
      fetchedAt: 1,
      isCanonical: true,
      lastVisibleActivityAt: "2026-07-21T17:00:00.000Z",
    });
    setCachedChatSnapshot(client, {
      sessionId: "session-1",
      entries: [message("optimistic")],
      firstItemIndex: 0,
      total: 1,
      hasMore: false,
      fetchedAt: 2,
      isCanonical: false,
    });

    expect(getCachedChatSnapshot(client, "session-1")).toMatchObject({
      entries: [{ content: "canonical" }],
      lastVisibleActivityAt: "2026-07-21T17:00:00.000Z",
    });
  });
});

describe("canonical tail reconciliation", () => {
  it("detects optimistic tails and local entries", () => {
    expect(hasOptimisticTail(5, 3, 7)).toBe(true);
    expect(hasOptimisticTail(5, 2, 7)).toBe(false);
    expect(hasClientGeneratedEntries([message("entry-1"), message("local-1")])).toBe(true);
    expect(hasClientGeneratedEntries([message("entry-1")])).toBe(false);
  });

  it("normalizes committed local ids but preserves interrupted legacy notices", () => {
    const normalized = normalizeCommittedClientEntries([
      message("entry-1"),
      { id: "local-user-1", role: "user", content: "Hello" },
      { id: "err-1", role: "assistant", content: "Partial\n\n*(interrupted)*" },
    ], 0, 3);

    expect(normalized[1]?.id).toBeUndefined();
    expect(normalized[2]?.id).toBe("err-1");
  });

  it("preserves older loaded messages when the refreshed tail overlaps", () => {
    const merged = mergeTailMessages(
      [message("entry-0"), message("entry-1"), message("entry-2")],
      0,
      5,
      [message("entry-2-new"), message("entry-3"), message("entry-4")],
    );

    expect(merged.firstItemIndex).toBe(0);
    expect(merged.entries.map((entry) => entry.id)).toEqual([
      "entry-0",
      "entry-1",
      "entry-2-new",
      "entry-3",
      "entry-4",
    ]);
    expect(merged.hasOptimisticTail).toBe(false);
  });

  it("preserves optimistic user entries after a stale background refresh", () => {
    const merged = mergeTailMessages(
      [message("entry-0"), { id: "local-user-1", role: "user", content: "Pending" }],
      0,
      1,
      [message("entry-0-new")],
    );

    expect(merged.entries).toMatchObject([
      { id: "entry-0-new" },
      { id: "local-user-1", role: "user" },
    ]);
    expect(merged.hasOptimisticTail).toBe(true);
    expect(merged.hasClientGeneratedEntries).toBe(true);
  });

  it("replaces a non-overlapping window", () => {
    const merged = mergeTailMessages(
      [message("entry-0"), message("entry-1")],
      0,
      10,
      [message("entry-8"), message("entry-9")],
    );

    expect(merged.firstItemIndex).toBe(8);
    expect(merged.entries.map((entry) => entry.id)).toEqual(["entry-8", "entry-9"]);
  });
});
