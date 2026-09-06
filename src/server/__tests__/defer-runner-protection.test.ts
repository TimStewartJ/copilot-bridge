import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import type { DatabaseSync } from "../db.js";
import { createDeferDeliveryGuard } from "../defer-delivery-guard.js";
import { createDeferLoopRunner } from "../defer-loop-runner.js";
import { createDeferLoopStore, type DeferLoop } from "../defer-loop-store.js";
import type { DeferRunnerCore } from "../defer-runner-core.js";
import {
  createDeferredPromptRunner,
  DEFER_WATCHDOG_INTERVAL_MS,
  MAX_ATTEMPTS,
  type DeferredPromptRunnerOptions,
} from "../deferred-prompt-runner.js";
import { createDeferredPromptStore, type DeferredPrompt } from "../deferred-prompt-store.js";
import type { DeferWorkerInput, DeferWorkerResult } from "../defer-worker.js";
import { createFocusProtectionStore, protectionRetryAt } from "../focus-protection-store.js";
import { createGlobalBus } from "../global-bus.js";
import { RESTART_RECOVERY_CONTINUE_PROMPT } from "../restart-resume.js";
import type { SessionManager } from "../session-manager.js";
import type { FocusProtectionWindow } from "../../shared/focus-protection.js";

type Kind = "defer" | "defer-loop";
const PROTECTION_MS = 95 * 60_000;
let db: DatabaseSync;
let bus: ReturnType<typeof createGlobalBus>;
let protection: ReturnType<typeof createFocusProtectionStore>;
let runners: DeferRunnerCore[];

function at(offset = 0): string {
  return new Date(Date.now() + offset).toISOString();
}

function wakeAt(item: DeferredPrompt | DeferLoop): string {
  return "runAt" in item ? item.runAt : item.nextRunAt;
}

function settledWakeAt(kind: Kind, item: DeferredPrompt | DeferLoop, deliveredAt: number): string {
  return kind === "defer"
    ? wakeAt(item)
    : new Date(deliveredAt + (item as DeferLoop).intervalSeconds * 1000).toISOString();
}

function releaseAt(kind: Kind, item: DeferredPrompt | DeferLoop, window: FocusProtectionWindow): number {
  return protectionRetryAt(window, `${kind}:${item.id}:${wakeAt(item)}`);
}

function protect(duration = PROTECTION_MS) {
  return protection.create({
    endsAt: at(duration),
    timezone: "UTC",
    reason: "Uninterrupted work",
    allowNeedsInput: true,
    allowAuthorizedDeadlineOverride: false,
  });
}

function track<T extends DeferRunnerCore>(runner: T): T {
  runners.push(runner);
  return runner;
}

