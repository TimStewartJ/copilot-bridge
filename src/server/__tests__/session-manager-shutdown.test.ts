import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearRestartPending, refreshRestartState, SessionManager, triggerRestartPending } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createRestartSuspendedSessionStore } from "../restart-suspended-session-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
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
    session.rpc.suspend = vi.fn(async () => {
      emit({
        type: "session.idle",
        data: {},
        timestamp: "2026-05-19T17:00:05.000Z",
      });
    });
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
    emit({
      type: "tool.execution_complete",
      data: { toolCallId: "tool-1", success: true },
      timestamp: "2026-05-19T17:00:03.000Z",
    });
    emit({
      type: "assistant.turn_end",
      data: { turnId: "1" },
      timestamp: "2026-05-19T17:00:04.000Z",
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

  it("does not restart-preserve an open follow-up assistant turn", async () => {
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
      data: { turnId: "1" },
      timestamp: "2026-05-19T17:00:01.000Z",
    });
    emit({
      type: "tool.execution_start",
      data: { toolCallId: "tool-1", toolName: "bash" },
      timestamp: "2026-05-19T17:00:02.000Z",
    });
    emit({
      type: "tool.execution_complete",
      data: { toolCallId: "tool-1", success: true },
      timestamp: "2026-05-19T17:00:03.000Z",
    });
    emit({
      type: "assistant.turn_end",
      data: { turnId: "1" },
      timestamp: "2026-05-19T17:00:04.000Z",
    });
    emit({
      type: "assistant.turn_start",
      data: { turnId: "2" },
      timestamp: "2026-05-19T17:00:05.000Z",
    });
    await flushMicrotasks();

    triggerRestartPending();
    await refreshRestartState();
    expect(manager.getRestartBlockingSessionActivity()).toEqual([expect.objectContaining({ id: "session-1" })]);

    await manager.gracefulShutdown({ preserveActiveRuns: true });

    expect(session.rpc.suspend).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(store.get("session-1")).toBeUndefined();
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

  it("quiesces restart-preservable runs after a tool turn closes", async () => {
    const db = setupTestDb();
    const store = createRestartSuspendedSessionStore(db);
    const eventBusRegistry = createEventBusRegistry();
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
      runtimePaths: makeTestRuntimePaths("restart-quiesce"),
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

    triggerRestartPending();
    await refreshRestartState();
    expect(await manager.quiesceRestartPreservableSessions()).toMatchObject({
      suspendedSessionIds: [],
      blockingSessions: [expect.objectContaining({ id: "session-1" })],
    });

    emit({
      type: "tool.execution_complete",
      data: { toolCallId: "tool-1", success: true },
      timestamp: "2026-05-19T17:00:03.000Z",
    });
    await flushMicrotasks();
    expect(session.rpc.suspend).not.toHaveBeenCalled();
    expect(await manager.quiesceRestartPreservableSessions()).toMatchObject({
      suspendedSessionIds: [],
      blockingSessions: [expect.objectContaining({ id: "session-1" })],
    });

    emit({
      type: "assistant.turn_end",
      data: { turnId: "1" },
      timestamp: "2026-05-19T17:00:04.000Z",
    });
    await flushMicrotasks();

    expect(session.rpc.suspend).toHaveBeenCalledTimes(1);
    expect(session.abort).not.toHaveBeenCalled();
    expect(store.get("session-1")).toMatchObject({
      sessionId: "session-1",
      status: "suspended",
    });
    expect(manager.getActiveSessions()).toEqual([]);
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().complete).toBe(false);
  });

  it("shares concurrent restart quiesce suspend attempts", async () => {
    const db = setupTestDb();
    const store = createRestartSuspendedSessionStore(db);
    const { session, emit } = makeSession();
    let resolveSuspend!: () => void;
    session.rpc.suspend = vi.fn(() => new Promise<void>((resolve) => {
      resolveSuspend = resolve;
    }));
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
      runtimePaths: makeTestRuntimePaths("restart-quiesce-concurrent"),
    }) as any;
    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
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
    emit({
      type: "tool.execution_complete",
      data: { toolCallId: "tool-1", success: true },
      timestamp: "2026-05-19T17:00:03.000Z",
    });
    emit({
      type: "assistant.turn_end",
      data: { turnId: "1" },
      timestamp: "2026-05-19T17:00:04.000Z",
    });
    await flushMicrotasks();

    triggerRestartPending();
    await refreshRestartState();
    const first = manager.trySuspendForPendingRestart("session-1");
    const second = manager.trySuspendForPendingRestart("session-1");
    await flushMicrotasks();
    expect(session.rpc.suspend).toHaveBeenCalledTimes(1);

    resolveSuspend();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(manager.getActiveSessions()).toEqual([]);
  });

  it("does not quiesce immediately after a prompt is accepted before tool work starts", async () => {
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
      runtimePaths: makeTestRuntimePaths("restart-quiesce-not-ready"),
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
    await flushMicrotasks();

    triggerRestartPending();
    await refreshRestartState();
    const result = await manager.quiesceRestartPreservableSessions();

    expect(result).toMatchObject({
      suspendedSessionIds: [],
      blockingSessions: [expect.objectContaining({ id: "session-1" })],
    });
    expect(manager.getRestartBlockingSessionActivity()).toEqual([expect.objectContaining({ id: "session-1" })]);
    expect(session.rpc.suspend).not.toHaveBeenCalled();
    expect(store.get("session-1")).toBeUndefined();
  });

  it("preserves active restart recovery during a subsequent restart shutdown after a safe boundary", async () => {
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
      rpc: {
        suspend: vi.fn().mockResolvedValue(undefined),
      },
      on: vi.fn(() => vi.fn()),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
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
    expect(manager.getActiveSessions()).toEqual(["session-1"]);
    resumeConfig.onEvent({
      type: "assistant.turn_start",
      data: { turnId: "1" },
      timestamp: "2026-05-19T17:00:03.000Z",
    });
    resumeConfig.onEvent({
      type: "tool.execution_start",
      data: { toolCallId: "tool-1", toolName: "bash" },
      timestamp: "2026-05-19T17:00:04.000Z",
    });
    resumeConfig.onEvent({
      type: "tool.execution_complete",
      data: { toolCallId: "tool-1", success: true },
      timestamp: "2026-05-19T17:00:05.000Z",
    });
    resumeConfig.onEvent({
      type: "assistant.turn_end",
      data: { turnId: "1" },
      timestamp: "2026-05-19T17:00:06.000Z",
    });
    await flushMicrotasks();

    triggerRestartPending();
    await refreshRestartState();
    expect(manager.getRestartBlockingSessionActivity()).toEqual([]);

    await manager.gracefulShutdown({ preserveActiveRuns: true });

    expect(recoveredSession.rpc.suspend).toHaveBeenCalledTimes(1);
    expect(store.get("session-1")).toMatchObject({
      sessionId: "session-1",
      status: "suspended",
      resumeAttempts: 1,
    });
    expect(manager.getActiveSessions()).toEqual([]);
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
        continuePendingWork: true,
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

  it("releases restart recovery when resume produces no events", async () => {
    vi.useFakeTimers();
    try {
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

      const recoveredSession = {
        on: vi.fn(() => vi.fn()),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
      const client = {
        start: vi.fn().mockResolvedValue(undefined),
        resumeSession: vi.fn(async (_sessionId: string, config: any) => {
          queueMicrotask(() => config.onEvent?.({
            type: "session.resume",
            data: {},
            timestamp: "2026-05-19T17:00:03.000Z",
          }));
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
      expect(manager.getActiveSessions()).toEqual(["session-1"]);

      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();

      expect(store.get("session-1")).toBeUndefined();
      expect(manager.getActiveSessions()).toEqual([]);
      expect(recoveredSession.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat persisted idle or shutdown after an open follow-up turn as restart recovery completion", async () => {
    vi.useFakeTimers();
    try {
      const db = setupTestDb();
      const store = createRestartSuspendedSessionStore(db);
      const telemetryStore = createTelemetryStore(db);
      store.upsertSuspending({
        sessionId: "session-1",
        runKind: "message",
        pendingPrompt: "hello",
        promptAccepted: true,
        suspendedAt: "2026-05-19T17:00:02.000Z",
        lastEventAt: "2026-05-19T17:00:01.000Z",
      });
      store.markSuspended("session-1", "2026-05-19T17:00:02.000Z");

      const runtimePaths = makeTestRuntimePaths("restart-resume-persisted-shutdown");
      const sessionStateDir = join(runtimePaths.copilotHome!, "session-state", "session-1");
      mkdirSync(sessionStateDir, { recursive: true });
      writeFileSync(
        join(sessionStateDir, "events.jsonl"),
        [
          {
            type: "assistant.message",
            data: { content: "intermediate" },
            timestamp: "2026-05-19T17:00:03.000Z",
          },
          {
            type: "assistant.turn_end",
            data: { turnId: "1" },
            timestamp: "2026-05-19T17:00:04.000Z",
          },
          {
            type: "assistant.turn_start",
            data: { turnId: "2" },
            timestamp: "2026-05-19T17:00:05.000Z",
          },
          {
            type: "session.idle",
            data: {},
            timestamp: "2026-05-19T17:00:06.000Z",
          },
          {
            type: "session.shutdown",
            data: {},
            timestamp: "2026-05-19T17:00:07.000Z",
          },
        ].map((event) => JSON.stringify(event)).join("\n") + "\n",
        "utf8",
      );

      const recoveredSession = {
        on: vi.fn(() => vi.fn()),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
      const client = {
        start: vi.fn().mockResolvedValue(undefined),
        resumeSession: vi.fn(async (_sessionId: string, config: any) => {
          queueMicrotask(() => config.onEvent?.({
            type: "session.resume",
            data: {},
            timestamp: "2026-05-19T17:00:08.000Z",
          }));
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
        runtimePaths,
        copilotHome: runtimePaths.copilotHome,
        telemetryStore,
        restartSuspendedSessionStore: store,
        createCopilotClient: () => client as any,
      });

      await manager.initialize();
      await flushMicrotasks();

      expect(store.get("session-1")).toMatchObject({ status: "resuming" });
      expect(manager.getActiveSessions()).toEqual(["session-1"]);
      expect(recoveredSession.disconnect).not.toHaveBeenCalled();
      expect(telemetryStore.querySpans({
        name: "session.restartResume.persisted_terminal",
        sessionId: "session-1",
      })).toEqual([]);

      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();

      expect(store.get("session-1")).toBeUndefined();
      expect(manager.getActiveSessions()).toEqual([]);
      expect(recoveredSession.disconnect).toHaveBeenCalledTimes(1);
      const [noEventsSpan] = telemetryStore.querySpans({
        name: "session.restartResume.no_events",
        sessionId: "session-1",
      });
      expect(noEventsSpan?.metadata).toMatchObject({
        noEventTimeoutMs: 30_000,
        lastLiveEventType: "session.resume",
        latestPersistedTerminalEventType: "session.shutdown",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
