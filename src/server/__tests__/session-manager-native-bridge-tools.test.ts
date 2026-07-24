import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { SessionManager } from "../session-manager.js";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { createTestBus, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

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
  return {
    sessionId,
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    on: vi.fn((_handler: (event: any) => void) => () => undefined),
    getEvents: vi.fn(async () => []),
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
  };
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createBridgeToolServer() {
  const server = new BridgeToolsMcpServer({} as any);
  server.registerTool({
    name: "global_bridge_tool",
    description: "Global Bridge tool",
    inputSchema: { type: "object", properties: {} },
    handler: async () => "global",
  });
  server.registerTool({
    name: "session_bridge_tool",
    description: "Session Bridge tool",
    inputSchema: { type: "object", properties: {} },
    scope: "session",
    handler: async () => "session",
  });
  server.registerTool({
    name: "report_intent",
    description: "Excluded Bridge tool",
    inputSchema: { type: "object", properties: {} },
    handler: async () => "excluded",
  });
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
    deleteSession: vi.fn(async () => undefined),
    getSessionMetadata: vi.fn(async () => ({})),
  };
  const manager = new SessionManager({
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: {
      findTaskBySessionId: vi.fn().mockReturnValue(null),
    } as any,
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

  return { manager, backend, db };
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
      await vi.waitFor(async () => {
        expect((await backend.createSession.mock.results[0].value).initializeTools).toHaveBeenCalledOnce();
      });
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("serializes resumed-session MCP probing behind native tool initialization without blocking warmup", async () => {
    const { manager, backend, db } = createManager();
    const initializationGate = createDeferred<void>();
    const callOrder: string[] = [];
    try {
      await manager.initialize();
      const session = createFakeSession("resumed-session");
      session.initializeTools.mockImplementationOnce(async () => {
        callOrder.push("initialize:start");
        await initializationGate.promise;
        callOrder.push("initialize:end");
      });
      session.listMcpServers.mockImplementationOnce(async () => {
        callOrder.push("mcp:list");
        return { servers: [] };
      });
      backend.resumeSession.mockResolvedValueOnce(session);

      await expect(manager.warmSession(session.sessionId)).resolves.toBeUndefined();

      expect(session.initializeTools).toHaveBeenCalledOnce();
      expect(session.listMcpServers).not.toHaveBeenCalled();

      initializationGate.resolve();
      await vi.waitFor(() => expect(session.listMcpServers).toHaveBeenCalledOnce());
      expect(callOrder).toEqual(["initialize:start", "initialize:end", "mcp:list"]);
    } finally {
      initializationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("initializes each successive cached session once", async () => {
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
        evictCachedSession(
          sessionId: string,
          expectedSession: typeof firstSession,
          reason: string,
        ): Promise<unknown>;
      };

      await sessionCache.cacheResumedSession(firstSession.sessionId, firstSession, { mcpServers: {} });
      await vi.waitFor(() => expect(firstSession.initializeTools).toHaveBeenCalledOnce());

      await sessionCache.evictCachedSession(
        firstSession.sessionId,
        firstSession,
        "test replacement",
      );
      await sessionCache.cacheResumedSession(secondSession.sessionId, secondSession, { mcpServers: {} });
      await vi.waitFor(() => expect(secondSession.initializeTools).toHaveBeenCalledOnce());

      expect(firstSession.initializeTools).toHaveBeenCalledOnce();
      expect(secondSession.initializeTools).toHaveBeenCalledOnce();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("does not publish an MCP probe from a superseded session", async () => {
    const { manager, backend, db } = createManager();
    const initializationGate = createDeferred<void>();
    try {
      await manager.initialize();
      const firstSession = createFakeSession("superseded-probe-session");
      const secondSession = createFakeSession("superseded-probe-session");
      firstSession.initializeTools.mockImplementationOnce(async () => {
        await initializationGate.promise;
      });
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
        probeMcpStatus(sessionId: string, session: typeof secondSession): void;
      };
      await sessionCache.evictCachedSession(
        firstSession.sessionId,
        firstSession,
        "test replacement",
      );
      await sessionCache.cacheResumedSession(secondSession.sessionId, secondSession, { mcpServers: {} });
      sessionCache.probeMcpStatus(secondSession.sessionId, secondSession);

      initializationGate.resolve();
      await vi.waitFor(() => expect(secondSession.listMcpServers).toHaveBeenCalledOnce());

      expect(firstSession.listMcpServers).not.toHaveBeenCalled();
      expect(await manager.getMcpStatus(secondSession.sessionId)).toEqual([
        { name: "current", status: "connected" },
      ]);
    } finally {
      initializationGate.resolve();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("logs a failed resumed-session initialization once before probing", async () => {
    const { manager, backend, db } = createManager();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.initialize();
      const session = createFakeSession("failed-initialization-session");
      session.initializeTools.mockRejectedValueOnce(new Error("initialization failed"));
      backend.resumeSession.mockResolvedValueOnce(session);

      await manager.warmSession(session.sessionId);
      await vi.waitFor(() => expect(session.listMcpServers).toHaveBeenCalledOnce());

      expect(session.initializeTools).toHaveBeenCalledOnce();
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
      const session = {
        ...createFakeSession("oauth-session"),
        startMcpOauthLogin,
      };
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
      const session = {
        ...createFakeSession("oauth-timeout-session"),
        startMcpOauthLogin,
      };
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
      const shutdown = manager.gracefulShutdown();
      creationGate.resolve();
      await shutdown;
      shutdownCompleted = true;

      expect(manager.isSessionWarm(sessionId)).toBe(false);
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
});
