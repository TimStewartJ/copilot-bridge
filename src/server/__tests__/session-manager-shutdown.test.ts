import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { clearRestartPending, refreshRestartState, SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus, testPath } from "./helpers.js";
import type { BrowserLifecycle, BrowserShutdownOutcome } from "../browser-lifecycle.js";

function createFakeBrowserLifecycle(overrides: Partial<{ result: BrowserShutdownOutcome; error: Error }> = {}) {
  const shutdown = vi.fn(async (): Promise<BrowserShutdownOutcome> => {
    if (overrides.error) throw overrides.error;
    return overrides.result ?? { skipped: true, reason: "disabled" };
  });
  return { shutdown } satisfies BrowserLifecycle;
}

describe("SessionManager graceful shutdown", () => {
  beforeEach(async () => {
    clearRestartPending();
    await refreshRestartState();
  });

  afterEach(async () => {
    clearRestartPending();
    await refreshRestartState();
  });

  function createManager(overrides: Record<string, unknown> = {}) {
    const db = setupTestDb();
    return new SessionManager({
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {
        findTaskBySessionId: vi.fn().mockReturnValue(null),
      } as any,
      settingsStore: {
        getMcpServers: () => ({}),
        getSettings: () => ({ mcpServers: {} }),
      } as any,
      config: { sessionMcpServers: {} },
      ...overrides,
    });
  }

  function makeSession() {
    const handlers: Array<(event: any) => void> = [];
    const session = {
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((handler: (event: any) => void) => {
        handlers.push(handler);
        return vi.fn(() => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        });
      }),
      send: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(async () => {
        for (const handler of [...handlers]) {
          handler({
            type: "abort",
            data: { reason: "shutdown" },
            timestamp: "2026-05-19T17:00:00.000Z",
          });
        }
      }),
      disconnect: vi.fn(),
    };
    return session;
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it("closes browser sessions and the primary bridge browser during graceful shutdown", async () => {
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const copilotHome = testPath("bridge-shutdown-home");
    const browserLifecycle = createFakeBrowserLifecycle();
    const manager = createManager({
      browserSessionStore: { closeAll },
      browserLifecycle,
      copilotHome,
    }) as any;
    manager.backend = { stop };

    await manager.gracefulShutdown();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(browserLifecycle.shutdown).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.backend).toBeNull();
  });

  it("continues shutdown when primary bridge browser cleanup fails", async () => {
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const browserLifecycle = createFakeBrowserLifecycle({ error: new Error("close failed") });
    const manager = createManager({
      browserSessionStore: { closeAll },
      browserLifecycle,
    }) as any;
    manager.backend = { stop };

    await manager.gracefulShutdown();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(browserLifecycle.shutdown).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.backend).toBeNull();
  });

  it("uses a no-op browser lifecycle by default so unit tests do not spawn the agent-browser CLI", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const manager = createManager() as any;
    manager.backend = { stop };

    await manager.gracefulShutdown();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.backend).toBeNull();
  });

  it("aborts active runs instead of suspending them during graceful shutdown", async () => {
    const session = makeSession();
    const stop = vi.fn().mockResolvedValue(undefined);
    const manager = createManager() as any;
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
      stop,
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await manager.gracefulShutdown();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(manager.getActiveSessions()).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung backend stop and forces stop without blocking shutdown", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(() => new Promise<void>(() => {})); // never resolves
      const forceStop = vi.fn().mockResolvedValue(undefined);
      const manager = createManager() as any;
      manager.backend = { stop, forceStop };

      const shutdownPromise = manager.gracefulShutdown();
      // Advance past the bounded backend-stop window (4s) within the overall budget.
      await vi.advanceTimersByTimeAsync(5_000);
      await shutdownPromise;

      expect(stop).toHaveBeenCalledTimes(1);
      expect(forceStop).toHaveBeenCalledTimes(1);
      expect(manager.backend).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
