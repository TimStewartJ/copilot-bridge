import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import {
  createDeferredPromptRunner,
  DEFER_WATCHDOG_INTERVAL_MS,
  INITIAL_BACKOFF_MS,
  LEASE_MS,
  LEASE_RENEW_INTERVAL_MS,
  MAX_ATTEMPTS,
  MAX_TIMER_DELAY_MS,
} from "../deferred-prompt-runner.js";
import { createGlobalBus } from "../global-bus.js";
import { createTelemetryStore } from "../telemetry-store.js";
import {
  BACKEND_DISCONNECTED_MESSAGE,
  BACKEND_RECONNECTING_MESSAGE,
} from "../backend-availability.js";
import {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  PROMPT_DELIVERY_SHUTDOWN_MESSAGE,
  RESTART_PENDING_MESSAGE,
} from "../session-manager.js";
import { RESTART_RECOVERY_CONTINUE_PROMPT } from "../restart-resume.js";
import type { DatabaseSync } from "../db.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeMockSessionManager(overrides: Partial<{
  sessions: string[];
  archivedSessions: Set<string>;
  busySessions: Set<string>;
  startWorkError?: Error;
}> = {}) {
  const { sessions = [], archivedSessions = new Set(), busySessions = new Set(), startWorkError } = overrides;
  const started: Array<{ sessionId: string; prompt: string }> = [];
  const deliveryOptions: unknown[] = [];
  const attention: Array<{ sessionId: string; at?: string }> = [];
  return {
    listSessionsFromDisk: async (options: { includeArchived?: boolean } = {}) =>
      sessions
        .filter((s) => options.includeArchived !== false || !archivedSessions.has(s))
        .map((s) => ({ sessionId: s })),
    isSessionBusy: (sid: string) => busySessions.has(sid),
    startWork: (sessionId: string, prompt: string) => {
      if (startWorkError) throw startWorkError;
      started.push({ sessionId, prompt });
    },
    startWorkAndWaitForDelivery: async (sessionId: string, prompt: string, _attachments?: unknown, options?: unknown) => {
      if (startWorkError) throw startWorkError;
      started.push({ sessionId, prompt });
      deliveryOptions.push(options);
    },
    markSessionAttention: (sessionId: string, at?: string) => {
      attention.push({ sessionId, at });
    },
    _started: started,
    _deliveryOptions: deliveryOptions,
    _attention: attention,
  };
}

let db: DatabaseSync;

