import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createDeferSummaryLookup, getDeferSummaryForSession } from "../defer-summary.js";
import { parseDeferId, toIntervalDeferId } from "../defer-ids.js";
import type { DeferLoopStore } from "../defer-loop-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let store: DeferLoopStore;

beforeEach(() => {
  db = setupTestDb();
  store = createDeferLoopStore(db);
});

describe("defer-loop-store", () => {
  const baseLoop = {
    sessionId: "session-1",
    name: "poller",
    prompt: "Check the thing",
    intervalSeconds: 300,
    nextRunAt: "2030-01-01T00:00:00.000Z",
    maxRuns: 3,
    expiresAt: "2030-01-02T00:00:00.000Z",
  };

  it("claims only due loops and schedules the next wake from the resulting lease", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-01T00:10:00.000Z";
    expect(store.getNextWakeAt(now)).toBeUndefined();
    const loop = store.create({ ...baseLoop, nextRunAt: now });
    store.create({ ...baseLoop, prompt: "later", nextRunAt: later });
    expect(loop).toMatchObject({ status: "active", attempts: 0, runCount: 0 });
    expect(loop.id).toBeTruthy();
    expect(loop.deferId).toBe(toIntervalDeferId(loop.id));
    expect(parseDeferId(loop.deferId)).toEqual({ kind: "interval", id: loop.id });
    expect(store.listDue(now).map((row) => row.id)).toEqual([loop.id]);
    expect(store.getNextWakeAt(now)).toBe(later);

    const claimed = store.claimDue(loop.id, 60_000, now)!;
    expect(claimed.loop).toMatchObject({ status: "running", attempts: 1 });
    expect(store.claimDue(loop.id, 60_000, now)).toBeUndefined();
    expect(store.getNextWakeAt(now)).toBe(claimed.loop.leaseExpiresAt);
    expect(store.listExpiredRunning("2026-01-01T00:00:30.000Z")).toEqual([]);
    expect(store.listExpiredRunning("2026-01-01T00:01:00.000Z")).toEqual([
      expect.objectContaining({ id: loop.id, status: "running", claimToken: claimed.claimToken }),
    ]);
  });

  it("renews and releases claims with token checks", () => {
    const loop = store.create({ ...baseLoop, nextRunAt: "2026-01-01T00:00:00.000Z" });
    const claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z")!;

    expect(store.renewClaim(loop.id, "wrong", 60_000)).toBe(false);
    expect(store.renewClaim(loop.id, claimed.claimToken, 120_000)).toBe(true);
    expect(store.release(loop.id, "wrong")).toBe(false);
    expect(store.release(loop.id, claimed.claimToken, { error: "No free context" })).toBe(true);

    // The try is given back and the loop stays due at its original time.
    expect(store.get(loop.id)).toMatchObject({
      status: "active",
      nextRunAt: "2026-01-01T00:00:00.000Z",
      attempts: 0,
      runCount: 0,
      lastError: "No free context",
    });
    expect(store.get(loop.id)!.claimToken).toBeUndefined();
  });

  it("notes why an active loop is waiting until its next successful check", () => {
    const loop = store.create({ ...baseLoop, nextRunAt: "2026-01-01T00:00:00.000Z" });
    store.noteWait(loop.id, "No free context");
    expect(store.get(loop.id)!.lastError).toBe("No free context");

    const claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z")!;
    const settled = store.settleOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:00:30.000Z",
    )!;
    expect(settled.lastError).toBeUndefined();
  });

  it("summarizes active and running loops with the earliest queued run time", () => {
    const earliest = "2030-01-01T00:01:00.000Z";
    const later = "2030-01-01T00:02:00.000Z";
    const runningAt = "2030-01-01T00:00:30.000Z";
    store.create({ ...baseLoop, name: "later", prompt: "Later", nextRunAt: later });
    store.create({ ...baseLoop, name: "earliest", prompt: "Earliest", nextRunAt: earliest });
    const running = store.create({ ...baseLoop, name: "running", prompt: "Running", nextRunAt: runningAt });
    store.claimDue(running.id, 60_000, runningAt);
    store.create({
      ...baseLoop,
      sessionId: "session-2",
      name: "other",
      prompt: "Other",
      nextRunAt: "2030-01-01T00:00:00.000Z",
    });

    expect(store.getSummaryForSession("session-1")).toEqual({
      count: 3,
      runningCount: 1,
      nextRunAt: earliest,
    });
    expect(store.getSummaryForSession("missing-session")).toEqual({
      count: 0,
      runningCount: 0,
      nextRunAt: null,
    });
  });

  it("counts a failed check as a run, keeps the failure streak, and clears it on success", () => {
    const promptStore = createDeferredPromptStore(db);
    const loop = store.create({ ...baseLoop, maxRuns: 5, nextRunAt: "2026-01-01T00:00:00.000Z" });
    let claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z")!;
    expect(claimed.loop.attempts).toBe(1);
    expect(store.settleOccurrence(
      loop.id,
      "wrong-token",
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:00:30.000Z",
      { error: "wrong" },
    )).toBeUndefined();

    const failed = store.settleOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:00:30.000Z",
      { error: "worker failed" },
    )!;
    expect(failed).toMatchObject({
      status: "active",
      runCount: 1,
      attempts: 1,
      nextRunAt: "2026-01-01T00:05:00.000Z",
      lastError: "worker failed",
    });

    claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:05:00.000Z")!;
    expect(claimed.loop.attempts).toBe(2);
    const notice = {
      id: "failing-notice",
      sessionId: loop.sessionId,
      sourceId: loop.deferId,
      prompt: "The recurring defer keeps failing.",
    };
    expect(store.settleOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T00:05:30.000Z",
      { error: "worker failed again", delivery: notice },
    )).toMatchObject({ status: "active", runCount: 2, attempts: 2, lastError: "worker failed again" });
    expect(promptStore.listDeliveriesForSession(loop.sessionId)).toEqual([
      expect.objectContaining({ id: notice.id, sourceId: loop.deferId }),
    ]);

    claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:10:00.000Z")!;
    const succeeded = store.settleOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:15:00.000Z",
      "2026-01-01T00:10:30.000Z",
    )!;
    expect(succeeded).toMatchObject({ status: "active", runCount: 3, attempts: 0 });
    expect(succeeded.lastError).toBeUndefined();
  });

  it("ends the loop when a failed check was its last run", () => {
    const loop = store.create({ ...baseLoop, maxRuns: 1, nextRunAt: "2026-01-01T00:00:00.000Z" });
    const claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z")!;
    expect(store.settleOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:00:30.000Z",
      { error: "worker failed" },
    )).toMatchObject({ status: "completed", runCount: 1, lastError: "worker failed" });
  });

  it("persists and preserves a checkpoint atomically with an occurrence", () => {
    const loop = store.create({
      ...baseLoop,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    let claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z")!;

    expect(store.settleOccurrence(
      loop.id,
      "wrong-token",
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:00:30.000Z",
      { checkpoint: { status: "wrong" } },
    )).toBeUndefined();
    expect(store.get(loop.id)?.checkpoint).toBeUndefined();

    const completed = store.settleOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:00:30.000Z",
      { checkpoint: { status: "running", buildId: 42 } },
    )!;
    expect(completed.checkpoint).toEqual({ status: "running", buildId: 42 });

    const reopenedStore = createDeferLoopStore(db);
    expect(reopenedStore.get(loop.id)?.checkpoint).toEqual({
      status: "running",
      buildId: 42,
    });
    claimed = reopenedStore.claimDue(
      loop.id,
      60_000,
      "2026-01-01T00:05:00.000Z",
    )!;
    expect(reopenedStore.settleOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T00:05:30.000Z",
    )?.checkpoint).toEqual({ status: "running", buildId: 42 });
  });

  it("ends an active loop and queues its final message atomically", () => {
    const promptStore = createDeferredPromptStore(db);
    const loop = store.create({ ...baseLoop, nextRunAt: "2026-01-01T00:00:00.000Z" });
    const running = store.create({ ...baseLoop, prompt: "running", nextRunAt: "2026-01-01T00:00:00.000Z" });
    store.claimDue(running.id, 60_000, "2026-01-01T00:00:00.000Z");
    const message = (id: string, deferId: string) => ({
      id,
      sessionId: loop.sessionId,
      sourceId: deferId,
      prompt: "Monitoring expired.",
    });

    expect(store.markTerminalWithMessage(running.id, "expired", message("running-final", running.deferId))).toBe(false);
    expect(promptStore.listDeliveriesForSession(loop.sessionId)).toEqual([]);

    expect(store.markTerminalWithMessage(loop.id, "expired", message("final", loop.deferId))).toBe(true);
    expect(store.get(loop.id)!.status).toBe("expired");
    expect(promptStore.listDeliveriesForSession(loop.sessionId)).toEqual([
      expect.objectContaining({ id: "final", sourceId: loop.deferId }),
    ]);
  });

  it("cancels active and running loops for a session", () => {
    const active = store.create(baseLoop);
    const running = store.create({ ...baseLoop, prompt: "running" });
    store.claimDue(running.id, 60_000, "2030-01-01T00:00:00.000Z");
    store.create({ ...baseLoop, sessionId: "session-2" });

    expect(store.cancelForSession("session-1")).toBe(2);
    expect(store.get(active.id)!.status).toBe("cancelled");
    expect(store.get(running.id)!.status).toBe("cancelled");
    expect(store.listForSession("session-2")[0]?.status).toBe("active");
  });

});

