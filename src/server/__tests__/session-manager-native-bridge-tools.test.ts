import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTelemetryStore } from "../telemetry-store.js";
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
  let eventHandler: ((event: any) => void) | undefined;
  return {
    sessionId,
    send: vi.fn(async () => {
      eventHandler?.({
        type: "session.idle",
        data: {},
        timestamp: new Date().toISOString(),
      });
    }),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    on: vi.fn((handler: (event: any) => void) => {
      eventHandler = handler;
      return () => undefined;
    }),
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
    listMcpServers: vi.fn(async () => ({ servers: [] })),
  };
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
  const telemetryStore = createTelemetryStore(db);
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
    telemetryStore,
    clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
    createBackend: vi.fn(() => backend as any),
    runtimePaths,
    copilotHome: runtimePaths.copilotHome,
  });

  return { manager, backend, db, telemetryStore };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionManager native Bridge tools", () => {
  it("keeps native tools configured while create and first send proceed before background warmup", async () => {
    const { manager, backend, db, telemetryStore } = createManager();
    let releaseWarmup!: () => void;
    const warmupPending = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    backend.createSession.mockImplementation(async (config: any) => {
      const session = createFakeSession(config.sessionId ?? "created-session", config.tools ?? []);
      session.initializeTools.mockImplementation(async () => {
        await warmupPending;
        return undefined;
      });
      return session;
    });
    try {
      await manager.initialize();
      const result = await manager.createSession();

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
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.initializeTools).toHaveBeenCalledOnce();
      expect(session.getCurrentToolMetadata).not.toHaveBeenCalled();
      expect((manager as any).nativeToolWarmups.size).toBe(1);
      expect((manager as any).scheduleNativeBridgeToolWarmup(result.sessionId, session)).toBe(true);
      expect(session.initializeTools).toHaveBeenCalledOnce();

      manager.startWork(result.sessionId, "use the configured native tools");
      await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
      expect(session.getCurrentToolMetadata).not.toHaveBeenCalled();

      releaseWarmup();
      await vi.waitFor(() => expect(session.getCurrentToolMetadata).toHaveBeenCalledOnce());
      expect((manager as any).nativeToolWarmups.size).toBe(0);
      expect(telemetryStore.querySpans({ name: "session.create.sdk" })).toHaveLength(1);
      expect(telemetryStore.querySpans({ name: "session.create" })).toHaveLength(1);
      expect(telemetryStore.querySpans({ name: "session.nativeTools.warmup" })[0]?.metadata)
        .toMatchObject({ outcome: "ready" });
    } finally {
      releaseWarmup();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("times out a stuck warmup and releases its session protection", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { manager, backend, db, telemetryStore } = createManager();
    let releaseWarmup!: () => void;
    const warmupPending = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    backend.createSession.mockImplementation(async (config: any) => {
      const session = createFakeSession(config.sessionId ?? "created-session", config.tools ?? []);
      session.initializeTools.mockImplementation(async () => {
        await warmupPending;
        return undefined;
      });
      return session;
    });
    try {
      await manager.initialize();
      const result = await manager.createSession();

      await vi.advanceTimersByTimeAsync(0);
      const session = await backend.createSession.mock.results[0].value;
      expect(session.initializeTools).toHaveBeenCalledOnce();
      expect((manager as any).nativeToolWarmups.size).toBe(1);

      await vi.advanceTimersByTimeAsync(15_000);

      expect((manager as any).nativeToolWarmups.size).toBe(0);
      expect(manager.isSessionWarm(result.sessionId)).toBe(true);
      expect(telemetryStore.querySpans({ name: "session.nativeTools.warmup" })[0]?.metadata)
        .toMatchObject({ outcome: "timed-out", timeoutMs: 15_000 });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Native Bridge tool warmup timed out"),
      );
      releaseWarmup();
      await Promise.resolve();
      expect(session.getCurrentToolMetadata).not.toHaveBeenCalled();
    } finally {
      releaseWarmup();
      vi.useRealTimers();
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("cancels warmup tracking during shutdown without continuing metadata work", async () => {
    const { manager, backend, db, telemetryStore } = createManager();
    let releaseWarmup!: () => void;
    const warmupPending = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    backend.createSession.mockImplementation(async (config: any) => {
      const session = createFakeSession(config.sessionId ?? "created-session", config.tools ?? []);
      session.initializeTools.mockImplementation(async () => {
        await warmupPending;
        return undefined;
      });
      return session;
    });
    try {
      await manager.initialize();
      await manager.createSession();
      const session = await backend.createSession.mock.results[0].value;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.initializeTools).toHaveBeenCalledOnce();
      expect((manager as any).nativeToolWarmups.size).toBe(1);

      await manager.gracefulShutdown();

      expect((manager as any).nativeToolWarmups.size).toBe(0);
      releaseWarmup();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.getCurrentToolMetadata).not.toHaveBeenCalled();
      expect(telemetryStore.querySpans({ name: "session.nativeTools.warmup" })).toHaveLength(0);
    } finally {
      releaseWarmup();
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
