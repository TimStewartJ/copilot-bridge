import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createSessionContextStore } from "../session-context-store.js";
import { normalizeLiveSessionContextEvent } from "../session-context-normalizer.js";

const cleanupPaths = new Set<string>();
const copilotUsageInfoFixture = JSON.parse(
  readFileSync(new URL("./fixtures/copilot-session-usage-info.json", import.meta.url), "utf-8"),
) as unknown;

afterEach(() => {
  for (const path of [...cleanupPaths].sort((a, b) => b.length - a.length)) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

function createProjectScratchDir(): string {
  const dir = join(process.cwd(), ".test-session-context-store", randomUUID());
  mkdirSync(dir, { recursive: true });
  cleanupPaths.add(join(process.cwd(), ".test-session-context-store"));
  return dir;
}

describe("session context telemetry store", () => {
  it("normalizes and coalesces unchanged live usage snapshots", () => {
    const store = createSessionContextStore(setupTestDb());
    store.recordTurnStart({
      sessionId: "session-1",
      provider: "copilot",
      providerSessionId: "provider-session-1",
      providerTurnId: "provider-turn-1",
      bridgeTurnId: "turn-1",
      startedAt: "2026-05-01T10:00:00.000Z",
    });

    const first = normalizeLiveSessionContextEvent({
      type: "usage_info",
      id: "usage-1",
      timestamp: "2026-05-01T10:00:01.000Z",
      data: {
        model: "gpt-5.4",
        contextWindow: 100_000,
        tokensUsed: 25_000,
        usage: { inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 4_900 },
      },
    }, {
      sessionId: "session-1",
      provider: "copilot",
      providerSessionId: "provider-session-1",
      bridgeTurnId: "turn-1",
    });
    const duplicate = normalizeLiveSessionContextEvent({
      type: "usage_info",
      id: "usage-2",
      timestamp: "2026-05-01T10:00:02.000Z",
      data: {
        model: "gpt-5.4",
        contextWindow: 100_000,
        tokensUsed: 25_000,
        usage: { inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 4_900 },
      },
    }, {
      sessionId: "session-1",
      provider: "copilot",
      providerSessionId: "provider-session-1",
      bridgeTurnId: "turn-1",
    });

    expect(first).not.toBeNull();
    expect(duplicate).not.toBeNull();
    const summary = store.recordContextEvent(first!);
    expect(store.recordContextEvent(duplicate!)).toBeNull();

    const context = store.getSessionContext("session-1");
    expect(summary).toMatchObject({
      provider: "copilot",
      providerSessionId: "provider-session-1",
      currentModel: "gpt-5.4",
      contextWindow: 100_000,
      tokensUsed: 25_000,
      snapshotCount: 1,
    });
    expect(context.capabilities).toMatchObject({
      contextWindow: "exact",
      modelUsage: "exact",
    });
    expect(context.turns).toHaveLength(1);
    expect(context.turns[0]).toMatchObject({
      bridgeTurnId: "turn-1",
      providerTurnId: "provider-turn-1",
      attribution: "turn",
    });
    expect(context.events).toHaveLength(1);
    expect(context.events[0]).toMatchObject({
      type: "context_snapshot",
      attribution: "turn",
      bridgeTurnId: "turn-1",
      providerEventId: "usage-1",
      modelUsage: {
        inputTokens: 20_000,
        outputTokens: 100,
        cacheReadTokens: 4_900,
        totalTokens: 25_000,
      },
      provenance: {
        contextWindow: { source: "live", confidence: "exact" },
        tokensUsed: { source: "live", confidence: "exact" },
        tokensRemaining: { source: "live", confidence: "exact" },
        modelUsage: { source: "live", confidence: "exact" },
      },
    });
  });

  it("normalizes Copilot SDK session.usage_info context snapshots", () => {
    const event = normalizeLiveSessionContextEvent(copilotUsageInfoFixture, {
      sessionId: "session-usage-info",
      provider: "copilot",
      providerSessionId: "provider-session-usage-info",
      bridgeTurnId: "turn-usage-info",
    });

    expect(event).toMatchObject({
      sessionId: "session-usage-info",
      provider: "copilot",
      providerSessionId: "provider-session-usage-info",
      providerEventId: "usage-info-1",
      bridgeTurnId: "turn-usage-info",
      attribution: "turn",
      type: "context_snapshot",
      contextWindow: 200_000,
      tokensUsed: 42_000,
      tokensRemaining: 158_000,
      usageRatio: 0.21,
      contextWindowCapability: "exact",
      provenance: {
        contextWindow: { source: "live", confidence: "exact" },
        tokensUsed: { source: "live", confidence: "exact" },
        tokensRemaining: { source: "live", confidence: "exact" },
      },
    });
  });

  it("stores truncation as a session-scoped marker with nullable turn identity", () => {
    const store = createSessionContextStore(setupTestDb());
    const summary = store.recordContextEvent({
      sessionId: "session-1",
      provider: "copilot",
      providerSessionId: "session-1",
      attribution: "session_overhead",
      bridgeTurnId: null,
      type: "truncation",
      occurredAt: "2026-05-01T11:00:00.000Z",
      metadata: { eventId: "event-1", eventsRemoved: 3 },
      dedupeKey: "truncation:event-1:3",
    });

    expect(summary).toMatchObject({ truncationCount: 1 });
    const context = store.getSessionContext("session-1");
    expect(context.capabilities.truncation).toBe("marker");
    expect(context.events).toHaveLength(1);
    expect(context.events[0]).toMatchObject({
      type: "truncation",
      attribution: "session_overhead",
      bridgeTurnId: null,
      metadata: { eventId: "event-1", eventsRemoved: 3 },
    });
  });

  it("backfills persisted shutdown and compaction markers idempotently", () => {
    const store = createSessionContextStore(setupTestDb());
    const events = [
      {
        type: "session.compaction",
        id: "compact-1",
        timestamp: "2026-05-01T12:00:00.000Z",
        data: { reason: "context pressure" },
      },
      {
        type: "session.shutdown",
        id: "shutdown-1",
        timestamp: "2026-05-01T12:05:00.000Z",
        data: {
          shutdownType: "normal",
          modelMetrics: {
            "gpt-5.4": {
              requests: { count: 2 },
              usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1 },
            },
          },
        },
      },
    ];

    store.backfillSessionContextEvents({ sessionId: "session-1", events });
    store.backfillSessionContextEvents({ sessionId: "session-1", events });

    const context = store.getSessionContext("session-1");
    expect(context.summary).toMatchObject({
      compactionCount: 1,
      shutdownCount: 1,
      modelUsage: {
        requests: 2,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        totalTokens: 16,
      },
      provenance: {
        modelUsage: { source: "backfill", confidence: "exact" },
      },
    });
    expect(context.capabilities).toMatchObject({
      modelUsage: "exact",
      compaction: "marker",
    });
    expect(context.events.map((event) => event.type)).toEqual(["compaction", "shutdown"]);
  });

  it("skips Copilot backfill when a different live provider already owns the summary", () => {
    const store = createSessionContextStore(setupTestDb());
    store.recordContextEvent({
      sessionId: "session-1",
      provider: "codex",
      providerSessionId: "codex-session-1",
      providerEventId: "codex-usage-1",
      bridgeTurnId: "turn-1",
      attribution: "turn",
      type: "context_snapshot",
      occurredAt: "2026-05-01T13:00:00.000Z",
      model: "codex-model",
      contextWindow: 80_000,
      tokensUsed: 20_000,
      contextWindowCapability: "exact",
    });

    store.backfillSessionContextEvents({
      sessionId: "session-1",
      provider: "copilot",
      providerSessionId: "copilot-session-1",
      events: [
        {
          type: "session.shutdown",
          id: "copilot-shutdown-1",
          timestamp: "2026-05-01T13:05:00.000Z",
          data: {
            modelMetrics: {
              "gpt-5.4": { usage: { inputTokens: 1 } },
            },
          },
        },
      ],
    });

    const context = store.getSessionContext("session-1");
    expect(context.provider).toBe("codex");
    expect(context.summary).toMatchObject({
      provider: "codex",
      providerSessionId: "codex-session-1",
      shutdownCount: 0,
      currentModel: "codex-model",
    });
    expect(context.events).toHaveLength(1);
    expect(context.events[0]).toMatchObject({
      provider: "codex",
      providerEventId: "codex-usage-1",
    });
  });

  it("async file backfill is idempotent and leaves cached context on file errors", async () => {
    const store = createSessionContextStore(setupTestDb());
    const scratchDir = createProjectScratchDir();
    const eventsPath = join(scratchDir, "events.jsonl");
    writeFileSync(eventsPath, `${JSON.stringify({
      type: "session.compaction",
      id: "compact-file-1",
      timestamp: "2026-05-01T14:00:00.000Z",
      data: { reason: "context pressure" },
    })}\n`);

    await store.backfillSessionContextFromEventsFile({ sessionId: "session-file", eventsPath });
    await store.backfillSessionContextFromEventsFile({ sessionId: "session-file", eventsPath });
    expect(store.getSessionContext("session-file").events.map((event) => event.providerEventId)).toEqual(["compact-file-1"]);

    rmSync(eventsPath, { force: true });
    await expect(store.backfillSessionContextFromEventsFile({ sessionId: "session-file", eventsPath })).resolves.toBeUndefined();
    expect(store.getSessionContext("session-file").summary).toMatchObject({
      compactionCount: 1,
      provider: "copilot",
    });
  });
});
