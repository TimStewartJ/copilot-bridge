import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEntry } from "./api";
import {
  getCachedChatSnapshot,
  keepLoadedEntries,
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
  it("hands out its own list of a cached window and evicts least-recently-used sessions", () => {
    const client = new QueryClient();
    for (let index = 0; index < 6; index += 1) {
      setCachedChatSnapshot(client, {
        sessionId: `session-${index}`,
        entries: [message(`entry-${index}`)],
        firstItemIndex: 0,
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
      fetchedAt: 1,
    });
    setCachedChatSnapshot(client, {
      sessionId: "session-1",
      entries: [message("newer")],
      firstItemIndex: 0,
      fetchedAt: 2,
    });

    expect(getCachedChatSnapshot(client, "session-1")).toMatchObject({
      entries: [{ content: "newer" }],
    });
  });

  it("keeps only the newest entries of a long window and moves its start to match", () => {
    const client = new QueryClient();
    setCachedChatSnapshot(client, {
      sessionId: "session-1",
      entries: Array.from({ length: 250 }, (_, index) => message(`entry-${50 + index}`)),
      firstItemIndex: 50,
      fetchedAt: 1,
    });

    const snapshot = getCachedChatSnapshot(client, "session-1");
    expect(snapshot?.entries).toHaveLength(200);
    expect(snapshot?.entries[0]).toEqual(message("entry-100"));
    expect(snapshot?.firstItemIndex).toBe(100);
  });

  it("returns the entries it was given, so a revisit and the read behind it can be compared", () => {
    const client = new QueryClient();
    const entry = message("entry-0");
    setCachedChatSnapshot(client, { sessionId: "session-1", entries: [entry], firstItemIndex: 0, fetchedAt: 1 });

    expect(getCachedChatSnapshot(client, "session-1")?.entries[0]).toBe(entry);
  });
});

describe("keepLoadedEntries", () => {
  const tool = (id: string, result?: string): ChatEntry => ({
    id,
    type: "tool",
    toolCall: { toolCallId: id, name: "view", args: { path: "a.ts" }, ...(result ? { result } : {}) },
  } as ChatEntry);

  it("keeps the loaded object for every entry a fresh read left unchanged", () => {
    const loaded = [message("entry-0"), tool("entry-1"), message("entry-2")];
    const kept = keepLoadedEntries(loaded, 0, [message("entry-0"), tool("entry-1", "done"), message("entry-2"), message("entry-3")], 0);

    expect(kept[0]).toBe(loaded[0]);
    expect(kept[2]).toBe(loaded[2]);
    // A changed entry is a new object, but still shares what did not change inside it.
    expect(kept[1]).not.toBe(loaded[1]);
    expect(kept[1]).toEqual(tool("entry-1", "done"));
    expect((kept[1] as { toolCall: { args: unknown } }).toolCall.args).toBe((loaded[1] as { toolCall: { args: unknown } }).toolCall.args);
    expect(kept[3]).toEqual(message("entry-3"));
  });

  it("matches entries by where they sit in the session, not in the window", () => {
    const loaded = [message("entry-4"), message("entry-5"), message("entry-6")];
    // The fresh window starts two entries later than the loaded one.
    const kept = keepLoadedEntries(loaded, 4, [message("entry-6"), message("entry-7")], 6);

    expect(kept[0]).toBe(loaded[2]);
    expect(kept[1]).toEqual(message("entry-7"));
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
