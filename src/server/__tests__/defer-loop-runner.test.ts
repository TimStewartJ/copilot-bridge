import { BRIDGE_RESTARTING_MESSAGE } from "../backend-availability.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferDeliveryGuard } from "../defer-delivery-guard.js";
import { parseDeferId } from "../defer-ids.js";
import { createDeferLoopRunner, FAILING_LOOP_NOTICE_AFTER } from "../defer-loop-runner.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import {
  createDeferredPromptRunner,
  DEFER_WATCHDOG_INTERVAL_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
} from "../deferred-prompt-runner.js";
import { LEASE_EXPIRED_ERROR } from "../defer-runner-core.js";
import { SessionCapacityError } from "../session-manager.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createGlobalBus } from "../global-bus.js";
import { createTelemetryStore } from "../telemetry-store.js";

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
  const sm = {
    // Each check runs in a worker. Unless a test supplies one, the check records itself in `_started`
    // and continues quietly, so scheduling tests can assert on what ran without caring how.
    runDeferWorker: undefined as undefined | ((input: any) => Promise<any> | any),
    tryAcquireDeferWorker: (): { run: (input: any) => Promise<any>; release: () => void } | undefined => ({
      run: async (input: any) => {
        if (sm.runDeferWorker) return sm.runDeferWorker(input);
        if (startWorkError) throw startWorkError;
        started.push({ sessionId: input.parentSessionId, prompt: input.prompt });
        return { action: "continue" };
      },
      release: () => {},
    }),
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
  return sm;
}

