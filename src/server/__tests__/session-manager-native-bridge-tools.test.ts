import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import {
  forceClearRestartPending,
  configureRestartStateStore,
  getRestartWaitingCount,
  isRestartImminent,
  refreshRestartState,
  SessionManager,
  triggerRestartPendingForExternalRequest,
} from "../session-manager.js";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { defineBridgeTool } from "../agent-tools-mcp/adapter.js";
import { createTestBus, makeAgentSessionStub, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

const EXTRA_MCP_SERVER_NAME = "extra-tools";

function createCapabilities() {
  return {
    resumeSession: true,
    streamingToolInput: true,
    costUsage: true,
    subAgents: true,
    images: true,
    bidirectionalStdin: false,
    externalToolEvents: true,
    forkBoundaries: true,
    nativeBridgeTools: true,
    eagerNativeTools: true,
    toolMetadataWarmup: true,
  };
}

function createFakeSession(sessionId: string, tools: any[] = []) {
  return makeAgentSessionStub({
    sessionId,
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    on: vi.fn((_handler: (event: any) => void) => () => undefined),
    initializeTools: vi.fn(async () => undefined),
    getCurrentToolMetadata: vi.fn(async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.parameters,
        deferLoading: false,
      })),
    })),
    listMcpServers: vi.fn(async () => ({
      servers: [] as Array<{ name: string; status: string; source?: string }>,
    })),
  });
}

function createInteractiveFakeSession(sessionId: string, tools: any[] = []) {
  const handlers = new Set<(event: any) => void>();
  const session = createFakeSession(sessionId, tools);
  session.on = vi.fn((handler: (event: any) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  });
  session.send = vi.fn(async () => {
    const timestamp = new Date().toISOString();
    for (const handler of handlers) {
      handler({ type: "user.message", data: {}, timestamp });
    }
    for (const handler of handlers) {
      handler({ type: "session.idle", data: {}, timestamp });
    }
  });
  return session;
}