// ── Merged from defer-summary.test.ts ────────────────────────────────────────
describe("defer summary (merged)", () => {
  it("combines both kinds of defer consistently in bulk and per-session summaries", () => {
    const deferredPromptStore = createDeferredPromptStore(db);
    const baseLoop = { prompt: "Check the thing", intervalSeconds: 300 };
    deferredPromptStore.create("session-1", "One shot later", "2030-01-01T00:10:00.000Z");
    deferredPromptStore.create("session-1", "One shot latest", "2030-01-01T00:20:00.000Z");
    deferredPromptStore.create("session-3", "Only one-shot", "2030-01-01T00:00:00.000Z");
    store.create({ ...baseLoop, sessionId: "session-1", nextRunAt: "2030-01-01T00:05:00.000Z" });
    store.create({ ...baseLoop, sessionId: "session-2", nextRunAt: "2030-01-01T00:01:00.000Z" });
    const cancelled = store.create({ ...baseLoop, sessionId: "session-4", nextRunAt: "2030-01-01T00:01:00.000Z" });
    store.cancelForSession(cancelled.sessionId);

    const lookup = createDeferSummaryLookup({ deferredPromptStore, deferLoopStore: store });
    for (const sessionId of ["session-1", "session-2", "session-3", "session-4", "missing"]) {
      expect(lookup(sessionId)).toEqual(getDeferSummaryForSession(sessionId, { deferredPromptStore, deferLoopStore: store }));
    }
    expect(lookup("session-1")).toEqual({ count: 3, runningCount: 0, nextRunAt: "2030-01-01T00:05:00.000Z" });
    expect(lookup("session-4")).toEqual({ count: 0, runningCount: 0, nextRunAt: null });
    expect(store.listSummariesBySession().has("session-4")).toBe(false);
    expect(createDeferSummaryLookup({})("session-1")).toEqual({ count: 0, runningCount: 0, nextRunAt: null });
  });
});