function harness(
  kind: Kind,
  options: DeferredPromptRunnerOptions & { onParentMessageQueued?: () => void } = {},
) {
  const promptStore = createDeferredPromptStore(db);
  const loopStore = createDeferLoopStore(db);
  const store = kind === "defer" ? promptStore : loopStore;
  const guard = createDeferDeliveryGuard();
  const claimSession = vi.spyOn(guard, "tryClaim");
  const releaseSession = vi.spyOn(guard, "release");
  const claimStore = kind === "defer"
    ? vi.spyOn(promptStore, "claimDue")
    : vi.spyOn(loopStore, "claimDue");
  const releaseStore = kind === "defer"
    ? vi.spyOn(promptStore, "releaseClaimWithoutAttempt")
    : vi.spyOn(loopStore, "releaseClaimWithoutAttempt");
  const workerRun = vi.fn<(input: DeferWorkerInput) => Promise<DeferWorkerResult>>()
    .mockResolvedValue({ action: "finish" });
  const workerRelease = vi.fn();
  const sessions = new Set(["session-1"]);
  const sm = {
    listSessionsFromDisk: vi.fn(async () => [...sessions].map((sessionId) => ({ sessionId }))),
    isSessionBusy: vi.fn((_sessionId: string) => false),
    getDeferDeliveryReadiness: vi.fn(() => ({ ready: true })),
    tryAcquireDeferWorker: vi.fn(() => ({ run: workerRun, release: workerRelease })),
    startWorkAndWaitForDelivery: vi.fn(async (_sessionId: string, _prompt: string) => {}),
    markSessionAttention: vi.fn(),
  };
  const telemetryStore = { recordSpan: vi.fn() };
  const runnerOptions = { focusProtectionStore: protection, telemetryStore, ...options };
  const summaries = { deferredPromptStore: promptStore, deferLoopStore: loopStore };
  const makePromptRunner = () => track(createDeferredPromptRunner(
    promptStore, sm as unknown as SessionManager, bus, guard, summaries, runnerOptions,
  ));
  const makeRunner = () => kind === "defer" ? makePromptRunner() : track(createDeferLoopRunner(
    loopStore, sm as unknown as SessionManager, bus, guard, summaries, runnerOptions,
  ));
  const createItem = (input: { id?: string; sessionId?: string; wakeAt?: string; expiresAt?: string } = {}) => {
    const sessionId = input.sessionId ?? "session-1";
    const wakeAt = input.wakeAt ?? at(-1_000);
    sessions.add(sessionId);
    const item = kind === "defer" ? promptStore.create(sessionId, "Check status", wakeAt) : loopStore.create({
      sessionId, prompt: "Check status", name: "Status check",
      nextRunAt: wakeAt, intervalSeconds: 300, expiresAt: input.expiresAt,
    });
    if (!input.id) return item;
    db.prepare(kind === "defer"
      ? "UPDATE deferred_prompts SET id=? WHERE id=?"
      : "UPDATE defer_loops SET id=? WHERE id=?").run(input.id, item.id);
    return store.get(input.id)!;
  };
  return {
    runner: makeRunner(), makeRunner, makePromptRunner, createItem, store, promptStore, loopStore,
    sm, guard, claimSession, releaseSession, claimStore, releaseStore, workerRun, workerRelease, telemetryStore,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-05T12:00:00.000Z");
  db = setupTestDb();
  bus = createGlobalBus();
  protection = createFocusProtectionStore(db, bus);
  runners = [];
});