function createControlledFakeSession(sessionId: string, tools: any[] = []) {
  const handlers = new Set<(event: any) => void>();
  const sendGate = createDeferred<undefined>();
  const session = createFakeSession(sessionId, tools);
  session.on = vi.fn((handler: (event: any) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  });
  session.send = vi.fn(() => sendGate.promise);
  return {
    session,
    releaseSend: () => sendGate.resolve(undefined),
    emit: (event: any) => {
      for (const handler of handlers) handler(event);
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  // Deep enough to drain the agent-registry reap the resume path now awaits.
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function createBridgeToolServer() {
  const server = new BridgeToolsMcpServer({} as any);
  server.registerTool(defineBridgeTool("global_bridge_tool", {
    description: "Global Bridge tool",
    handler: async () => "global",
  }));
  server.registerTool(defineBridgeTool("session_bridge_tool", {
    description: "Session Bridge tool",
    scope: "session",
    handler: async () => "session",
  }));
  server.registerTool(defineBridgeTool("report_intent", {
    description: "Excluded Bridge tool",
    handler: async () => "excluded",
  }));
  return server;
}

function createManager() {
  const db = setupTestDb();
  const runtimePaths = makeTestRuntimePaths("native-bridge-tools");
  const bridgeToolsMcpServer = createBridgeToolServer();
  const backend = {
    id: "copilot" as const,
    capabilities: createCapabilities(),
    permissionPolicy: undefined,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    forceStop: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async (config: any) => createFakeSession(config.sessionId ?? "created-session", config.tools ?? [])),
    resumeSession: vi.fn(async (sessionId: string, config: any) => createFakeSession(sessionId, config.tools ?? [])),
    forkSession: vi.fn(async () => ({ sessionId: "forked-session" })),
    deleteSession: vi.fn(async () => undefined),
    getSessionMetadata: vi.fn(async () => ({})),
  };
  const taskStore = {
    findTaskBySessionId: vi.fn().mockReturnValue(null),
    getTask: vi.fn().mockReturnValue(null),
    listTasks: vi.fn().mockReturnValue([]),
    unlinkSession: vi.fn(),
  };
  const manager = new SessionManager({
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: taskStore as any,
    config: { sessionMcpServers: { custom: { command: "custom-mcp", args: [] } } },
    builtInMcpServers: {
      [EXTRA_MCP_SERVER_NAME]: { command: "node", args: ["extra-mcp.js"] },
    },
    bridgeToolsMcpServer,
    clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
    createBackend: vi.fn(() => backend as any),
    runtimePaths,
    copilotHome: runtimePaths.copilotHome,
  });

  return { manager, backend, db, runtimePaths, taskStore };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("SessionManager native Bridge tools", () => {
  it("promotes Bridge tools as canonical native tools without starting a Bridge MCP transport", async () => {
    const { manager, backend, db } = createManager();
    try {
      await manager.initialize();
      const result = await manager.createSession({ background: true });

      expect(result.sessionId).toMatch(/[0-9a-f-]{36}/);
      const config = backend.createSession.mock.calls[0][0] as any;
      expect(config.tools.map((tool: any) => tool.name).sort()).toEqual([
        "global_bridge_tool",
        "session_bridge_tool",
      ]);
      expect(config.tools.every((tool: any) => tool.defer === "never")).toBe(true);
      expect(config.tools.every((tool: any) => tool.skipPermission === true)).toBe(true);
      expect(config.mcpServers.custom).toEqual({ command: "custom-mcp", args: [] });
      // Generic built-in MCP seam still flows through untouched.
      expect(config.mcpServers[EXTRA_MCP_SERVER_NAME]).toEqual({ command: "node", args: ["extra-mcp.js"] });
      // No Bridge tools stdio/socket MCP server is injected anymore.
      expect(config.mcpServers["bridge-tools"]).toBeUndefined();
      expect(config.mcpServers["bridge-tools-session"]).toBeUndefined();
      const session = await backend.createSession.mock.results[0].value;
      expect(session.initializeTools).not.toHaveBeenCalled();

      await manager.startWorkAndWaitForDelivery(result.sessionId, "hello");
      expect(session.initializeTools).toHaveBeenCalledOnce();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("warms a resumed session without initializing tools or probing MCP", async () => {
    const { manager, backend, db } = createManager();
    try {
      await manager.initialize();
      const session = createFakeSession("resumed-session");
      backend.resumeSession.mockResolvedValueOnce(session);

      await expect(manager.warmSession(session.sessionId)).resolves.toBeUndefined();

      expect(session.initializeTools).not.toHaveBeenCalled();
      expect(session.listMcpServers).not.toHaveBeenCalled();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("holds the first resumed prompt until native tool initialization completes", async () => {
    const { manager, backend, db } = createManager();
    const initializationGate = createDeferred<void>();
    const callOrder: string[] = [];
    try {
      await manager.initialize();
      const session = createInteractiveFakeSession("resumed-prompt-session");
      session.initializeTools.mockImplementationOnce(async () => {
        callOrder.push("initialize:start");
        await initializationGate.promise;
        callOrder.push("initialize:end");
      });
      const send = session.send.getMockImplementation();
      session.send.mockImplementationOnce(async () => {
        callOrder.push("send");
        await send?.();
      });
      backend.resumeSession.mockResolvedValueOnce(session);

      const delivered = manager.startWorkAndWaitForDelivery(session.sessionId, "hello");
      await vi.waitFor(() => expect(session.initializeTools).toHaveBeenCalledOnce());

      expect(session.send).not.toHaveBeenCalled();

      initializationGate.resolve();
      await expect(delivered).resolves.toBeUndefined();
      expect(session.send).toHaveBeenCalledOnce();
      expect(callOrder).toEqual(["initialize:start", "initialize:end", "send"]);
    } finally {
      initializationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("fails the first resumed prompt instead of racing timed-out tool initialization", async () => {
    const { manager, backend, db } = createManager();
    const initializationGate = createDeferred<void>();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.initialize();
      const session = createInteractiveFakeSession("resumed-prompt-timeout");
      session.initializeTools.mockImplementationOnce(async () => {
        await initializationGate.promise;
      });
      backend.resumeSession.mockResolvedValueOnce(session);
      const testManager = manager as unknown as {
        sessionToolInitializationWaitTimeoutMs: number;
      };
      testManager.sessionToolInitializationWaitTimeoutMs = 1;

      await expect(manager.startWorkAndWaitForDelivery(session.sessionId, "hello"))
        .rejects.toThrow("Session tool initialization did not complete before prompt delivery");

      expect(session.send).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        `[sdk] [${session.sessionId.slice(0, 8)}] Session tool initialization timed out after 1ms`,
      );
    } finally {
      initializationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("rejects steering until the resumed session accepts its first prompt", async () => {
    const { manager, backend, db } = createManager();
    const initializationGate = createDeferred<void>();
    try {
      await manager.initialize();
      const session = createInteractiveFakeSession("resumed-steering-session");
      session.initializeTools.mockImplementationOnce(async () => {
        await initializationGate.promise;
      });
      backend.resumeSession.mockResolvedValueOnce(session);

      manager.startWork(session.sessionId, "hello");
      await vi.waitFor(() => expect(session.initializeTools).toHaveBeenCalledOnce());

      await expect(manager.steerSession(session.sessionId, "please adjust"))
        .rejects.toThrow("Session is still starting the current turn");
      expect(session.send).not.toHaveBeenCalled();

      initializationGate.resolve();
      await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    } finally {
      initializationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("initializes each successive cached session once when explicitly requested", async () => {
    const { manager, db } = createManager();
    try {
      await manager.initialize();
      const firstSession = createFakeSession("replacement-session");
      const secondSession = createFakeSession("replacement-session");
      const sessionCache = manager as unknown as {
        cacheResumedSession(
          sessionId: string,
          session: typeof firstSession,
          sessionConfig: { mcpServers: Record<string, never> },
        ): Promise<unknown>;
        waitForSessionToolInitialization(
          sessionId: string,
          session: typeof firstSession,
        ): Promise<boolean>;
        evictCachedSession(
          sessionId: string,
          expectedSession: typeof firstSession,
          reason: string,
        ): Promise<unknown>;
      };

      await sessionCache.cacheResumedSession(firstSession.sessionId, firstSession, { mcpServers: {} });
      expect(firstSession.initializeTools).not.toHaveBeenCalled();
      await expect(
        Promise.all([
          sessionCache.waitForSessionToolInitialization(firstSession.sessionId, firstSession),
          sessionCache.waitForSessionToolInitialization(firstSession.sessionId, firstSession),
        ]),
      ).resolves.toEqual([true, true]);

      await sessionCache.evictCachedSession(
        firstSession.sessionId,
        firstSession,
        "test replacement",
      );
      await sessionCache.cacheResumedSession(secondSession.sessionId, secondSession, { mcpServers: {} });
      expect(secondSession.initializeTools).not.toHaveBeenCalled();
      await expect(
        sessionCache.waitForSessionToolInitialization(secondSession.sessionId, secondSession),
      ).resolves.toBe(true);

      expect(firstSession.initializeTools).toHaveBeenCalledOnce();
      expect(secondSession.initializeTools).toHaveBeenCalledOnce();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("uses only the current session for an explicit MCP status request", async () => {
    const { manager, backend, db } = createManager();
    try {
      await manager.initialize();
      const firstSession = createFakeSession("superseded-probe-session");
      const secondSession = createFakeSession("superseded-probe-session");
      firstSession.listMcpServers.mockResolvedValueOnce({
        servers: [{ name: "old", status: "failed" }],
      });
      secondSession.listMcpServers.mockResolvedValue({
        servers: [{ name: "current", status: "connected" }],
      });
      backend.resumeSession.mockResolvedValueOnce(firstSession);

      await manager.warmSession(firstSession.sessionId);
      const sessionCache = manager as unknown as {
        cacheResumedSession(
          sessionId: string,
          session: typeof secondSession,
          sessionConfig: { mcpServers: Record<string, never> },
        ): Promise<unknown>;
        evictCachedSession(
          sessionId: string,
          expectedSession: typeof firstSession,
          reason: string,
        ): Promise<unknown>;
      };
      await sessionCache.evictCachedSession(
        firstSession.sessionId,
        firstSession,
        "test replacement",
      );
      await sessionCache.cacheResumedSession(secondSession.sessionId, secondSession, { mcpServers: {} });
      await expect(manager.getMcpStatus(secondSession.sessionId)).resolves.toEqual([
        { name: "current", status: "connected" },
      ]);

      expect(firstSession.initializeTools).not.toHaveBeenCalled();
      expect(firstSession.listMcpServers).not.toHaveBeenCalled();
      expect(secondSession.listMcpServers).toHaveBeenCalledOnce();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("defers failed initialization reporting until MCP status is explicitly requested", async () => {
    const { manager, backend, db } = createManager();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.initialize();
      const session = createFakeSession("failed-initialization-session");
      session.initializeTools.mockRejectedValueOnce(new Error("initialization failed"));
      backend.resumeSession.mockResolvedValueOnce(session);

      await manager.warmSession(session.sessionId);
      expect(session.initializeTools).not.toHaveBeenCalled();
      expect(session.listMcpServers).not.toHaveBeenCalled();

      await expect(manager.getMcpStatus(session.sessionId)).resolves.toEqual([]);

      expect(session.initializeTools).toHaveBeenCalledOnce();
      expect(session.listMcpServers).toHaveBeenCalledOnce();
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(consoleWarn).toHaveBeenCalledWith(
        `[sdk] [${session.sessionId.slice(0, 8)}] Native Bridge tool warmup failed: initialization failed`,
      );
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("waits for resumed-session initialization before starting MCP OAuth", async () => {
    const { manager, backend, db } = createManager();
    const initializationGate = createDeferred<void>();
    const startMcpOauthLogin = vi.fn(async () => ({}));
    try {
      await manager.initialize();
      const session = makeAgentSessionStub({
        ...createFakeSession("oauth-session"),
        startMcpOauthLogin,
      });
      session.initializeTools.mockImplementationOnce(async () => {
        await initializationGate.promise;
      });
      backend.resumeSession.mockResolvedValueOnce(session);

      const login = manager.loginMcpServer(session.sessionId, "custom");
      await vi.waitFor(() => expect(session.initializeTools).toHaveBeenCalledOnce());

      expect(startMcpOauthLogin).not.toHaveBeenCalled();

      initializationGate.resolve();
      await expect(login).resolves.toEqual({
        serverName: "custom",
        servers: [],
      });
      expect(startMcpOauthLogin).toHaveBeenCalledOnce();
      expect(session.listMcpServers).toHaveBeenCalledOnce();
    } finally {
      initializationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("fails MCP OAuth instead of racing a timed-out session initialization", async () => {
    const { manager, backend, db } = createManager();
    const initializationGate = createDeferred<void>();
    const startMcpOauthLogin = vi.fn(async () => ({}));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.initialize();
      const session = makeAgentSessionStub({
        ...createFakeSession("oauth-timeout-session"),
        startMcpOauthLogin,
      });
      session.initializeTools.mockImplementationOnce(async () => {
        await initializationGate.promise;
      });
      backend.resumeSession.mockResolvedValueOnce(session);
      const testManager = manager as unknown as {
        sessionToolInitializationWaitTimeoutMs: number;
      };
      testManager.sessionToolInitializationWaitTimeoutMs = 1;

      await expect(manager.loginMcpServer(session.sessionId, "custom"))
        .rejects.toThrow("Session tool initialization did not complete before MCP authentication");

      expect(startMcpOauthLogin).not.toHaveBeenCalled();
      expect(session.listMcpServers).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        `[sdk] [${session.sessionId.slice(0, 8)}] Session tool initialization timed out after 1ms`,
      );
    } finally {
      initializationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("returns the reserved session ID before MCP-backed creation completes", async () => {
    const { manager, backend, db } = createManager();
    const creationGate = createDeferred<void>();
    try {
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async (config: any) => {
        await creationGate.promise;
        return createFakeSession(config.sessionId, config.tools ?? []);
      });

      const result = await manager.createSession({ background: true });

      expect(result.sessionId).toMatch(/[0-9a-f-]{36}/);
      expect(manager.isSessionWarm(result.sessionId)).toBe(false);

      creationGate.resolve();
      await vi.waitFor(() => expect(manager.isSessionWarm(result.sessionId)).toBe(true));
    } finally {
      creationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("warms a pending creation by reusing its handle instead of resuming the same ID", async () => {
    const { manager, backend, db } = createManager();
    const creationGate = createDeferred<void>();
    try {
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async (config: any) => {
        await creationGate.promise;
        return createFakeSession(config.sessionId, config.tools ?? []);
      });
      const { sessionId } = await manager.createSession({ background: true });
      const warming = manager.warmSession(sessionId);
      await flushMicrotasks();

      expect(backend.resumeSession).not.toHaveBeenCalled();
      expect(manager.isSessionWarm(sessionId)).toBe(false);

      creationGate.resolve();
      await expect(warming).resolves.toBeUndefined();
      expect(manager.isSessionWarm(sessionId)).toBe(true);
      expect(backend.createSession).toHaveBeenCalledOnce();
      expect(backend.resumeSession).not.toHaveBeenCalled();
    } finally {
      creationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("surfaces pending creation failures to warm without attempting a resume", async () => {
    const { manager, backend, db } = createManager();
    const creationGate = createDeferred<void>();
    const creationError = new Error("HydraFusion is unavailable");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async () => {
        await creationGate.promise;
        throw creationError;
      });
      const { sessionId } = await manager.createSession({ background: true });
      const warming = manager.warmSession(sessionId);
      const rejection = expect(warming).rejects.toBe(creationError);
      creationGate.resolve();

      await rejection;
      expect(backend.resumeSession).not.toHaveBeenCalled();
      expect(manager.isSessionWarm(sessionId)).toBe(false);
    } finally {
      creationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("keeps restart waiting on plain creation after an active run settles", async () => {
    const { manager, backend, db, runtimePaths } = createManager();
    const creationGate = createDeferred<void>();
    const activeSession = createControlledFakeSession("active-session");
    try {
      configureRestartStateStore(runtimePaths);
      forceClearRestartPending();
      await refreshRestartState();
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async (config: any) => {
        await creationGate.promise;
        return createFakeSession(config.sessionId, config.tools ?? []);
      });
      backend.resumeSession.mockResolvedValueOnce(activeSession.session);

      const { sessionId } = await manager.createSession({ background: true });
      manager.startWork(activeSession.session.sessionId, "hello");
      await vi.waitFor(() => {
        expect(manager.getActiveSessions()).toEqual([activeSession.session.sessionId]);
      });

      expect(manager.isSessionWarm(sessionId)).toBe(false);
      expect(manager.getRuntimeActivity().sessions.active).toBe(1);
      expect(manager.getLifecycleBlockingSessionCount()).toBe(2);
      expect(triggerRestartPendingForExternalRequest(manager.getLifecycleBlockingSessionCount())).toBe(2);
      expect(getRestartWaitingCount()).toBe(2);
      expect(isRestartImminent()).toBe(false);

      activeSession.releaseSend();
      await flushMicrotasks();
      activeSession.emit({
        type: "session.idle",
        data: {},
        timestamp: new Date().toISOString(),
      });
      await flushMicrotasks();
      await vi.waitFor(() => expect(getRestartWaitingCount()).toBe(1));

      expect(manager.getActiveSessions()).toEqual([]);
      expect(manager.getRuntimeActivity().sessions.active).toBe(0);
      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);
      expect(isRestartImminent()).toBe(false);

      creationGate.resolve();
      await flushMicrotasks();
      await vi.waitFor(() => expect(getRestartWaitingCount()).toBe(0));

      expect(manager.isSessionWarm(sessionId)).toBe(true);
      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
      expect(isRestartImminent()).toBe(true);
    } finally {
      activeSession.releaseSend();
      creationGate.resolve();
      forceClearRestartPending();
      await refreshRestartState();
      await manager.gracefulShutdown();
      configureRestartStateStore(undefined);
      db.close();
    }
  });

  it("releases restart waiting and task links when background task creation fails", async () => {
    const { manager, backend, db, runtimePaths, taskStore } = createManager();
    const creationGate = createDeferred<void>();
    const creationError = new Error("Task MCP initialization failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      configureRestartStateStore(runtimePaths);
      forceClearRestartPending();
      await refreshRestartState();
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async (config: any) => {
        await creationGate.promise;
        return createFakeSession(config.sessionId, config.tools ?? []);
      });

      const { sessionId } = await manager.createTaskSession(
        "task-1",
        "Task one",
        [],
        [],
        "",
        undefined,
        undefined,
        undefined,
        { background: true },
      );
      taskStore.listTasks.mockReturnValue([{ id: "task-1", sessionIds: [sessionId] }]);

      expect(manager.getActiveSessions()).toEqual([]);
      expect(manager.getRuntimeActivity().sessions.active).toBe(0);
      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);
      expect(triggerRestartPendingForExternalRequest(manager.getLifecycleBlockingSessionCount())).toBe(1);
      expect(getRestartWaitingCount()).toBe(1);
      expect(isRestartImminent()).toBe(false);

      creationGate.reject(creationError);
      await flushMicrotasks();
      await vi.waitFor(() => expect(manager.getLifecycleBlockingSessionCount()).toBe(0));
      await vi.waitFor(() => expect(getRestartWaitingCount()).toBe(0));
      await vi.waitFor(() => expect(taskStore.unlinkSession).toHaveBeenCalledWith("task-1", sessionId));

      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
      expect(manager.isSessionWarm(sessionId)).toBe(false);
      expect(isRestartImminent()).toBe(true);
      expect(consoleError).toHaveBeenCalledWith(
        `[sdk] Session ${sessionId} creation failed:`,
        creationError.message,
      );
    } finally {
      creationGate.reject(creationError);
      forceClearRestartPending();
      await refreshRestartState();
      await manager.gracefulShutdown();
      configureRestartStateStore(undefined);
      db.close();
    }
  });

  it("releases creation capacity once the session is cached", async () => {
    const { manager, backend, db } = createManager();
    const warmupGate = createDeferred<void>();
    try {
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async (config: any) => {
        const session = createFakeSession(config.sessionId, config.tools ?? []);
        session.initializeTools.mockImplementationOnce(async () => {
          await warmupGate.promise;
          return undefined;
        });
        return session;
      });

      const { sessionId } = await manager.createSession({ background: true });
      await vi.waitFor(() => expect(manager.isSessionWarm(sessionId)).toBe(true));

      expect(manager.getRuntimeActivity().capacity.contexts.retained).toBe(1);

      warmupGate.resolve();
      await manager.deleteSession(sessionId);
    } finally {
      warmupGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("queues the first prompt behind pending creation without resuming the session", async () => {
    const { manager, backend, db } = createManager();
    const creationGate = createDeferred<void>();
    try {
      await manager.initialize();
      const session = createInteractiveFakeSession("placeholder");
      backend.createSession.mockImplementationOnce(async (config: any) => {
        await creationGate.promise;
        return { ...session, sessionId: config.sessionId };
      });

      const { sessionId } = await manager.createSession({ background: true });
      const accepted = manager.startWorkAndWaitForDelivery(sessionId, "hello");
      await Promise.resolve();

      expect(session.send).not.toHaveBeenCalled();
      expect(backend.resumeSession).not.toHaveBeenCalled();

      creationGate.resolve();
      await expect(accepted).resolves.toBeUndefined();
      expect(session.send).toHaveBeenCalledOnce();
      expect(backend.resumeSession).not.toHaveBeenCalled();
    } finally {
      creationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("surfaces pending creation failures to the queued first prompt", async () => {
    const { manager, backend, db } = createManager();
    const creationGate = createDeferred<void>();
    const creationError = new Error("MCP initialization failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async () => {
        await creationGate.promise;
        throw creationError;
      });

      const { sessionId } = await manager.createSession({ background: true });
      const accepted = manager.startWorkAndWaitForDelivery(sessionId, "hello");
      creationGate.resolve();

      await expect(accepted).rejects.toThrow(creationError.message);
      expect(manager.isSessionWarm(sessionId)).toBe(false);
      expect(backend.resumeSession).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        `[sdk] Session ${sessionId} creation failed:`,
        creationError.message,
      );
    } finally {
      creationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("does not retain a session that finishes creating during shutdown", async () => {
    const { manager, backend, db } = createManager();
    const creationGate = createDeferred<void>();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let shutdownCompleted = false;
    try {
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async (config: any) => {
        await creationGate.promise;
        return createFakeSession(config.sessionId, config.tools ?? []);
      });

      const { sessionId } = await manager.createSession({ background: true });
      expect(manager.getActiveSessions()).toEqual([]);
      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);

      const shutdown = manager.gracefulShutdown().then(() => {
        shutdownCompleted = true;
      });
      await Promise.resolve();
      expect(shutdownCompleted).toBe(false);

      creationGate.resolve();
      await shutdown;

      expect(manager.isSessionWarm(sessionId)).toBe(false);
      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
      expect(backend.deleteSession).toHaveBeenCalledWith(sessionId);
    } finally {
      creationGate.resolve();
      if (!shutdownCompleted) await manager.gracefulShutdown();
      db.close();
    }
  });

  it("drains synchronous session creation during shutdown", async () => {
    const { manager, backend, db } = createManager();
    const creationGate = createDeferred<void>();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let shutdownCompleted = false;
    try {
      await manager.initialize();
      backend.createSession.mockImplementationOnce(async (config: any) => {
        await creationGate.promise;
        return createFakeSession(config.sessionId, config.tools ?? []);
      });

      const creation = manager.createSession();
      await vi.waitFor(() => expect(backend.createSession).toHaveBeenCalledOnce());
      const shutdown = manager.gracefulShutdown();
      creationGate.resolve();

      await expect(creation).rejects.toThrow("shut down before session creation completed");
      await shutdown;
      shutdownCompleted = true;
    } finally {
      creationGate.resolve();
      if (!shutdownCompleted) await manager.gracefulShutdown();
      db.close();
    }
  });

  it("blocks new work while deleting a session that is still creating", async () => {
    const { manager, backend, db } = createManager();
    const creationGate = createDeferred<void>();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await manager.initialize();
      const session = createInteractiveFakeSession("placeholder");
      backend.createSession.mockImplementationOnce(async (config: any) => {
        await creationGate.promise;
        return { ...session, sessionId: config.sessionId };
      });

      const { sessionId } = await manager.createSession({ background: true });
      const deleting = manager.deleteSession(sessionId);

      expect(() => manager.startWork(sessionId, "should not run")).toThrow("Session is being deleted");
      await expect(manager.warmSession(sessionId)).rejects.toThrow("Session is being deleted");

      creationGate.resolve();
      await deleting;
      expect(session.send).not.toHaveBeenCalled();
      expect(backend.deleteSession).toHaveBeenCalledWith(sessionId);
    } finally {
      creationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("keeps native Bridge tools in resume configs", async () => {
    const { manager, backend, db } = createManager();
    try {
      await manager.initialize();
      await manager.warmSession("existing-session");

      const config = backend.resumeSession.mock.calls[0][1] as any;
      expect(config.tools.map((tool: any) => tool.name).sort()).toEqual([
        "global_bridge_tool",
        "session_bridge_tool",
      ]);
      expect(config.mcpServers.custom).toEqual({ command: "custom-mcp", args: [] });
      expect(config.mcpServers[EXTRA_MCP_SERVER_NAME]).toEqual({ command: "node", args: ["extra-mcp.js"] });
      expect(config.mcpServers["bridge-tools"]).toBeUndefined();
      expect(config.mcpServers["bridge-tools-session"]).toBeUndefined();
      expect(config.model).toBeUndefined();
      expect(config.reasoningEffort).toBeUndefined();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("caches a forked session and releases resume cleanup exactly once", async () => {
    const { manager, backend, db } = createManager();
    try {
      await manager.initialize();
      const forkedSession = createFakeSession("forked-session");
      backend.resumeSession.mockResolvedValueOnce(forkedSession);
      const endSessionResume = vi.spyOn(manager as any, "endSessionResume");
      const flushPendingSessionEviction = vi.spyOn(manager as any, "flushPendingSessionEviction");

      await expect(manager.forkSession("source-session")).resolves.toEqual({
        sessionId: "forked-session",
      });
      await Promise.resolve();

      expect(manager.isSessionWarm("forked-session")).toBe(true);
      expect(forkedSession.initializeTools).not.toHaveBeenCalled();
      expect(forkedSession.listMcpServers).not.toHaveBeenCalled();
      expect(endSessionResume).toHaveBeenCalledTimes(1);
      expect(flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("holds the restart lifecycle block through fork finalization", async () => {
    const { manager, db } = createManager();
    const finalizerGate = createDeferred<void>();
    try {
      await manager.initialize();
      const finalizer = vi.fn(() => finalizerGate.promise);

      const forking = manager.forkSessionWithFinalizer("source-session", {}, finalizer);
      await vi.waitFor(() => expect(finalizer).toHaveBeenCalledWith({ sessionId: "forked-session" }));

      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);
      finalizerGate.resolve();
      await expect(forking).resolves.toEqual({ sessionId: "forked-session" });
      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    } finally {
      finalizerGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("preserves fork success without starting MCP initialization", async () => {
    const { manager, backend, db } = createManager();
    const resumeGate = createDeferred<ReturnType<typeof createFakeSession>>();
    let settled = false;
    try {
      await manager.initialize();
      vi.useFakeTimers();
      const forkedSession = createFakeSession("forked-session");
      backend.resumeSession.mockImplementationOnce(() => resumeGate.promise);
      const endSessionResume = vi.spyOn(manager as any, "endSessionResume");
      const flushPendingSessionEviction = vi.spyOn(manager as any, "flushPendingSessionEviction");

      const forking = manager.forkSession("source-session");
      void forking.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);

      resumeGate.resolve(forkedSession);
      await expect(forking).resolves.toEqual({ sessionId: "forked-session" });
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
      expect(forkedSession.initializeTools).not.toHaveBeenCalled();
      expect(forkedSession.listMcpServers).not.toHaveBeenCalled();
      expect(endSessionResume).toHaveBeenCalledTimes(1);
      expect(flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      resumeGate.resolve(createFakeSession("forked-session"));
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("deletes a failed fork and releases resume cleanup exactly once", async () => {
    const { manager, backend, db } = createManager();
    const resumeError = new Error("fork resume failed");
    try {
      await manager.initialize();
      backend.resumeSession.mockRejectedValueOnce(resumeError);
      const endSessionResume = vi.spyOn(manager as any, "endSessionResume");
      const flushPendingSessionEviction = vi.spyOn(manager as any, "flushPendingSessionEviction");

      await expect(manager.forkSession("source-session")).rejects.toBe(resumeError);

      expect(backend.deleteSession).toHaveBeenCalledTimes(1);
      expect(backend.deleteSession).toHaveBeenCalledWith("forked-session");
      expect(endSessionResume).toHaveBeenCalledTimes(1);
      expect(flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });
});
