import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEntry } from "./api";
import {
  getCachedChatSnapshot,
  replaceHistoryWindow,
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
  it("clones cached disk windows and evicts least-recently-used sessions", () => {
    const client = new QueryClient();
    for (let index = 0; index < 6; index += 1) {
      setCachedChatSnapshot(client, {
        sessionId: `session-${index}`,
        entries: [message(`entry-${index}`)],
        firstItemIndex: 0,
        total: 1,
        hasMore: false,
        fetchedAt: index,
      });
    }

    expect(getCachedChatSnapshot(client, "session-0")).toBeUndefined();
    const snapshot = getCachedChatSnapshot(client, "session-5");
    expect(snapshot?.entries).toEqual([message("entry-5")]);
    snapshot!.entries[0] = message("mutated");
    expect(getCachedChatSnapshot(client, "session-5")?.entries).toEqual([message("entry-5")]);
  });

  it("always stores the newest disk window without canonical gating", () => {
    const client = new QueryClient();
    setCachedChatSnapshot(client, {
      sessionId: "session-1",
      entries: [message("older")],
      firstItemIndex: 0,
      total: 1,
      hasMore: false,
      fetchedAt: 1,
    });
    setCachedChatSnapshot(client, {
      sessionId: "session-1",
      entries: [message("newer")],
      firstItemIndex: 0,
      total: 1,
      hasMore: false,
      fetchedAt: 2,
    });

    expect(getCachedChatSnapshot(client, "session-1")).toMatchObject({
      entries: [{ content: "newer" }],
    });
  });
});

describe("replaceHistoryWindow", () => {
  it("replaces the loaded window wholesale when the refreshed window covers it", () => {
    const result = replaceHistoryWindow(
      [message("entry-0"), message("entry-1"), message("entry-2")],
      0,
      [message("entry-0"), message("entry-1"), message("entry-2"), message("entry-3")],
      4,
    );

    expect(result.firstItemIndex).toBe(0);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "entry-0",
      "entry-1",
      "entry-2",
      "entry-3",
    ]);
    expect(result.total).toBe(4);
    expect(result.hasGap).toBe(false);
  });

  it("keeps the paginated prefix when the refreshed window starts later", () => {
    const result = replaceHistoryWindow(
      [message("entry-0"), message("entry-1"), message("entry-2")],
      0,
      [message("entry-2"), message("entry-3")],
      4,
    );

    expect(result.firstItemIndex).toBe(0);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "entry-0",
      "entry-1",
      "entry-2",
      "entry-3",
    ]);
    expect(result.hasGap).toBe(false);
  });

  it("reports a gap when the refreshed window starts past the loaded window", () => {
    const result = replaceHistoryWindow(
      [message("entry-0"), message("entry-1")],
      0,
      [message("entry-8"), message("entry-9")],
      10,
    );

    expect(result.hasGap).toBe(true);
  });

  it("drops stale client-generated entries from the committed window", () => {
    const result = replaceHistoryWindow(
      [message("entry-0"), { id: "local-1", role: "user", content: "Retry me" }],
      0,
      [message("entry-0"), message("entry-1")],
      2,
    );

    expect(result.entries.map((entry) => entry.id)).toEqual(["entry-0", "entry-1"]);
  });
});