afterEach(() => {
  for (const runner of runners) runner.shutdown();
  protection.stop();
  db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(["defer", "defer-loop"] as const)("%s focus protection", (kind) => {
  it("holds before all admission claims for 95 minutes without a hold or timer storm, then resumes once", async () => {
    const h = harness(kind);
    const item = h.createItem();
    const scheduledFor = "runAt" in item ? item.runAt : item.nextRunAt;
    const window = protect();
    const retryAt = releaseAt(kind, item, window);
    const hold = vi.spyOn(protection, "hold");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const timeout = vi.spyOn(globalThis, "setTimeout");

    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 0; n < 12; n++) {
      h.runner.poke();
      bus.emit({ type: "session:idle", sessionId: item.sessionId });
      await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);
    }
    await vi.advanceTimersByTimeAsync(PROTECTION_MS - 12 * DEFER_WATCHDOG_INTERVAL_MS - 1);

    expect(h.store.get(item.id)).toEqual(item);
    expect(h.sm.listSessionsFromDisk).not.toHaveBeenCalled();
    expect(h.claimSession).not.toHaveBeenCalled();
    expect(h.releaseSession).not.toHaveBeenCalled();
    expect(h.sm.tryAcquireDeferWorker).not.toHaveBeenCalled();
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.releaseStore).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
    expect(h.sm.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
    expect(hold).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout.mock.calls[0]?.[1]).toBe(retryAt - Date.parse(window.startsAt));
    expect(h.telemetryStore.recordSpan.mock.calls.filter(([span]) => span.name === "defer.runner.hold"))
      .toHaveLength(1);
    expect(protection.outstanding(kind)).toEqual([
      expect.objectContaining({
        workId: item.id, sessionId: item.sessionId, scheduledFor,
        windowId: window.id, endsAt: window.endsAt,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(1);
    protection.reconcile();
    for (let n = 0; n < 12; n++) {
      h.runner.poke();
      bus.emit({ type: "server:restart-cleared" });
      bus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(h.store.get(item.id)).toEqual(item);
    expect(h.claimSession).not.toHaveBeenCalled();
    expect(h.releaseSession).not.toHaveBeenCalled();
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.releaseStore).not.toHaveBeenCalled();
    expect(h.sm.tryAcquireDeferWorker).not.toHaveBeenCalled();
    expect(h.workerRelease).not.toHaveBeenCalled();
    expect(hold).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledOnce();
    expect(h.telemetryStore.recordSpan.mock.calls.filter(([span]) => span.name === "defer.runner.hold"))
      .toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.claimSession).toHaveBeenCalledOnce();
    expect(h.claimStore).toHaveBeenCalledOnce();
    expect(h.sm.tryAcquireDeferWorker).toHaveBeenCalledOnce();
    expect(h.workerRun).toHaveBeenCalledOnce();
    expect(h.store.get(item.id)?.status).toBe("completed");
    expect(protection.impacts(window.id)).toMatchObject({
      postponed: 1, pending: 0, dispositions: { started: 1 },
    });

    h.runner.poke();
    bus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
    await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS);
    expect(h.workerRun).toHaveBeenCalledOnce();
  });

  it("pokes immediately when protection is cancelled, without waiting for its old end timer", async () => {
    const h = harness(kind);
    const item = h.createItem();
    const window = protect();
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get(item.id)?.attempts).toBe(0);

    protection.cancel(window.id);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.workerRun).toHaveBeenCalledOnce();
    expect(h.claimStore).toHaveBeenCalledOnce();
    expect(protection.outstanding(kind)).toEqual([]);
    expect(protection.impacts(window.id).dispositions).toEqual({ started: 1 });
  });

  it("closes protection creation during the asynchronous session lookup", async () => {
    const h = harness(kind);
    const item = h.createItem();
    let finishLookup!: (sessions: Array<{ sessionId: string }>) => void;
    h.sm.listSessionsFromDisk.mockImplementationOnce(() => new Promise((resolve) => {
      finishLookup = resolve;
    }));
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sm.listSessionsFromDisk).toHaveBeenCalledOnce();
    expect(h.claimSession).not.toHaveBeenCalled();

    const window = protect();
    finishLookup([{ sessionId: item.sessionId }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.store.get(item.id)).toEqual(item);
    expect(h.claimSession).not.toHaveBeenCalled();
    expect(h.sm.tryAcquireDeferWorker).not.toHaveBeenCalled();
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
    expect(protection.outstanding(kind)).toHaveLength(1);

    protection.cancel(window.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.workerRun).toHaveBeenCalledOnce();
  });

  it("composes supplied readiness with protection instead of replacing either gate", async () => {
    let ready = false;
    const additionalReadiness = vi.fn(() => ({
      ready, reason: "Explicit delivery gate", retryAfterMs: 30_000,
    }));
    const h = harness(kind, { additionalReadiness });
    const item = h.createItem();
    const window = protect();
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(additionalReadiness).toHaveBeenCalled();
    expect(h.claimStore).not.toHaveBeenCalled();

    ready = true;
    h.runner.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(protection.outstanding(kind)).toHaveLength(1);
    expect(h.store.get(item.id)?.attempts).toBe(0);

    ready = false;
    protection.cancel(window.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.claimStore).not.toHaveBeenCalled();

    ready = true;
    h.runner.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.workerRun).toHaveBeenCalledOnce();
  });

  it.each(["active", "jitter"] as const)("reconstructs the same release from durable state after an %s-phase restart", async (phase) => {
    const h = harness(kind);
    const item = h.createItem({ id: "work-1" });
    const window = protect(10_000);
    const retryAt = releaseAt(kind, item, window);
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    h.runner.shutdown();
    protection.stop();

    const endsAt = Date.parse(window.endsAt);
    vi.setSystemTime(phase === "active" ? endsAt - 1_000 : endsAt + Math.floor((retryAt - endsAt) / 2));
    protection = createFocusProtectionStore(db, bus);
    const restarted = harness(kind);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    restarted.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), retryAt - Date.now());
    expect(protection.impacts(window.id)).toMatchObject({ postponed: 1, pending: 1 });

    bus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
    bus.emit({ type: "server:restart-cleared" });
    restarted.runner.poke();
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(restarted.store.get(item.id)).toEqual(item);
    expect(restarted.claimSession).not.toHaveBeenCalled();
    expect(restarted.releaseSession).not.toHaveBeenCalled();
    expect(restarted.claimStore).not.toHaveBeenCalled();
    expect(restarted.releaseStore).not.toHaveBeenCalled();
    expect(restarted.sm.tryAcquireDeferWorker).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(restarted.workerRun).toHaveBeenCalledOnce();
    expect(restarted.store.get(item.id)).toMatchObject({
      status: "completed", updatedAt: new Date(retryAt).toISOString(),
    });
    expect(wakeAt(restarted.store.get(item.id)!)).toBe(settledWakeAt(kind, item, retryAt));
    expect(protection.impacts(window.id)).toMatchObject({
      postponed: 1, pending: 0, dispositions: { started: 1 },
    });
    expect(h.claimStore).not.toHaveBeenCalled();
  });

  it.each(["offline", "backend", "additional readiness"] as const)(
    "recovers residual jitter for holdless days-old work masked by %s",
    async (maskedBy) => {
      let ready = maskedBy !== "additional readiness";
      const h = harness(kind, { additionalReadiness: () => ({ ready }) });
      const item = h.createItem({ id: "work-1", wakeAt: at(-2 * 24 * 60 * 60_000) });
      const window = protect(10_000);
      const retryAt = releaseAt(kind, item, window);
      if (maskedBy === "offline") {
        for (let n = 0; n < 125; n++) {
          const startsAt = Date.parse(window.endsAt) + (n + 1) * 60_000;
          protection.create({
            startsAt: new Date(startsAt).toISOString(),
            endsAt: new Date(startsAt + 60_000).toISOString(),
            timezone: "UTC", reason: "Future protection",
          });
        }
      } else {
        if (maskedBy === "backend") h.sm.getDeferDeliveryReadiness.mockReturnValue({ ready: false });
        h.runner.start();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(protection.outstanding(kind)).toEqual([]);
      expect(h.claimStore).not.toHaveBeenCalled();

      const endsAt = Date.parse(window.endsAt);
      vi.setSystemTime(endsAt + Math.floor((retryAt - endsAt) / 2));
      const listing = vi.spyOn(protection, "list");
      ready = true;
      h.sm.getDeferDeliveryReadiness.mockReturnValue({ ready: true });
      if (maskedBy === "offline") h.runner.start();
      else bus.emit({ type: "server:restart-cleared" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.store.get(item.id)).toEqual(item);
      expect(protection.outstanding(kind)).toEqual([
        expect.objectContaining({ workId: item.id, scheduledFor: wakeAt(item), windowId: window.id }),
      ]);
      expect(listing).not.toHaveBeenCalled();

      h.runner.poke();
      bus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
      await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
      expect(h.store.get(item.id)).toEqual(item);
      expect(h.claimStore).not.toHaveBeenCalled();
      expect(h.releaseStore).not.toHaveBeenCalled();
      expect(h.claimSession).not.toHaveBeenCalled();
      expect(h.releaseSession).not.toHaveBeenCalled();
      expect(h.sm.tryAcquireDeferWorker).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(h.workerRun).toHaveBeenCalledOnce();
      expect(h.store.get(item.id)).toMatchObject({
        status: "completed", updatedAt: new Date(retryAt).toISOString(),
      });
      expect(wakeAt(h.store.get(item.id)!)).toBe(settledWakeAt(kind, item, retryAt));
      expect(protection.impacts(window.id)).toMatchObject({
        postponed: 1, pending: 0, dispositions: { started: 1 },
      });
    },
  );

  it.each(["elapsed jitter", "due at end", "due after end"] as const)(
    "does not invent a protection delay for %s",
    async (scenario) => {
      const h = harness(kind);
      const window = protect(10_000);
      const endsAt = Date.parse(window.endsAt);
      const now = endsAt + (scenario === "elapsed jitter" ? 3_000 : scenario === "due after end" ? 1 : 0);
      const item = h.createItem({
        wakeAt: scenario === "elapsed jitter" ? at(-2 * 24 * 60 * 60_000) : new Date(now).toISOString(),
      });
      vi.setSystemTime(now);
      h.runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(h.workerRun).toHaveBeenCalledOnce();
      expect(h.claimStore).toHaveBeenCalledOnce();
      expect(wakeAt(h.store.get(item.id)!)).toBe(settledWakeAt(kind, item, now));
      expect(protection.impacts(window.id)).toMatchObject({ postponed: 0, pending: 0 });
    },
  );

  it.each([500, 5_000])("uses the later release for a back-to-back window lasting %i ms", async (secondDuration) => {
    const h = harness(kind);
    const item = h.createItem({ id: "work-2" });
    const first = protect(10_000);
    const second = protection.create({
      startsAt: first.endsAt,
      endsAt: new Date(Date.parse(first.endsAt) + secondDuration).toISOString(),
      timezone: "UTC", reason: "Follow-on protection",
    });
    const firstRetryAt = releaseAt(kind, item, first);
    const secondRetryAt = releaseAt(kind, item, second);
    const hold = vi.spyOn(protection, "hold");
    h.runner.start();
    await vi.advanceTimersByTimeAsync(10_000);
    protection.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(protection.current()?.id).toBe(second.id);
    expect(hold).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(firstRetryAt - Date.now());
    bus.emit({ type: "focus:protection-cleared", protectionWindowId: first.id });
    h.runner.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get(item.id)).toEqual(item);
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.claimSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(Math.max(0, Date.parse(second.endsAt) - Date.now()));
    protection.reconcile();
    await vi.advanceTimersByTimeAsync(secondRetryAt - Date.now() - 1);
    expect(h.store.get(item.id)).toEqual(item);
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(hold).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.workerRun).toHaveBeenCalledOnce();
    expect(h.store.get(item.id)?.updatedAt).toBe(new Date(secondRetryAt).toISOString());
    for (const window of [first, second]) {
      expect(protection.impacts(window.id)).toMatchObject({
        postponed: 1, pending: 0, dispositions: { started: 1 },
      });
    }
  });

  it("allows terminal attempt cleanup during residual jitter without claiming the original work", async () => {
    const h = harness(kind);
    const item = h.createItem({ id: "work-2" });
    const window = protect(10_000);
    h.runner.start();
    await vi.advanceTimersByTimeAsync(10_000);
    db.prepare(kind === "defer"
      ? "UPDATE deferred_prompts SET attempts=? WHERE id=?"
      : "UPDATE defer_loops SET attempts=? WHERE id=?").run(MAX_ATTEMPTS, item.id);
    h.runner.poke();
    await vi.advanceTimersByTimeAsync(0);

    const status = "failed";
    expect(h.store.get(item.id)).toMatchObject({ status, attempts: MAX_ATTEMPTS });
    expect(protection.impacts(window.id)).toMatchObject({
      postponed: 1, pending: 0, dispositions: { [status]: 1 },
    });
    expect(h.claimStore.mock.calls.some(([id]) => id === item.id)).toBe(false);
    expect(h.releaseStore).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
    if (kind === "defer") {
      expect(h.claimStore).toHaveBeenCalledOnce();
      expect(h.claimSession).toHaveBeenCalledOnce();
      expect(h.releaseSession).toHaveBeenCalledOnce();
      expect(h.sm.startWorkAndWaitForDelivery).toHaveBeenCalledOnce();
    } else {
      expect(h.claimStore).not.toHaveBeenCalled();
      expect(h.claimSession).not.toHaveBeenCalled();
      expect(h.releaseSession).not.toHaveBeenCalled();
      expect(h.sm.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
    }
  });

  it.each(["cancelled", "deleted"] as const)("settles a durable hold after an offline %s on restart", async (action) => {
    const h = harness(kind);
    const item = h.createItem();
    const window = protect();
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    h.runner.shutdown();
    if (action === "cancelled") h.store.cancelById(item.id);
    else h.store.deleteForSession(item.sessionId);
    expect(protection.outstanding(kind)).toHaveLength(1);
    vi.setSystemTime(Date.parse(window.endsAt) + 1);

    h.makeRunner().start();
    await vi.advanceTimersByTimeAsync(0);

    expect(protection.outstanding(kind)).toEqual([]);
    expect(protection.impacts(window.id).dispositions).toEqual({
      [action === "cancelled" ? "cancelled" : "no-longer-needed"]: 1,
    });
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
  });

  it("reconciles every old deleted hold rather than only the first page", async () => {
    const h = harness(kind);
    const window = protect();
    for (let n = 0; n < 125; n++) {
      protection.hold(window, { kind, workId: `removed-${n}`, scheduledFor: at(-1_000) });
    }
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(protection.outstanding(kind)).toEqual([]);
    expect(protection.impacts(window.id)).toMatchObject({
      postponed: 125, pending: 0, dispositions: { "no-longer-needed": 125 },
    });
    expect(h.claimStore).not.toHaveBeenCalled();
  });

  it.each(["active", "jitter"] as const)("allows an admitted worker return past older %s-held work on the same session", async (phase) => {
    let parentRunner: DeferRunnerCore | undefined;
    const h = harness(kind, { onParentMessageQueued: () => parentRunner?.poke() });
    const item = h.createItem();
    let finishWorker!: (result: DeferWorkerResult) => void;
    h.workerRun.mockImplementationOnce(() => new Promise((resolve) => { finishWorker = resolve; }));
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get(item.id)?.status).toBe("running");
    expect(h.workerRun).toHaveBeenCalledOnce();

    const window = protect(10_000);
    const ordinary = h.promptStore.create("session-1", "New ordinary work", at(-500));
    if (kind === "defer-loop") {
      parentRunner = h.makePromptRunner();
      parentRunner.start();
    } else {
      h.runner.poke();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get(item.id)?.status).toBe("running");
    expect(h.promptStore.get(ordinary.id)?.attempts).toBe(0);
    if (phase === "jitter") {
      await vi.advanceTimersByTimeAsync(10_000);
      protection.reconcile();
      await vi.advanceTimersByTimeAsync(0);
    }

    finishWorker({ action: "return", message: "Already-running work is complete." });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.sm.startWorkAndWaitForDelivery).toHaveBeenCalledExactlyOnceWith(
      "session-1",
      expect.stringContaining("Already-running work is complete."),
      undefined,
      { completionAttention: true },
    );
    expect(h.sm.tryAcquireDeferWorker).toHaveBeenCalledOnce();
    expect(h.workerRun).toHaveBeenCalledOnce();
    expect(h.promptStore.get(ordinary.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(h.store.get(item.id)?.status).toBe("completed");
    expect(protection.impacts(window.id)).toMatchObject({ postponed: 1, pending: 1 });
  });

  it("stops protected retry timers and queued idle work on shutdown", async () => {
    const h = harness(kind);
    const item = h.createItem();
    const window = protect();
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    bus.emit({ type: "session:idle", sessionId: item.sessionId });
    h.runner.shutdown();
    expect(vi.getTimerCount()).toBe(0);

    protection.cancel(window.id);
    h.runner.poke();
    await vi.advanceTimersByTimeAsync(PROTECTION_MS + DEFER_WATCHDOG_INTERVAL_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
    expect(h.store.get(item.id)).toEqual(item);
  });

  it("durably queues an in-flight result without rearming after shutdown", async () => {
    const onParentMessageQueued = vi.fn();
    const h = harness(kind, { onParentMessageQueued });
    const item = h.createItem();
    let finishWorker!: (result: DeferWorkerResult) => void;
    h.workerRun.mockImplementationOnce(() => new Promise((resolve) => { finishWorker = resolve; }));
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    h.runner.shutdown();
    const emit = vi.spyOn(bus, "emit");

    finishWorker({ action: "return", message: "Finished during shutdown" });
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    if (kind === "defer-loop") expect(onParentMessageQueued).toHaveBeenCalledOnce();
    else expect(onParentMessageQueued).not.toHaveBeenCalled();
    expect(h.promptStore.listDeliveriesForSession("session-1")).toEqual([
      expect.objectContaining({
        status: "pending",
        sourceId: item.deferId,
        prompt: expect.stringContaining("Finished during shutdown"),
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.workerRelease).toHaveBeenCalledOnce();
  });
});

describe("mixed defer protection release", () => {
  it("stagger-releases multiple prompt and loop sessions at exact bounded per-kind/id/slot deadlines", async () => {
    const delivered: Array<{ deferId: string; at: number }> = [];
    const work = (["defer", "defer-loop"] as const).flatMap((kind) => {
      const h = harness(kind);
      h.workerRun.mockImplementation(async (input) => {
        delivered.push({ deferId: input.deferId, at: Date.now() });
        return { action: "finish" };
      });
      return [1, 2, 3].map((n) => ({
        kind, h, item: h.createItem({ id: `work-${n}`, sessionId: `${kind}-session-${n}` }),
      }));
    });
    const window = protect(DEFER_WATCHDOG_INTERVAL_MS - 1);
    const releases = work.map((entry) => ({ ...entry, retryAt: releaseAt(entry.kind, entry.item, window) }))
      .sort((a, b) => a.retryAt - b.retryAt);
    expect(new Set(releases.map((entry) => entry.retryAt)).size).toBe(work.length);
    for (const entry of releases) {
      expect(entry.retryAt).toBeGreaterThan(Date.parse(window.endsAt));
      expect(entry.retryAt).toBeLessThanOrEqual(Date.parse(window.endsAt) + 3_000);
    }
    const hold = vi.spyOn(protection, "hold");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const harnesses = [...new Set(work.map((entry) => entry.h))];
    for (const h of harnesses) h.runner.start();
    await vi.advanceTimersByTimeAsync(DEFER_WATCHDOG_INTERVAL_MS - 1);
    protection.reconcile();
    for (let n = 0; n < 5; n++) {
      bus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
      bus.emit({ type: "server:restart-cleared" });
      for (const h of harnesses) h.runner.poke();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(timeout).toHaveBeenCalledTimes(2);

    for (let n = 0; n < releases.length; n++) {
      const { item, retryAt } = releases[n];
      await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
      expect(delivered).toHaveLength(n);
      for (const pending of releases.slice(n)) {
        expect(pending.h.store.get(pending.item.id)).toEqual(pending.item);
        expect(pending.h.claimStore.mock.calls.some(([id]) => id === pending.item.id)).toBe(false);
        expect(pending.h.claimSession.mock.calls.some(([id]) => id === pending.item.sessionId)).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(delivered).toHaveLength(n + 1);
      expect(delivered[n]).toEqual({ deferId: item.deferId, at: retryAt });
    }
    for (const entry of work) {
      expect(entry.h.store.get(entry.item.id)?.status).toBe("completed");
      const deliveredAt = delivered.find(({ deferId }) => deferId === entry.item.deferId)?.at;
      expect(deliveredAt).toBeDefined();
      expect(wakeAt(entry.h.store.get(entry.item.id)!)).toBe(
        settledWakeAt(entry.kind, entry.item, deliveredAt!),
      );
    }
    for (const h of harnesses) {
      expect(h.releaseStore).not.toHaveBeenCalled();
      expect(h.telemetryStore.recordSpan.mock.calls.filter(([span]) => span.name === "defer.runner.hold"))
        .toHaveLength(3);
    }
    expect(hold).toHaveBeenCalledTimes(work.length);
    expect(info).toHaveBeenCalledTimes(work.length);
    expect(timeout).toHaveBeenCalledTimes(work.length);
    expect(protection.impacts(window.id)).toMatchObject({
      postponed: work.length, pending: 0, dispositions: { started: work.length },
    });
  });
});

describe("protected defer continuation and expiry", () => {
  it("expires loops before a future next-run without waiting for that run, even on a busy parent", async () => {
    const h = harness("defer-loop");
    const expiresAt = at(17_321);
    const item = h.createItem({ wakeAt: at(PROTECTION_MS + 60_000), expiresAt });
    const second = h.createItem({ wakeAt: at(PROTECTION_MS + 120_000), expiresAt });
    protect();
    h.sm.isSessionBusy.mockReturnValue(true);
    h.runner.start();
    await vi.advanceTimersByTimeAsync(17_320);
    expect(h.store.get(item.id)?.status).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    for (const id of [item.id, second.id]) {
      expect(h.store.get(id)).toMatchObject({ status: "expired", attempts: 0, updatedAt: expiresAt });
    }
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.sm.listSessionsFromDisk).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
  });

  it.each(["active", "jitter"] as const)("exempts restart recovery from %s holds before FIFO dedup but still waits for readiness", async (phase) => {
    let restartPending = true;
    const h = harness("defer", { isRestartPending: () => restartPending });
    const ordinary = h.createItem({ wakeAt: at(-2_000) });
    const recovery = h.promptStore.create("session-1", RESTART_RECOVERY_CONTINUE_PROMPT, at(-1_000));
    protect(10_000);
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.claimStore).not.toHaveBeenCalled();

    h.sm.getDeferDeliveryReadiness.mockReturnValue({ ready: false });
    restartPending = false;
    if (phase === "jitter") {
      await vi.advanceTimersByTimeAsync(10_000);
      protection.reconcile();
    }
    bus.emit({ type: "server:restart-cleared" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.claimStore).not.toHaveBeenCalled();

    h.sm.getDeferDeliveryReadiness.mockReturnValue({ ready: true });
    h.runner.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.sm.startWorkAndWaitForDelivery).toHaveBeenCalledExactlyOnceWith(
      "session-1", RESTART_RECOVERY_CONTINUE_PROMPT, undefined, { completionAttention: true },
    );
    expect(h.promptStore.get(recovery.id)?.status).toBe("completed");
    expect(h.promptStore.get(ordinary.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(h.sm.tryAcquireDeferWorker).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
    expect(protection.outstanding("defer").map((hold) => hold.workId)).toEqual([ordinary.id]);
  });

  it("expires a loop inside release jitter at its original expiry without worker admission", async () => {
    const h = harness("defer-loop");
    const window = protect(10_000);
    const scheduledFor = at(-1_000);
    const retryAt = protectionRetryAt(window, `defer-loop:work-2:${scheduledFor}`);
    const endsAt = Date.parse(window.endsAt);
    const expiresAtMs = endsAt + Math.floor((retryAt - endsAt) / 2);
    const expiresAt = new Date(expiresAtMs).toISOString();
    const item = h.createItem({ id: "work-2", wakeAt: scheduledFor, expiresAt });
    expect(expiresAtMs).toBeGreaterThan(endsAt);
    expect(expiresAtMs).toBeLessThan(retryAt);
    h.sm.isSessionBusy.mockReturnValue(true);
    h.runner.start();
    await vi.advanceTimersByTimeAsync(10_000);
    protection.reconcile();
    h.runner.poke();
    await vi.advanceTimersByTimeAsync(expiresAtMs - Date.now() - 1);
    expect(h.store.get(item.id)).toEqual(item);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.store.get(item.id)).toMatchObject({
      status: "expired", attempts: 0, runCount: 0, nextRunAt: scheduledFor, expiresAt, updatedAt: expiresAt,
    });
    expect(protection.impacts(window.id)).toMatchObject({
      postponed: 1, pending: 0, dispositions: { expired: 1 },
    });
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() + DEFER_WATCHDOG_INTERVAL_MS);
    expect(h.sm.listSessionsFromDisk).not.toHaveBeenCalled();
    expect(h.sm.tryAcquireDeferWorker).not.toHaveBeenCalled();
    expect(h.claimSession).not.toHaveBeenCalled();
    expect(h.releaseSession).not.toHaveBeenCalled();
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.releaseStore).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
  });

  it.each([17_321, PROTECTION_MS])("expires a protected loop at its actual deadline (%i ms), never at admission or release", async (expiryMs) => {
    const h = harness("defer-loop");
    const expiresAt = at(expiryMs);
    const item = h.createItem({ expiresAt });
    const window = protect();
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(expiryMs - 1);
    expect(h.loopStore.get(item.id)).toEqual(item);
    expect(protection.impacts(window.id)).toMatchObject({ postponed: 1, pending: 1 });

    await vi.advanceTimersByTimeAsync(1);
    expect(h.loopStore.get(item.id)).toMatchObject({
      status: "expired", expiresAt, nextRunAt: "nextRunAt" in item ? item.nextRunAt : undefined,
      attempts: 0, runCount: 0, updatedAt: expiresAt,
    });
    expect(protection.impacts(window.id)).toMatchObject({
      postponed: 1, pending: 0, dispositions: { expired: 1 },
    });
    await vi.advanceTimersByTimeAsync(PROTECTION_MS - expiryMs + 1_000);
    expect(h.sm.listSessionsFromDisk).not.toHaveBeenCalled();
    expect(h.claimSession).not.toHaveBeenCalled();
    expect(h.sm.tryAcquireDeferWorker).not.toHaveBeenCalled();
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
  });

  it.each([20_000, PROTECTION_MS + 1_000])("settles an offline loop expiry on restart after %i ms while preserving its original deadline", async (offlineMs) => {
    const h = harness("defer-loop");
    const expiresAt = at(10_000);
    const item = h.createItem({ expiresAt });
    const window = protect();
    h.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    h.runner.shutdown();
    vi.setSystemTime(Date.now() + offlineMs);

    h.makeRunner().start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.loopStore.get(item.id)).toMatchObject({
      status: "expired", expiresAt, attempts: 0, runCount: 0,
    });
    expect(protection.impacts(window.id).dispositions).toEqual({ expired: 1 });
    expect(h.claimStore).not.toHaveBeenCalled();
    expect(h.workerRun).not.toHaveBeenCalled();
    const disposition = db.prepare(
      "SELECT detailsJson FROM focus_attention_events WHERE eventType='protection_disposition' AND objectId=?",
    ).get(window.id) as { detailsJson: string };
    expect(JSON.parse(disposition.detailsJson)).toMatchObject({ disposition: "expired", expiresAt });
  });
});
