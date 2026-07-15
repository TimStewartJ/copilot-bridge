import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRestartState, writeRestartState } from "../restart-state.js";
import {
  clearRestartPending,
  SessionManager,
  RESTART_PENDING_MESSAGE,
  configureRestartStateStore,
  getRestartWaitingCount,
  isRestartImminent,
  isRestartPending,
  refreshRestartState,
  triggerRestartPending,
} from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createSessionContextStore } from "../session-context-store.js";
import type { TelemetryStore } from "../telemetry-store.js";
import type { RuntimePaths } from "../runtime-paths.js";
import { setupTestDb, createTestBus, makeTestDir, makeTestRuntimePaths } from "./helpers.js";

describe("SessionManager run state", () => {
  function createManager(opts: { copilotHome?: string; runtimePaths?: RuntimePaths; telemetry?: boolean } = {}) {
    const db = setupTestDb();
    const telemetryStore = opts.telemetry ? createTelemetryStore(db) : undefined;
    const sessionContextStore = createSessionContextStore(db);
    const globalBus = createTestBus();
    const eventBusRegistry = createEventBusRegistry();
    const runtimePaths = opts.runtimePaths ?? makeTestRuntimePaths(
      "run-state-manager",
      opts.copilotHome ? { copilotHome: opts.copilotHome } : {},
    );
    const copilotHome = opts.copilotHome ?? runtimePaths.copilotHome;
    configureRestartStateStore(runtimePaths);
    const sessionMetaStore = createSessionMetaStore(db);
    const manager = new SessionManager({
      globalBus,
      eventBusRegistry,
      sessionTitles: createSessionTitlesStore(db),
      sessionMetaStore,
      taskStore: {
        findTaskBySessionId: vi.fn().mockReturnValue(null),
      } as any,
      settingsStore: {
        getMcpServers: () => ({}),
        getSettings: () => ({ mcpServers: {} }),
      } as any,
      config: { sessionMcpServers: {} },
      telemetryStore,
      sessionContextStore,
      clientEnv: runtimePaths.env,
      copilotHome,
      runtimePaths,
    }) as any;

    return { manager, globalBus, eventBusRegistry, db, telemetryStore, sessionContextStore, sessionMetaStore };
  }

  function makeSession(opts: { replayOnSubscribe?: any | (() => any) } = {}) {
    const handlers: Array<(event: any) => void> = [];
    let releaseSend: (() => void) | undefined;
    const session = {
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((cb: (event: any) => void) => {
        handlers.push(cb);
        if (opts.replayOnSubscribe) {
          const replayed = typeof opts.replayOnSubscribe === "function"
            ? opts.replayOnSubscribe()
            : opts.replayOnSubscribe;
          cb(replayed);
        }
        return vi.fn(() => {
          const idx = handlers.indexOf(cb);
          if (idx !== -1) handlers.splice(idx, 1);
        });
      }),
      send: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
      }),
      invokeSlashCommand: vi.fn(),
      listSlashCommands: vi.fn(),
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const getHandler = () => {
      if (handlers.length === 0) return undefined;
      return (event: any) => {
        for (const handler of [...handlers]) {
          handler(event);
        }
      };
    };
    const getReleaseSend = () => releaseSend;
    return { session, getHandler, getReleaseSend };
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  function latestSpanMetadata(telemetryStore: TelemetryStore | undefined, name: string, sessionId: string): Record<string, unknown> {
    expect(telemetryStore).toBeDefined();
    const [span] = telemetryStore!.querySpans({ name, sessionId, limit: 10 });
    expect(span).toBeDefined();
    return span.metadata ?? {};
  }

  async function waitForRestartPhase(filePath: string, phase: "idle" | "queued" | "waiting-for-sessions" | "restarting") {
    for (let i = 0; i < 50; i++) {
      if ((await readRestartState(filePath)).phase === phase) return;
      await flushMicrotasks();
    }
    throw new Error(`Timed out waiting for restart state ${phase} at ${filePath}`);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    configureRestartStateStore(undefined);
    vi.useRealTimers();
  });

  it("allows startWork while persisted restart state is active and updates waiting sessions", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-run-state-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-"));
    try {
      const { manager } = createManager({
        copilotHome,
      });
      const { session, getHandler, getReleaseSend } = makeSession();
      manager.backend = {
        resumeSession: vi.fn().mockResolvedValue(session),
      };

      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });
      await writeRestartState(join(dataDir, "restart-state.json"), {
        requestId: "req-run-state",
        phase: "waiting-for-sessions",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 2,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();

      expect(() => manager.startWork("session-1", "hello")).not.toThrow();
      await flushMicrotasks();

      expect(manager.backend.resumeSession).toHaveBeenCalled();
      expect(manager.backend.resumeSession.mock.calls[0]?.[0]).toBe("session-1");
      expect(manager.getSessionRunState("session-1")).toBe("busy");
      expect(getRestartWaitingCount()).toBe(1);

      getReleaseSend()?.();
      await flushMicrotasks();
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      await flushMicrotasks();
      expect(manager.getSessionRunState("session-1")).toBe("idle");
      expect(getRestartWaitingCount()).toBe(0);
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("sends steering prompts immediately through the active cached session", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();

    session.send.mockResolvedValueOnce(undefined);
    await manager.steerSession("session-1", "please adjust");

    expect(session.send).toHaveBeenLastCalledWith({
      prompt: "please adjust",
      mode: "immediate",
    });
    const bus = eventBusRegistry.getBus("session-1");
    expect(bus?.getSnapshot().pendingPrompt).toBe("please adjust");

    getHandler()?.({
      type: "user.message",
      data: { content: "hello" },
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    expect(bus?.getSnapshot().pendingPrompt).toBe("please adjust");

    getHandler()?.({
      type: "user.message",
      data: { content: "please adjust" },
      timestamp: "2026-04-24T12:00:01.000Z",
    });
    expect(bus?.getSnapshot().pendingPrompt).toBeUndefined();
  });

  it("sets the SDK session mode before sending normal work", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello", undefined, { mode: "autopilot" });
    await flushMicrotasks();

    expect(session.setSendMode).toHaveBeenCalledWith({ mode: "autopilot" });
    expect(session.setSendMode.mock.invocationCallOrder[0]).toBeLessThan(
      session.send.mock.invocationCallOrder[0],
    );

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    await flushMicrotasks();
  });

  it("emits a tool_loop_candidate telemetry span when an obvious no-op shell tool starts (observe only)", async () => {
    const { manager, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-loop-guard", "deploy now");
    await flushMicrotasks();

    getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    getHandler()?.({
      type: "tool.execution_start",
      data: {
        toolCallId: "tool-1",
        toolName: "bash",
        arguments: { command: "true", description: "No-op" },
      },
      timestamp: "2026-04-24T12:00:01.000Z",
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-loop-guard")).toBe("busy");
    expect(latestSpanMetadata(telemetryStore, "session.run.tool_loop_candidate", "session-loop-guard")).toMatchObject({
      toolName: "bash",
      loopReason: "no_op_shell",
    });

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-24T12:00:02.000Z",
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-loop-guard")).toBe("idle");
  });

  it("refreshes the agent registry and emits session:agents on background task signals", async () => {
    const { manager, globalBus } = createManager();
    const agentEvents: any[] = [];
    globalBus.subscribe((event: any) => {
      if (event.type === "session:agents") agentEvents.push(event);
    });
    const { session, getHandler, getReleaseSend } = makeSession();
    (session as any).listTasks = vi.fn(async () => ({
      tasks: [
        {
          kind: "agent",
          id: "explore-docs",
          toolCallId: "toolu_1",
          status: "running",
          executionMode: "background",
          agentType: "explore",
        },
      ],
    }));
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-agents", "spawn a background agent");
    await flushMicrotasks();

    getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    getHandler()?.({
      type: "session.background_tasks_changed",
      data: {},
      timestamp: "2026-04-24T12:00:01.000Z",
    });
    await flushMicrotasks();

    expect((session as any).listTasks).toHaveBeenCalled();
    expect(manager.getBackgroundAgentsSummary("session-agents")).toMatchObject({
      running: 1,
      total: 1,
      source: "live",
    });
    expect(agentEvents.length).toBeGreaterThanOrEqual(1);
    expect(agentEvents.at(-1).backgroundAgents).toMatchObject({ running: 1, source: "live" });

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-24T12:00:02.000Z",
    });
    await flushMicrotasks();
  });

  it("removes a finished sync agent after its parent tool call completes", async () => {
    const { manager } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    let status = "running";
    let removed = false;
    (session as any).listTasks = vi.fn(async () => ({
      tasks: removed
        ? []
        : [{
            kind: "agent",
            id: "sync-check",
            toolCallId: "agent-call-1",
            status,
            executionMode: "sync",
            agentType: "task",
          }],
    }));
    (session as any).removeTask = vi.fn(async (id: string) => {
      removed = id === "sync-check";
      return { removed };
    });
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-sync-agent", "run a one-shot check");
    await flushMicrotasks();
    getHandler()?.({
      type: "tool.execution_start",
      data: { toolCallId: "agent-call-1", toolName: "task", arguments: {} },
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    getHandler()?.({
      type: "subagent.started",
      data: { toolCallId: "agent-call-1", agentName: "task" },
      timestamp: "2026-04-24T12:00:01.000Z",
    });
    await flushMicrotasks();

    status = "idle";
    getHandler()?.({
      type: "tool.execution_complete",
      data: { toolCallId: "agent-call-1", success: true, result: "done" },
      timestamp: "2026-04-24T12:00:02.000Z",
    });
    await flushMicrotasks();

    expect((session as any).removeTask).toHaveBeenCalledWith("sync-check");
    expect(manager.agentRegistry.getTrackedAgentCount("session-sync-agent")).toBe(0);

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-24T12:00:03.000Z",
    });
    await flushMicrotasks();
  });

  it("records usage after turn end as session overhead", async () => {
    const { manager, sessionContextStore } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    const handler = getHandler();
    handler?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: "2026-05-01T10:00:00.000Z",
    });
    handler?.({
      type: "usage_info",
      id: "usage-in-turn",
      timestamp: "2026-05-01T10:00:01.000Z",
      data: { contextWindow: 100, tokensUsed: 10 },
    });
    handler?.({
      type: "assistant.turn_end",
      data: {},
      timestamp: "2026-05-01T10:00:02.000Z",
    });
    handler?.({
      type: "usage_info",
      id: "usage-after-turn",
      timestamp: "2026-05-01T10:00:03.000Z",
      data: { contextWindow: 100, tokensUsed: 11 },
    });
    getReleaseSend()?.();
    await flushMicrotasks();
    handler?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-05-01T10:00:04.000Z",
    });
    await flushMicrotasks();

    const snapshots = sessionContextStore.getSessionContext("session-1").events
      .filter((event) => event.type === "context_snapshot");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      providerEventId: "usage-in-turn",
      attribution: "turn",
      tokensUsed: 10,
    });
    expect(snapshots[0].bridgeTurnId).toEqual(expect.any(String));
    expect(snapshots[1]).toMatchObject({
      providerEventId: "usage-after-turn",
      attribution: "session_overhead",
      bridgeTurnId: null,
      tokensUsed: 11,
    });
  });

  it("cleans subagent context attribution after subagent completion", async () => {
    const { manager, sessionContextStore } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    const handler = getHandler();
    handler?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: "2026-05-01T11:00:00.000Z",
    });
    handler?.({
      type: "subagent.started",
      data: { toolCallId: "agent-call-1", agentName: "explore" },
      timestamp: "2026-05-01T11:00:01.000Z",
    });
    handler?.({
      type: "usage_info",
      id: "usage-subagent",
      timestamp: "2026-05-01T11:00:02.000Z",
      data: { parentToolCallId: "agent-call-1", contextWindow: 100, tokensUsed: 20 },
    });
    handler?.({
      type: "subagent.completed",
      data: { toolCallId: "agent-call-1" },
      timestamp: "2026-05-01T11:00:03.000Z",
    });
    handler?.({
      type: "usage_info",
      id: "usage-after-subagent",
      timestamp: "2026-05-01T11:00:04.000Z",
      data: { parentToolCallId: "agent-call-1", contextWindow: 100, tokensUsed: 21 },
    });
    getReleaseSend()?.();
    await flushMicrotasks();
    handler?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-05-01T11:00:05.000Z",
    });
    await flushMicrotasks();

    const snapshots = sessionContextStore.getSessionContext("session-1").events
      .filter((event) => event.type === "context_snapshot");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      providerEventId: "usage-subagent",
      attribution: "subagent_turn",
      tokensUsed: 20,
    });
    expect(snapshots[1]).toMatchObject({
      providerEventId: "usage-after-subagent",
      attribution: "turn",
      tokensUsed: 21,
    });
  });

  it("routes slash command agent prompts through the backend before sending", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    session.invokeSlashCommand.mockResolvedValueOnce({
      kind: "send",
      prompt: "The user set this explicit autopilot objective with /autopilot:\n\nfix tests",
      displayPrompt: "Autopilot objective: fix tests",
      mode: "autopilot",
    });
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "/goal fix tests");
    await flushMicrotasks();

    expect(session.invokeSlashCommand).toHaveBeenCalledWith({ name: "goal", input: "fix tests" });
    expect(session.setSendMode).toHaveBeenCalledWith({ mode: "autopilot" });
    await flushMicrotasks();
    expect(session.send).toHaveBeenCalledWith({
      prompt: "The user set this explicit autopilot objective with /autopilot:\n\nfix tests",
      displayPrompt: "Autopilot objective: fix tests",
    });

    getHandler()?.({
      type: "user.message",
      data: { content: "Autopilot objective: fix tests" },
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    const bus = eventBusRegistry.getBus("session-1");
    expect(bus?.getSnapshot().pendingPrompt).toBeUndefined();

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-24T12:00:01.000Z",
    });
    await flushMicrotasks();
  });

  it("completes text-only slash commands without sending an agent prompt", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session } = makeSession();
    session.invokeSlashCommand.mockResolvedValueOnce({ kind: "text", text: "Command output" });
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    await expect(manager.startWorkAndWaitForDelivery("session-1", "/context")).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(session.invokeSlashCommand).toHaveBeenCalledWith({ name: "context", input: "" });
    expect(session.send).not.toHaveBeenCalled();
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().finalContent).toBe("Command output");
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("does not dispatch escaped slash prompts as commands", async () => {
    const { manager } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "//goal literal");
    await flushMicrotasks();

    expect(session.invokeSlashCommand).not.toHaveBeenCalled();
    expect(session.send).toHaveBeenCalledWith({ prompt: "//goal literal" });

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    await flushMicrotasks();
  });

  it("lists slash commands from the cached live session without resuming", async () => {
    const { manager } = createManager();
    const { session } = makeSession();
    session.listSlashCommands.mockResolvedValue({
      commands: [{
        name: "goal",
        description: "Set an autopilot objective",
        kind: "builtin",
        allowDuringAgentExecution: true,
      }],
    });
    manager.sessionObjects.set("session-1", session);
    manager.backend = {
      resumeSession: vi.fn(),
    };

    await expect(manager.listSlashCommands("session-1")).resolves.toEqual({
      supported: true,
      commands: [{
        name: "goal",
        description: "Set an autopilot objective",
        kind: "builtin",
        allowDuringAgentExecution: true,
      }],
    });
    await expect(manager.listSlashCommands("session-1")).resolves.toEqual({
      supported: true,
      commands: [{
        name: "goal",
        description: "Set an autopilot objective",
        kind: "builtin",
        allowDuringAgentExecution: true,
      }],
    });
    expect(session.listSlashCommands).toHaveBeenCalledOnce();
    expect(manager.backend.resumeSession).not.toHaveBeenCalled();
    expect(manager.backend.resumeSession).not.toHaveBeenCalled();
  });

  it("fails delivery before sending when SDK session mode cannot be set", async () => {
    const { manager } = createManager();
    const { session } = makeSession();
    session.setSendMode.mockRejectedValueOnce(new Error("mode unavailable"));
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    await expect(manager.startWorkAndWaitForDelivery("session-1", "hello", undefined, { mode: "autopilot" }))
      .rejects.toThrow("mode unavailable");
    await flushMicrotasks();

    expect(session.send).not.toHaveBeenCalled();
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("continues default interactive sends when the SDK mode RPC is missing", async () => {
    const { manager } = createManager();
    const handlers: Array<(event: any) => void> = [];
    const session = {
      on: vi.fn((handler: (event: any) => void) => {
        handlers.push(handler);
        return vi.fn();
      }),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    expect(session.send).toHaveBeenCalledWith({ prompt: "hello" });
    for (const handler of handlers) {
      handler({
        type: "session.idle",
        data: {},
        timestamp: "2026-04-24T12:00:00.000Z",
      });
    }
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("rejects steering while a session is busy without an active run", async () => {
    const { manager } = createManager();
    manager.backend = {
      resumeSession: vi.fn(),
    };
    (manager as any).modelSwitchingSessions.add("session-1");

    await expect(manager.steerSession("session-1", "please adjust")).rejects.toThrow("not accepting steering");
  });

  it("rejects steering if the active run completes before the immediate send returns", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();

    session.send.mockImplementationOnce(async () => {
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: "2026-04-24T12:00:00.000Z",
      });
      await flushMicrotasks();
    });

    await expect(manager.steerSession("session-1", "please adjust")).rejects.toThrow("ended before steering");
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().pendingPrompt).toBeUndefined();
  });

  it("rejects steering while the busy session is still reconnecting", async () => {
    const { manager } = createManager();
    let resolveResume!: (session: ReturnType<typeof makeSession>["session"]) => void;
    manager.backend = {
      resumeSession: vi.fn(() => new Promise((resolve) => {
        resolveResume = resolve;
      })),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await expect(manager.steerSession("session-1", "please adjust")).rejects.toThrow("still reconnecting");

    const { session, getReleaseSend, getHandler } = makeSession();
    resolveResume(session);
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-24T12:00:02.000Z",
    });
    await flushMicrotasks();
  });

  it("blocks startWork when the launcher-owned restart cutover is in progress", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-run-state-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-"));
    try {
      const { manager } = createManager({
        copilotHome,
      });
      manager.backend = {
        resumeSession: vi.fn(),
      };

      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });
      await writeRestartState(join(dataDir, "restart-state.json"), {
        requestId: "req-run-state-restarting",
        phase: "restarting",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 0,
        launcherHeartbeatAt: "2026-04-24T12:00:05.000Z",
      });
      await refreshRestartState();

      expect(() => manager.startWork("session-1", "hello")).toThrow(RESTART_PENDING_MESSAGE);
      expect(manager.backend.resumeSession).not.toHaveBeenCalled();
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("keeps restart waiting count nonzero when a normal run ends while a cold resume is active", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-resume-count-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-resume-count-"));
    try {
      const { manager } = createManager({ copilotHome });
      const restartStatePath = join(dataDir, "restart-state.json");
      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });

      const messageSession = { getEvents: vi.fn().mockResolvedValue([]) };
      let resolveMessageResume!: (session: typeof messageSession) => void;
      const { session: runSession, getHandler, getReleaseSend } = makeSession();
      manager.backend = {
        resumeSession: vi.fn((sessionId: string) => {
          if (sessionId === "message-session") {
            return new Promise<typeof messageSession>((resolve) => {
              resolveMessageResume = resolve;
            });
          }
          return Promise.resolve(runSession);
        }),
      };

      const messageLoad = manager.warmSession("message-session");
      manager.startWork("run-session", "hello");
      await flushMicrotasks();

      await writeRestartState(restartStatePath, {
        requestId: "req-run-and-resume",
        phase: "waiting-for-sessions",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 2,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();

      getReleaseSend()?.();
      await flushMicrotasks();
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      await flushMicrotasks();

      expect(getRestartWaitingCount()).toBe(1);

      resolveMessageResume(messageSession);
      await messageLoad;
      expect(getRestartWaitingCount()).toBe(0);
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("syncs restart waiting count when a cold resume starts and finishes during restart pending", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-resume-only-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-resume-only-"));
    try {
      const { manager } = createManager({ copilotHome });
      const restartStatePath = join(dataDir, "restart-state.json");
      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });
      await writeRestartState(restartStatePath, {
        requestId: "req-resume-only",
        phase: "queued",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 0,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();

      const resumedSession = { getEvents: vi.fn().mockResolvedValue([]) };
      let resolveResume!: (session: typeof resumedSession) => void;
      manager.backend = {
        resumeSession: vi.fn(() => new Promise<typeof resumedSession>((resolve) => {
          resolveResume = resolve;
        })),
      };

      const messageLoad = manager.warmSession("message-session");
      await flushMicrotasks();

      expect(getRestartWaitingCount()).toBe(1);

      resolveResume(resumedSession);
      await messageLoad;

      expect(getRestartWaitingCount()).toBe(0);
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("keeps restart waiting count nonzero when a normal run ends while a model switch is active", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-model-switch-count-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-model-switch-count-"));
    try {
      const { manager } = createManager({ copilotHome });
      const restartStatePath = join(dataDir, "restart-state.json");
      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });

      let resolveSetModel!: () => void;
      const switchSession = {
        setModel: vi.fn(() => new Promise<void>((resolve) => {
          resolveSetModel = resolve;
        })),
        getCurrentModel: vi.fn().mockResolvedValue({ modelId: "gpt-5.5" }),
        disconnect: vi.fn(),
      };
      const { session: runSession, getHandler, getReleaseSend } = makeSession();
      manager.backend = {
        resumeSession: vi.fn().mockResolvedValue(runSession),
      };
      manager.sessionObjects.set("switch-session", switchSession);

      const switching = manager.setSessionModel("switch-session", "gpt-5.5");
      manager.startWork("run-session", "hello");
      await flushMicrotasks();

      await writeRestartState(restartStatePath, {
        requestId: "req-run-and-switch",
        phase: "waiting-for-sessions",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 2,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();

      getReleaseSend()?.();
      await flushMicrotasks();
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      await flushMicrotasks();

      expect(getRestartWaitingCount()).toBe(1);

      resolveSetModel();
      await switching;
      expect(getRestartWaitingCount()).toBe(0);
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("allows startWork while the launcher is waiting for active sessions", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-run-state-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-"));
    try {
      const { manager } = createManager({
        copilotHome,
      });
      const { session, getHandler, getReleaseSend } = makeSession();
      manager.backend = {
        resumeSession: vi.fn().mockResolvedValue(session),
      };

      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });
      await writeRestartState(join(dataDir, "restart-state.json"), {
        requestId: "req-run-state-launcher-waiting",
        phase: "waiting-for-sessions",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 2,
        launcherHeartbeatAt: "2026-04-24T12:00:05.000Z",
      });
      await refreshRestartState();

      expect(() => manager.startWork("session-1", "hello")).not.toThrow();
      await flushMicrotasks();

      expect(manager.backend.resumeSession).toHaveBeenCalledWith("session-1", expect.anything());
      expect(manager.getSessionRunState("session-1")).toBe("busy");
      expect(getRestartWaitingCount()).toBe(1);

      getReleaseSend()?.();
      await flushMicrotasks();
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      await flushMicrotasks();
      expect(manager.getSessionRunState("session-1")).toBe("idle");
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("does not let a superseded cold prompt resume overwrite a newer cached session", async () => {
    const { manager } = createManager();
    const stale = makeSession();
    const current = makeSession();
    let resolveResume!: (session: typeof stale.session) => void;
    manager.backend = {
      resumeSession: vi.fn(() => new Promise<typeof stale.session>((resolve) => {
        resolveResume = resolve;
      })),
    };

    const accepted = manager.startWorkAndWaitForDelivery("session-run-superseded", "hello");
    await flushMicrotasks();

    manager.sessionObjects.set("session-run-superseded", current.session);
    resolveResume(stale.session);
    await flushMicrotasks();

    expect(manager.sessionObjects.get("session-run-superseded")).toBe(current.session);
    expect(stale.session.disconnect).toHaveBeenCalledTimes(1);
    expect(stale.session.send).not.toHaveBeenCalled();
    expect(current.session.send).toHaveBeenCalledOnce();

    current.getHandler()?.({
      type: "user.message",
      data: {},
      timestamp: new Date(Date.now() + 1).toISOString(),
    });
    await expect(accepted).resolves.toBeUndefined();

    current.getReleaseSend()?.();
    await flushMicrotasks();
    current.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(Date.now() + 2).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-run-superseded")).toBe("idle");
  });

  it("keeps non-restart work isolated from live launcher restart state", async () => {
    const liveDataDir = mkdtempSync(join(tmpdir(), "bridge-live-restart-state-"));
    const liveDocsDir = join(liveDataDir, "docs");
    try {
      configureRestartStateStore({
        dataDir: liveDataDir,
        docsDir: liveDocsDir,
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: liveDataDir,
          BRIDGE_DOCS_DIR: liveDocsDir,
        },
      });
      await writeRestartState(join(liveDataDir, "restart-state.json"), {
        requestId: "req-live-launcher",
        phase: "restarting",
        requestedAt: "2026-04-30T19:20:51.000Z",
        waitingSessions: 0,
        launcherHeartbeatAt: "2026-04-30T19:20:51.000Z",
      });
      await refreshRestartState();
      expect(isRestartPending()).toBe(true);

      const { manager } = createManager();
      const { session, getHandler, getReleaseSend } = makeSession();
      manager.backend = {
        resumeSession: vi.fn().mockResolvedValue(session),
      };

      const accepted = manager.startWorkAndWaitForDelivery("session-isolated", "hello");
      await flushMicrotasks();

      expect(manager.backend.resumeSession).toHaveBeenCalledOnce();
      getHandler()?.({
        type: "user.message",
        data: {},
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      await expect(accepted).resolves.toBeUndefined();

      getReleaseSend()?.();
      await flushMicrotasks();
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 2).toISOString(),
      });
      await flushMicrotasks();
      expect(manager.getSessionRunState("session-isolated")).toBe("idle");
    } finally {
      rmSync(liveDataDir, { recursive: true, force: true });
    }
  });

  it("blocks startWork when persisted restart state advances to cutover after the cache was queued", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-run-state-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-"));
    try {
      const { manager } = createManager({
        copilotHome,
      });
      manager.backend = {
        resumeSession: vi.fn(),
      };

      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });
      const restartStatePath = join(dataDir, "restart-state.json");
      await writeRestartState(restartStatePath, {
        requestId: "req-run-state-race",
        phase: "waiting-for-sessions",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 1,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();
      await writeRestartState(restartStatePath, {
        requestId: "req-run-state-race",
        phase: "restarting",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 0,
        launcherHeartbeatAt: "2026-04-24T12:00:05.000Z",
      });

      expect(() => manager.startWork("session-1", "hello")).toThrow(RESTART_PENDING_MESSAGE);
      expect(manager.backend.resumeSession).not.toHaveBeenCalled();
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("allows session creation paths while the launcher is waiting for active sessions", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-run-state-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-"));
    try {
      const { manager } = createManager({
        copilotHome,
      });
      manager.backend = {
        createSession: vi.fn().mockResolvedValue({ sessionId: "created-session" }),
      };

      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });
      await writeRestartState(join(dataDir, "restart-state.json"), {
        requestId: "req-create-launcher-waiting",
        phase: "waiting-for-sessions",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 2,
        launcherHeartbeatAt: "2026-04-24T12:00:05.000Z",
      });
      await refreshRestartState();

      await expect(manager.createSession()).resolves.toEqual({ sessionId: "created-session" });
      expect(manager.backend.createSession).toHaveBeenCalledOnce();
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("blocks session creation paths when persisted restart state advances to cutover after the cache was queued", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-run-state-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-"));
    try {
      const { manager } = createManager({
        copilotHome,
      });
      manager.backend = {
        createSession: vi.fn(),
      };

      configureRestartStateStore({
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: {
          ...process.env,
          BRIDGE_DATA_DIR: dataDir,
          BRIDGE_DOCS_DIR: join(dataDir, "docs"),
        },
      });
      const restartStatePath = join(dataDir, "restart-state.json");
      await writeRestartState(restartStatePath, {
        requestId: "req-create-race",
        phase: "waiting-for-sessions",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 1,
        launcherHeartbeatAt: null,
      });
      await refreshRestartState();
      await writeRestartState(restartStatePath, {
        requestId: "req-create-race",
        phase: "restarting",
        requestedAt: "2026-04-24T12:00:00.000Z",
        waitingSessions: 0,
        launcherHeartbeatAt: "2026-04-24T12:00:05.000Z",
      });

      await expect(manager.createSession()).rejects.toThrow(RESTART_PENDING_MESSAGE);
      await expect(manager.forkSession("source-session")).rejects.toThrow(RESTART_PENDING_MESSAGE);
      await expect(manager.createTaskSession("task-1", "Task one", [], [], "")).rejects.toThrow(RESTART_PENDING_MESSAGE);
      expect(manager.backend.createSession).not.toHaveBeenCalled();
    } finally {
      configureRestartStateStore(undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("startWorkAndWaitForDelivery resolves when the user prompt is accepted", async () => {
    const { manager } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const accepted = manager.startWorkAndWaitForDelivery("session-1", "hello");
    await flushMicrotasks();

    getHandler()?.({
      type: "user.message",
      data: {},
      timestamp: new Date(Date.now() + 1).toISOString(),
    });

    await expect(accepted).resolves.toBeUndefined();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(Date.now() + 2).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("records completion attention on natural idle when enabled", async () => {
    const { manager, db } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const accepted = manager.startWorkAndWaitForDelivery("session-1", "hello", undefined, {
      completionAttention: true,
    });
    await flushMicrotasks();
    getHandler()?.({
      type: "user.message",
      data: {},
      timestamp: "2026-05-09T10:00:00.000Z",
    });
    await expect(accepted).resolves.toBeUndefined();

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-05-09T10:01:00.000Z",
    });
    await flushMicrotasks();

    const row = db.prepare("SELECT lastAttentionAt FROM bridge_session_state WHERE sessionId = ?").get("session-1") as any;
    expect(row?.lastAttentionAt).toBe("2026-05-09T10:01:00.000Z");
  });

  it("does not record completion attention on aborts", async () => {
    const { manager, db } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello", undefined, { completionAttention: true });
    await flushMicrotasks();
    getHandler()?.({
      type: "abort",
      data: { reason: "user initiated" },
      timestamp: "2026-05-09T10:01:00.000Z",
    });
    getReleaseSend()?.();
    await flushMicrotasks();

    const row = db.prepare("SELECT lastAttentionAt FROM bridge_session_state WHERE sessionId = ?").get("session-1") as any;
    expect(row?.lastAttentionAt).toBeUndefined();
  });

  it("startWorkAndWaitForDelivery rejects when send fails before acceptance", async () => {
    const { manager } = createManager();
    const session = {
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(() => vi.fn()),
      send: vi.fn(async () => {
        throw new Error("send failed");
      }),
      disconnect: vi.fn(),
    };
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    await expect(manager.startWorkAndWaitForDelivery("session-1", "hello")).rejects.toThrow("send failed");
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("truncates a previous quiet interval defer tail before sending the next interval prompt", async () => {
    const { manager, globalBus } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    const statusEvents: any[] = [];
    const truncate = vi.fn(async () => ({ eventsRemoved: 3 }));
    const sessionWithHistory = Object.assign(session, {
      getEvents: vi.fn(async () => [
        {
          id: "previous-quiet-user",
          type: "user.message",
          data: {
            content: [
              "<defer>",
              "deferId: interval_loop-1",
              "kind: interval",
              "attentionMode: quiet",
              "</defer>",
              "",
              "User prompt:",
              "Poll deployment",
            ].join("\n"),
          },
        },
        { id: "previous-assistant", type: "assistant.message", data: { content: "No change" } },
        { id: "previous-idle", type: "session.idle", data: {} },
      ]),
      truncateHistory: truncate,
    });
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };
    globalBus.subscribe((event) => statusEvents.push(event));

    const accepted = manager.startWorkAndWaitForDelivery("session-1", "next poll", undefined, {
      attentionMode: "quiet",
      historyTruncation: {
        mode: "replace-quiet-interval-defer-tail",
        deferId: "interval_loop-1",
      },
    });
    await flushMicrotasks();
    for (let attempt = 0; attempt < 5 && session.send.mock.calls.length === 0; attempt += 1) {
      await flushMicrotasks();
    }

    expect(sessionWithHistory.getEvents).toHaveBeenCalled();
    expect(truncate).toHaveBeenCalledWith({ eventId: "previous-quiet-user" });
    expect(truncate.mock.invocationCallOrder[0]).toBeLessThan(session.send.mock.invocationCallOrder[0]);
    expect(statusEvents).toContainEqual({ type: "session:history-truncated", sessionId: "session-1" });

    getHandler()?.({
      type: "user.message",
      data: {},
      timestamp: new Date(Date.now() + 1).toISOString(),
    });
    await expect(accepted).resolves.toBeUndefined();

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(Date.now() + 2).toISOString(),
    });
    await flushMicrotasks();
  });

  it("undoes a validated user turn, rewinds activity metadata, and publishes refresh events", async () => {
    const {
      manager,
      globalBus,
      sessionContextStore,
      sessionMetaStore,
    } = createManager({ telemetry: true });
    const statusEvents: any[] = [];
    const events = [
      { id: "user-1", type: "user.message", timestamp: "2026-05-09T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-05-09T10:00:01.000Z", data: { content: "Answer one" } },
      { id: "turn-end-1", type: "assistant.turn_end", timestamp: "2026-05-09T10:00:02.000Z", data: {} },
      { id: "user-2", type: "user.message", timestamp: "2026-05-09T10:01:00.000Z", data: { content: "Second" } },
      { id: "assistant-2", type: "assistant.message", timestamp: "2026-05-09T10:01:01.000Z", data: { content: "Answer two" } },
    ];
    const truncateHistory = vi.fn().mockResolvedValue({ eventsRemoved: 2 });
    const session = {
      sessionId: "session-1",
      on: vi.fn(() => vi.fn()),
      send: vi.fn(),
      abort: vi.fn(),
      setModel: vi.fn(),
      disconnect: vi.fn(),
      getEvents: vi.fn().mockResolvedValue(events),
      truncateHistory,
    };
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };
    sessionMetaStore.setLastVisibleActivityAt("session-1", "2026-05-09T10:01:01.000Z");
    sessionMetaStore.setLastAttentionAt("session-1", "2026-05-09T10:01:02.000Z");
    globalBus.subscribe((event) => statusEvents.push(event));

    await expect(manager.undoSessionTurn("session-1", " user-2 ")).resolves.toEqual({
      eventsRemoved: 2,
      lastVisibleActivityAt: "2026-05-09T10:00:01.000Z",
    });

    expect(truncateHistory).toHaveBeenCalledWith({ eventId: "user-2" });
    expect(sessionMetaStore.getMeta("session-1")?.lastVisibleActivityAt)
      .toBe("2026-05-09T10:00:01.000Z");
    expect(sessionMetaStore.getMeta("session-1")?.lastAttentionAt).toBeUndefined();
    expect(statusEvents).toEqual(expect.arrayContaining([
      { type: "session:history-truncated", sessionId: "session-1" },
      { type: "sessions:changed", sessionId: "session-1" },
    ]));
    expect(sessionContextStore.getSessionContext("session-1").events[0]).toMatchObject({
      type: "truncation",
      metadata: { eventId: "user-2", reason: "user-undo" },
    });
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("rejects stale or non-user undo boundaries before truncating history", async () => {
    const { manager } = createManager();
    const truncateHistory = vi.fn();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        on: vi.fn(() => vi.fn()),
        send: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn(),
        disconnect: vi.fn(),
        getEvents: vi.fn().mockResolvedValue([
          {
            id: "skill-browser",
            type: "user.message",
            data: { content: "<skill-context name=\"browser\">", source: "skill-browser" },
          },
        ]),
        truncateHistory,
      }),
    };

    await expect(manager.undoSessionTurn("session-1", "skill-browser")).rejects.toMatchObject({
      code: "stale-boundary",
    });
    expect(truncateHistory).not.toHaveBeenCalled();
  });

  it("can undo the first turn and clear all derived session activity", async () => {
    const { manager, sessionMetaStore } = createManager();
    sessionMetaStore.setLastVisibleActivityAt("session-1", "2026-05-09T10:00:01.000Z");
    sessionMetaStore.setLastAttentionAt("session-1", "2026-05-09T10:00:02.000Z");
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        on: vi.fn(() => vi.fn()),
        send: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn(),
        disconnect: vi.fn(),
        getEvents: vi.fn().mockResolvedValue([
          { id: "user-1", type: "user.message", timestamp: "2026-05-09T10:00:00.000Z", data: { content: "First" } },
          { id: "assistant-1", type: "assistant.message", timestamp: "2026-05-09T10:00:01.000Z", data: { content: "Answer" } },
        ]),
        truncateHistory: vi.fn().mockResolvedValue({ eventsRemoved: 2 }),
      }),
    };

    await expect(manager.undoSessionTurn("session-1", "user-1"))
      .resolves.toEqual({ eventsRemoved: 2 });
    expect(sessionMetaStore.getMeta("session-1")).toBeUndefined();
  });

  it("marks undo as busy so concurrent mutations cannot race it", async () => {
    const { manager } = createManager();
    let releaseTruncate!: () => void;
    const truncateHistory = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseTruncate = resolve;
      });
      return { eventsRemoved: 1 };
    });
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        on: vi.fn(() => vi.fn()),
        send: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn(),
        disconnect: vi.fn(),
        getEvents: vi.fn().mockResolvedValue([
          { id: "user-1", type: "user.message", data: { content: "First" } },
        ]),
        truncateHistory,
      }),
    };

    const firstUndo = manager.undoSessionTurn("session-1", "user-1");
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");
    await expect(manager.undoSessionTurn("session-1", "user-1")).rejects.toMatchObject({
      code: "busy",
    });

    releaseTruncate();
    await expect(firstUndo).resolves.toEqual({ eventsRemoved: 1 });
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("transitions busy → stalled → busy → idle from the server run-state model", async () => {
    const { manager, globalBus } = createManager();
    const events: string[] = [];
    globalBus.subscribe((event) => {
      if (event.sessionId === "session-1" && ["session:busy", "session:stalled", "session:idle"].includes(event.type)) {
        events.push(event.type);
      }
    });

    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(manager.isSessionBusy("session-1")).toBe(true);

    // Watchdog fires every 60s; stall threshold is 300s — first trigger at exactly 300s
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    expect(manager.isSessionStalled("session-1")).toBe(true);
    expect(manager.getActiveSessions()).toEqual(["session-1"]);
    expect(manager.getSessionActivity()).toEqual([
      expect.objectContaining({
        id: "session-1",
        state: "stalled",
        stalledAt: expect.any(Number),
      }),
    ]);
    const recoveryEventBase = Date.now();

    getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(recoveryEventBase + 1_000).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(manager.isSessionStalled("session-1")).toBe(false);

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(recoveryEventBase + 2_000).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(manager.isSessionBusy("session-1")).toBe(false);
    expect(events).toEqual(["session:busy", "session:stalled", "session:busy", "session:idle"]);
  });

  it("keeps native elicitation waits busy beyond the stalled watchdog window", async () => {
    const sessionId = "session-elicitation-wait";
    const { manager, eventBusRegistry, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler, getReleaseSend } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();

    const config = (Reflect.get(manager, "buildSessionConfig") as () => any).call(manager);
    const elicitationPromise = config.onElicitationRequest({
      sessionId,
      message: "Choose a deployment target",
      requestedSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["staging", "production"],
          },
        },
        required: ["target"],
      },
    });
    await flushMicrotasks();

    const requestId = eventBusRegistry.getBus(sessionId)
      ?.getSnapshot()
      .pendingElicitations[0]
      ?.requestId;
    expect(requestId).toBeDefined();

    await vi.advanceTimersByTimeAsync(900_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(telemetryStore!.querySpans({ name: "session.run.stalled", sessionId })).toEqual([]);
    expect(telemetryStore!.querySpans({ name: "session.run.force_released", sessionId })).toEqual([]);

    await manager.submitElicitationResponse(sessionId, requestId!, { action: "cancel" });
    await expect(elicitationPromise).resolves.toEqual({ action: "cancel" });
    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date().toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
  });

  it("includes the final assistant message preview on normal idle events", async () => {
    const { manager, globalBus } = createManager();
    let idleEvent: any;
    globalBus.subscribe((event) => {
      if (event.type === "session:idle" && event.sessionId === "session-1") {
        idleEvent = event;
      }
    });

    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    getHandler()?.({
      type: "assistant.message",
      data: {
        content: "**Done.** Here's the `fix`:\n\n```ts\nconst noisy = true;\n```\n\nSecond paragraph should not be in the preview.",
      },
      timestamp: new Date().toISOString(),
    });
    await flushMicrotasks();

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date().toISOString(),
    });
    await flushMicrotasks();

    expect(idleEvent).toMatchObject({
      type: "session:idle",
      sessionId: "session-1",
      assistantPreview: "Done. Here's the fix:",
    });
  });

  it("attempts recovery (re-resume + re-subscribe) when a session first becomes stalled", async () => {
    const { manager } = createManager();
    const { session } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(1);

    // Advance to exactly the stall threshold
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    // Recovery should have triggered a second resume
    expect(resumeSession).toHaveBeenCalledTimes(2);
  });

  it("keeps quiet external tools busy instead of recovering them as stalled sessions", async () => {
    const sessionId = "session-external-tool-wait";
    const { manager, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler, getReleaseSend } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();
    const baseTime = Date.now();

    getHandler()?.({
      type: "external_tool.requested",
      timestamp: new Date(baseTime + 1_000).toISOString(),
      data: {
        requestId: "external-req-1",
        sessionId,
        toolCallId: "external-call-1",
        toolName: "staging_preview",
        arguments: {},
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(telemetryStore!.querySpans({ name: "session.run.stalled", sessionId })).toEqual([]);
    expect(latestSpanMetadata(telemetryStore, "session.run.waiting_on_external_tool", sessionId)).toMatchObject({
      watchdogTimeoutMs: 300_000,
      activeExternalToolCount: 1,
      activeExternalToolNames: ["staging_preview"],
      oldestActiveExternalToolName: "staging_preview",
      oldestActiveExternalToolRequestId: "external-req-1",
      oldestActiveExternalToolCallId: "external-call-1",
    });

    getHandler()?.({
      type: "external_tool.completed",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      data: {
        requestId: "external-req-1",
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("stalled");
    expect(resumeSession).toHaveBeenCalledTimes(2);
  });

  it("clears quiet external tool protection when the matching tool execution completes", async () => {
    const sessionId = "session-external-tool-execution-complete";
    const { manager } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();
    const baseTime = Date.now();

    getHandler()?.({
      type: "external_tool.requested",
      timestamp: new Date(baseTime + 1_000).toISOString(),
      data: {
        requestId: "external-req-2",
        sessionId,
        toolCallId: "external-call-2",
        toolName: "staging_preview",
        arguments: {},
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(resumeSession).toHaveBeenCalledTimes(1);

    getHandler()?.({
      type: "tool.execution_complete",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      data: {
        toolCallId: "external-call-2",
        success: true,
        output: "done",
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("stalled");
    expect(resumeSession).toHaveBeenCalledTimes(2);
  });

  it("retries recovery every 5 minutes while the session remains stalled", async () => {
    const { manager } = createManager();
    const { session } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    // First stall + first recovery at 300s (first eligible watchdog tick)
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(2);

    // Second recovery after exactly RECOVERY_INTERVAL (300s) while still stalled
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(3);
  });

  it("re-attaches listeners to the recovered session so later events clear stalled state", async () => {
    const { manager, globalBus } = createManager();
    const events: string[] = [];
    globalBus.subscribe((event) => {
      if (event.sessionId === "session-1" && ["session:busy", "session:stalled", "session:idle"].includes(event.type)) {
        events.push(event.type);
      }
    });
    const initial = makeSession();
    const recovered = makeSession();
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    expect(initial.session.disconnect).toHaveBeenCalledTimes(1);
    const recoveryEventBase = Date.now();

    initial.getReleaseSend()?.();
    await flushMicrotasks();

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(recoveryEventBase + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    recovered.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(recoveryEventBase + 2_000).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(events).toEqual(["session:busy", "session:stalled", "session:busy", "session:idle"]);
  });

  it("does not let a superseded stalled-recovery resume overwrite a newer cached session", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const recovered = makeSession();
    const current = makeSession();
    let resolveRecovery!: (session: typeof recovered.session) => void;
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockReturnValueOnce(new Promise<typeof recovered.session>((resolve) => {
          resolveRecovery = resolve;
        })),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    manager.sessionObjects.set("session-1", current.session);
    resolveRecovery(recovered.session);
    await flushMicrotasks();

    expect(manager.sessionObjects.get("session-1")).toBe(current.session);
    expect(recovered.session.disconnect).toHaveBeenCalledTimes(1);
    expect(recovered.session.on).not.toHaveBeenCalled();
    expect(current.session.on).toHaveBeenCalledOnce();
    expect(initial.session.disconnect).toHaveBeenCalledTimes(1);

    initial.getReleaseSend()?.();
    await flushMicrotasks();

    current.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    current.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(Date.now() + 2_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("records completion telemetry for live session.idle", async () => {
    const sessionId = "session-live-idle-telemetry";
    const { manager, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();
    const baseTime = Date.now();

    getHandler()?.({
      type: "assistant.message",
      timestamp: new Date(baseTime + 1_000).toISOString(),
      data: { content: "done" },
    });
    getHandler()?.({
      type: "assistant.turn_end",
      timestamp: new Date(baseTime + 2_000).toISOString(),
      data: { turnId: "1" },
    });
    getHandler()?.({
      type: "session.idle",
      timestamp: new Date(baseTime + 3_000).toISOString(),
      data: {},
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(latestSpanMetadata(telemetryStore, "session.run.complete", sessionId)).toMatchObject({
      completionSource: "live_session_idle",
      completionStatus: "done",
      terminalEventType: "session.idle",
      terminalEventOrigin: "live",
      finalContentLength: 4,
      assistantContentKnown: true,
      liveTurnEndCount: 1,
      eventsAfterLastLiveTurnEnd: 0,
      activeEventsAfterLastLiveTurnEnd: 0,
      lastLiveEventType: "session.idle",
    });
  });

  it("does not complete on live session.idle when a follow-up assistant turn is open", async () => {
    const sessionId = "session-idle-open-followup";
    const { manager, eventBusRegistry, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const bus = eventBusRegistry.getOrCreateBus(sessionId);
    manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();
    const baseTime = Date.now();

    getHandler()?.({
      type: "assistant.message",
      timestamp: new Date(baseTime + 1_000).toISOString(),
      data: { content: "intermediate" },
    });
    getHandler()?.({
      type: "assistant.turn_end",
      timestamp: new Date(baseTime + 2_000).toISOString(),
      data: { turnId: "1" },
    });
    getHandler()?.({
      type: "assistant.turn_start",
      timestamp: new Date(baseTime + 3_000).toISOString(),
      data: { turnId: "2" },
    });
    getHandler()?.({
      type: "session.idle",
      timestamp: new Date(baseTime + 4_000).toISOString(),
      data: {},
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(bus.getSnapshot().complete).toBe(false);
    expect(telemetryStore!.querySpans({
      name: "session.run.complete",
      sessionId,
    })).toEqual([]);
    expect(latestSpanMetadata(telemetryStore, "session.idle.ignored_active_turn", sessionId)).toMatchObject({
      ignoredIdleReason: "active_followup_after_turn_end",
      idleEventOrigin: "live",
      lastLiveEventType: "session.idle",
      liveTurnEndCount: 1,
      activeEventsAfterLastLiveTurnEnd: 1,
    });

    getHandler()?.({
      type: "assistant.message",
      timestamp: new Date(baseTime + 5_000).toISOString(),
      data: { content: "final" },
    });
    getHandler()?.({
      type: "assistant.turn_end",
      timestamp: new Date(baseTime + 6_000).toISOString(),
      data: { turnId: "2" },
    });
    getHandler()?.({
      type: "session.idle",
      timestamp: new Date(baseTime + 7_000).toISOString(),
      data: {},
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(bus.getSnapshot()).toMatchObject({
      complete: true,
      terminalType: "done",
      finalContent: "final",
    });
    expect(latestSpanMetadata(telemetryStore, "session.run.complete", sessionId)).toMatchObject({
      completionSource: "live_session_idle",
      completionStatus: "done",
      terminalEventType: "session.idle",
      liveTurnEndCount: 2,
      activeEventsAfterLastLiveTurnEnd: 0,
    });
  });

  it("records diagnostic telemetry when a live turn-end stalls before persisted recovery", async () => {
    const tmpDir = makeTestDir("stall-turn-end-telemetry");
    const sessionId = "session-turn-end-telemetry";
    const sessionStateDir = join(tmpDir, "session-state", sessionId);
    mkdirSync(sessionStateDir, { recursive: true });

    const { manager, telemetryStore } = createManager({ copilotHome: tmpDir, telemetry: true });
    const initial = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(initial.session);
    manager.backend = { resumeSession };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();
    const baseTime = Date.now();

    initial.getHandler()?.({
      type: "assistant.message",
      timestamp: new Date(baseTime + 1_000).toISOString(),
      data: { content: "done from turn_end" },
    });
    initial.getHandler()?.({
      type: "assistant.turn_end",
      timestamp: new Date(baseTime + 2_000).toISOString(),
      data: { turnId: "1" },
    });
    await flushMicrotasks();

    writeFileSync(join(sessionStateDir, "events.jsonl"), [
      JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 500).toISOString(), data: { content: "hello" } }),
      JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "done from turn_end" } }),
      JSON.stringify({ type: "assistant.turn_end", timestamp: new Date(baseTime + 2_000).toISOString(), data: { turnId: "1" } }),
    ].join("\n") + "\n");

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(latestSpanMetadata(telemetryStore, "session.run.stalled", sessionId)).toMatchObject({
      previousRunState: "busy",
      watchdogTimeoutMs: 300_000,
      lastLiveEventType: "assistant.turn_end",
      liveTurnEndCount: 1,
      eventsAfterLastLiveTurnEnd: 0,
      activeEventsAfterLastLiveTurnEnd: 0,
      latestPersistedEventType: "assistant.turn_end",
      latestPersistedTerminalEventType: "assistant.turn_end",
    });
    expect(latestSpanMetadata(telemetryStore, "session.run.complete", sessionId)).toMatchObject({
      completionSource: "persisted_assistant_turn_end_recovery",
      completionStatus: "done",
      terminalEventType: "assistant.turn_end",
      terminalEventOrigin: "persisted_recovery",
      recoveryReason: "before resume",
      finalContentLength: "done from turn_end".length,
      assistantContentKnown: true,
      lastLiveEventType: "assistant.turn_end",
      liveTurnEndCount: 1,
    });
    expect(latestSpanMetadata(telemetryStore, "session.run.recovery", sessionId)).toMatchObject({
      outcome: "resolved_persisted_terminal",
      when: "before_resume",
      terminalEventType: "assistant.turn_end",
      attemptIndex: 1,
      latestPersistedEventType: "assistant.turn_end",
      latestPersistedTerminalEventType: "assistant.turn_end",
    });
  });

  it("resolves a stalled turn from persisted terminal events without waiting for a new live event", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-terminal-"));
    try {
      const sessionId = "session-terminal";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager, globalBus } = createManager({ copilotHome: tmpDir });
      const events: string[] = [];
      globalBus.subscribe((event) => {
        if (event.sessionId === sessionId && ["session:busy", "session:stalled", "session:idle"].includes(event.type)) {
          events.push(event.type);
        }
      });

      const initial = makeSession();
      const resumeSession = vi.fn().mockResolvedValue(initial.session);
      manager.backend = { resumeSession };

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      initial.getReleaseSend()?.();
      await flushMicrotasks();
      const baseTime = Date.now();

      writeFileSync(join(sessionStateDir, "events.jsonl"), [
        JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 2_000).toISOString(), data: { content: "done" } }),
        JSON.stringify({ type: "session.idle", timestamp: new Date(baseTime + 3_000).toISOString(), data: {} }),
      ].join("\n") + "\n");

      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("idle");
      expect(events).toEqual(["session:busy", "session:stalled", "session:idle"]);
      expect(resumeSession).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves a stalled turn from persisted assistant.turn_end without waiting for session.idle", async () => {
    const tmpDir = makeTestDir("stall-turn-end-terminal");
    try {
      const sessionId = "session-turn-end-terminal";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager, eventBusRegistry } = createManager({ copilotHome: tmpDir });
      const initial = makeSession();
      const resumeSession = vi.fn().mockResolvedValue(initial.session);
      manager.backend = { resumeSession };

      const bus = eventBusRegistry.getOrCreateBus(sessionId);
      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      initial.getReleaseSend()?.();
      await flushMicrotasks();
      const baseTime = Date.now();

      writeFileSync(join(sessionStateDir, "events.jsonl"), [
        JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 2_000).toISOString(), data: { content: "done from turn_end" } }),
        JSON.stringify({ type: "assistant.turn_end", timestamp: new Date(baseTime + 3_000).toISOString(), data: {} }),
      ].join("\n") + "\n");

      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("idle");
      expect(resumeSession).toHaveBeenCalledTimes(1);
      expect(bus.getSnapshot()).toMatchObject({
        terminalType: "done",
        finalContent: "done from turn_end",
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats routine session.shutdown as a shutdown terminal event", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    getReleaseSend()?.();
    await flushMicrotasks();

    getHandler()?.({
      type: "assistant.message",
      data: { content: "partial response" },
      timestamp: "2026-04-20T00:00:01.000Z",
    });
    await flushMicrotasks();

    getHandler()?.({
      type: "session.shutdown",
      data: { shutdownType: "graceful" },
      timestamp: "2026-04-20T00:00:02.000Z",
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(bus.getSnapshot()).toMatchObject({
      terminalType: "shutdown",
      finalContent: "partial response",
    });
  });

  it("treats error session.shutdown as a terminal error", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    getReleaseSend()?.();
    await flushMicrotasks();

    getHandler()?.({
      type: "session.shutdown",
      data: { shutdownType: "error", message: "runtime failed" },
      timestamp: "2026-04-20T00:00:02.000Z",
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(bus.getSnapshot()).toMatchObject({
      terminalType: "error",
      errorMessage: "runtime failed",
    });
  });

  it("resolves abort locally when the runtime never confirms it", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    getReleaseSend()?.();
    await flushMicrotasks();

    const abortPromise = manager.abortSession("session-1");
    await flushMicrotasks();
    expect(session.abort).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await abortPromise;
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(bus.getSnapshot().terminalType).toBe("aborted");
  });

  it("clears run state when an abort event arrives while send is still pending", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");
    getHandler()?.({
      type: "abort",
      data: { reason: "user_initiated" },
      timestamp: "2026-04-20T00:00:02.000Z",
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(bus.getSnapshot().terminalType).toBe("aborted");
    expect(session.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not send the prompt after a local abort during initial resume", async () => {
    const { manager, eventBusRegistry } = createManager();
    let resolveResume!: (session: any) => void;
    const resumePromise = new Promise<any>((resolve) => {
      resolveResume = resolve;
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const session = {
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(() => vi.fn()),
      send,
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    manager.backend = {
      resumeSession: vi.fn().mockReturnValue(resumePromise),
    };

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await expect(manager.abortSession("session-1")).resolves.toBe(true);
    expect(bus.getSnapshot().terminalType).toBe("aborted");

    resolveResume(session);
    await flushMicrotasks();

    expect(send).not.toHaveBeenCalled();
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(manager.getSessionRunState("session-1")).toBe("idle"));
  });

  it("does not attempt a second recovery while one is already in progress", async () => {
    const { manager } = createManager();
    let resolveRecovery!: () => void;
    const recoveryPromise = new Promise<void>((res) => { resolveRecovery = res; });
    const { session } = makeSession();
    // First call returns immediately; second call hangs (simulates slow recovery)
    const resumeSession = vi.fn()
      .mockResolvedValueOnce(session)
      .mockReturnValueOnce(recoveryPromise.then(() => session));
    manager.backend = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    // Trigger first stall + recovery
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(2);
    // Recovery is still in progress — advance another watchdog interval
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    // Should NOT have triggered a third resume while recovery is pending
    expect(resumeSession).toHaveBeenCalledTimes(2);

    resolveRecovery();
  });

  it("keeps the existing session listener and abort path if recovery resume fails", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const resumeSession = vi.fn()
      .mockResolvedValueOnce(initial.session)
      .mockRejectedValueOnce(new Error("resume failed"));
    manager.backend = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    expect(initial.session.disconnect).not.toHaveBeenCalled();
    expect(resumeSession).toHaveBeenCalledTimes(2);

    const abortPromise = manager.abortSession("session-1");
    await flushMicrotasks();
    expect(initial.session.abort).toHaveBeenCalledTimes(1);

    initial.getHandler()?.({
      type: "abort",
      data: { reason: "user initiated" },
      timestamp: "2026-04-20T00:00:02.000Z",
    });
    await expect(abortPromise).resolves.toBe(true);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("does not attach a recovered listener after the original stalled turn already finished", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const recovered = makeSession();
    let resolveRecovery!: (session: any) => void;
    const recoveryPromise = new Promise<any>((resolve) => {
      resolveRecovery = resolve;
    });
    const resumeSession = vi.fn()
      .mockResolvedValueOnce(initial.session)
      .mockReturnValueOnce(recoveryPromise);
    manager.backend = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-20T00:00:02.000Z",
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("idle");

    resolveRecovery(recovered.session);
    await flushMicrotasks();

    expect(recovered.session.on).not.toHaveBeenCalled();
    expect(recovered.session.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps the original listener when stalled recovery wakes up after live events have resumed", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const recovered = makeSession();
    let resolveRecovery!: (session: any) => void;
    const recoveryPromise = new Promise<any>((resolve) => {
      resolveRecovery = resolve;
    });
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockReturnValueOnce(recoveryPromise),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    resolveRecovery(recovered.session);
    await flushMicrotasks();

    expect(recovered.session.on).not.toHaveBeenCalled();
    expect(recovered.session.disconnect).toHaveBeenCalledTimes(1);
    expect(initial.session.disconnect).not.toHaveBeenCalled();
  });

  it("ignores replayed historical events when attaching a recovered listener", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const staleTimestamp = new Date(Date.now() - 1_000).toISOString();
    const recovered = makeSession({
      replayOnSubscribe: {
        type: "session.idle",
        data: {},
        timestamp: staleTimestamp,
      },
    });
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    recovered.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(Date.now() + 2_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("processes fresh replayed terminal events from the recovered listener", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const recovered = makeSession({
      replayOnSubscribe: () => ({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      }),
    });
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("ignores replayed same-turn events that were already processed before the stall", async () => {
    const { manager } = createManager();
    const replayedTurnStart = new Date(Date.now() + 1_000).toISOString();
    const initial = makeSession();
    const recovered = makeSession({
      replayOnSubscribe: {
        type: "assistant.turn_start",
        data: {},
        timestamp: replayedTurnStart,
      },
    });
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: replayedTurnStart,
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");
  });

  it("does not duplicate replayed same-turn delta content during recovery", async () => {
    const { manager, eventBusRegistry } = createManager();
    const replayedDeltaTimestamp = new Date(Date.now() + 1_000).toISOString();
    const initial = makeSession();
    const recovered = makeSession({
      replayOnSubscribe: {
        type: "assistant.message_delta",
        data: { deltaContent: "dup" },
        timestamp: replayedDeltaTimestamp,
      },
    });
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "assistant.message_delta",
      data: { deltaContent: "dup" },
      timestamp: replayedDeltaTimestamp,
    });
    await flushMicrotasks();
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().accumulatedContent).toBe("dup");

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().accumulatedContent).toBe("dup");

    recovered.getHandler()?.({
      type: "assistant.message_delta",
      data: { deltaContent: "new" },
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().accumulatedContent).toBe("dupnew");
  });

  it("processes distinct recovered events that share a timestamp with the last handled event", async () => {
    const { manager } = createManager();
    const sharedTimestamp = new Date(Date.now() + 1_000).toISOString();
    const initial = makeSession();
    const recovered = makeSession({
      replayOnSubscribe: {
        type: "session.idle",
        data: {},
        timestamp: sharedTimestamp,
      },
    });
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: sharedTimestamp,
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("ignores historical recovered events emitted after subscription becomes active", async () => {
    const { manager } = createManager();
    const initialTurnBase = Date.now();
    const initial = makeSession();
    const recovered = makeSession();
    manager.backend = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    recovered.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(initialTurnBase - 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");
  });

  it("resolves from persisted terminal events that land while recovery resume is still in flight", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-terminal-after-resume-"));
    try {
      const sessionId = "session-terminal-after-resume";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const initial = makeSession();
      const recovered = makeSession();
      let resolveRecovery!: (session: any) => void;
      const recoveryPromise = new Promise<any>((resolve) => {
        resolveRecovery = resolve;
      });
      manager.backend = {
        resumeSession: vi.fn()
          .mockResolvedValueOnce(initial.session)
          .mockReturnValueOnce(recoveryPromise),
      };

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      initial.getReleaseSend()?.();
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      const baseTime = Date.now();
      writeFileSync(join(sessionStateDir, "events.jsonl"), [
        JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 2_000).toISOString(), data: { content: "done" } }),
        JSON.stringify({ type: "session.idle", timestamp: new Date(baseTime + 3_000).toISOString(), data: {} }),
      ].join("\n") + "\n");

      resolveRecovery(recovered.session);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("idle");
      expect(recovered.session.on).not.toHaveBeenCalled();
      expect(recovered.session.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves from persisted terminal events if recovery resume fails after the turn already finished on disk", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-terminal-after-failure-"));
    try {
      const sessionId = "session-terminal-after-failure";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const initial = makeSession();
      let rejectRecovery!: (error: Error) => void;
      const recoveryPromise = new Promise<any>((_, reject) => {
        rejectRecovery = reject;
      });
      manager.backend = {
        resumeSession: vi.fn()
          .mockResolvedValueOnce(initial.session)
          .mockReturnValueOnce(recoveryPromise),
      };

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      initial.getReleaseSend()?.();
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      const baseTime = Date.now();
      writeFileSync(join(sessionStateDir, "events.jsonl"), [
        JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 2_000).toISOString(), data: { content: "done" } }),
        JSON.stringify({ type: "session.idle", timestamp: new Date(baseTime + 3_000).toISOString(), data: {} }),
      ].join("\n") + "\n");

      rejectRecovery(new Error("resume failed"));
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("idle");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("updates lastEventAt from events.jsonl mtime to prevent false stale reports", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-test-"));
    try {
      const sessionId = "session-file-test";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const { session } = makeSession();
      manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();

      // Write an events.jsonl with the current fake time as the mtime proxy —
      // we'll check that the run record's lastEventAt is pushed forward by file
      // mtime probing once we write a file and advance the watchdog.
      const eventsPath = join(sessionStateDir, "events.jsonl");
      writeFileSync(eventsPath, '{"type":"user.message"}\n');

      // Advance past the stall threshold so the watchdog fires
      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      // The file's real mtime is close to wall-clock time so it will be
      // greater than the fake-timer lastEventTime; the run record should have
      // lastEventAt updated to the file's mtime.
      const activity = manager.getSessionActivity();
      expect(activity).toHaveLength(1);
      // lastEventAt must be >= the file's mtime (set near test start) which is
      // well after the fake-time start, so staleMs should not be ~300s
      expect(activity[0].staleMs).toBeLessThan(300_000);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disk-mtime progress does not suppress stall detection or recovery retries", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-test-disk-"));
    try {
      const sessionId = "session-disk-stall";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const { session } = makeSession();
      const resumeSession = vi.fn().mockResolvedValue(session);
      manager.backend = { resumeSession };

      // Create events.jsonl before starting so its mtime is close to the fake-timer epoch.
      // The live listener stays silent throughout, which is the condition under test.
      const eventsPath = join(sessionStateDir, "events.jsonl");
      writeFileSync(eventsPath, '{"type":"user.message"}\n');

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      expect(resumeSession).toHaveBeenCalledTimes(1);

      // Advance to exactly the stall threshold.
      // Even though events.jsonl mtime is fresh relative to real wall-clock time, it must
      // NOT suppress stall detection — lastEventTime is only updated by live SDK events.
      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("stalled");
      expect(resumeSession).toHaveBeenCalledTimes(2);

      // Recovery retries must still fire on schedule while stalled, regardless of disk activity.
      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("stalled");
      expect(resumeSession).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("force releases a stalled turn after the bounded stalled window", async () => {
    const { manager, eventBusRegistry, telemetryStore } = createManager({ telemetry: true });
    const { session } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    await vi.advanceTimersByTimeAsync(600_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(bus.getSnapshot().terminalType).toBe("error");
    expect(bus.getSnapshot().errorMessage).toContain("Session stalled for");
    expect(session.disconnect).toHaveBeenCalled();
    expect(latestSpanMetadata(telemetryStore, "session.run.force_released", "session-1")).toMatchObject({
      reason: "stalled_watchdog_timeout",
      forceReleaseThresholdMs: 600_000,
    });
  });

  it("waits for sync shell initial_wait before marking a session stalled", async () => {
    const { manager } = createManager();
    const { session, getHandler } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    getHandler()?.({
      type: "tool.execution_start",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      data: {
        toolCallId: "tool-sync-shell",
        toolName: "bash",
        arguments: {
          command: "npm run build",
          mode: "sync",
          initial_wait: 480,
        },
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(resumeSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(240_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    expect(resumeSession).toHaveBeenCalledTimes(2);
  });

  it("resolves a stalled turn from persisted session.shutdown events", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-shutdown-terminal-"));
    try {
      const sessionId = "session-shutdown-terminal";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager, eventBusRegistry } = createManager({ copilotHome: tmpDir });
      const initial = makeSession();
      const resumeSession = vi.fn().mockResolvedValue(initial.session);
      manager.backend = { resumeSession };

      const bus = eventBusRegistry.getOrCreateBus(sessionId);
      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      initial.getReleaseSend()?.();
      await flushMicrotasks();
      const baseTime = Date.now();

      writeFileSync(join(sessionStateDir, "events.jsonl"), [
        JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 2_000).toISOString(), data: { content: "done" } }),
        JSON.stringify({ type: "session.shutdown", timestamp: new Date(baseTime + 3_000).toISOString(), data: { shutdownType: "graceful" } }),
      ].join("\n") + "\n");

      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("idle");
      expect(bus.getSnapshot()).toMatchObject({
        terminalType: "shutdown",
        finalContent: "done",
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("syncRestartWaitingSessions handoff guard", () => {
    it("does not clobber launcher-owned fields when launcher has heartbeated before queued write fires", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-handoff-"));
      const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-"));
      try {
        const { manager } = createManager({ copilotHome });
        configureRestartStateStore({
          dataDir,
          docsDir: join(dataDir, "docs"),
          env: { ...process.env, BRIDGE_DATA_DIR: dataDir, BRIDGE_DOCS_DIR: join(dataDir, "docs") },
        });
        const restartStatePath = join(dataDir, "restart-state.json");

        // Start a session BEFORE restart becomes pending (startWork throws if restart is pending)
        const { session, getHandler, getReleaseSend } = makeSession();
        manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };
        manager.startWork("session-1", "hello");
        await flushMicrotasks();

        // Server-initiated restart state (one session blocking)
        await writeRestartState(restartStatePath, {
          requestId: "req-handoff",
          phase: "waiting-for-sessions",
          requestedAt: "2026-01-01T00:00:00.000Z",
          waitingSessions: 1,
          launcherHeartbeatAt: null,
        });
        await refreshRestartState();  // loads server state into in-memory cache

        // Launcher picks up the restart and advances the file while server cache is still stale
        await writeRestartState(restartStatePath, {
          requestId: "req-handoff",
          phase: "restarting",
          requestedAt: "2026-01-01T00:00:00.000Z",
          waitingSessions: 1,
          launcherHeartbeatAt: "2026-01-01T00:00:01.000Z",
        });

        // Session ends → syncRestartWaitingSessions is called with stale cached state
        getReleaseSend()?.();
        await flushMicrotasks();
        getHandler()?.({ type: "session.idle", data: {}, timestamp: new Date(Date.now() + 1).toISOString() });
        await flushMicrotasks();

        // Flush the write queue — refreshRestartState awaits _restartStateWriteQueue
        await refreshRestartState();

        // Launcher-owned fields must be intact on disk; the server must not have overwritten them
        const diskState = await readRestartState(restartStatePath);
        expect(diskState.phase).toBe("restarting");
        expect(diskState.launcherHeartbeatAt).toBe("2026-01-01T00:00:01.000Z");
        expect(diskState.requestId).toBe("req-handoff");
        expect(diskState.waitingSessions).toBe(1);
      } finally {
        configureRestartStateStore(undefined);
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(copilotHome, { recursive: true, force: true });
      }
    });

    it("emits live waiting-session updates after launcher handoff without rewriting disk", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-handoff-events-"));
      const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-events-"));
      try {
        const { manager, globalBus } = createManager({ copilotHome });
        configureRestartStateStore({
          dataDir,
          docsDir: join(dataDir, "docs"),
          env: { ...process.env, BRIDGE_DATA_DIR: dataDir, BRIDGE_DOCS_DIR: join(dataDir, "docs") },
        });
        const restartStatePath = join(dataDir, "restart-state.json");
        const restartEvents: Array<{ waitingSessions?: number }> = [];
        globalBus.subscribe((event) => {
          if (event.type === "server:restart-pending") {
            restartEvents.push({ waitingSessions: event.waitingSessions });
          }
        });

        const { session, getHandler, getReleaseSend } = makeSession();
        manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };
        manager.startWork("session-handoff-event", "hello");
        await flushMicrotasks();

        await writeRestartState(restartStatePath, {
          requestId: "req-handoff-events",
          phase: "waiting-for-sessions",
          requestedAt: "2026-01-01T00:00:00.000Z",
          waitingSessions: 1,
          launcherHeartbeatAt: "2026-01-01T00:00:01.000Z",
        });
        await refreshRestartState();

        getReleaseSend()?.();
        await flushMicrotasks();
        getHandler()?.({ type: "session.idle", data: {}, timestamp: new Date(Date.now() + 1).toISOString() });
        await flushMicrotasks();

        expect(restartEvents).toContainEqual({ waitingSessions: 0 });
        expect(getRestartWaitingCount()).toBe(0);

        await expect(refreshRestartState()).resolves.toMatchObject({
          requestId: "req-handoff-events",
          launcherHeartbeatAt: "2026-01-01T00:00:01.000Z",
          waitingSessions: 0,
        });
        expect(getRestartWaitingCount()).toBe(0);

        const diskState = await readRestartState(restartStatePath);
        expect(diskState.phase).toBe("waiting-for-sessions");
        expect(diskState.launcherHeartbeatAt).toBe("2026-01-01T00:00:01.000Z");
        expect(diskState.requestId).toBe("req-handoff-events");
        expect(diskState.waitingSessions).toBe(1);

        await writeRestartState(restartStatePath, {
          ...diskState,
          waitingSessions: 2,
          launcherHeartbeatAt: "2026-01-01T00:00:04.000Z",
        });
        await expect(refreshRestartState()).resolves.toMatchObject({
          requestId: "req-handoff-events",
          launcherHeartbeatAt: "2026-01-01T00:00:04.000Z",
          waitingSessions: 2,
        });
      } finally {
        configureRestartStateStore(undefined);
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(copilotHome, { recursive: true, force: true });
      }
    });

    it("does not clobber launcher phase when launcher advanced to restarting without a heartbeat yet", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-phase-"));
      const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home2-"));
      try {
        const { manager } = createManager({ copilotHome });
        configureRestartStateStore({
          dataDir,
          docsDir: join(dataDir, "docs"),
          env: { ...process.env, BRIDGE_DATA_DIR: dataDir, BRIDGE_DOCS_DIR: join(dataDir, "docs") },
        });
        const restartStatePath = join(dataDir, "restart-state.json");

        const { session, getHandler, getReleaseSend } = makeSession();
        manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };
        manager.startWork("session-2", "hello");
        await flushMicrotasks();

        await writeRestartState(restartStatePath, {
          requestId: "req-phase-only",
          phase: "waiting-for-sessions",
          requestedAt: "2026-01-01T00:00:00.000Z",
          waitingSessions: 1,
          launcherHeartbeatAt: null,
        });
        await refreshRestartState();

        // Launcher transitions phase to "restarting" but has not written launcherHeartbeatAt yet
        await writeRestartState(restartStatePath, {
          requestId: "req-phase-only",
          phase: "restarting",
          requestedAt: "2026-01-01T00:00:00.000Z",
          waitingSessions: 1,
          launcherHeartbeatAt: null,
        });

        getReleaseSend()?.();
        await flushMicrotasks();
        getHandler()?.({ type: "session.idle", data: {}, timestamp: new Date(Date.now() + 1).toISOString() });
        await flushMicrotasks();

        await refreshRestartState();

        const diskState = await readRestartState(restartStatePath);
        expect(diskState.phase).toBe("restarting");
        expect(diskState.requestId).toBe("req-phase-only");
      } finally {
        configureRestartStateStore(undefined);
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(copilotHome, { recursive: true, force: true });
      }
    });

    it("keeps pre-pickup waiting-session countdown in memory without rewriting disk", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-pre-pickup-"));
      const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home3-"));
      try {
        const { manager } = createManager({ copilotHome });
        configureRestartStateStore({
          dataDir,
          docsDir: join(dataDir, "docs"),
          env: { ...process.env, BRIDGE_DATA_DIR: dataDir, BRIDGE_DOCS_DIR: join(dataDir, "docs") },
        });
        const restartStatePath = join(dataDir, "restart-state.json");

        const { session, getHandler, getReleaseSend } = makeSession();
        manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };
        manager.startWork("session-3", "hello");
        await flushMicrotasks();

        // Server-initiated restart — launcher has NOT picked up yet (no launcherHeartbeatAt, no "restarting" phase)
        await writeRestartState(restartStatePath, {
          requestId: "req-pre-pickup",
          phase: "waiting-for-sessions",
          requestedAt: "2026-01-01T00:00:00.000Z",
          waitingSessions: 1,
          launcherHeartbeatAt: null,
        });
        await refreshRestartState();

        // Session ends — server should update in-memory/UI state only until the launcher picks up.
        getReleaseSend()?.();
        await flushMicrotasks();
        getHandler()?.({ type: "session.idle", data: {}, timestamp: new Date(Date.now() + 1).toISOString() });
        await flushMicrotasks();

        const refreshedState = await refreshRestartState();

        const diskState = await readRestartState(restartStatePath);
        expect(refreshedState.phase).toBe("queued");
        expect(refreshedState.waitingSessions).toBe(0);
        expect(getRestartWaitingCount()).toBe(0);
        expect(isRestartImminent()).toBe(true);
        expect(diskState.phase).toBe("waiting-for-sessions");
        expect(diskState.waitingSessions).toBe(1);
        expect(diskState.requestId).toBe("req-pre-pickup");
        expect(diskState.launcherHeartbeatAt).toBeNull();
      } finally {
        configureRestartStateStore(undefined);
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(copilotHome, { recursive: true, force: true });
      }
    });

    it("keeps queued restart-state writes bound to the path active when they were enqueued", async () => {
      const firstDataDir = mkdtempSync(join(tmpdir(), "bridge-restart-first-"));
      const secondDataDir = mkdtempSync(join(tmpdir(), "bridge-restart-second-"));
      try {
        const firstRuntimePaths = {
          dataDir: firstDataDir,
          docsDir: join(firstDataDir, "docs"),
          env: { ...process.env, BRIDGE_DATA_DIR: firstDataDir, BRIDGE_DOCS_DIR: join(firstDataDir, "docs") },
        };
        const secondRuntimePaths = {
          dataDir: secondDataDir,
          docsDir: join(secondDataDir, "docs"),
          env: { ...process.env, BRIDGE_DATA_DIR: secondDataDir, BRIDGE_DOCS_DIR: join(secondDataDir, "docs") },
        };
        const firstRestartStatePath = join(firstDataDir, "restart-state.json");
        const secondRestartStatePath = join(secondDataDir, "restart-state.json");

        configureRestartStateStore(firstRuntimePaths);
        triggerRestartPending();
        configureRestartStateStore(secondRuntimePaths);

        await waitForRestartPhase(firstRestartStatePath, "queued");
        expect(isRestartPending()).toBe(false);
        await expect(refreshRestartState()).resolves.toMatchObject({ phase: "idle" });
        expect((await readRestartState(secondRestartStatePath)).phase).toBe("idle");

        await writeRestartState(firstRestartStatePath, {
          requestId: "req-first",
          phase: "waiting-for-sessions",
          requestedAt: "2026-01-01T00:00:00.000Z",
          waitingSessions: 1,
          launcherHeartbeatAt: null,
        });
        await writeRestartState(secondRestartStatePath, {
          requestId: "req-second",
          phase: "waiting-for-sessions",
          requestedAt: "2026-01-01T00:00:00.000Z",
          waitingSessions: 1,
          launcherHeartbeatAt: null,
        });

        configureRestartStateStore(firstRuntimePaths);
        await refreshRestartState();
        clearRestartPending();
        configureRestartStateStore(secondRuntimePaths);

        await waitForRestartPhase(firstRestartStatePath, "idle");
        const secondDiskState = await readRestartState(secondRestartStatePath);
        expect(secondDiskState.phase).toBe("waiting-for-sessions");
        expect(secondDiskState.requestId).toBe("req-second");
      } finally {
        configureRestartStateStore(undefined);
        rmSync(firstDataDir, { recursive: true, force: true });
        rmSync(secondDataDir, { recursive: true, force: true });
      }
    });
  });

});
