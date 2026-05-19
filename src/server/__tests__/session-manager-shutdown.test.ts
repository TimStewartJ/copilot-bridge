import { describe, expect, it, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createRestartSuspendedSessionStore } from "../restart-suspended-session-store.js";
import { setupTestDb, createTestBus, testPath } from "./helpers.js";

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
  beforeEach(() => {
    shutdownBridgeBrowserMock.mockReset();
    shutdownBridgeBrowserMock.mockResolvedValue(undefined);
  });

  function createManager(overrides: Record<string, unknown> = {}) {
    const db = setupTestDb();
    return new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {} as any,
      config: { sessionMcpServers: {} },
      ...overrides,
    });
  }

  function makeSession() {
    const handlers: Array<(event: any) => void> = [];
    const session = {
      rpc: {
        suspend: vi.fn().mockResolvedValue(undefined),
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
    const emit = (event: any) => {
      for (const handler of [...handlers]) handler(event);
    };
    return { session, emit };
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

  it("suspends eligible active message runs during restart-preserving shutdown", async () => {
    const db = setupTestDb();
    const store = createRestartSuspendedSessionStore(db);
    const eventBusRegistry = createEventBusRegistry();
    const stop = vi.fn().mockResolvedValue(undefined);
    const { session, emit } = makeSession();
    const manager = new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry,
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {
        findTaskBySessionId: vi.fn().mockReturnValue(null),
      } as any,
      settingsStore: {
        getMcpServers: () => ({}),
        getSettings: () => ({ mcpServers: {} }),
      } as any,
      config: { sessionMcpServers: {} },
      restartSuspendedSessionStore: store,
    }) as any;
    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(session),
      stop,
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    emit({
      type: "user.message",
      data: { content: "hello" },
      timestamp: "2026-05-19T17:00:00.000Z",
    });
    await flushMicrotasks();

    await manager.gracefulShutdown({ preserveActiveRuns: true });

    expect(session.rpc.suspend).toHaveBeenCalledTimes(1);
    expect(session.abort).not.toHaveBeenCalled();
    expect(store.get("session-1")).toMatchObject({
      sessionId: "session-1",
      status: "suspended",
      runKind: "message",
      promptAccepted: true,
    });
    expect(manager.getActiveSessions()).toEqual([]);
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().complete).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("falls back to aborting active runs that have tools in flight", async () => {
    const db = setupTestDb();
    const store = createRestartSuspendedSessionStore(db);
    const { session, emit } = makeSession();
    const manager = new SessionManager({
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
      restartSuspendedSessionStore: store,
    }) as any;
    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    emit({
      type: "user.message",
      data: { content: "hello" },
      timestamp: "2026-05-19T17:00:00.000Z",
    });
    emit({
      type: "assistant.turn_start",
      data: {},
      timestamp: "2026-05-19T17:00:01.000Z",
    });
    emit({
      type: "tool.execution_start",
      data: { toolCallId: "tool-1", toolName: "bash" },
      timestamp: "2026-05-19T17:00:02.000Z",
    });
    await flushMicrotasks();

    await manager.gracefulShutdown({ preserveActiveRuns: true });

    expect(session.rpc.suspend).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(store.get("session-1")).toBeUndefined();
  });

  it("starts recovery for restart-suspended records on initialize", async () => {
    const db = setupTestDb();
    const store = createRestartSuspendedSessionStore(db);
    store.upsertSuspending({
      sessionId: "session-1",
      runKind: "message",
      pendingPrompt: "hello",
      promptAccepted: true,
      suspendedAt: "2026-05-19T17:00:00.000Z",
      lastEventAt: "2026-05-19T17:00:01.000Z",
    });
    store.markSuspended("session-1", "2026-05-19T17:00:02.000Z");

    let resumeConfig: any;
    const recoveredSession = {
      on: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      resumeSession: vi.fn(async (_sessionId: string, config: any) => {
        resumeConfig = config;
        return recoveredSession;
      }),
    };
    const manager = new SessionManager({
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
      restartSuspendedSessionStore: store,
      createCopilotClient: () => client as any,
    });

    await manager.initialize();
    await flushMicrotasks();

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.resumeSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        continuePendingWork: false,
        onEvent: expect.any(Function),
      }),
    );

    resumeConfig.onEvent({
      type: "assistant.message",
      data: { content: "recovered" },
      timestamp: "2026-05-19T17:00:03.000Z",
    });
    resumeConfig.onEvent({
      type: "session.idle",
      data: {},
      timestamp: "2026-05-19T17:00:04.000Z",
    });
    await flushMicrotasks();

    expect(store.get("session-1")).toBeUndefined();
    expect(manager.getActiveSessions()).toEqual([]);
    expect(recoveredSession.disconnect).toHaveBeenCalledTimes(1);
  });
});
