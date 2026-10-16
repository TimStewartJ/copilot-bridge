import { createElement, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, TranscriptAgent } from "../../api";
import { getCachedChatSnapshot, resetCachedChatSnapshotState } from "../../chat-cache";
import { createReactDomHarness, type Act } from "../../test-react-harness";
import { NO_HISTORY, useChatHistoryWindow } from "./useChatHistoryWindow";

afterEach(resetCachedChatSnapshotState);

async function withWindow(run: (helpers: {
  get: () => ReturnType<typeof useChatHistoryWindow>;
  queryClient: QueryClient;
  readThrough: ReturnType<typeof vi.fn>;
  setSessionId: (id: string) => void;
  act: Act;
}) => Promise<void>) {
  const harness = await createReactDomHarness();
  const queryClient = new QueryClient();
  const readThrough = vi.fn();
  let value!: ReturnType<typeof useChatHistoryWindow>;
  let setSessionId!: (id: string) => void;
  function Probe() {
    const [id, setId] = useState("one");
    setSessionId = setId;
    value = useChatHistoryWindow({
      sessionId: id, keepViewportRef: useRef(false), onRenderedReadThrough: readThrough,
    });
    return null;
  }
  try {
    await harness.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
    await run({ get: () => value, queryClient, readThrough, setSessionId: (id) => setSessionId(id), act: harness.act });
  } finally {
    await harness.cleanup();
    queryClient.clear();
  }
}

const entries: ChatEntry[] = [{ id: "reply", role: "assistant", content: "A reply", timestamp: "2026-10-16T17:00:00.000Z" }];

describe("chat history window", () => {
  it("keeps the rendered window and disk cache aligned and reports activity after rendering", async () => {
    await withWindow(async ({ get, queryClient, readThrough, act }) => {
      await act(async () => get().applyHistory(entries, {
        firstItemIndex: 25, fetchedAt: 123, lastVisibleActivityAt: "2026-10-16T17:00:01.000Z",
      }));
      expect(get().entries).toBe(entries);
      expect(get().entriesRef.current).toBe(entries);
      expect(get().hasMore).toBe(true);
      expect(get().firstItemIndex.current).toBe(25);
      expect(getCachedChatSnapshot(queryClient, "one")).toMatchObject({ entries, firstItemIndex: 25, fetchedAt: 123 });
      expect(readThrough).toHaveBeenCalledExactlyOnceWith("one", "2026-10-16T17:00:01.000Z");
    });
  });

  it("uses the new session as the default owner without changing the apply command identity", async () => {
    await withWindow(async ({ get, queryClient, readThrough, setSessionId, act }) => {
      const apply = get().applyHistory;
      await act(async () => setSessionId("two"));
      expect(get().applyHistory).toBe(apply);
      await act(async () => get().applyHistory(entries));
      expect(getCachedChatSnapshot(queryClient, "one")).toBeUndefined();
      expect(getCachedChatSnapshot(queryClient, "two")?.entries).toEqual(entries);
      expect(readThrough).toHaveBeenCalledWith("two", "2026-10-16T17:00:00.000Z");
    });
  });

  it("does not cache or mark a historical or error window as newly read", async () => {
    await withWindow(async ({ get, queryClient, readThrough, act }) => {
      await act(async () => get().applyHistory(entries, { persistSnapshot: false, reportReadThrough: false }));
      expect(getCachedChatSnapshot(queryClient, "one")).toBeUndefined();
      expect(readThrough).not.toHaveBeenCalled();
      await act(async () => get().applyHistory([], NO_HISTORY));
      expect(get().entries).toEqual([]);
      expect(get().historyFetchedAtRef.current).toBeNull();
      expect(get().hasMore).toBe(false);
      expect(readThrough).not.toHaveBeenCalled();
    });
  });

  it("shares unchanged agent records so a history refresh does not rerender their rows", async () => {
    await withWindow(async ({ get, act }) => {
      const agents: TranscriptAgent[] = [{
        toolCallId: "task", agentId: "agent", name: "Worker",
        status: "finished", activeMs: 0, toolCount: 0, failedToolCount: 0,
      }];
      await act(async () => get().applyAgentRecords(agents));
      const previous = get().agentRecords;
      await act(async () => get().applyAgentRecords(agents.map((agent) => ({ ...agent }))));
      expect(get().agentRecords).toBe(previous);
    });
  });
});
