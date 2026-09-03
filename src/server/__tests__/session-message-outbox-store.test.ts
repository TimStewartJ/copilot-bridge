import { beforeEach, describe, expect, it } from "vitest";
import { createSessionMessageOutboxStore } from "../session-message-outbox-store.js";
import { setupTestDb } from "./helpers.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;

beforeEach(() => {
  db = setupTestDb();
});

describe("session message outbox store", () => {
  it("persists, claims, retries, and completes messages", () => {
    const store = createSessionMessageOutboxStore(db);
    const item = store.enqueue({
      id: "delivery-1",
      sessionId: "session-1",
      prompt: "Result",
      source: "defer_result",
      sourceId: "interval_1",
      availableAt: "2026-09-03T00:00:00.000Z",
    })!;

    expect(item).toMatchObject({
      id: "delivery-1",
      status: "pending",
      attempts: 0,
      sourceId: "interval_1",
    });
    const claimed = store.claimDue(item.id, 60_000, "2026-09-03T00:00:00.000Z")!;
    expect(claimed.item).toMatchObject({ status: "running", attempts: 1 });
    expect(store.retry(
      item.id,
      claimed.claimToken,
      "2026-09-03T00:01:00.000Z",
      "Backend unavailable",
    )).toBe(true);

    const retried = store.get(item.id)!;
    expect(retried).toMatchObject({
      status: "pending",
      attempts: 1,
      availableAt: "2026-09-03T00:01:00.000Z",
      lastError: "Backend unavailable",
    });
    const reclaimed = store.claimDue(
      item.id,
      60_000,
      "2026-09-03T00:01:00.000Z",
    )!;
    expect(store.markCompleted(item.id, reclaimed.claimToken)).toBe(true);
    expect(store.get(item.id)?.status).toBe("completed");
  });

  it("reclaims expired leases and prunes only old terminal rows", () => {
    const store = createSessionMessageOutboxStore(db);
    const running = store.enqueue({
      id: "running",
      sessionId: "session-1",
      prompt: "Result",
      source: "defer_result",
      availableAt: "2026-09-03T00:00:00.000Z",
    })!;
    store.claimDue(running.id, 60_000, "2026-09-03T00:00:00.000Z");
    expect(store.reclaimExpiredRunning("2026-09-03T00:01:00.000Z")).toBe(1);
    expect(store.get(running.id)?.status).toBe("pending");

    const completed = store.enqueue({
      id: "completed",
      sessionId: "session-1",
      prompt: "Done",
      source: "defer_result",
    })!;
    store.markCompletedById(completed.id);
    db.prepare("UPDATE session_message_outbox SET updatedAt = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", completed.id);

    expect(store.pruneTerminalRows("2021-01-01T00:00:00.000Z")).toBe(1);
    expect(store.get(completed.id)).toBeUndefined();
    expect(store.get(running.id)).toBeDefined();
  });

  it("reactivates failed deliveries by source defer", () => {
    const store = createSessionMessageOutboxStore(db);
    const item = store.enqueue({
      id: "delivery-1",
      sessionId: "session-1",
      prompt: "Result",
      source: "defer_result",
      sourceId: "interval_1",
    })!;
    const claimed = store.claimDue(item.id, 60_000)!;
    store.markFailed(item.id, claimed.claimToken, "Parent unavailable");

    expect(store.reactivateFailedForSource("session-1", "interval_1")).toBe(1);
    expect(store.get(item.id)).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: undefined,
    });
  });
});