function capacityError(): SessionCapacityError {
  return new SessionCapacityError("context-limit", {
    contexts: 33,
    contextLimit: 32,
    localMcpInstances: 33,
    capacityUnits: 41.25,
    capacityLimit: 64,
  });
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
  it("runs one due check in a worker with its run context and advances from acceptance time", async () => {
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
    sm.runDeferWorker = vi.fn(async () => ({ action: "continue" }));
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm.runDeferWorker).toHaveBeenCalledExactlyOnceWith({
      deferId: loop.deferId,
      kind: "interval",
      parentSessionId: "session-1",
      prompt: "Poll deployment",
      runCount: 1,
      maxRuns: 2,
      remainingRunsAfterThis: 1,
      isFinalRun: false,
      intervalSeconds: 300,
    });
    // The check never becomes a turn in the chat itself.
    expect(sm._started).toEqual([]);
    const updated = store.get(loop.id)!;
    expect(updated.status).toBe("active");
    expect(updated.runCount).toBe(1);
    expect(Date.parse(updated.nextRunAt)).toBe(Date.now() + 300_000);
    expect(summaryEvents).toEqual([
      { type: "session:defer-summary", sessionId: "session-1", deferSummary: { count: 1, runningCount: 1, nextRunAt: null } },
      { type: "session:defer-summary", sessionId: "session-1", deferSummary: { count: 1, runningCount: 0, nextRunAt: updated.nextRunAt } },
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
    sm.runDeferWorker = vi.fn()
      .mockResolvedValueOnce({
        action: "continue",
        checkpoint: { status: "running", buildId: 42 },
      })
      .mockResolvedValueOnce({ action: "finish" });
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
    expect(store.get(loop.id)).toMatchObject({
      status: "active",
      runCount: 1,
      checkpoint: { status: "running", buildId: 42 },
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(sm.runDeferWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({
      checkpoint: { status: "running", buildId: 42 },
    }));
    expect(store.get(loop.id)).toMatchObject({ status: "completed", runCount: 2 });
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
    sm.runDeferWorker = vi.fn(async () => ({
      action: "return",
      message: "Deployment failed.",
      checkpoint: { status: "failed", reason: "validation" },
    }));
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
    expect(store.get(loop.id)).toMatchObject({
      status: "completed",
      runCount: 1,
      checkpoint: { status: "failed", reason: "validation" },
    });
    expect(promptStore.listDeliveriesForSession("session-1")).toEqual([
      expect.objectContaining({
        status: "pending",
        sourceId: loop.deferId,
        prompt: expect.stringContaining("Deployment failed."),
      }),
    ]);
    expect(promptStore.listDeliveriesForSession("session-1")[0]?.prompt).toContain(
      "FINAL DEFER RESULT: Monitoring completed. This defer is no longer active.",
    );
    expect(promptStore.listDeliveriesForSession("session-1")[0]?.prompt).not.toContain(
      "without reaching a terminal result",
    );
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
    sm.runDeferWorker = vi.fn(async () => ({
      action: "notify",
      message: "Phase two started.",
      checkpoint: { phase: 2 },
    }));
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

    expect(store.get(loop.id)).toMatchObject({
      status: "active",
      runCount: 1,
      checkpoint: { phase: 2 },
    });
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
    expect(promptStore.listDeliveriesForSession("session-1")[0]?.prompt).not.toContain(
      "defer-checkpoint",
    );
    expect(onParentMessageQueued).toHaveBeenCalledOnce();
    runner.shutdown();
  });

  it("returns a final result when the worker chooses finish", async () => {
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
    expect(promptStore.listDeliveriesForSession("session-1")).toEqual([
      expect.objectContaining({
        status: "pending",
        sourceId: loop.deferId,
        prompt: expect.stringContaining(
          "FINAL DEFER RESULT: Monitoring completed. This defer is no longer active.",
        ),
      }),
    ]);
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
        prompt: expect.stringContaining("FINAL DEFER RESULT: Monitoring stopped after 1 checks"),
      }),
    ]);
    expect(onParentMessageQueued).toHaveBeenCalledOnce();
    runner.shutdown();
  });

  it("does not let a stale claim settle a loop that was reactivated meanwhile", async () => {
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

    expect(store.settleOccurrence(
      loop.id,
      claimed.claimToken,
      new Date(Date.now() + 300_000).toISOString(),
      new Date().toISOString(),
      { status: "expired" },
    )).toBeUndefined();
    expect(store.release(loop.id, claimed.claimToken)).toBe(false);
    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 0 });
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

  it("keeps a loop on its schedule when checks fail, counts each as a run, and tells the chat once", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      name: "Deployment monitor",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    let failing = true;
    sm.runDeferWorker = vi.fn(async () => {
      if (failing) throw new Error("Deferred worker ended without calling defer_result.");
      return { action: "continue" };
    });
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
    // More failed checks than the old attempt budget, one interval apart.
    const failures = MAX_ATTEMPTS + 2;
    for (let failure = 1; failure <= failures; failure++) {
      await vi.advanceTimersByTimeAsync(failure === 1 ? 0 : 300_000);
      const row = store.get(loop.id)!;
      expect(row).toMatchObject({
        status: "active",
        runCount: failure,
        attempts: failure,
        lastError: "Deferred worker ended without calling defer_result.",
      });
      expect(Date.parse(row.nextRunAt)).toBe(Date.now() + 300_000);
      expect(promptStore.listDeliveriesForSession("session-1"))
        .toHaveLength(failure >= FAILING_LOOP_NOTICE_AFTER ? 1 : 0);
    }
    expect(sm.runDeferWorker).toHaveBeenCalledTimes(failures);

    const [notice] = promptStore.listDeliveriesForSession("session-1");
    expect(notice).toMatchObject({ sourceId: loop.deferId, status: "pending" });
    expect(notice!.prompt).toContain("continues: true");
    expect(notice!.prompt).toContain(
      `The last ${FAILING_LOOP_NOTICE_AFTER} checks of the recurring defer "Deployment monitor" (${loop.deferId}) failed`,
    );
    expect(notice!.prompt).toContain("Last error: Deferred worker ended without calling defer_result.");
    // It must not read as a request to cancel: a monitor should outlast a temporary error.
    expect(notice!.prompt).toContain("The defer is still active");
    expect(notice!.prompt).toContain("Leave it running if the error looks temporary.");
    expect(notice!.prompt).not.toContain("FINAL DEFER RESULT");
    expect(sm._attention).toHaveLength(1);

    // The next good check clears the streak; a later failure starts a new one.
    failing = false;
    await vi.advanceTimersByTimeAsync(300_000);
    const recovered = store.get(loop.id)!;
    expect(recovered).toMatchObject({ status: "active", runCount: failures + 1, attempts: 0 });
    expect(recovered.lastError).toBeUndefined();

    // A new streak is reported again, once, when it reaches the same length.
    failing = true;
    for (let failure = 1; failure <= FAILING_LOOP_NOTICE_AFTER + 1; failure++) {
      await vi.advanceTimersByTimeAsync(300_000);
      expect(store.get(loop.id)).toMatchObject({ status: "active", attempts: failure });
      expect(promptStore.listDeliveriesForSession("session-1"))
        .toHaveLength(failure >= FAILING_LOOP_NOTICE_AFTER ? 2 : 1);
    }
    runner.shutdown();
    warnSpy.mockRestore();
  });

  it("says why a loop never got its last check when it expires while waiting", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.runDeferWorker = vi.fn();
    sm.getSessionCapacityWait = () => "All 32 live Copilot contexts are currently in use.";
    const runner = createDeferLoopRunner(store, sm, createGlobalBus());

    runner.start();
    await vi.advanceTimersByTimeAsync(2 * DEFER_WATCHDOG_INTERVAL_MS);

    expect(sm.runDeferWorker).not.toHaveBeenCalled();
    expect(store.get(loop.id)?.status).toBe("expired");
    const [final] = promptStore.listDeliveriesForSession("session-1");
    expect(final!.prompt).toContain("FINAL DEFER RESULT: Monitoring expired before another check could run");
    expect(final!.prompt).toContain("Last error: All 32 live Copilot contexts are currently in use.");
    runner.shutdown();
  });

  it("goes on to a chat's next loop when the first one cannot get a worker", async () => {
    const store = createDeferLoopStore(db);
    const first = store.create({
      sessionId: "session-1",
      prompt: "First",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 2_000).toISOString(),
    });
    // Already past its run limit: ending it needs no worker, so a waiting loop ahead of it must not delay that.
    const second = store.create({
      sessionId: "session-1",
      prompt: "Second",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
      maxRuns: 1,
    });
    db.prepare("UPDATE defer_loops SET runCount = 1 WHERE id = ?").run(second.id);
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.tryAcquireDeferWorker = vi.fn(() => undefined);
    const runner = createDeferLoopRunner(store, sm, createGlobalBus());

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(first.id)).toMatchObject({ status: "active", runCount: 0, attempts: 0 });
    expect(store.get(second.id)?.status).toBe("completed");
    runner.shutdown();
  });

  it("names the last error when the final run of a loop fails", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
      maxRuns: 1,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    sm.runDeferWorker = vi.fn(async () => {
      throw new Error("Model request failed");
    });
    const runner = createDeferLoopRunner(store, sm as any, createGlobalBus());

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(loop.id)).toMatchObject({ status: "completed", runCount: 1, lastError: "Model request failed" });
    const [final] = promptStore.listDeliveriesForSession("session-1");
    expect(final!.prompt).toContain("FINAL DEFER RESULT: Monitoring stopped after 1 checks");
    expect(final!.prompt).toContain("The last check failed: Model request failed");
    expect(final!.prompt).not.toContain("continues: true");
    runner.shutdown();
    warnSpy.mockRestore();
  });

  it.each([
    { streak: 1, notices: 0 },
    { streak: FAILING_LOOP_NOTICE_AFTER, notices: 1 },
  ])("settles a check the server stopped in the middle of as a failed run (streak $streak)", async ({ streak, notices }) => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    // What a claim leaves behind when the server dies: running, lease long gone.
    db.prepare(`
      UPDATE defer_loops
      SET status = 'running', attempts = ?, claimToken = 'stale-claim', leaseExpiresAt = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(streak, loop.id);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onParentMessageQueued = vi.fn();
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
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

    const row = store.get(loop.id)!;
    expect(row).toMatchObject({ status: "active", runCount: 1, attempts: streak, lastError: LEASE_EXPIRED_ERROR });
    expect(row.claimToken).toBeUndefined();
    expect(Date.parse(row.nextRunAt)).toBe(Date.now() + 300_000);
    // It is not rerun at once: a check that takes the server down must not run on every start.
    expect(sm._started).toEqual([]);
    expect(promptStore.listDeliveriesForSession("session-1")).toHaveLength(notices);
    expect(onParentMessageQueued).toHaveBeenCalledTimes(notices);
    runner.shutdown();
    warnSpy.mockRestore();
  });

  it("cancels a loop whose chat is gone without queuing anything for it", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const loop = store.create({
      sessionId: "missing-session",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    db.prepare("UPDATE defer_loops SET attempts = ?, lastError = ? WHERE id = ?")
      .run(MAX_ATTEMPTS, "Worker failed", loop.id);
    const runner = createDeferLoopRunner(
      store,
      makeMockSessionManager({ sessions: [] }) as any,
      createGlobalBus(),
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(loop.id)?.status).toBe("cancelled");
    expect(promptStore.listDeliveriesForSession("missing-session")).toEqual([]);
    runner.shutdown();
  });

  it("waits without counting anything while no Copilot context is free, then runs", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: dueAt,
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    sm.runDeferWorker = vi.fn(async () => ({ action: "continue" }));
    let full = true;
    // A check needs a context of its own, so the runner asks without naming the chat.
    sm.getSessionCapacityWait = vi.fn((sessionId?: string) =>
      full && sessionId === undefined ? "All 32 live Copilot contexts are currently in use." : undefined);
    const summaryEvents: any[] = [];
    bus.subscribe((event) => {
      if (event.type === "session:defer-summary") summaryEvents.push(event);
    });
    const runner = createDeferLoopRunner(store, sm, bus);

    runner.start();
    // A full house that lasts far longer than five tries used to.
    await vi.advanceTimersByTimeAsync(60 * DEFER_WATCHDOG_INTERVAL_MS);

    expect(sm.runDeferWorker).not.toHaveBeenCalled();
    expect(sm.getSessionCapacityWait.mock.calls.length).toBeGreaterThan(MAX_ATTEMPTS);
    expect(store.get(loop.id)).toMatchObject({
      status: "active",
      runCount: 0,
      attempts: 0,
      nextRunAt: dueAt,
      lastError: "All 32 live Copilot contexts are currently in use.",
    });
    // Nothing was claimed, so the chat's defer indicator never flickered and nothing was queued for it.
    expect(summaryEvents).toEqual([]);
    expect(promptStore.listDeliveriesForSession("session-1")).toEqual([]);

    full = false;
    await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

    expect(sm.runDeferWorker).toHaveBeenCalledOnce();
    const ran = store.get(loop.id)!;
    expect(ran).toMatchObject({ status: "active", runCount: 1, attempts: 0 });
    expect(ran.lastError).toBeUndefined();
    runner.shutdown();
  });

  it("does not count a try the worker gave up for lack of capacity", async () => {
    const store = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: dueAt,
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    let full = true;
    sm.runDeferWorker = vi.fn(async () => {
      if (full) throw capacityError();
      return { action: "continue" };
    });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    for (let sweep = 0; sweep <= MAX_ATTEMPTS + 2; sweep++) {
      await vi.advanceTimersByTimeAsync(sweep === 0 ? 0 : DEFER_WATCHDOG_INTERVAL_MS);
      const row = store.get(loop.id)!;
      expect(row).toMatchObject({ status: "active", runCount: 0, attempts: 0, nextRunAt: dueAt });
      expect(row.lastError).toContain("All 32 live Copilot contexts are currently in use.");
      expect(row.claimToken).toBeUndefined();
    }
    // One try per sweep: a waiting loop stays due, so it must not spin.
    expect(sm.runDeferWorker).toHaveBeenCalledTimes(MAX_ATTEMPTS + 3);
    expect(promptStore.listDeliveriesForSession("session-1")).toEqual([]);

    full = false;
    await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);
    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 1, attempts: 0 });
    runner.shutdown();
  });

  it("does not let two runners with waiting checks wake each other in a loop", async () => {
    const loopStore = createDeferLoopStore(db);
    const promptStore = createDeferredPromptStore(db);
    const bus = createGlobalBus();
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    loopStore.create({ sessionId: "session-1", prompt: "Loop", intervalSeconds: 300, nextRunAt: dueAt });
    promptStore.create("session-2", "One shot", dueAt);
    const sm = makeMockSessionManager({ sessions: ["session-1", "session-2"] });
    // The gate lets both through and the worker is refused: what a full weighted limit looks like.
    sm.runDeferWorker = vi.fn(async () => {
      throw capacityError();
    });
    // Wired as in the app: each runner wakes the other when one of its items settles.
    const runners: { loop?: { poke(): void }; prompt?: { poke(): void } } = {};
    const promptRunner = createDeferredPromptRunner(promptStore, sm as any, bus, createDeferDeliveryGuard(), undefined, {
      onSettled: () => runners.loop?.poke(),
    });
    const loopRunner = createDeferLoopRunner(loopStore, sm as any, bus, createDeferDeliveryGuard(), undefined, {
      onParentMessageQueued: () => runners.prompt?.poke(),
    });
    runners.loop = loopRunner;
    runners.prompt = promptRunner;

    loopRunner.start();
    promptRunner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sm.runDeferWorker).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);
    expect(sm.runDeferWorker).toHaveBeenCalledTimes(4);
    loopRunner.shutdown();
    promptRunner.shutdown();
  });

  it("does not count a check that failed because the Bridge stopped being ready under it", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
    let ready = true;
    sm.getDeferDeliveryReadiness = vi.fn(() => ready
      ? { ready: true }
      : { ready: false, reason: "agent backend is reconnecting", retryAfterMs: 5_000 });
    sm.runDeferWorker = vi.fn(async () => {
      // The backend goes away mid-check; the error it surfaces as is not one the runner knows by name.
      ready = false;
      throw new Error("socket hang up");
    });
    const runner = createDeferLoopRunner(store, sm, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm.runDeferWorker).toHaveBeenCalledOnce();
    expect(store.get(loop.id)).toMatchObject({
      status: "active",
      runCount: 0,
      attempts: 0,
      lastError: "socket hang up",
    });

    sm.runDeferWorker = vi.fn(async () => ({ action: "continue" }));
    ready = true;
    await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);
    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 1, attempts: 0 });
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
      startWorkError: new Error(BRIDGE_RESTARTING_MESSAGE),
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

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(LEASE_MS);

    // The interrupted check is a failed run; the loop picks up again one interval later.
    expect(sm._started).toHaveLength(0);
    expect(store.get(loop.id)).toMatchObject({
      status: "active",
      runCount: 1,
      attempts: 1,
      lastError: LEASE_EXPIRED_ERROR,
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(sm._started).toHaveLength(1);
    expect(store.get(loop.id)).toMatchObject({ status: "active", runCount: 2, attempts: 0 });
    runner.shutdown();
    warnSpy.mockRestore();
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
    // Both are checks, so each runs in a worker; here a worker's run is the manager's delivery.
    const withWorker = Object.assign(sm, {
      tryAcquireDeferWorker: () => ({
        run: async (input: { parentSessionId: string; prompt: string; kind: string }) => {
          await sm.startWorkAndWaitForDelivery(input.parentSessionId, input.prompt);
          return { action: input.kind === "interval" ? "continue" : "finish" };
        },
        release: () => {},
      }),
    });
    const loopRunner = createDeferLoopRunner(loopStore, withWorker as any, bus, guard);
    const promptRunner = createDeferredPromptRunner(promptStore, withWorker as any, bus, guard);

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

  it("keeps a loop cancelled when it is cancelled while its check runs", async () => {
    const store = createDeferLoopStore(db);
    const bus = createGlobalBus();
    const loop = store.create({
      sessionId: "session-1",
      prompt: "Poll until done",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sm = makeMockSessionManager({ sessions: ["session-1"] });
    sm.runDeferWorker = vi.fn(async (input: { deferId: string }) => {
      expect(parseDeferId(input.deferId)).toEqual({ kind: "interval", id: loop.id });
      store.cancelById(loop.id);
      return { action: "continue" };
    });
    const runner = createDeferLoopRunner(store, sm as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sm.runDeferWorker).toHaveBeenCalledOnce();
    expect(store.get(loop.id)).toMatchObject({ status: "cancelled", runCount: 0 });
    runner.shutdown();
  });
});
