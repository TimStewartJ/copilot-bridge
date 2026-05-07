import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferDeliveryGuard } from "../defer-delivery-guard.js";
import { parseDeferId } from "../defer-ids.js";
import { createDeferLoopRunner } from "../defer-loop-runner.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import { createDeferredPromptRunner, LEASE_MS } from "../deferred-prompt-runner.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createGlobalBus } from "../global-bus.js";
import { RESTART_PENDING_MESSAGE } from "../session-manager.js";
import type { DatabaseSync } from "../db.js";

function makeMockSessionManager(overrides: Partial<{
  sessions: string[];
  busySessions: Set<string>;
  startWorkError?: Error;
}> = {}) {
  const { sessions = [], busySessions = new Set(), startWorkError } = overrides;
  const started: Array<{ sessionId: string; prompt: string; options?: unknown }> = [];
  return {
    listSessionsFromDisk: async (options: { includeArchived?: boolean } = {}) =>
      sessions.map((s) => ({ sessionId: s, archived: false, ...options })),
    isSessionBusy: (sid: string) => busySessions.has(sid),
    startWorkAndWaitForDelivery: async (sessionId: string, prompt: string, _attachments?: unknown, options?: unknown) => {
      if (startWorkError) throw startWorkError;
      started.push({ sessionId, prompt, options });
    },
    _started: started,
  };
}

let db: DatabaseSync;

