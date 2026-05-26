import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { clearRestartPending, refreshRestartState, SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { makeTestRuntimePaths, setupTestDb, createTestBus, testPath } from "./helpers.js";

const { shutdownBridgeBrowserMock } = vi.hoisted(() => ({
  shutdownBridgeBrowserMock: vi.fn(),
}));

vi.mock("../agent-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-browser.js")>("../agent-browser.js");
  return {
    ...actual,
    shutdownBridgeBrowser: shutdownBridgeBrowserMock,
  };
});

describe("SessionManager graceful shutdown", () => {
  beforeEach(async () => {
    clearRestartPending();
    await refreshRestartState();
    shutdownBridgeBrowserMock.mockReset();
    shutdownBridgeBrowserMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    clearRestartPending();
    await refreshRestartState();
  });

  function createManager(overrides: Record<string, unknown> = {}) {
    const db = setupTestDb();
    return new SessionManager({
      tools: [],
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
      rpc: {
        suspend: vi.fn().mockResolvedValue(undefined),
        mode: {
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
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
    const manager = createManager({
      browserSessionStore: { closeAll },
      copilotHome,
    }) as any;
    manager.client = { stop };

    await manager.gracefulShutdown();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(shutdownBridgeBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileDir: join(copilotHome, "browser-profile"),
      }),
      undefined,
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.client).toBeNull();
  });

  it("continues shutdown when primary bridge browser cleanup fails", async () => {
    shutdownBridgeBrowserMock.mockRejectedValue(new Error("close failed"));

    const closeAll = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const manager = createManager({
      browserSessionStore: { closeAll },
    }) as any;
    manager.client = { stop };

    await manager.gracefulShutdown();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(shutdownBridgeBrowserMock).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.client).toBeNull();
  });

  it("aborts active runs instead of suspending them during graceful shutdown", async () => {
    const session = makeSession();
    const stop = vi.fn().mockResolvedValue(undefined);
    const manager = createManager() as any;
    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(session),
      stop,
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await manager.gracefulShutdown();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.rpc.suspend).not.toHaveBeenCalled();
    expect(manager.getActiveSessions()).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
