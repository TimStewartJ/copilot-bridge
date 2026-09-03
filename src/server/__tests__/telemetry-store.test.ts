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
  it("records single and bulk spans with optional session, metadata, and dedupe keys", () => {
    store.recordSpan({ name: "session.create", duration: 150, source: "server" });
    const created = store.querySpans({ name: "session.create" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: "session.create", duration: 150, source: "server" });
    // Spans without metadata round-trip as null rather than undefined.
    expect(created[0].metadata).toBeNull();

    store.recordSpan({
      name: "session.resume",
      sessionId: "abc-123",
      duration: 300,
      metadata: { context: "doWork", cacheHit: false },
      source: "server",
    });
    const bySession = store.querySpans({ sessionId: "abc-123" });
    expect(bySession).toHaveLength(1);
    expect(bySession[0].sessionId).toBe("abc-123");
    expect(bySession[0].metadata).toEqual({ context: "doWork", cacheHit: false });

    store.recordSpans([
      { name: "api.tasks", duration: 20, source: "client" },
      { name: "api.task-groups", duration: 30, sessionId: "s-1", source: "client" },
      // Repeating an ingestKey must not create a second row.
      { name: "api.dup", duration: 20, source: "client", ingestKey: "dup-1" },
      { name: "api.dup", duration: 20, source: "client", ingestKey: "dup-1" },
    ]);
    const clientSpans = store.querySpans({ source: "client", limit: 10 });
    expect(clientSpans.map((span) => span.name).sort()).toEqual([
      "api.dup",
      "api.task-groups",
      "api.tasks",
    ]);
  });

  it("filters queries by source and honours the limit", () => {
    store.recordSpan({ name: "api.sessions", duration: 50, source: "client" });
    for (let i = 0; i < 10; i++) {
      store.recordSpan({ name: "test", duration: i * 10, source: "server" });
    }

    expect(store.querySpans({ source: "client" })).toHaveLength(1);
    expect(store.querySpans({ source: "server" })).toHaveLength(10);
    expect(store.querySpans({ limit: 3 })).toHaveLength(3);
  });

  it("filters spans by JSON metadata before applying the limit", () => {
    store.recordSpan({
      name: "defer.worker",
      sessionId: "session-1",
      duration: 100,
      source: "server",
      metadata: { deferId: "interval_target", action: "continue" },
    });
    store.recordSpans(Array.from({ length: 10 }, (_, index) => ({
      name: "defer.worker",
      sessionId: "session-1",
      duration: index,
      source: "server" as const,
      metadata: { deferId: "interval_other", action: "continue" },
    })));

    expect(store.querySpans({
      name: "defer.worker",
      sessionId: "session-1",
      limit: 1,
      metadataEquals: { deferId: "interval_target" },
    })).toEqual([
      expect.objectContaining({
        duration: 100,
        metadata: expect.objectContaining({ deferId: "interval_target" }),
      }),
    ]);
  });

  it("prunes spans older than the retention window and keeps recent ones", () => {
    store.recordSpan({ name: "old", duration: 100, source: "server" });
    db.prepare("UPDATE telemetry_spans SET createdAt = '2020-01-01T00:00:00Z'").run();
    store.recordSpan({ name: "recent", duration: 100, source: "server" });

    expect(store.pruneOldSpans(1)).toBe(1);
    expect(store.querySpans().map((span) => span.name)).toEqual(["recent"]);
    expect(store.pruneOldSpans(7)).toBe(0);
    expect(store.querySpans()).toHaveLength(1);
  });
});