beforeEach(() => {
  db = setupTestDb();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("defer-loop-runner", () => {
  it("delivers one due occurrence with metadata and advances from acceptance time", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const summaryEvents: any[] = [];
    bus.subscribe((event) => {
      if (event.type === "session:defer-summary") summaryEvents.push(event);
    });
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: dueAt,
      maxRuns: 2,
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm._started).toHaveLength(1);
    expect(sm._started[0].prompt).toContain(`<defer>\ndeferId: ${loop.deferId}`);
    expect(sm._started[0].prompt).toContain("kind: interval");
    expect(sm._started[0].prompt).toContain("attentionMode: quiet");
    expect(sm._started[0].prompt).toContain("runCount: 1");
    expect(sm._started[0].prompt).toContain("If user input, approval, a decision, credentials, clarification, or prioritization is needed, you MUST use ask_user");
    expect(sm._started[0].prompt).toContain("User prompt:\nPoll deployment");
    expect(sm._started[0].options).toEqual({ attentionMode: "quiet" });
    const updated = store.get(loop.id)!;
    expect(updated.status).toBe("active");
    expect(updated.runCount).toBe(1);
    expect(Date.parse(updated.nextRunAt)).toBe(Date.now() + 300_000);
    expect(summaryEvents).toEqual([
      { type: "session:defer-summary", sessionId: "session-1", deferSummary: { count: 0, nextRunAt: null } },
      { type: "session:defer-summary", sessionId: "session-1", deferSummary: { count: 1, nextRunAt: updated.nextRunAt } },
    ]);
    runner.shutdown();
  });

  it("collapses missed intervals into one occurrence scheduled from acceptance time", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const dueAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: dueAt,
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm._started).toHaveLength(1);
    expect(store.get(loop.id)).toMatchObject({
      status: "active",
      runCount: 1,
      nextRunAt: new Date(Date.now() + 300_000).toISOString(),
    });
    runner.shutdown();
  });

  it("completes after maxRuns and expires loops without delivery", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    const maxRunLoop = store.create({
      sessionId: "session-1",
      prompt: "Run once",
      intervalSeconds: 300,
      nextRunAt: dueAt,
      maxRuns: 1,
    });
    const expiredLoop = store.create({
      sessionId: "session-2",
      prompt: "Expired",
      intervalSeconds: 300,
      nextRunAt: dueAt,
      expiresAt: new Date(Date.now() - 500).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1", "session-2"] });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(maxRunLoop.id)!.status).toBe("completed");
    expect(store.get(expiredLoop.id)!.status).toBe("expired");
    expect(sm._started).toHaveLength(1);
    runner.shutdown();
  });

  it("does not consume a run while the session is busy and retries on idle", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const busySessions = new Set(["session-1"]);
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"], busySessions });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sm._started).toHaveLength(0);
    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 0, attempts: 0 });

    busySessions.clear();
    bus.emit({ type: "session:idle", sessionId: "session-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sm._started).toHaveLength(1);
    expect(store.get(loop.id)!.runCount).toBe(1);
    runner.shutdown();
  });

  it("allows max attempt count for busy delivery errors", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sm = makeMockSessionManager({
      sessions: ["session-1"],
      startWorkError: new Error("Session is busy processing another message"),
    });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    for (let attempt = 1; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(attempt === 1 ? 0 : 5_000 * Math.pow(2, attempt - 2));
      expect(store.get(loop.id)).toMatchObject({
        status: "active",
        attempts: attempt,
      });
    }

    await vi.advanceTimersByTimeAsync(40_000);
    expect(store.get(loop.id)).toMatchObject({
      status: "failed",
      attempts: 5,
    });
    runner.shutdown();
  });

  it("releases restart-interrupted claims without consuming a run", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sm = makeMockSessionManager({
      sessions: ["session-1"],
      startWorkError: new Error(RESTART_PENDING_MESSAGE),
    });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 0, attempts: 0 });
    runner.shutdown();
  });

  it("reclaims running interval loops when their lease expires after startup", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    store.claimDue(loop.id, LEASE_MS);
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sm._started).toHaveLength(0);
    expect(store.get(loop.id)!.status).toBe("running");

    await vi.advanceTimersByTimeAsync(LEASE_MS);

    expect(sm._started).toHaveLength(1);
    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 1 });
    runner.shutdown();
  });

  it("shares a session delivery guard with one-shot defers", async () => {
    const loopStore = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const guard = createDeferDeliveryGuard();
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    loopStore.create({
      sessionId: "session-1",
      prompt: "Loop",
      intervalSeconds: 300,
      nextRunAt: dueAt,
    });
    promptStore.create("session-1", "One shot", dueAt);
    let releaseDelivery: (() => void) | undefined;
    const started: Array<{ sessionId: string; prompt: string }> = [];
    const sm = {
      listSessionsFromDisk: async () => [{ sessionId: "session-1" }],
      isSessionBusy: () => false,
      startWorkAndWaitForDelivery: (sessionId: string, prompt: string) => {
        started.push({ sessionId, prompt });
        if (started.length === 1) {
          return new Promise<void>((resolve) => {
            releaseDelivery = resolve;
          });
        }
        return Promise.resolve();
      },
    };
    const loopRunner = createDeferLoopRunner(loopStore, sm as any, bus, guard);
    const promptRunner = createDeferredPromptRunner(promptStore, sm as any, bus, guard);

    loopRunner.start();
    promptRunner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(1);

    releaseDelivery?.();
    await vi.advanceTimersByTimeAsync(0);
    bus.emit({ type: "session:idle", sessionId: "session-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2);
    loopRunner.shutdown();
    promptRunner.shutdown();
  });

  it("cancels active and running loops when a session is archived", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const active = store.create({
      sessionId: "session-1",
      prompt: "Future",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const running = store.create({
      sessionId: "session-1",
      prompt: "Running",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    store.claimDue(running.id, LEASE_MS);
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    bus.emit({ type: "session:archived", sessionId: "session-1", archived: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(active.id)!.status).toBe("cancelled");
    expect(store.get(running.id)!.status).toBe("cancelled");
    runner.shutdown();
  });

  it("keeps a self-cancelled interval cancelled after delivery resolves", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll until done",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const started: Array<{ sessionId: string; prompt: string }> = [];
    const sm = {
      listSessionsFromDisk: async () => [{ sessionId: "session-1" }],
      isSessionBusy: () => false,
      startWorkAndWaitForDelivery: async (sessionId: string, prompt: string) => {
        started.push({ sessionId, prompt });
        const deferId = prompt.match(/deferId: (interval_[^\n]+)/)?.[1];
        expect(deferId).toBe(loop.deferId);
        expect(parseDeferId(deferId!)).toEqual({ kind: "interval", id: loop.id });
        store.cancelById(loop.id);
      },
    };
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(started).toHaveLength(1);
    expect(store.get(loop.id)).toMatchObject({ status: "cancelled", runCount: 0 });
    runner.shutdown();
  });
});
