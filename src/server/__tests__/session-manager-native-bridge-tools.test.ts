import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { SessionManager } from "../session-manager.js";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { BRIDGE_TOOLS_MCP_SERVER_NAME } from "../agent-tools-mcp/endpoint.js";
import { createTestBus, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

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
    on: vi.fn(() => () => undefined),
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
      [BRIDGE_TOOLS_MCP_SERVER_NAME]: { command: "node", args: ["bridge-mcp.js"], tools: ["global_bridge_tool"] },
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
  it("promotes Bridge tools as canonical native tools and suppresses Bridge MCP on create", async () => {
    const { manager, backend, db } = createManager();
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
      expect(config.mcpServers[BRIDGE_TOOLS_MCP_SERVER_NAME]).toBeUndefined();
      expect((await backend.createSession.mock.results[0].value).initializeTools).toHaveBeenCalledOnce();
    } finally {
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
      expect(config.mcpServers[BRIDGE_TOOLS_MCP_SERVER_NAME]).toBeUndefined();
      expect(config.model).toBeUndefined();
      expect(config.reasoningEffort).toBeUndefined();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });
});
