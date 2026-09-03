import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferDeliveryGuard } from "../defer-delivery-guard.js";
import { parseDeferId } from "../defer-ids.js";
import { createDeferLoopRunner } from "../defer-loop-runner.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import {
  createDeferredPromptRunner,
  DEFER_WATCHDOG_INTERVAL_MS,
  INITIAL_BACKOFF_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
} from "../deferred-prompt-runner.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createGlobalBus } from "../global-bus.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { RESTART_PENDING_MESSAGE } from "../session-manager.js";
import {
  BACKEND_DISCONNECTED_MESSAGE,
  BACKEND_RECONNECTING_MESSAGE,
} from "../backend-availability.js";
import type { DatabaseSync } from "../db.js";

function makeMockSessionManager(overrides: Partial<{
  sessions: string[];
  busySessions: Set<string>;
  startWorkError?: Error;
}> = {}) {
  const { sessions = [], busySessions = new Set(), startWorkError } = overrides;
  const started: Array<{ sessionId: string; prompt: string; options?: unknown }> = [];
  const attention: Array<{ sessionId: string; at?: string }> = [];
  return {
    listSessionsFromDisk: async (options: { includeArchived?: boolean } = {}) =>
      sessions.map((s) => ({ sessionId: s, archived: false, ...options })),
    isSessionBusy: (sid: string) => busySessions.has(sid),
    startWorkAndWaitForDelivery: async (sessionId: string, prompt: string, _attachments?: unknown, options?: unknown) => {
      if (startWorkError) throw startWorkError;
      started.push({ sessionId, prompt, options });
    },
    markSessionAttention: (sessionId: string, at?: string) => {
      attention.push({ sessionId, at });
    },
    _started: started,
    _attention: attention,
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
    expect(sm._started[0].prompt).toContain("If user action is needed, cancel this recurring deferral with the defer cancel tool using the deferId above, then clearly state the required next step and stop.");
    expect(sm._started[0].prompt).not.toContain("ask_user");
    expect(sm._started[0].prompt).toContain("User prompt:\nPoll deployment");
    expect(sm._started[0].options).toEqual({
      attentionMode: "quiet",
      historyTruncation: {
        mode: "replace-quiet-interval-defer-tail",
        deferId: loop.deferId,
      },
    });
    const updated = store.get(loop.id)!;
    expect(updated.status).toBe("active");
    expect(updated.runCount).toBe(1);
    expect(Date.parse(updated.nextRunAt)).toBe(Date.now() + 300_000);
    expect(summaryEvents).toEqual([
      { type: "session:defer-summary", sessionId: "session-1", deferSummary: { count: 0, nextRunAt: null } },
      { type: "session:defer-summary", sessionId: "session-1", deferSummary: { count: 1, nextRunAt: updated.nextRunAt } },
    ]);
    expect(sm._attention).toEqual([]);
    runner.shutdown();
  });

  it("uses an isolated worker and continues without waking the parent", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.runDeferWorker = vi.fn(async () => ({ action: "continue" }));
    const runner = createDeferLoopRunner(store, sm, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm.runDeferWorker).toHaveBeenCalledWith(expect.objectContaining({
      deferId: loop.deferId,
      kind: "interval",
      parentSessionId: "session-1",
      intervalSeconds: 300,
    }));
    expect(sm._started).toEqual([]);
    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 1 });
    runner.shutdown();
  });

  it("returns a worker result to the parent once and finishes the loop", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.runDeferWorker = vi.fn(async () => ({ action: "return", message: "Deployment failed." }));
    const deliveryGuard = createDeferDeliveryGuard();
    const onParentMessageQueued = vi.fn(() => {
      expect(deliveryGuard.isActive("session-1")).toBe(false);
    });
    const runner = createDeferLoopRunner(
      store,
      sm,
      bus,
      deliveryGuard,
      { deferredPromptStore: promptStore, deferLoopStore: store },
      { onParentMessageQueued },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm._started).toEqual([]);
    expect(store.get(loop.id)).toMatchObject({ status: "completed", runCount: 1 });
    expect(promptStore.listDeliveriesForSession("session-1")).toEqual([
      expect.objectContaining({
        status: "pending",
        sourceId: loop.deferId,
        prompt: expect.stringContaining("Deployment failed."),
      }),
    ]);
    expect(onParentMessageQueued).toHaveBeenCalledOnce();
    runner.shutdown();
  });

  it("notifies the parent and keeps the loop active", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
      maxRuns: 3,
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.runDeferWorker = vi.fn(async () => ({ action: "notify", message: "Phase two started." }));
    const onParentMessageQueued = vi.fn();
    const runner = createDeferLoopRunner(
      store,
      sm,
      bus,
      createDeferDeliveryGuard(),
      { deferredPromptStore: promptStore, deferLoopStore: store },
      { onParentMessageQueued },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 1 });
    expect(promptStore.listDeliveriesForSession("session-1")).toEqual([
      expect.objectContaining({
        status: "pending",
        sourceId: loop.deferId,
        prompt: expect.stringContaining("Phase two started."),
      }),
    ]);
    expect(promptStore.listDeliveriesForSession("session-1")[0]?.prompt).toContain(
      "The recurring deferred check remains active.",
    );
    expect(onParentMessageQueued).toHaveBeenCalledOnce();
    runner.shutdown();
  });

  it("finishes a loop silently when the worker chooses finish", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.runDeferWorker = vi.fn(async () => ({ action: "finish" }));
    const runner = createDeferLoopRunner(
      store,
      sm,
      createGlobalBus(),
      createDeferDeliveryGuard(),
      { deferredPromptStore: promptStore, deferLoopStore: store },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(loop.id)).toMatchObject({ status: "completed", runCount: 1 });
    expect(promptStore.listDeliveriesForSession("session-1")).toEqual([]);
    runner.shutdown();
  });

  it("returns a terminal notice when continue exhausts maxRuns", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
      maxRuns: 1,
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.runDeferWorker = vi.fn(async () => ({ action: "continue" }));
    const onParentMessageQueued = vi.fn();
    const runner = createDeferLoopRunner(
      store,
      sm,
      bus,
      createDeferDeliveryGuard(),
      { deferredPromptStore: promptStore, deferLoopStore: store },
      { onParentMessageQueued },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm.runDeferWorker).toHaveBeenCalledWith(expect.objectContaining({
      maxRuns: 1,
      remainingRunsAfterThis: 0,
      isFinalRun: true,
    }));
    expect(store.get(loop.id)).toMatchObject({ status: "completed", runCount: 1 });
    expect(promptStore.listDeliveriesForSession("session-1")).toEqual([
      expect.objectContaining({
        status: "pending",
        sourceId: loop.deferId,
        prompt: expect.stringContaining("reaching its maximum of 1 runs"),
      }),
    ]);
    expect(onParentMessageQueued).toHaveBeenCalledOnce();
    runner.shutdown();
  });

  it("expires a claimed worker occurrence without touching a reactivated loop", async () => {
    const store = createDeferLoopStore(db);
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const claimed = store.claimDue(loop.id, LEASE_MS)!;
    expect(store.cancelById(loop.id)).toBe(true);
    expect(store.reactivate(loop.id)).toBe(true);

    expect(store.markClaimedExpired(loop.id, claimed.claimToken)).toBe(false);
    expect(store.get(loop.id)?.status).toBe("active");
  });

  it("holds due loops while defer delivery readiness is not ready and resumes later", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const telemetryStore = createTelemetryStore(db);
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let readinessCalls = 0;
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.getDeferDeliveryReadiness = vi.fn(() => {
      readinessCalls += 1;
      return readinessCalls >= 3
        ? { ready: true }
        : { ready: false, reason: "agent backend startup hold", retryAfterMs: 1000 };
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const runner = createDeferLoopRunner(
      store,
      sm,
      bus,
      undefined,
      { deferLoopStore: store },
      { telemetryStore },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sm._started).toHaveLength(0);
    expect(store.get(loop.id)).toMatchObject({ status: "active", attempts: 0, runCount: 0 });
    expect(infoSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sm._started).toHaveLength(0);
    expect(store.get(loop.id)).toMatchObject({ status: "active", attempts: 0, runCount: 0 });
    expect(infoSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sm._started).toHaveLength(1);
    expect(store.get(loop.id)).toMatchObject({ status: "active", attempts: 0, runCount: 1 });
    expect(telemetryStore.querySpans({ name: "defer.runner.hold" })).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          deferKind: "interval",
          dueCount: 1,
          reason: "agent backend startup hold",
        }),
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({
          deferKind: "interval",
          dueCount: 1,
          reason: "agent backend startup hold",
        }),
      }),
    ]);
    infoSpy.mockRestore();
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

  it("catches up an overdue busy loop once when the idle event is missed", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const busySessions = new Set(["session-1"]);
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"], busySessions });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    busySessions.clear();
    await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

    expect(sm._started).toHaveLength(1);
    expect(store.get(loop.id)).toMatchObject({
      status: "active",
      runCount: 1,
      nextRunAt: new Date(Date.now() + 300_000).toISOString(),
    });
    runner.shutdown();
  });

  it("rolls back a claimed loop when setup fails after the claim", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll deployment",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    vi.spyOn(bus, "emit").mockImplementationOnce(() => {
      throw new Error("simulated summary failure");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm._started).toHaveLength(0);
    expect(store.get(loop.id)).toMatchObject({ status: "active", attempts: 0, runCount: 0 });

    await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

    expect(sm._started).toHaveLength(1);
    expect(store.get(loop.id)).toMatchObject({ status: "active", attempts: 0, runCount: 1 });
    errorSpy.mockRestore();
    runner.shutdown();
  });

  it("returns terminal notices for already exhausted and expired loops", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
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
    const onParentMessageQueued = vi.fn();
    const runner = createDeferLoopRunner(
      store,
      sm as any,
      bus,
      createDeferDeliveryGuard(),
      { deferredPromptStore: promptStore, deferLoopStore: store },
      { onParentMessageQueued },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(maxRunLoop.id)!.status).toBe("completed");
    expect(store.get(expiredLoop.id)!.status).toBe("expired");
    expect(sm._started).toHaveLength(1);
    expect(sm._attention).toHaveLength(2);
    expect(sm._attention).toEqual(expect.arrayContaining([
      { sessionId: "session-2", at: expect.any(String) },
      { sessionId: "session-1", at: expect.any(String) },
    ]));
    expect(promptStore.listDeliveriesForSession("session-2")).toEqual([
      expect.objectContaining({
        sourceId: expiredLoop.deferId,
        prompt: expect.stringContaining("expired before another check"),
      }),
    ]);
    expect(onParentMessageQueued).toHaveBeenCalledTimes(2);
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

  it.each([
    "Session tool initialization did not complete before prompt delivery",
    "resumeSession timed out after 60s",
  ])("retries transient loop delivery error with backoff until MAX_ATTEMPTS: %s", async (message) => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sm = makeMockSessionManager({
      sessions: ["session-1"],
      startWorkError: new Error(message),
    });
    const runner = createDeferLoopRunner(store, sm as any, bus);
    runner.start();

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(attempt === 1 ? 0 : INITIAL_BACKOFF_MS * Math.pow(2, attempt - 2));
      const row = store.get(loop.id)!;
      expect(row.status).toBe("active");
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toBe(message);
      expect(Date.parse(row.nextRunAt) - Date.now()).toBe(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
    }

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * Math.pow(2, MAX_ATTEMPTS - 2));
    expect(store.get(loop.id)).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      lastError: message,
    });
    expect(warnSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Loop ${loop.id} failed after ${MAX_ATTEMPTS} attempt(s)`),
    );
    runner.shutdown();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
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

  it.each([
    BACKEND_DISCONNECTED_MESSAGE,
    BACKEND_RECONNECTING_MESSAGE,
  ])("pauses backend-unavailable loop delivery without burning attempts: %s", async (message) => {
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
      startWorkError: new Error(message),
    });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 0, attempts: 0 });
    expect(store.get(loop.id)!.claimToken).toBeUndefined();
    expect(store.get(loop.id)!.leaseExpiresAt).toBeUndefined();
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