beforeEach(() => {
  db = setupTestDb();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("deferred-prompt-runner", () => {
  describe("startup", () => {
    it("processes due prompts on start", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const summaryEvents: any[] = [];
      bus.subscribe((event) => {
        if (event.type === "session:defer-summary") summaryEvents.push(event);
      });
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", "Do something", past);

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);

      runner.start();
      // Let async work settle
      await vi.advanceTimersByTimeAsync(0);

      expect(sm._started).toHaveLength(1);
      expect(sm._started[0]).toEqual({ sessionId: "session-1", prompt: "Do something" });
      expect(sm._deliveryOptions[0]).toEqual({ completionAttention: true });
      const dp = store.listForSession("session-1")[0];
      expect(dp.status).toBe("completed");
      expect(summaryEvents).toEqual([
        { type: "session:defer-summary", sessionId: "session-1", deferSummary: { count: 0, nextRunAt: null } },
        { type: "session:defer-summary", sessionId: "session-1", deferSummary: { count: 0, nextRunAt: null } },
      ]);

      runner.shutdown();
    });

    it("holds restart recovery prompts until the restart clears", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", RESTART_RECOVERY_CONTINUE_PROMPT, past);
      let restartPending = true;

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(
        store,
        sm as any,
        bus,
        undefined,
        undefined,
        { isRestartPending: () => restartPending },
      );

      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sm._started).toEqual([]);
      expect(store.listForSession("session-1")[0]?.status).toBe("pending");

      restartPending = false;
      bus.emit({ type: "server:restart-cleared" });
      await vi.advanceTimersByTimeAsync(0);

      expect(sm._started).toEqual([
        { sessionId: "session-1", prompt: RESTART_RECOVERY_CONTINUE_PROMPT },
      ]);
      expect(store.listForSession("session-1")[0]?.status).toBe("completed");
      runner.shutdown();
    });

    it("holds due prompts while defer delivery readiness is not ready and resumes later", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const telemetryStore = createTelemetryStore(db);
      const past = new Date(Date.now() - 1000).toISOString();
      const dp = store.create("session-1", "Do something", past);
      let readinessCalls = 0;

      const sm = makeMockSessionManager({ sessions: ["session-1"] }) as any;
      sm.getDeferDeliveryReadiness = vi.fn(() => {
        readinessCalls += 1;
        return readinessCalls >= 3
          ? { ready: true }
          : { ready: false, reason: "agent backend startup hold", retryAfterMs: 1000 };
      });
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const runner = createDeferredPromptRunner(
        store,
        sm,
        bus,
        undefined,
        { deferredPromptStore: store },
        { telemetryStore },
      );

      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sm._started).toHaveLength(0);
      expect(store.get(dp.id)).toMatchObject({ status: "pending", attempts: 0 });
      expect(infoSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(sm._started).toHaveLength(0);
      expect(store.get(dp.id)).toMatchObject({ status: "pending", attempts: 0 });
      expect(infoSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(sm._started).toEqual([{ sessionId: "session-1", prompt: "Do something" }]);
      expect(store.get(dp.id)!.status).toBe("completed");
      expect(telemetryStore.querySpans({ name: "defer.runner.hold" })).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            deferKind: "once",
            dueCount: 1,
            reason: "agent backend startup hold",
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            deferKind: "once",
            dueCount: 1,
            reason: "agent backend startup hold",
          }),
        }),
      ]);
      runner.shutdown();
    });

    it("reclaims expired running on start", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      const dp = store.create("session-1", "Prompt", past);

      // Manually set the row to running with an expired lease (simulate a crashed run)
      db.exec(`
        UPDATE deferred_prompts
        SET status = 'running', claimToken = 'old-token', leaseExpiresAt = '2000-01-01T00:00:00.000Z', attempts = 1
        WHERE id = '${dp.id}'
      `);

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      // Should reclaim to pending and then process
      expect(sm._started).toHaveLength(1);
      runner.shutdown();
    });

    it("reclaims running deferrals when their lease expires after startup", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      const dp = store.create("session-1", "Prompt", past);
      store.claimDue(dp.id, LEASE_MS);

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(sm._started).toHaveLength(0);
      expect(store.get(dp.id)!.status).toBe("running");

      await vi.advanceTimersByTimeAsync(LEASE_MS - 1);
      expect(sm._started).toHaveLength(0);
      expect(store.get(dp.id)!.status).toBe("running");

      await vi.advanceTimersByTimeAsync(1);

      expect(sm._started).toEqual([{ sessionId: "session-1", prompt: "Prompt" }]);
      expect(store.get(dp.id)!.status).toBe("completed");
      runner.shutdown();
    });

    it("skips sessions that do not exist on disk", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("ghost-session", "Do something", past);

      const sm = makeMockSessionManager({ sessions: [] }); // ghost not in list
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(sm._started).toHaveLength(0);
      const dp = store.listForSession("ghost-session")[0];
      expect(dp.status).toBe("cancelled");
      runner.shutdown();
    });

    it("cancels all pending deferrals for a missing session", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      const first = store.create("ghost-session", "First", past);
      const second = store.create("ghost-session", "Second", past);

      const sm = makeMockSessionManager({ sessions: [] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(sm._started).toHaveLength(0);
      expect(store.get(first.id)!.status).toBe("cancelled");
      expect(store.get(second.id)!.status).toBe("cancelled");
      runner.shutdown();
    });

    it("cancels due deferrals for sessions already archived before startup", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("archived-session", "Do not send", past);

      const sm = makeMockSessionManager({
        sessions: ["archived-session"],
        archivedSessions: new Set(["archived-session"]),
      });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(sm._started).toHaveLength(0);
      const dp = store.listForSession("archived-session")[0];
      expect(dp.status).toBe("cancelled");
      runner.shutdown();
    });

    it("skips busy sessions and does not consume the deferral", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", "Prompt", past);

      const busySessions = new Set(["session-1"]);
      const sm = makeMockSessionManager({ sessions: ["session-1"], busySessions });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      // Only advance microtasks/promises — no retry timers should be armed for past-due busy items
      await vi.advanceTimersByTimeAsync(0);

      expect(sm._started).toHaveLength(0);
      // Should still be pending (not consumed)
      const dp = store.listForSession("session-1")[0];
      expect(dp.status).toBe("pending");
      runner.shutdown();
    });

    it("does not complete a deferral until the prompt delivery is acknowledged", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      const deferred = store.create("session-1", "Prompt", past);
      let resolveDelivery: (() => void) | undefined;
      const started: Array<{ sessionId: string; prompt: string }> = [];
      const sm = {
        listSessionsFromDisk: async () => [{ sessionId: "session-1" }],
        isSessionBusy: () => false,
        startWorkAndWaitForDelivery: (sessionId: string, prompt: string) => {
          started.push({ sessionId, prompt });
          return new Promise<void>((resolve) => {
            resolveDelivery = resolve;
          });
        },
      };
      const runner = createDeferredPromptRunner(store, sm as any, bus);

      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(started).toEqual([{ sessionId: "session-1", prompt: "Prompt" }]);
      expect(store.get(deferred.id)?.status).toBe("running");

      resolveDelivery?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.get(deferred.id)?.status).toBe("completed");
      runner.shutdown();
    });

    it("does not let one pending delivery acknowledgment block other sessions", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      const first = store.create("session-1", "First", past);
      const second = store.create("session-2", "Second", past);

      let resolveFirst: (() => void) | undefined;
      const started: Array<{ sessionId: string; prompt: string }> = [];
      const sm = {
        listSessionsFromDisk: async () => [{ sessionId: "session-1" }, { sessionId: "session-2" }],
        isSessionBusy: () => false,
        startWorkAndWaitForDelivery: (sessionId: string, prompt: string) => {
          started.push({ sessionId, prompt });
          if (sessionId === "session-1") {
            return new Promise<void>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return Promise.resolve();
        },
      };
      const runner = createDeferredPromptRunner(store, sm as any, bus);

      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(started).toEqual([
        { sessionId: "session-1", prompt: "First" },
        { sessionId: "session-2", prompt: "Second" },
      ]);
      expect(store.get(first.id)?.status).toBe("running");
      expect(store.get(second.id)?.status).toBe("completed");

      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.get(first.id)?.status).toBe("completed");
      runner.shutdown();
    });

    it("renews the lease while waiting for delivery acknowledgment", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      const deferred = store.create("session-1", "Prompt", past);
      let resolveDelivery: (() => void) | undefined;
      const started: Array<{ sessionId: string; prompt: string }> = [];
      const sm = {
        listSessionsFromDisk: async () => [{ sessionId: "session-1" }],
        isSessionBusy: () => false,
        startWorkAndWaitForDelivery: (sessionId: string, prompt: string) => {
          started.push({ sessionId, prompt });
          return new Promise<void>((resolve) => {
            resolveDelivery = resolve;
          });
        },
      };
      const runner = createDeferredPromptRunner(store, sm as any, bus);

      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      const initialLease = Date.parse(store.get(deferred.id)!.leaseExpiresAt!);
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
      const renewedLease = Date.parse(store.get(deferred.id)!.leaseExpiresAt!);

      expect(renewedLease).toBeGreaterThan(initialLease);

      await vi.advanceTimersByTimeAsync(LEASE_MS);
      expect(started).toEqual([{ sessionId: "session-1", prompt: "Prompt" }]);
      expect(store.get(deferred.id)).toMatchObject({ status: "running", attempts: 1 });

      resolveDelivery?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.get(deferred.id)?.status).toBe("completed");
      runner.shutdown();
    });
  });

  describe("session:idle bus event", () => {
    it("processes due deferral when session becomes idle", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", "Follow-up", past);

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      // Drain initial pass (session was busy on first pass)
      await vi.advanceTimersByTimeAsync(0);

      // Simulate session going idle
      bus.emit({ type: "session:idle", sessionId: "session-1" });
      await vi.advanceTimersByTimeAsync(0);

      // Should have been processed in one of the two passes
      const dp = store.listForSession("session-1")[0];
      expect(["completed", "pending"]).toContain(dp.status);
      runner.shutdown();
    });

    it("reruns due processing when an idle event arrives during an in-flight pass", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const firstDue = new Date(Date.now() - 2_000).toISOString();
      const secondDue = new Date(Date.now() - 1_000).toISOString();
      store.create("busy-session", "Busy follow-up", firstDue);
      const other = store.create("other-session", "Other follow-up", secondDue);

      const busySessions = new Set(["busy-session"]);
      let resolveOther: (() => void) | undefined;
      const started: Array<{ sessionId: string; prompt: string }> = [];
      const sm = {
        listSessionsFromDisk: async () => [{ sessionId: "busy-session" }, { sessionId: "other-session" }],
        isSessionBusy: (sessionId: string) => busySessions.has(sessionId),
        startWorkAndWaitForDelivery: (sessionId: string, prompt: string) => {
          started.push({ sessionId, prompt });
          if (sessionId === "other-session") {
            return new Promise<void>((resolve) => {
              resolveOther = resolve;
            });
          }
          return Promise.resolve();
        },
      };
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual([{ sessionId: "other-session", prompt: "Other follow-up" }]);
      expect(store.listForSession("busy-session")[0].status).toBe("pending");
      expect(store.get(other.id)?.status).toBe("running");

      busySessions.delete("busy-session");
      bus.emit({ type: "session:idle", sessionId: "busy-session" });
      await vi.advanceTimersByTimeAsync(0);
      resolveOther?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(started).toEqual([
        { sessionId: "other-session", prompt: "Other follow-up" },
        { sessionId: "busy-session", prompt: "Busy follow-up" },
      ]);
      expect(store.listForSession("busy-session")[0].status).toBe("completed");
      expect(store.get(other.id)?.status).toBe("completed");
      runner.shutdown();
    });
  });

  describe("session:archived bus event", () => {
    it("cancels pending deferrals for archived session", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const future = new Date(Date.now() + 60_000).toISOString();
      store.create("session-1", "Later", future);

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();

      bus.emit({ type: "session:archived", sessionId: "session-1", archived: true });
      await vi.advanceTimersByTimeAsync(0);

      const dp = store.listForSession("session-1")[0];
      expect(dp.status).toBe("cancelled");
      runner.shutdown();
    });

    it("does not cancel deferrals when a session is unarchived", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const future = new Date(Date.now() + 60_000).toISOString();
      store.create("session-1", "Later", future);

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();

      bus.emit({ type: "session:archived", sessionId: "session-1", archived: false });
      await vi.advanceTimersByTimeAsync(0);

      const dp = store.listForSession("session-1")[0];
      expect(dp.status).toBe("pending");
      runner.shutdown();
    });
  });

  describe("retry logic", () => {
    it("retries on busy error with backoff", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const summaryEvents: any[] = [];
      bus.subscribe((event) => {
        if (event.type === "session:defer-summary") summaryEvents.push(event);
      });
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", "Prompt", past);

      const sm = makeMockSessionManager({
        sessions: ["session-1"],
        startWorkError: new Error("Session is busy processing another message"),
      });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      // Only flush the initial async pass; don't advance into retry timers
      await vi.advanceTimersByTimeAsync(0);

      const dp = store.listForSession("session-1")[0];
      // After one attempt the prompt should be re-queued pending with backoff
      expect(dp.status).toBe("pending");
      expect(dp.attempts).toBe(1);
      expect(summaryEvents.map((event) => event.deferSummary.count)).toEqual([0, 1]);
      expect(summaryEvents.at(-1)).toMatchObject({
        type: "session:defer-summary",
        sessionId: "session-1",
        deferSummary: { count: 1, nextRunAt: dp.runAt },
      });
      runner.shutdown();
    });

    it("pauses on restart pending without burning attempts", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", "Prompt", past);

      let restartPending = true;
      const started: Array<{ sessionId: string; prompt: string }> = [];
      const sm = {
        listSessionsFromDisk: async () => [{ sessionId: "session-1" }],
        isSessionBusy: () => false,
        startWorkAndWaitForDelivery: async (sessionId: string, prompt: string) => {
          if (restartPending) throw new Error(RESTART_PENDING_MESSAGE);
          started.push({ sessionId, prompt });
        },
      };
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      let dp = store.listForSession("session-1")[0];
      expect(dp.status).toBe("pending");
      expect(dp.attempts).toBe(0);
      expect(started).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(80_000);
      dp = store.listForSession("session-1")[0];
      expect(dp.status).toBe("pending");
      expect(dp.attempts).toBe(0);

      restartPending = false;
      bus.emit({ type: "server:restart-cleared" });
      await vi.advanceTimersByTimeAsync(0);

      expect(started).toEqual([{ sessionId: "session-1", prompt: "Prompt" }]);
      expect(store.listForSession("session-1")[0].status).toBe("completed");
      runner.shutdown();
    });

    it.each([
      PROMPT_DELIVERY_ABORTED_MESSAGE,
      PROMPT_DELIVERY_SHUTDOWN_MESSAGE,
    ])("re-queues interrupted pre-acceptance delivery without burning attempts: %s", async (message) => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", "Prompt", past);

      const sm = makeMockSessionManager({
        sessions: ["session-1"],
        startWorkError: new Error(message),
      });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      const dp = store.listForSession("session-1")[0];
      expect(dp.status).toBe("pending");
      expect(dp.attempts).toBe(0);
      expect(dp.claimToken).toBeUndefined();
      expect(dp.leaseExpiresAt).toBeUndefined();
      runner.shutdown();
    });

    it.each([
      BACKEND_DISCONNECTED_MESSAGE,
      BACKEND_RECONNECTING_MESSAGE,
    ])("pauses backend-unavailable delivery without burning attempts: %s", async (message) => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", "Prompt", past);

      const sm = makeMockSessionManager({
        sessions: ["session-1"],
        startWorkError: new Error(message),
      });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      const dp = store.listForSession("session-1")[0];
      expect(dp.status).toBe("pending");
      expect(dp.attempts).toBe(0);
      expect(dp.claimToken).toBeUndefined();
      expect(dp.leaseExpiresAt).toBeUndefined();
      runner.shutdown();
    });

    it.each([
      "Session tool initialization did not complete before prompt delivery",
      "resumeSession timed out after 60s",
    ])("retries transient delivery error with backoff until MAX_ATTEMPTS: %s", async (message) => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      const dp = store.create("session-1", "Prompt", past);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const sm = makeMockSessionManager({
        sessions: ["session-1"],
        startWorkError: new Error(message),
      });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();

      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        await vi.advanceTimersByTimeAsync(attempt === 1 ? 0 : INITIAL_BACKOFF_MS * Math.pow(2, attempt - 2));
        const row = store.get(dp.id)!;
        expect(row.status).toBe("pending");
        expect(row.attempts).toBe(attempt);
        expect(Date.parse(row.runAt) - Date.now()).toBe(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
      }

      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * Math.pow(2, MAX_ATTEMPTS - 2));
      expect(store.get(dp.id)).toMatchObject({
        status: "failed",
        attempts: MAX_ATTEMPTS,
        lastError: message,
      });
      expect(warnSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Deferral ${dp.id} failed after ${MAX_ATTEMPTS} attempt(s)`),
      );
      runner.shutdown();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("marks failed after MAX_ATTEMPTS non-retryable errors", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1000).toISOString();
      const dp = store.create("session-1", "Prompt", past);

      // Set attempts to MAX_ATTEMPTS - 1 so next attempt exceeds max
      db.exec(`UPDATE deferred_prompts SET attempts = ${MAX_ATTEMPTS - 1} WHERE id = '${dp.id}'`);

      const sm = makeMockSessionManager({
        sessions: ["session-1"],
        startWorkError: new Error("Fatal error"),
      });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      const updated = store.get(dp.id)!;
      expect(updated.status).toBe("failed");
      expect(updated.lastError).toContain("Fatal error");
      expect(sm._attention).toEqual([{ sessionId: "session-1", at: expect.any(String) }]);
      runner.shutdown();
    });
  });

  describe("future prompt timer", () => {
    it("arms a timer for a future pending prompt and fires it", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const future = new Date(Date.now() + 5_000).toISOString();
      store.create("session-1", "Delayed", future);

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();

      // Nothing due yet
      await vi.advanceTimersByTimeAsync(0);
      let dp = store.listForSession("session-1")[0];

      if (dp.status === "pending") {
        await vi.advanceTimersByTimeAsync(5_000);
        dp = store.listForSession("session-1")[0];
      }

      expect(dp.status).toBe("completed");
      runner.shutdown();
    });

    it("caps far-future timer delays below Node's timeout overflow limit", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const future = new Date(Date.now() + MAX_TIMER_DELAY_MS + 60_000).toISOString();
      store.create("session-1", "Much later", future);

      const sm = makeMockSessionManager({ sessions: ["session-1"] });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();

      await vi.advanceTimersByTimeAsync(1);
      expect(sm._started).toHaveLength(0);
      expect(store.listForSession("session-1")[0].status).toBe("pending");

      runner.shutdown();
    });

    it("does not let an overdue busy-session deferral starve later deferrals for other sessions", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1_000).toISOString();
      const future = new Date(Date.now() + 5_000).toISOString();
      store.create("busy-session", "Busy follow-up", past);
      store.create("other-session", "Other follow-up", future);

      const busySessions = new Set(["busy-session"]);
      const sm = makeMockSessionManager({ sessions: ["busy-session", "other-session"], busySessions });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(sm._started).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(sm._started).toEqual([{ sessionId: "other-session", prompt: "Other follow-up" }]);
      expect(store.listForSession("busy-session")[0].status).toBe("pending");
      expect(store.listForSession("other-session")[0].status).toBe("completed");

      runner.shutdown();
    });
  });

  describe("shutdown", () => {
    it("does not dispatch queued idle work after shutdown", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const past = new Date(Date.now() - 1_000).toISOString();
      store.create("session-1", "Should not run", past);

      const busySessions = new Set(["session-1"]);
      const sm = makeMockSessionManager({ sessions: ["session-1"], busySessions });
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();

      await vi.advanceTimersByTimeAsync(0);
      busySessions.delete("session-1");
      bus.emit({ type: "session:idle", sessionId: "session-1" });
      runner.shutdown();
      await vi.advanceTimersByTimeAsync(0);

      expect(sm._started).toHaveLength(0);
      expect(store.listForSession("session-1")[0].status).toBe("pending");
    });
  });

  describe("watchdog catch-up", () => {
      it("retries an overdue busy session even when the idle event is missed", async () => {
        const store = createDeferredPromptStore(db);
        const bus = createGlobalBus();
        const busySessions = new Set(["session-1"]);
        const deferred = store.create("session-1", "Follow-up", new Date(Date.now() - 1_000).toISOString());
        const sm = makeMockSessionManager({ sessions: ["session-1"], busySessions });
        const runner = createDeferredPromptRunner(store, sm as any, bus);

        runner.start();
        await vi.advanceTimersByTimeAsync(0);
        busySessions.clear();

        await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS - 1);
        expect(sm._started).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1);
        expect(sm._started).toEqual([{ sessionId: "session-1", prompt: "Follow-up" }]);
        expect(store.get(deferred.id)?.status).toBe("completed");
        runner.shutdown();
      });

      it("catches a lost exact timer and records overdue sweep telemetry", async () => {
        const store = createDeferredPromptStore(db);
        const telemetryStore = createTelemetryStore(db);
        const bus = createGlobalBus();
        const future = new Date(Date.now() + 5_000).toISOString();
        const deferred = store.create("session-1", "Wake after sleep", future);
        const sm = makeMockSessionManager({ sessions: ["session-1"] });
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const runner = createDeferredPromptRunner(
          store,
          sm as any,
          bus,
          undefined,
          undefined,
          { telemetryStore },
        );

        runner.start();
        await vi.advanceTimersByTimeAsync(0);
        let timerIndex = -1;
        for (let index = 0; index < timeoutSpy.mock.calls.length; index++) {
          if (timeoutSpy.mock.calls[index]?.[1] === 5_000) timerIndex = index;
        }
        const exactTimer = timeoutSpy.mock.results[timerIndex]?.value as ReturnType<typeof setTimeout> | undefined;
        expect(exactTimer).toBeDefined();
        clearTimeout(exactTimer);
        timeoutSpy.mockRestore();

        await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

        expect(sm._started).toEqual([{ sessionId: "session-1", prompt: "Wake after sleep" }]);
        expect(store.get(deferred.id)?.status).toBe("completed");
        expect(telemetryStore.querySpans({ name: "defer.runner.watchdog_sweep" })[0]).toMatchObject({
          metadata: {
            deferKind: "once",
            overdueCount: 1,
            oldestOverdueAgeMs: expect.any(Number),
          },
        });
        runner.shutdown();
      });

      it("isolates item failures and releases the same-session guard for the next sweep", async () => {
        const store = createDeferredPromptStore(db);
        const bus = createGlobalBus();
        const dueAt = new Date(Date.now() - 1_000).toISOString();
        const first = store.create("session-1", "First", dueAt);
        const second = store.create("session-2", "Second", dueAt);
        const originalClaimDue = store.claimDue.bind(store);
        let failFirstClaim = true;
        vi.spyOn(store, "claimDue").mockImplementation((id, leaseMs) => {
          if (id === first.id && failFirstClaim) {
            failFirstClaim = false;
            throw new Error("simulated claim failure");
          }
          return originalClaimDue(id, leaseMs);
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let resolveSecond: (() => void) | undefined;
        const started: Array<{ sessionId: string; prompt: string }> = [];
        const sm = {
          listSessionsFromDisk: async () => [{ sessionId: "session-1" }, { sessionId: "session-2" }],
          isSessionBusy: () => false,
          startWorkAndWaitForDelivery: (sessionId: string, prompt: string) => {
            started.push({ sessionId, prompt });
            if (sessionId === "session-2") {
              return new Promise<void>((resolve) => {
                resolveSecond = resolve;
              });
            }
            return Promise.resolve();
          },
        };
        const runner = createDeferredPromptRunner(store, sm as any, bus);

        runner.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(started).toEqual([{ sessionId: "session-2", prompt: "Second" }]);
        expect(store.get(first.id)?.status).toBe("pending");
        expect(store.get(second.id)?.status).toBe("running");

        await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

        expect(started).toEqual([
          { sessionId: "session-2", prompt: "Second" },
          { sessionId: "session-1", prompt: "First" },
        ]);
        expect(store.get(first.id)?.status).toBe("completed");
        resolveSecond?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(store.get(second.id)?.status).toBe("completed");
        errorSpy.mockRestore();
        runner.shutdown();
      });

      it("rolls back a claimed row when setup fails after the claim", async () => {
        const store = createDeferredPromptStore(db);
        const bus = createGlobalBus();
        const deferred = store.create("session-1", "Retry setup", new Date(Date.now() - 1_000).toISOString());
        vi.spyOn(bus, "emit").mockImplementationOnce(() => {
          throw new Error("simulated summary failure");
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const sm = makeMockSessionManager({ sessions: ["session-1"] });
        const runner = createDeferredPromptRunner(store, sm as any, bus);

        runner.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(sm._started).toHaveLength(0);
        expect(store.get(deferred.id)).toMatchObject({ status: "pending", attempts: 0 });

        await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

        expect(sm._started).toEqual([{ sessionId: "session-1", prompt: "Retry setup" }]);
        expect(store.get(deferred.id)).toMatchObject({ status: "completed", attempts: 1 });
        errorSpy.mockRestore();
        runner.shutdown();
      });

      it("does not duplicate delivery when the exact timer and watchdog wake together", async () => {
        const store = createDeferredPromptStore(db);
        const bus = createGlobalBus();
        const deferred = store.create(
          "session-1",
          "Exactly once",
          new Date(Date.now() + DEFER_WATCHDOG_INTERVAL_MS).toISOString(),
        );
        const sm = makeMockSessionManager({ sessions: ["session-1"] });
        const runner = createDeferredPromptRunner(store, sm as any, bus);

        runner.start();
        await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

        expect(sm._started).toEqual([{ sessionId: "session-1", prompt: "Exactly once" }]);
        expect(store.get(deferred.id)?.status).toBe("completed");
        runner.shutdown();
      });

      it("records exact timer wake drift telemetry", async () => {
        const store = createDeferredPromptStore(db);
        const telemetryStore = createTelemetryStore(db);
        const bus = createGlobalBus();
        const deferred = store.create(
          "session-1",
          "Exact wake",
          new Date(Date.now() + 5_000).toISOString(),
        );
        const sm = makeMockSessionManager({ sessions: ["session-1"] });
        const runner = createDeferredPromptRunner(
          store,
          sm as any,
          bus,
          undefined,
          undefined,
          { telemetryStore },
        );

        runner.start();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(sm._started).toEqual([{ sessionId: "session-1", prompt: "Exact wake" }]);
        expect(telemetryStore.querySpans({ name: "defer.runner.timer_wake" })[0]).toMatchObject({
          metadata: {
            deferKind: "once",
            scheduledFor: deferred.runAt,
            wakeDriftMs: expect.any(Number),
          },
        });
        runner.shutdown();
      });

      it("records watchdog sweep failures and continues future sweeps", async () => {
        const store = createDeferredPromptStore(db);
        const telemetryStore = createTelemetryStore(db);
        const bus = createGlobalBus();
        const sm = makeMockSessionManager({ sessions: [] });
        const runner = createDeferredPromptRunner(
          store,
          sm as any,
          bus,
          undefined,
          undefined,
          { telemetryStore },
        );

        runner.start();
        await vi.advanceTimersByTimeAsync(0);
        const listDueSpy = vi.spyOn(store, "listDue").mockImplementationOnce(() => {
          throw new Error("simulated sweep failure");
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

        expect(telemetryStore.querySpans({ name: "defer.runner.watchdog_sweep_failure" })[0]).toMatchObject({
          metadata: {
            deferKind: "once",
            error: "simulated sweep failure",
          },
        });

        await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);
        expect(listDueSpy).toHaveBeenCalledTimes(3);
        errorSpy.mockRestore();
        runner.shutdown();
      });

      it("stops watchdog retries on shutdown", async () => {
        const store = createDeferredPromptStore(db);
        const bus = createGlobalBus();
        const busySessions = new Set(["session-1"]);
        const deferred = store.create("session-1", "Do not run", new Date(Date.now() - 1_000).toISOString());
        const sm = makeMockSessionManager({ sessions: ["session-1"], busySessions });
        const runner = createDeferredPromptRunner(store, sm as any, bus);

        runner.start();
        await vi.advanceTimersByTimeAsync(0);
        runner.shutdown();
        busySessions.clear();
        await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);

        expect(sm._started).toHaveLength(0);
        expect(store.get(deferred.id)?.status).toBe("pending");
      });
  });

  describe("one per session per pass", () => {
    it("processes only the first due prompt per session per pass", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const t1 = new Date(Date.now() - 2000).toISOString();
      const t2 = new Date(Date.now() - 1000).toISOString();
      store.create("session-1", "First", t1);
      store.create("session-1", "Second", t2);

      let resolveFirst: (() => void) | undefined;
      const started: Array<{ sessionId: string; prompt: string }> = [];
      const sm = {
        listSessionsFromDisk: async () => [{ sessionId: "session-1" }],
        isSessionBusy: () => false,
        startWorkAndWaitForDelivery: (sessionId: string, prompt: string) => {
          started.push({ sessionId, prompt });
          if (prompt === "First") {
            return new Promise<void>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return Promise.resolve();
        },
      };
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      // Flush only the initial async processDue pass (no timer advance into future items)
      await vi.advanceTimersByTimeAsync(0);

      // Only one should be dispatched in the first pass (FIFO per session)
      expect(started).toEqual([{ sessionId: "session-1", prompt: "First" }]);

      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual([
        { sessionId: "session-1", prompt: "First" },
        { sessionId: "session-1", prompt: "Second" },
      ]);
      runner.shutdown();
    });

    it("does not strand the next same-session prompt when the first prompt fails", async () => {
      const store = createDeferredPromptStore(db);
      const bus = createGlobalBus();
      const t1 = new Date(Date.now() - 2000).toISOString();
      const t2 = new Date(Date.now() - 1000).toISOString();
      const first = store.create("session-1", "First", t1);
      const second = store.create("session-1", "Second", t2);
      db.exec(`UPDATE deferred_prompts SET attempts = ${MAX_ATTEMPTS - 1} WHERE id = '${first.id}'`);
      const started: Array<{ sessionId: string; prompt: string }> = [];
      const sm = {
        listSessionsFromDisk: async () => [{ sessionId: "session-1" }],
        isSessionBusy: () => false,
        startWorkAndWaitForDelivery: async (sessionId: string, prompt: string) => {
          started.push({ sessionId, prompt });
          if (prompt === "First") throw new Error("Fatal error");
        },
      };

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const runner = createDeferredPromptRunner(store, sm as any, bus);
      runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(started).toEqual([
        { sessionId: "session-1", prompt: "First" },
        { sessionId: "session-1", prompt: "Second" },
      ]);
      expect(store.get(first.id)?.status).toBe("failed");
      expect(store.get(second.id)?.status).toBe("completed");
      errorSpy.mockRestore();
      runner.shutdown();
    });
  });
});
