import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createTelemetryStore } from "../telemetry-store.js";
import type { TelemetryStore } from "../telemetry-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let store: TelemetryStore;

beforeEach(() => {
  db = setupTestDb();
  store = createTelemetryStore(db);
});

describe("telemetry-store", () => {
  it("records and queries a span", () => {
    store.recordSpan({ name: "session.create", duration: 150, source: "server" });
    const spans = store.querySpans({ name: "session.create" });
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("session.create");
    expect(spans[0].duration).toBe(150);
    expect(spans[0].source).toBe("server");
  });

  it("records span with sessionId and metadata", () => {
    store.recordSpan({
      name: "session.resume",
      sessionId: "abc-123",
      duration: 300,
      metadata: { context: "doWork", cacheHit: false },
      source: "server",
    });
    const spans = store.querySpans({ sessionId: "abc-123" });
    expect(spans).toHaveLength(1);
    expect(spans[0].sessionId).toBe("abc-123");
    expect(spans[0].metadata).toEqual({ context: "doWork", cacheHit: false });
  });

  it("records spans in bulk", () => {
    store.recordSpans([
      { name: "api.tasks", duration: 20, source: "client" },
      { name: "api.task-groups", duration: 30, sessionId: "s-1", source: "client" },
    ]);
    const spans = store.querySpans({ source: "client", limit: 10 });
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.name).sort()).toEqual(["api.task-groups", "api.tasks"]);
  });

  it("deduplicates spans with the same ingest key", () => {
    store.recordSpans([
      { name: "api.tasks", duration: 20, source: "client", ingestKey: "dup-1" },
      { name: "api.tasks", duration: 20, source: "client", ingestKey: "dup-1" },
    ]);
    const spans = store.querySpans({ source: "client", limit: 10 });
    expect(spans).toHaveLength(1);
  });

  it("filters by source", () => {
    store.recordSpan({ name: "api.sessions", duration: 50, source: "client" });
    store.recordSpan({ name: "session.create", duration: 200, source: "server" });

    expect(store.querySpans({ source: "client" })).toHaveLength(1);
    expect(store.querySpans({ source: "server" })).toHaveLength(1);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.recordSpan({ name: "test", duration: i * 10, source: "server" });
    }
    const spans = store.querySpans({ limit: 3 });
    expect(spans).toHaveLength(3);
  });

  it("getStats returns aggregated stats", () => {
    store.recordSpan({ name: "session.create", duration: 100, source: "server" });
    store.recordSpan({ name: "session.create", duration: 200, source: "server" });
    store.recordSpan({ name: "session.create", duration: 300, source: "server" });
    store.recordSpan({ name: "session.resume", duration: 500, source: "server" });

    const stats = store.getStats();
    expect(stats).toHaveLength(2);

    const createStats = stats.find((s) => s.name === "session.create")!;
    expect(createStats.count).toBe(3);
    expect(createStats.avg).toBe(200);
    expect(createStats.min).toBe(100);
    expect(createStats.max).toBe(300);
  });

  it("pruneOldSpans removes old entries", () => {
    store.recordSpan({ name: "old", duration: 100, source: "server" });

    // Manually backdate the entry
    db.prepare("UPDATE telemetry_spans SET createdAt = '2020-01-01T00:00:00Z'").run();

    const pruned = store.pruneOldSpans(1);
    expect(pruned).toBe(1);
    expect(store.querySpans()).toHaveLength(0);
  });

  it("pruneOldSpans keeps recent entries", () => {
    store.recordSpan({ name: "recent", duration: 100, source: "server" });
    const pruned = store.pruneOldSpans(7);
    expect(pruned).toBe(0);
    expect(store.querySpans()).toHaveLength(1);
  });

  it("handles null metadata gracefully", () => {
    store.recordSpan({ name: "test", duration: 42, source: "client" });
    const spans = store.querySpans();
    expect(spans[0].metadata).toBeNull();
  });
});
