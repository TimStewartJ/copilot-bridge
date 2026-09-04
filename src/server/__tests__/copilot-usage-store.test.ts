import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../db.js";
import {
  createRetainedCopilotUsageEntry,
  createCopilotUsageStore,
  type CopilotUsageCacheEntry,
} from "../copilot-usage-store.js";

function createEntry(sessionId: string, inputTokens: number): CopilotUsageCacheEntry {
  return {
    sessionId,
    parserVersion: 1,
    fingerprint: {
      events: { state: "file", size: inputTokens, mtimeMs: inputTokens + 1 },
      modelState: { state: "missing" },
    },
    result: {
      hasEvents: true,
      included: false,
      reason: "no_shutdown",
      includedUsageAts: [],
      skippedAt: null,
      modelRows: [],
      totals: {
        requests: 0,
        inputTokens,
        uncachedInputTokens: inputTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: inputTokens,
        meteredAiCredits: 0,
        meteredTokens: 0,
      },
    },
  };
}

describe("createCopilotUsageStore", () => {
  it("persists, replaces, and deletes per-session cache entries", () => {
    const db = openMemoryDatabase();
    const store = createCopilotUsageStore(db);

    store.upsertEntries([createEntry("session-1", 10), createEntry("session-2", 20)]);
    expect(store.listSessionIds()).toEqual(["session-1", "session-2"]);
    expect(store.listEntries()).toEqual([
      createEntry("session-1", 10),
      createEntry("session-2", 20),
    ]);

    store.upsertEntries([createEntry("session-1", 30)]);
    store.deleteEntries(["session-2"]);

    expect(store.listEntries()).toEqual([createEntry("session-1", 30)]);
    db.close();
  });

  it("persists the latest completed scan timestamp", () => {
    const db = openMemoryDatabase();
    const store = createCopilotUsageStore(db);

    expect(store.getLastCompletedAt()).toBeNull();
    store.setLastCompletedAt("2026-07-15T12:00:00.000Z");
    expect(store.getLastCompletedAt()).toBe("2026-07-15T12:00:00.000Z");

    db.close();
  });

  it("prunes only expired retained defer-worker entries", () => {
    const db = openMemoryDatabase();
    const store = createCopilotUsageStore(db);
    const retained = createRetainedCopilotUsageEntry(
      "d3f3e000-0000-4000-8000-000000000001",
      1,
      createEntry("ignored", 10).result,
    );
    store.upsertEntries([retained, createEntry("regular-session", 20)]);
    db.prepare("UPDATE copilot_usage_sessions SET updatedAt = ?").run(
      "2026-01-01T00:00:00.000Z",
    );

    expect(store.pruneRetainedEntries("2026-02-01T00:00:00.000Z")).toEqual([
      retained.sessionId,
    ]);
    expect(store.listSessionIds()).toEqual(["regular-session"]);
    db.close();
  });
});
