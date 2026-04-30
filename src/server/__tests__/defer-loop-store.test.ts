import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import { parseDeferId, toIntervalDeferId, toOnceDeferId } from "../defer-ids.js";
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

  it("creates loops with prefixed public defer ids", () => {
    const loop = store.create(baseLoop);
    expect(loop.id).toBeTruthy();
    expect(loop.deferId).toBe(toIntervalDeferId(loop.id));
    expect(parseDeferId(loop.deferId)).toEqual({ kind: "interval", id: loop.id });
    expect(parseDeferId(toOnceDeferId("one-shot"))).toEqual({ kind: "once", id: "one-shot" });
    expect(loop.status).toBe("active");
    expect(loop.runCount).toBe(0);
    expect(loop.attempts).toBe(0);
  });

  it("lists and claims due active loops only", () => {
    const due = store.create({ ...baseLoop, nextRunAt: "2026-01-01T00:00:00.000Z" });
    store.create({ ...baseLoop, prompt: "future", nextRunAt: "2030-01-01T00:00:00.000Z" });

    expect(store.listDue("2026-01-01T00:00:00.000Z").map((loop) => loop.id)).toEqual([due.id]);

    const claimed = store.claimDue(due.id, 60_000, "2026-01-01T00:00:00.000Z");
    expect(claimed).toBeDefined();
    expect(claimed!.loop.status).toBe("running");
    expect(claimed!.loop.attempts).toBe(1);
    expect(store.claimDue(due.id, 60_000, "2026-01-01T00:00:00.000Z")).toBeUndefined();
  });

  it("renews, retries, and releases claims with token checks", () => {
    const loop = store.create({ ...baseLoop, nextRunAt: "2026-01-01T00:00:00.000Z" });
    const claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z")!;

    expect(store.renewClaim(loop.id, "wrong", 60_000)).toBe(false);
    expect(store.renewClaim(loop.id, claimed.claimToken, 120_000)).toBe(true);
    expect(store.releaseClaimWithoutAttempt(loop.id, "wrong")).toBe(false);
    expect(store.retry(loop.id, "wrong", "2026-01-01T00:05:00.000Z")).toBe(false);
    expect(store.retry(loop.id, claimed.claimToken, "2026-01-01T00:05:00.000Z", "busy")).toBe(true);

    const retried = store.get(loop.id)!;
    expect(retried.status).toBe("active");
    expect(retried.nextRunAt).toBe("2026-01-01T00:05:00.000Z");
    expect(retried.lastError).toBe("busy");
  });

  it("summarizes active loops for a session with the earliest next run time", () => {
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
      count: 2,
      nextRunAt: earliest,
    });
    expect(store.getSummaryForSession("missing-session")).toEqual({
      count: 0,
      nextRunAt: null,
    });
  });

  it("completes occurrences and marks max-run loops completed", () => {
    const loop = store.create({ ...baseLoop, maxRuns: 1, nextRunAt: "2026-01-01T00:00:00.000Z" });
    const claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z")!;

    const completed = store.completeOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:00:30.000Z",
    )!;

    expect(completed.runCount).toBe(1);
    expect(completed.status).toBe("completed");
    expect(completed.claimToken).toBeUndefined();
  });

  it("resets attempts after a successful occurrence", () => {
    const loop = store.create({ ...baseLoop, maxRuns: 3, nextRunAt: "2026-01-01T00:00:00.000Z" });
    let claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z")!;
    expect(claimed.loop.attempts).toBe(1);
    expect(store.retry(loop.id, claimed.claimToken, "2026-01-01T00:00:10.000Z", "busy")).toBe(true);
    claimed = store.claimDue(loop.id, 60_000, "2026-01-01T00:00:10.000Z")!;
    expect(claimed.loop.attempts).toBe(2);

    const completed = store.completeOccurrence(
      loop.id,
      claimed.claimToken,
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:00:30.000Z",
    )!;

    expect(completed.status).toBe("active");
    expect(completed.runCount).toBe(1);
    expect(completed.attempts).toBe(0);
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

  it("reclaims expired running loops without consuming attempts", () => {
    const loop = store.create({ ...baseLoop, nextRunAt: "2026-01-01T00:00:00.000Z" });
    store.claimDue(loop.id, 60_000, "2026-01-01T00:00:00.000Z");

    expect(store.reclaimExpiredRunning("2026-01-01T00:00:30.000Z")).toBe(0);
    expect(store.reclaimExpiredRunning("2026-01-01T00:01:00.000Z")).toBe(1);
    expect(store.get(loop.id)!.status).toBe("active");
  });
});
