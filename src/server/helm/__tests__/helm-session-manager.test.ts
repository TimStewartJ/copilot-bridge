import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeToolsMcpServer } from "../../agent-tools-mcp/server.js";
import { defineBridgeTool } from "../../agent-tools-mcp/adapter.js";
import { createEventBusRegistry } from "../../event-bus.js";
import { createSessionTitlesStore } from "../../session-titles.js";
import type { SessionConfigBuilderDeps } from "../../session-config-builder.js";
import { SessionManager, type SessionConfigProfile, type SessionManagerDeps } from "../../session-manager.js";
import { createTestBus, makeAgentSessionStub, makeTestRuntimePaths, setupTestDb } from "../../__tests__/helpers.js";
import { applyHelmSessionProfile } from "../helm-session-profile.js";

const HELM_TOOLS = [
  defineBridgeTool("bridge_overview", { description: "Overview", handler: async () => "ok" }),
  defineBridgeTool("task_list", { description: "Tasks", handler: async () => "ok" }),
];

const MODEL = "gpt-5.6-luna";

function createFakeSession(sessionId: string, tools: Array<{ name: string }>, reasoningEffort?: string) {
  const handlers = new Set<(event: any) => void>();
  const current = { modelId: MODEL, reasoningEffort };
  const calls: string[] = [];
  return makeAgentSessionStub({
    sessionId,
    calls,
    getCurrentModel: vi.fn(async () => ({ ...current })),
    setModel: vi.fn(async (_model: string, options?: { reasoningEffort?: string }) => {
      calls.push(`setModel:${options?.reasoningEffort}`);
      current.reasoningEffort = options?.reasoningEffort;
      return undefined;
    }),
    send: vi.fn(async () => {
      calls.push("send");
      const timestamp = new Date().toISOString();
      for (const handler of handlers) handler({ type: "user.message", data: {}, timestamp });
      for (const handler of handlers) handler({ type: "session.idle", data: {}, timestamp });
    }),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    on: vi.fn((handler: (event: any) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    initializeTools: vi.fn(async () => undefined),
    getCurrentToolMetadata: vi.fn(async () => ({
      tools: tools.map((tool) => ({ name: tool.name, description: "", input_schema: {}, deferLoading: false })),
    })),
    listMcpServers: vi.fn(async () => ({ servers: [] })),
  });
}

function createManager(
  helmSessionIds: Set<string>,
  options: { supportedEfforts?: string[]; defaultTurnEffort?: () => string | undefined; computerUsePluginDirectory?: string } = {},
) {
  const db = setupTestDb();
  const runtimePaths = makeTestRuntimePaths("helm-session-manager");
  const bridgeToolsMcpServer = new BridgeToolsMcpServer({} as any);
  bridgeToolsMcpServer.registerTool(defineBridgeTool("staging_deploy", { description: "Deploys", handler: async () => "deployed" }));
  bridgeToolsMcpServer.registerTool(HELM_TOOLS[1]!);
  const backend = {
    id: "copilot" as const,
    capabilities: {
      resumeSession: true, streamingToolInput: true, costUsage: true, subAgents: true, images: true, bidirectionalStdin: false,
      externalToolEvents: true, forkBoundaries: true, nativeBridgeTools: true, eagerNativeTools: true, toolMetadataWarmup: true,
    },
    permissionPolicy: undefined,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    forceStop: vi.fn(async () => undefined),
    listModels: vi.fn(async () => [{ id: MODEL, name: "Luna", supportedReasoningEfforts: options.supportedEfforts ?? ["none", "low", "medium", "high", "xhigh", "max"] }]),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async (config: any) => createFakeSession(config.sessionId, config.tools ?? [], config.reasoningEffort)),
    resumeSession: vi.fn(async (sessionId: string, config: any) => createFakeSession(sessionId, config.tools ?? [], "max")),
    forkSession: vi.fn(async () => ({ sessionId: "forked" })),
    deleteSession: vi.fn(async () => undefined),
    getSessionMetadata: vi.fn(async () => ({})),
  };
  const profile: SessionConfigProfile = {
    toolNames: HELM_TOOLS.map((tool) => tool.name),
    apply: (config) => applyHelmSessionProfile(config, { tools: HELM_TOOLS, workingDirectory: runtimePaths.dataDir, timeZone: "UTC" }),
    ...(options.defaultTurnEffort ? { defaultTurnReasoningEffort: options.defaultTurnEffort } : {}),
  };
  const onUserPrompt = vi.fn();
  // The manager hands its deps to the config builder, which is how the plugin resolver gets there.
  const deps: SessionManagerDeps & Pick<SessionConfigBuilderDeps, "resolveComputerUsePlugin"> = {
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: { findTaskBySessionId: vi.fn().mockReturnValue(null), getTask: vi.fn().mockReturnValue(null), listTasks: vi.fn().mockReturnValue([]), unlinkSession: vi.fn() } as any,
    config: { sessionMcpServers: { custom: { command: "custom-mcp", args: [] } } },
    bridgeToolsMcpServer,
    clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
    createBackend: vi.fn(() => backend as any),
    runtimePaths,
    copilotHome: runtimePaths.copilotHome,
    resolveSessionProfile: (sessionId) => (helmSessionIds.has(sessionId) ? profile : undefined),
    onUserPrompt,
    ...(options.computerUsePluginDirectory
      ? {
          settingsStore: {
            getSettings: () => ({ mcpServers: {}, computerUse: { enabled: true } }),
            getMcpServers: () => ({}),
          } as unknown as SessionManagerDeps["settingsStore"],
          resolveComputerUsePlugin: () => ({ available: true, pluginDirectory: options.computerUsePluginDirectory }),
        }
      : {}),
  };
  const manager = new SessionManager(deps);
  return { manager, backend, db, onUserPrompt };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SessionManager with the Helm profile", () => {
  it("builds a Helm conversation as Helm on create and leaves ordinary sessions alone", async () => {
    const helmId = crypto.randomUUID();
    const plainId = crypto.randomUUID();
    const { manager, backend, db } = createManager(new Set([helmId]));
    try {
      await manager.initialize();
      await manager.createSession({ expectedSessionId: helmId, model: "gpt-5.6-luna" });
      await manager.createSession({ expectedSessionId: plainId });

      const helmConfig = backend.createSession.mock.calls[0]![0];
      expect(helmConfig.sessionId).toBe(helmId);
      expect(helmConfig.model).toBe("gpt-5.6-luna");
      expect(helmConfig.systemMessage).toMatchObject({ mode: "replace" });
      expect(helmConfig.systemMessage.content).toContain("You are Helm");
      expect(helmConfig.tools.map((tool: { name: string }) => tool.name)).toEqual(["bridge_overview", "task_list"]);
      expect(helmConfig.availableTools).toEqual(["bridge_overview", "task_list"]);
      expect(helmConfig.mcpServers).toEqual({});
      expect(helmConfig.memory).toEqual({ enabled: false });

      const plainConfig = backend.createSession.mock.calls[1]![0];
      expect(plainConfig.systemMessage.mode).toBe("customize");
      expect(plainConfig.tools.map((tool: { name: string }) => tool.name)).toContain("staging_deploy");
      expect(plainConfig.availableTools).toBeUndefined();
      expect(Object.keys(plainConfig.mcpServers)).toContain("custom");
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("resumes a Helm conversation as Helm, never as a general-purpose session", async () => {
    const helmId = crypto.randomUUID();
    const { manager, backend, db } = createManager(new Set([helmId]));
    try {
      await manager.initialize();
      await manager.createSession({ expectedSessionId: helmId });
      await manager.evictAllCachedSessions();
      await manager.warmSession(helmId);

      expect(backend.resumeSession).toHaveBeenCalledTimes(1);
      const [resumedId, resumeConfig] = backend.resumeSession.mock.calls[0]!;
      expect(resumedId).toBe(helmId);
      expect(resumeConfig.systemMessage.content).toContain("You are Helm");
      expect(resumeConfig.availableTools).toEqual(["bridge_overview", "task_list"]);
      expect(resumeConfig.tools.map((tool: { name: string }) => tool.name)).not.toContain("staging_deploy");
      expect(resumeConfig.mcpServers).toEqual({});
      // Resume keeps trusting the session's persisted model.
      expect(resumeConfig.model).toBeUndefined();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("does not inherit capabilities ordinary sessions gain, such as the Computer Use plugin", async () => {
    const helmId = crypto.randomUUID();
    const plainId = crypto.randomUUID();
    const { manager, backend, db } = createManager(new Set([helmId]), { computerUsePluginDirectory: "/plugins/computer-use" });
    try {
      await manager.initialize();
      await manager.createSession({ expectedSessionId: plainId });
      await manager.createSession({ expectedSessionId: helmId });
      await manager.evictAllCachedSessions();
      await manager.warmSession(helmId);

      // The setting is on, and an ordinary session really does get mouse and keyboard control...
      expect(backend.createSession.mock.calls[0]![0].pluginDirectories).toEqual(["/plugins/computer-use"]);
      // ...but Helm gets it neither when it is created nor when it is resumed.
      expect(backend.createSession.mock.calls[1]![0].sessionId).toBe(helmId);
      expect(backend.createSession.mock.calls[1]![0].pluginDirectories).toBeUndefined();
      const [resumedId, resumeConfig] = backend.resumeSession.mock.calls.find(([sessionId]) => sessionId === helmId)!;
      expect(resumedId).toBe(helmId);
      expect(resumeConfig.pluginDirectories).toBeUndefined();
      expect(resumeConfig.systemMessage.content).toContain("You are Helm");
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("reports prompts the user authored, whatever route they took, but not application-generated ones", async () => {
    const helmId = crypto.randomUUID();
    const { manager, db, onUserPrompt } = createManager(new Set([helmId]));
    try {
      await manager.initialize();
      await manager.createSession({ expectedSessionId: helmId });

      await manager.startWorkAndWaitForDelivery(helmId, "[hands-free]\nwhat's new?", undefined, { displayPrompt: "what's new?" });
      await vi.waitFor(() => expect(manager.isSessionBusy(helmId)).toBe(false));
      expect(onUserPrompt).toHaveBeenCalledTimes(1);
      expect(onUserPrompt).toHaveBeenLastCalledWith(helmId);

      await manager.startWorkAndWaitForDelivery(helmId, "[hands-free]\n[Bridge update to mention briefly:]\nSession finished.", undefined, { promptSource: "system" });
      await vi.waitFor(() => expect(manager.isSessionBusy(helmId)).toBe(false));
      expect(onUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("thinks at the typed effort by default and at the effort a spoken turn asks for, switching only when the mode changes", async () => {
    const helmId = crypto.randomUUID();
    const { manager, backend, db } = createManager(new Set([helmId]), { defaultTurnEffort: () => "max" });
    const turn = async (prompt: string, options?: { reasoningEffort?: string }) => {
      await manager.startWorkAndWaitForDelivery(helmId, prompt, undefined, options);
      await vi.waitFor(() => expect(manager.isSessionBusy(helmId)).toBe(false));
    };
    try {
      await manager.initialize();
      await manager.createSession({ expectedSessionId: helmId, model: MODEL, reasoningEffort: "max" });
      const session = await backend.createSession.mock.results[0]!.value;

      await turn("typed: already at max, nothing to switch");
      await turn("typed again");
      expect(session.calls).toEqual(["send", "send"]);
      // One look at the live model, then the steady state costs no RPC at all.
      expect(session.getCurrentModel).toHaveBeenCalledTimes(1);

      await turn("[hands-free]\nwhat's new?", { reasoningEffort: "xhigh" });
      await turn("[hands-free]\nand the tasks?", { reasoningEffort: "xhigh" });
      await turn("typed once more");
      // The switch lands before the prompt it is for, and only when the mode actually changed.
      expect(session.calls).toEqual(["send", "send", "setModel:xhigh", "send", "send", "setModel:max", "send"]);
      expect(session.setModel).toHaveBeenLastCalledWith(MODEL, { reasoningEffort: "max" });
      expect((await manager.getSessionModelState(helmId)).reasoningEffort).toBe("max");
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("falls back to the nearest effort the model has, and never fails a turn over it", async () => {
    const helmId = crypto.randomUUID();
    const { manager, backend, db } = createManager(new Set([helmId]), { supportedEfforts: ["low", "medium", "high"], defaultTurnEffort: () => "max" });
    try {
      await manager.initialize();
      await manager.createSession({ expectedSessionId: helmId, model: MODEL, reasoningEffort: "low" });
      const session = await backend.createSession.mock.results[0]!.value;

      await manager.startWorkAndWaitForDelivery(helmId, "typed");
      await vi.waitFor(() => expect(manager.isSessionBusy(helmId)).toBe(false));
      expect(session.calls).toEqual(["setModel:high", "send"]);

      session.setModel.mockRejectedValueOnce(new Error("model switch unavailable"));
      await manager.startWorkAndWaitForDelivery(helmId, "[hands-free]\nhello", undefined, { reasoningEffort: "none" });
      await vi.waitFor(() => expect(manager.isSessionBusy(helmId)).toBe(false));
      expect(session.calls).toEqual(["setModel:high", "send", "send"]);
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });

  it("leaves ordinary sessions at whatever effort they have", async () => {
    const plainId = crypto.randomUUID();
    const { manager, backend, db } = createManager(new Set(), { defaultTurnEffort: () => "max" });
    try {
      await manager.initialize();
      await manager.createSession({ expectedSessionId: plainId });
      const session = await backend.createSession.mock.results[0]!.value;
      await manager.startWorkAndWaitForDelivery(plainId, "hello");
      await vi.waitFor(() => expect(manager.isSessionBusy(plainId)).toBe(false));
      expect(session.calls).toEqual(["send"]);
      expect(session.getCurrentModel).not.toHaveBeenCalled();
    } finally {
      await manager.gracefulShutdown();
      db.close();
    }
  });
});
