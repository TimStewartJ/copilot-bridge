import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeRestartState } from "../restart-state.js";
import { PENDING_INTERACTION_AUTO_ANSWER, SessionManager } from "../session-manager.js";

import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createSessionContextStore } from "../session-context-store.js";
import type { TelemetryStore } from "../telemetry-store.js";
import type { RuntimePaths } from "../runtime-paths.js";
import { setupTestDb, createTestBus, makeAgentSessionStub, makeTestDir, makeTestRuntimePaths } from "./helpers.js";

// Captured before any test installs fake timers: real file I/O only finishes on the real event loop.
const realSetImmediate = setImmediate;

describe("SessionManager run state", () => {
  function createManager(opts: {
    copilotHome?: string;
    runtimePaths?: RuntimePaths;
    telemetry?: boolean;
    settingsStore?: {
      getMcpServers: () => Record<string, never>;
      getSettings: () => { mcpServers: Record<string, never> };
    };
  } = {}) {
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

    const sessionMetaStore = createSessionMetaStore(db);
    const manager = new SessionManager({
      globalBus,
      eventBusRegistry,
      sessionTitles: createSessionTitlesStore(db),
      sessionMetaStore,
      taskStore: {
        findTaskBySessionId: vi.fn().mockReturnValue(null),
      } as any,
      settingsStore: (opts.settingsStore ?? {
        getMcpServers: () => ({}),
        getSettings: () => ({ mcpServers: {} }),
      }) as any,
      config: { sessionMcpServers: {} },
      telemetryStore,
      sessionContextStore,
      clientEnv: runtimePaths.env,
      copilotHome,
      runtimePaths,
    }) as any;

    return { manager, globalBus, eventBusRegistry, db, telemetryStore, sessionContextStore, sessionMetaStore, copilotHome };
  }

  function writeSessionEvents(copilotHome: string | undefined, sessionId: string, events: unknown[]): void {
    if (!copilotHome) throw new Error("test manager has no copilotHome");
    const dir = join(copilotHome, "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }

  function makeSession() {
    const handlers: Array<(event: any) => void> = [];
    const pendingUserInputs: any[] = [];
    const pendingElicitations: any[] = [];
    let releaseSend: (() => void) | undefined;
    const session = makeAgentSessionStub({
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((cb: (event: any) => void) => {
        handlers.push(cb);
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
      // `undefined` is a runtime that cannot say what it is doing, so the watchdog leaves the run alone.
      getActivity: vi.fn(async (): Promise<{ processing: boolean } | undefined> => undefined),
      listTasks: vi.fn(async (): Promise<{ tasks: any[] }> => ({ tasks: [] })),
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      respondToUserInput: vi.fn(async (requestId: string) => {
        const index = pendingUserInputs.findIndex((request) => request.requestId === requestId);
        if (index < 0) return false;
        pendingUserInputs.splice(index, 1);
        return true;
      }),
      tryRespondToElicitation: vi.fn(async (requestId: string) => {
        const index = pendingElicitations.findIndex((request) => request.requestId === requestId);
        if (index < 0) return false;
        pendingElicitations.splice(index, 1);
        return true;
      }),
    });
    const getHandler = () => {
      if (handlers.length === 0) return undefined;
      return (event: any) => {
        for (const handler of [...handlers]) {
          handler(event);
        }
      };
    };
    const getReleaseSend = () => releaseSend;
    return {
      session,
      getHandler,
      getReleaseSend,
      pendingUserInputs,
      pendingElicitations,
    };
  }

  async function flushMicrotasks() {
    // Deep enough to drain the agent-registry reap the resume path now awaits:
    // session doubles expose the full AgentSession facade, so `listTasks` runs
    // for real instead of short-circuiting on a missing method.
    for (let i = 0; i < 80; i++) await Promise.resolve();
  }

  function latestSpanMetadata(telemetryStore: TelemetryStore | undefined, name: string, sessionId: string): Record<string, unknown> {
    expect(telemetryStore).toBeDefined();
    const [span] = telemetryStore!.querySpans({ name, sessionId, limit: 10 });
    expect(span).toBeDefined();
    return span.metadata ?? {};
  }

  /** Starts a run whose prompt the runtime has accepted, with its events.jsonl under a temp Copilot home. */
  async function startDeliveredRun(name: string) {
    const created = createManager({ copilotHome: makeTestDir(name), telemetry: true });
    const made = makeSession();
    created.manager.backend = { resumeSession: vi.fn().mockResolvedValue(made.session) };
    const sessionId = `session-${name}`;
    const bus = created.eventBusRegistry.getOrCreateBus(sessionId);
    created.manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    made.getReleaseSend()?.();
    await flushMicrotasks();
    return { ...created, ...made, sessionId, bus, startedAt: Date.now() };
  }

  function at(run: { startedAt: number }, offsetMs: number): string {
    return new Date(run.startedAt + offsetMs).toISOString();
  }

  /**
   * Drives a watchdog tick to its end. A tick alternates real file I/O with a wait on the fake
   * clock before it asks the runtime a second time, so neither an advance nor an await alone finishes it.
   */
  async function settleWatchdog(manager: any, sessionId: string): Promise<void> {
    let settled = false;
    const idle = manager.waitForSessionWatchdogIdle(sessionId).then(() => {
      settled = true;
    });
    while (!settled) {
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await idle;
    await flushMicrotasks();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {

    vi.useRealTimers();
  });

  it("reuses cached Claude sessions without pre-send model or history inspection", async () => {
    const sessionId = "session-claude-cache-reuse";
    const { manager } = createManager();
    const cached = makeSession();
    cached.session.getCurrentModel = vi.fn();
    manager.sessionObjects.set(sessionId, cached.session);
    manager.backend = {
      resumeSession: vi.fn(),
    };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();

    expect(cached.session.send).toHaveBeenCalledWith({ prompt: "hello" });
    expect(cached.session.getCurrentModel).not.toHaveBeenCalled();
    expect(cached.session.disconnect).not.toHaveBeenCalled();
    expect(manager.backend.resumeSession).not.toHaveBeenCalled();

    cached.getReleaseSend()?.();
    await flushMicrotasks();
    cached.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(Date.now() + 1).toISOString(),
    });
    await flushMicrotasks();
  });

  it("allows startWork while persisted restart state is active or launcher is waiting for active sessions", async () => {
    // allows startWork while persisted restart state is active and updates waiting sessions
    {
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

      await writeRestartState(join(dataDir, "restart-state.json"), { phase: "restarting", releaseFailure: null });

      expect(() => manager.startWork("session-1", "hello")).not.toThrow();
      await flushMicrotasks();

      expect(manager.backend.resumeSession).toHaveBeenCalled();
      expect(manager.backend.resumeSession.mock.calls[0]?.[0]).toBe("session-1");
      expect(manager.getSessionRunState("session-1")).toBe("busy");
      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);

      getReleaseSend()?.();
      await flushMicrotasks();
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      await flushMicrotasks();
      expect(manager.getSessionRunState("session-1")).toBe("idle");
      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    } finally {

      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
    }

    // allows startWork while the launcher is waiting for active sessions
    {
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

      await writeRestartState(join(dataDir, "restart-state.json"), { phase: "restarting", releaseFailure: null });

      expect(() => manager.startWork("session-1", "hello")).not.toThrow();
      await flushMicrotasks();

      expect(manager.backend.resumeSession).toHaveBeenCalledWith("session-1", expect.anything());
      expect(manager.getSessionRunState("session-1")).toBe("busy");
      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);

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

      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
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
    expect(bus?.getSnapshot().pendingUserMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "please adjust", pending: true }),
    ]));

    getHandler()?.({
      id: "user-event-hello",
      type: "user.message",
      data: { content: "hello" },
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    expect(bus?.getSnapshot().pendingUserMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: "hello",
        pending: false,
        sourceEventId: "user-event-hello",
      }),
      expect.objectContaining({ content: "please adjust", pending: true }),
    ]));

    getHandler()?.({
      id: "user-event-steer",
      type: "user.message",
      data: { content: "please adjust" },
      timestamp: "2026-04-24T12:00:01.000Z",
    });
    expect(bus?.getSnapshot().pendingUserMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: "please adjust",
        pending: false,
        sourceEventId: "user-event-steer",
      }),
    ]));
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
    const { manager, telemetryStore, sessionMetaStore } = createManager({ telemetry: true });
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
      id: "terminal-event-live-idle",
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
    (session as any).cancelTask = vi.fn(async (id: string) => {
      if (id !== "sync-check" || status !== "idle") return { cancelled: false };
      status = "cancelled";
      return { cancelled: true };
    });
    (session as any).removeTask = vi.fn(async (id: string) => {
      removed = id === "sync-check" && status === "cancelled";
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

    expect((session as any).cancelTask).toHaveBeenCalledWith("sync-check");
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

  it("keeps the parent run active when a subagent query errors", async () => {
    const sessionId = "session-sync-subagent-query-error";
    const { manager, eventBusRegistry, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const bus = eventBusRegistry.getOrCreateBus(sessionId);
    const received: any[] = [];
    bus.subscribe((event) => received.push(event));
    manager.startWork(sessionId, "review the validator");
    await flushMicrotasks();
    const handler = getHandler();
    const baseTime = Date.now();

    handler?.({
      type: "assistant.turn_start",
      timestamp: new Date(baseTime + 1_000).toISOString(),
      data: { turnId: "1" },
    });
    handler?.({
      type: "tool.execution_start",
      timestamp: new Date(baseTime + 2_000).toISOString(),
      data: {
        toolCallId: "sync-agent-1",
        toolName: "task",
        arguments: { mode: "sync", agent_type: "code-review" },
      },
    });
    handler?.({
      type: "subagent.started",
      timestamp: new Date(baseTime + 3_000).toISOString(),
      data: { toolCallId: "sync-agent-1", agentName: "code-review" },
    });
    handler?.({
      id: "subagent-query-error-1",
      type: "session.error",
      agentId: "sync-agent-1",
      timestamp: new Date(baseTime + 4_000).toISOString(),
      data: {
        errorType: "query",
        message: "CAPIError: flagged child request",
      },
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(bus.getSnapshot().complete).toBe(false);
    expect(latestSpanMetadata(telemetryStore, "session.subagent.error", sessionId)).toMatchObject({
      subagentTracked: true,
      errorType: "query",
    });

    handler?.({
      type: "subagent.completed",
      timestamp: new Date(baseTime + 4_010).toISOString(),
      data: { toolCallId: "sync-agent-1" },
    });
    handler?.({
      type: "tool.execution_complete",
      timestamp: new Date(baseTime + 4_020).toISOString(),
      data: { toolCallId: "sync-agent-1", success: true, result: "" },
    });
    expect(received).toContainEqual(expect.objectContaining({
      type: "tool_done",
      toolCallId: "sync-agent-1",
      name: "🤖 code-review",
      result: "CAPIError: flagged child request",
      success: false,
      isSubAgent: true,
    }));
    handler?.({
      type: "assistant.turn_end",
      timestamp: new Date(baseTime + 5_000).toISOString(),
      data: { turnId: "1" },
    });
    handler?.({
      type: "assistant.turn_start",
      timestamp: new Date(baseTime + 6_000).toISOString(),
      data: { turnId: "2" },
    });
    handler?.({
      id: "parent-response-1",
      type: "assistant.message",
      timestamp: new Date(baseTime + 7_000).toISOString(),
      data: { content: "Parent continued successfully." },
    });
    handler?.({
      type: "assistant.turn_end",
      timestamp: new Date(baseTime + 8_000).toISOString(),
      data: { turnId: "2" },
    });
    getReleaseSend()?.();
    await flushMicrotasks();
    handler?.({
      id: "parent-idle-1",
      type: "session.idle",
      timestamp: new Date(baseTime + 9_000).toISOString(),
      data: {},
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(bus.getTerminalState()).toMatchObject({
      complete: true,
      terminalType: "done",
      finalContent: "Parent continued successfully.",
    });
  });

  it("keeps root query errors terminal while a background subagent is active", async () => {
    const sessionId = "session-background-subagent-root-error";
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const bus = eventBusRegistry.getOrCreateBus(sessionId);
    manager.startWork(sessionId, "start a background review");
    await flushMicrotasks();
    const handler = getHandler();

    handler?.({
      type: "tool.execution_start",
      data: {
        toolCallId: "background-agent-1",
        toolName: "task",
        arguments: { mode: "background", agent_type: "code-review" },
      },
    });
    handler?.({
      type: "subagent.started",
      data: { toolCallId: "background-agent-1", agentName: "code-review" },
    });
    handler?.({
      id: "root-query-error-1",
      type: "session.error",
      data: {
        errorType: "query",
        message: "Root request failed",
      },
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(bus.getTerminalState()).toMatchObject({
      complete: true,
      terminalType: "error",
      errorMessage: "Root request failed",
    });
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

  it("records live cache breaks safely and preserves usage expiry without attributing unknown subagents to the parent", async () => {
    const { manager, sessionContextStore, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };
    manager.startWork("session-cache", "hello");
    await flushMicrotasks();
    const handler = getHandler();
    expect(handler).toBeDefined();
    handler?.({ type: "assistant.turn_start", data: {}, timestamp: "2026-05-01T10:00:00Z" });
    handler?.({ type: "prompt_cache_break", id: "root-break", data: { primaryReason: "unknown" } });
    const rootBreak = latestSpanMetadata(telemetryStore, "session.prompt_cache_break", "session-cache");
    expect(rootBreak).toMatchObject({
      attribution: "turn", providerEventId: "root-break", bridgeTurnId: expect.any(String),
    });
    handler?.({
      type: "prompt_cache_break", agentId: "unmapped-child", data: {
        primaryReason: "changed", contributingReasons: ["changed"],
        survivedTokens: 10, frontierTokens: 20, shortfallTokens: 10, retentionRatio: 0.5,
        beforeRequest: { systemPrompt: "secret" }, toolsAddedRaw: ["private-tool"],
      },
    });
    handler?.({
      type: "assistant.usage", id: "child-cache-usage", agentId: "unmapped-child",
      timestamp: "2026-05-01T10:00:01Z",
      data: { cacheReadTokens: 10, cacheWriteTokens: 20, cacheExpiresAt: "2026-05-01T10:05:00Z" },
    });
    handler?.({
      type: "assistant.usage", id: "parent-cache-usage",
      timestamp: "2026-05-01T10:00:02Z",
      data: { cacheReadTokens: 30, cacheWriteTokens: 40, cacheExpiresAt: "not a timestamp" },
    });
    getReleaseSend()?.();
    await flushMicrotasks();
    handler?.({ type: "session.idle", data: {} });
    await flushMicrotasks();
    const metadata = latestSpanMetadata(telemetryStore, "session.prompt_cache_break", "session-cache");
    expect(metadata).toMatchObject({
      attribution: "subagent_turn", shortfallTokens: 10, agentId: "unmapped-child",
      processStartedAt: expect.any(String), processId: process.pid,
    });
    expect(metadata.bridgeTurnId).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toMatch(/secret|private-tool|systemPrompt/);
    const events = sessionContextStore.getSessionContext("session-cache").events;
    expect(events.find((event) => event.providerEventId === "child-cache-usage")).toMatchObject({
      attribution: "subagent_turn", bridgeTurnId: null,
      modelUsage: { cacheReadTokens: 10, cacheWriteTokens: 20 },
      metadata: { cacheExpiresAt: "2026-05-01T10:05:00Z" },
    });
    const parent = events.find((event) => event.providerEventId === "parent-cache-usage");
    expect(parent).toMatchObject({ attribution: "turn", modelUsage: { cacheReadTokens: 30, cacheWriteTokens: 40 } });
    expect(parent?.metadata?.cacheExpiresAt).toBeUndefined();
  });

  it("cleans the subagent turn mapping without attributing late child usage to the parent", async () => {
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
      attribution: "subagent_turn",
      bridgeTurnId: null,
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
    expect(bus?.getSnapshot().pendingUserMessages).toEqual([
      expect.objectContaining({
        content: "Autopilot objective: fix tests",
        pending: false,
      }),
    ]);

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
    expect(eventBusRegistry.getBus("session-1")?.getTerminalState().finalContent).toBe("Command output");
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

  it("gives up on a hanging slash-command rpc without caching the miss", async () => {
    const { manager } = createManager();
    const { session } = makeSession();
    session.listSlashCommands.mockImplementation(() => new Promise(() => {}));
    manager.sessionObjects.set("session-1", session);

    vi.useFakeTimers();
    try {
      const pending = manager.listSlashCommands("session-1");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({ supported: false, commands: [] });
    } finally {
      vi.useRealTimers();
    }
    expect(manager.slashCommandListCache.has("session-1")).toBe(false);

    // Once the session answers, the next call is served and cached.
    session.listSlashCommands.mockResolvedValue({ commands: [{ name: "goal", description: "d", kind: "builtin", allowDuringAgentExecution: true }] });
    await expect(manager.listSlashCommands("session-1")).resolves.toMatchObject({ supported: true });
    expect(manager.slashCommandListCache.has("session-1")).toBe(true);
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
    const session = makeAgentSessionStub({
      on: vi.fn((handler: (event: any) => void) => {
        handlers.push(handler);
        return vi.fn();
      }),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    });
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
    (manager as any).sessionOverlayBusyReasons.set("session-1", "model-switching");

    await expect(manager.steerSession("session-1", "please adjust")).rejects.toThrow("not accepting steering");
  });

  it("derives busy and active state from the owned overlay reason", () => {
    const { manager } = createManager();
    (manager as any).sessionOverlayBusyReasons.set("session-1", "history-undo");

    expect(manager.isSessionBusy("session-1")).toBe(true);
    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(manager.getActiveSessions()).toContain("session-1");
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
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().pendingUserMessages.some((message) => message.pending))
      .toBe(false);
  });

  it("discards the projected steering message when the immediate send fails", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();

    session.send.mockRejectedValueOnce(new Error("steer failed"));
    await expect(manager.steerSession("session-1", "please adjust")).rejects.toThrow("steer failed");

    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().pendingUserMessages).toEqual([
      expect.objectContaining({ content: "hello" }),
    ]);

    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-24T12:00:00.000Z",
    });
    await flushMicrotasks();
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

  it("keeps passive session warmup out of the user-visible run state", async () => {
    const { manager } = createManager();
    const resumedSession = makeAgentSessionStub({ sessionId: "session-1" });
    let resolveResume!: (session: typeof resumedSession) => void;
    manager.backend = {
      resumeSession: vi.fn(() => new Promise<typeof resumedSession>((resolve) => {
        resolveResume = resolve;
      })),
    };

    const warming = manager.warmSession("session-1");
    await flushMicrotasks();

    expect(manager.isSessionBusy("session-1")).toBe(true);
    expect(manager.getActiveSessions()).toContain("session-1");
    expect(manager.getSessionRunState("session-1")).toBe("idle");

    resolveResume(resumedSession);
    await warming;

    expect(manager.isSessionBusy("session-1")).toBe(false);
    expect(manager.getActiveSessions()).not.toContain("session-1");
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("keeps restart waiting count nonzero when a normal run ends while a cold resume or model switch is active", async () => {
    // cold resume is active
    {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-resume-count-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-resume-count-"));
    try {
      const { manager } = createManager({ copilotHome });
      const restartStatePath = join(dataDir, "restart-state.json");

      const messageSession = makeAgentSessionStub({ sessionId: "message-session" });
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

      await writeRestartState(restartStatePath, { phase: "restarting", releaseFailure: null });

      getReleaseSend()?.();
      await flushMicrotasks();
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      await flushMicrotasks();

      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);

      resolveMessageResume(messageSession);
      await messageLoad;
      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    } finally {

      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
    }

    // model switch is active
    {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-model-switch-count-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-model-switch-count-"));
    try {
      const { manager } = createManager({ copilotHome });
      const restartStatePath = join(dataDir, "restart-state.json");

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

      manager.startWork("run-session", "hello");
      await flushMicrotasks();

      await writeRestartState(restartStatePath, { phase: "restarting", releaseFailure: null });

      const switching = manager.setSessionModel("switch-session", "gpt-5.5");
      await vi.waitFor(() => expect(switchSession.setModel).toHaveBeenCalledTimes(1));
      expect(manager.getLifecycleBlockingSessionCount()).toBe(2);

      getReleaseSend()?.();
      await flushMicrotasks();
      getHandler()?.({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      await flushMicrotasks();

      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);

      resolveSetModel();
      await switching;
      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    } finally {

      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
    }
  });
  it("syncs restart waiting count when a cold resume starts and finishes during restart pending", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-resume-only-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-resume-only-"));
    try {
      const { manager } = createManager({ copilotHome });
      const restartStatePath = join(dataDir, "restart-state.json");

      await writeRestartState(restartStatePath, { phase: "restarting", releaseFailure: null });

      const resumedSession = makeAgentSessionStub({ sessionId: "session-1" });
      let resolveResume!: (session: typeof resumedSession) => void;
      manager.backend = {
        resumeSession: vi.fn(() => new Promise<typeof resumedSession>((resolve) => {
          resolveResume = resolve;
        })),
      };

      const messageLoad = manager.warmSession("message-session");
      await flushMicrotasks();

      expect(manager.getLifecycleBlockingSessionCount()).toBe(1);

      resolveResume(resumedSession);
      await messageLoad;

      expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    } finally {

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
    expect(stale.session.disconnect).not.toHaveBeenCalled();
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

  it("allows session creation paths while the launcher is waiting for active sessions", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-restart-run-state-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-restart-home-"));
    try {
      const { manager } = createManager({
        copilotHome,
      });
      manager.backend = {
        createSession: vi.fn().mockResolvedValue(makeAgentSessionStub({ sessionId: "created-session" })),
      };

      await writeRestartState(join(dataDir, "restart-state.json"), { phase: "restarting", releaseFailure: null });

      await expect(manager.createSession()).resolves.toEqual({ sessionId: "created-session" });
      expect(manager.backend.createSession).toHaveBeenCalledOnce();
    } finally {

      rmSync(dataDir, { recursive: true, force: true });
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it("fails before backend creation when settings become unreadable at the creation boundary", async () => {
    const getSettings = vi.fn()
      .mockReturnValueOnce({ mcpServers: {} })
      .mockImplementation(() => {
        throw new Error("persisted settings unreadable");
      });
    const { manager } = createManager({
      settingsStore: {
        getMcpServers: () => ({}),
        getSettings,
      },
    });
    manager.backend = {
      createSession: vi.fn(),
    };

    await expect(manager.createSession()).rejects.toThrow("persisted settings unreadable");
    expect(manager.backend.createSession).not.toHaveBeenCalled();
    expect(manager.getRuntimeActivity().capacity.contexts.retained).toBe(0);
    expect(manager.getRuntimeActivity().capacity.weightedUnits.retained).toBe(0);
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
    expect(row?.lastAttentionAt).toBeNull();
  });

  it("startWorkAndWaitForDelivery rejects when send fails before acceptance", async () => {
    const { manager } = createManager();
    const session = makeAgentSessionStub({
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(() => vi.fn()),
      send: vi.fn(async () => {
        throw new Error("send failed");
      }),
      disconnect: vi.fn(),
    });
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    await expect(manager.startWorkAndWaitForDelivery("session-1", "hello")).rejects.toThrow("send failed");
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("truncates a previous quiet interval defer tail before sending the next interval prompt", async () => {
    const { manager, globalBus, copilotHome } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    const statusEvents: any[] = [];
    const truncate = vi.fn(async () => ({ eventsRemoved: 3 }));
    writeSessionEvents(copilotHome, "session-1", [
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
    ]);
    Object.assign(session, {
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
    // The truncation boundary is read from events.jsonl on disk, so real I/O must settle first.
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());

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
      copilotHome,
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
    const session = makeAgentSessionStub({
      sessionId: "session-1",
      on: vi.fn(() => vi.fn()),
      send: vi.fn(),
      abort: vi.fn(),
      setModel: vi.fn(),
      disconnect: vi.fn(),
      truncateHistory,
    });
    writeSessionEvents(copilotHome, "session-1", events);
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };
    const endSessionResume = vi.spyOn(manager, "endSessionResume");
    const flushPendingSessionEviction = vi.spyOn(manager, "flushPendingSessionEviction");
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
    expect(endSessionResume).toHaveBeenCalledTimes(1);
    expect(flushPendingSessionEviction).toHaveBeenCalledTimes(1);
  });

  it("releases undo resume cleanup exactly once on resume failure or timeout", async () => {
    // releases undo resume cleanup exactly once when resume fails
    {
    const { manager } = createManager({ telemetry: true });
    const resumeError = new Error("resume failed");
    manager.backend = {
      resumeSession: vi.fn().mockRejectedValue(resumeError),
    };
    const endSessionResume = vi.spyOn(manager, "endSessionResume");
    const flushPendingSessionEviction = vi.spyOn(manager, "flushPendingSessionEviction");

    await expect(manager.undoSessionTurn("session-1", "user-1")).rejects.toBe(resumeError);

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(endSessionResume).toHaveBeenCalledTimes(1);
    expect(flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    }

    // releases undo resume cleanup exactly once on timeout
    {
    const { manager } = createManager({ telemetry: true });
    manager.backend = {
      resumeSession: vi.fn(() => new Promise(() => {})),
    };
    const endSessionResume = vi.spyOn(manager, "endSessionResume");
    const flushPendingSessionEviction = vi.spyOn(manager, "flushPendingSessionEviction");

    const undo = manager.undoSessionTurn("session-1", "user-1");
    const rejection = expect(undo).rejects.toThrow("undo history resume timed out after 60s");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(endSessionResume).toHaveBeenCalledTimes(1);
    expect(flushPendingSessionEviction).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects stale or non-user undo boundaries before truncating history", async () => {
    const { manager, copilotHome } = createManager();
    const truncateHistory = vi.fn();
    writeSessionEvents(copilotHome, "session-1", [
      {
        id: "skill-browser",
        type: "user.message",
        data: { content: "<skill-context name=\"browser\">", source: "skill-browser" },
      },
    ]);
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        on: vi.fn(() => vi.fn()),
        send: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn(),
        disconnect: vi.fn(),
        truncateHistory,
      }),
    };

    await expect(manager.undoSessionTurn("session-1", "skill-browser")).rejects.toMatchObject({
      code: "stale-boundary",
    });
    expect(truncateHistory).not.toHaveBeenCalled();
  });

  it("can undo the first turn and clear all derived session activity", async () => {
    const { manager, sessionMetaStore, copilotHome } = createManager();
    sessionMetaStore.setLastVisibleActivityAt("session-1", "2026-05-09T10:00:01.000Z");
    sessionMetaStore.setLastAttentionAt("session-1", "2026-05-09T10:00:02.000Z");
    writeSessionEvents(copilotHome, "session-1", [
      { id: "user-1", type: "user.message", timestamp: "2026-05-09T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-05-09T10:00:01.000Z", data: { content: "Answer" } },
    ]);
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        on: vi.fn(() => vi.fn()),
        send: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn(),
        disconnect: vi.fn(),
        truncateHistory: vi.fn().mockResolvedValue({ eventsRemoved: 2 }),
      }),
    };

    await expect(manager.undoSessionTurn("session-1", "user-1"))
      .resolves.toEqual({ eventsRemoved: 2 });
    expect(sessionMetaStore.getMeta("session-1")).toBeUndefined();
  });

  it("marks undo as busy so concurrent mutations cannot race it", async () => {
    const { manager, copilotHome } = createManager();
    writeSessionEvents(copilotHome, "session-1", [
      { id: "user-1", type: "user.message", data: { content: "First" } },
    ]);
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
        truncateHistory,
      }),
    };

    const firstUndo = manager.undoSessionTurn("session-1", "user-1");
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");
    await expect(manager.undoSessionTurn("session-1", "user-1")).rejects.toMatchObject({
      code: "busy",
    });

    // The boundary lookup streams events.jsonl, so wait for the real disk read before releasing the RPC.
    await vi.waitFor(() => expect(truncateHistory).toHaveBeenCalled());
    releaseTruncate();
    await expect(firstUndo).resolves.toEqual({ eventsRemoved: 1 });
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("keeps advisory inactivity in the busy state until live events complete the run", async () => {
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

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await manager.waitForSessionWatchdogIdle("session-1");
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(manager.isSessionStalled("session-1")).toBe(false);
    expect(manager.getActiveSessions()).toEqual(["session-1"]);
    expect(manager.getSessionActivity()).toEqual([
      expect.objectContaining({
        id: "session-1",
        state: "busy",
      }),
    ]);
    const eventBase = Date.now();

    getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(eventBase + 1_000).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(eventBase + 2_000).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(manager.isSessionBusy("session-1")).toBe(false);
    expect(events).toEqual(["session:busy", "session:idle"]);
  });

  it("drops an unparseable request event without blocking a valid sibling", async () => {
    // Listings come from the event-derived index, so per-event normalization at
    // ingest is what keeps one malformed request from blanking the whole
    // reconnect snapshot or stranding a valid prompt.
    const sessionId = "session-unparseable-sibling";
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend, pendingElicitations } = makeSession();
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();

    // The runtime holds both requests regardless of whether Bridge could parse
    // them; only the index decides what Bridge is willing to answer.
    pendingElicitations.push({ requestId: "el-broken" }, { requestId: "el-valid" });
    const requestedSchema = {
      type: "object",
      properties: { target: { type: "string", enum: ["staging", "production"] } },
      required: ["target"],
    };
    // `message` must be a string; this entry cannot be normalized.
    getHandler()?.({
      type: "elicitation.requested",
      timestamp: new Date().toISOString(),
      data: { requestId: "el-broken", message: 42, mode: "form", requestedSchema },
    });
    getHandler()?.({
      type: "elicitation.requested",
      timestamp: new Date().toISOString(),
      data: { requestId: "el-valid", message: "Choose a target", mode: "form", requestedSchema },
    });
    await flushMicrotasks();

    expect(
      eventBusRegistry.getBus(sessionId)!.getPendingInteractionIndex()
        .pendingElicitations.map((request) => request.requestId),
    ).toEqual(["el-valid"]);

    // The malformed sibling is unknown to the index and must 404 rather than be
    // answered unvalidated; the valid one still resolves through the runtime.
    await expect(manager.submitElicitationResponse(sessionId, "el-broken", { action: "cancel" }))
      .rejects.toMatchObject({ code: "request_not_found", statusCode: 404 });
    await expect(manager.submitElicitationResponse(sessionId, "el-valid", { action: "cancel" }))
      .resolves.toMatchObject({ requestId: "el-valid", action: "cancel" });
  });

  it("keeps native elicitation waits busy beyond the no-progress warning window", async () => {
    const sessionId = "session-elicitation-wait";
    const { manager, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler, getReleaseSend, pendingElicitations } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();

    pendingElicitations.push({
      requestId: "el-1",
      request: {
        message: "Choose a deployment target",
        mode: "form",
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
      },
    });
    getHandler()?.({
      type: "elicitation.requested",
      data: {
        requestId: "el-1",
        message: "Choose a deployment target",
        mode: "form",
        requestedSchema: pendingElicitations[0].request.requestedSchema,
      },
      timestamp: new Date().toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getPendingUserInputCount(sessionId)).toBe(1);

    await vi.advanceTimersByTimeAsync(900_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(telemetryStore!.querySpans({ name: "session.run.no_progress_abort", sessionId })).toEqual([]);

    await manager.submitElicitationResponse(sessionId, "el-1", { action: "cancel" });
    expect(session.tryRespondToElicitation).toHaveBeenCalledWith("el-1", { action: "cancel" });
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

  it("auto-answers questions that waited an hour instead of aborting the turn", async () => {
    const sessionId = "session-auto-answer";
    const { manager, telemetryStore, globalBus } = createManager({ telemetry: true });
    const inputStatus = vi.fn();
    const unsubscribe = globalBus.subscribe(inputStatus);
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };
    // Like the runtime, a responder completes the request with a live event before it returns.
    session.respondToUserInput.mockImplementation(async (...[requestId, response]: any[]) => {
      getHandler()?.({
        type: "user_input.completed",
        data: { requestId, ...response },
        timestamp: new Date().toISOString(),
      });
      return true;
    });
    session.tryRespondToElicitation.mockImplementation(async (...[requestId, response]: any[]) => {
      getHandler()?.({
        type: "elicitation.completed",
        data: { requestId, action: response.action },
        timestamp: new Date().toISOString(),
      });
      return true;
    });

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();

    const multiSelect = { type: "array", items: { type: "string", enum: ["a", "b"] } };
    const approval = { type: "object", properties: { approved: { type: "boolean" }, extras: multiSelect } };
    const timestamp = new Date().toISOString();
    getHandler()?.({
      type: "user_input.requested",
      timestamp,
      data: { requestId: "ui-legacy", question: "Which one?" },
    });
    getHandler()?.({
      type: "elicitation.requested",
      timestamp,
      data: { requestId: "el-ask", message: "Approve?", mode: "form", requestedSchema: approval },
    });
    getHandler()?.({
      type: "elicitation.requested",
      timestamp,
      data: {
        requestId: "el-multi",
        message: "Extras?",
        mode: "form",
        requestedSchema: { type: "object", properties: { extras: multiSelect } },
      },
    });
    getHandler()?.({
      type: "elicitation.requested",
      timestamp,
      data: {
        requestId: "el-mcp",
        message: "Token?",
        mode: "form",
        elicitationSource: "some-mcp",
        requestedSchema: approval,
      },
    });
    await flushMicrotasks();
    expect(manager.getPendingUserInputCount(sessionId)).toBe(4);

    await vi.advanceTimersByTimeAsync(59 * 60_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    expect(session.respondToUserInput).not.toHaveBeenCalled();
    expect(session.tryRespondToElicitation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    await flushMicrotasks();

    expect(session.respondToUserInput.mock.calls).toEqual([
      ["ui-legacy", { answer: PENDING_INTERACTION_AUTO_ANSWER, wasFreeform: true }],
    ]);
    expect(session.tryRespondToElicitation.mock.calls).toEqual([
      ["el-ask", { action: "accept", content: { approved: PENDING_INTERACTION_AUTO_ANSWER } }],
      ["el-multi", { action: "accept", content: { extras: [PENDING_INTERACTION_AUTO_ANSWER] } }],
      ["el-mcp", { action: "cancel" }],
    ]);
    expect(manager.getPendingUserInputCount(sessionId)).toBe(0);
    expect(await manager.hydratePendingInteractions(sessionId)).toEqual({ pendingUserInputs: [], pendingElicitations: [] });
    expect(inputStatus).toHaveBeenCalledWith(expect.objectContaining({ type: "session:user-input", sessionId, needsUserInput: false }));
    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(session.abort).not.toHaveBeenCalled();
    expect(telemetryStore!.querySpans({ name: "session.run.no_progress", sessionId })).toEqual([]);
    expect(telemetryStore!.querySpans({ name: "session.run.no_progress_abort", sessionId })).toEqual([]);
    expect(telemetryStore!.querySpans({ name: "session.pending_interaction.auto_answer", sessionId })).toHaveLength(4);

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({ type: "session.idle", data: {}, timestamp: new Date().toISOString() });
    await flushMicrotasks();
    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    unsubscribe();
  });

  it("drops an overdue question the runtime no longer holds and lets the watchdog end the dead turn", async () => {
    const sessionId = "session-auto-answer-stale";
    const { manager } = createManager();
    // The default responder reports false for a request the runtime does not hold.
    const { session, getHandler } = makeSession();
    session.abort.mockImplementation(async () => {
      getHandler()?.({ type: "abort", data: { reason: "watchdog" }, timestamp: new Date().toISOString() });
    });
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    getHandler()?.({
      type: "elicitation.requested",
      timestamp: new Date().toISOString(),
      data: {
        requestId: "el-gone",
        message: "Approve?",
        mode: "form",
        requestedSchema: { type: "object", properties: { approved: { type: "boolean" } } },
      },
    });
    await flushMicrotasks();

    // Watchdog ticks await real file I/O under fake timers, so which tick observes the hour is not
    // exact. Settling between phases keeps the contract deterministic: one attempt, never retried,
    // and the next tick then ends the dead turn like any other stall.
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    await flushMicrotasks();
    expect(session.tryRespondToElicitation).toHaveBeenCalledTimes(1);
    expect(manager.getPendingUserInputCount(sessionId)).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    await flushMicrotasks();
    expect(session.tryRespondToElicitation).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(manager.getSessionRunState(sessionId)).toBe("idle");
  });

  it("translates runtime capability-loss cancellation without owning the request", async () => {
    const sessionId = "session-elicitation-cancel";
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend, pendingElicitations } = makeSession();
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };
    const events: any[] = [];

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();
    eventBusRegistry.getBus(sessionId)?.subscribe((event) => events.push(event));
    pendingElicitations.push({
      requestId: "el-cancel",
      request: {
        message: "Choose",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    getHandler()?.({
      type: "elicitation.requested",
      data: {
        requestId: "el-cancel",
        message: "Choose",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      },
      timestamp: "2026-07-23T12:00:00.000Z",
    });
    pendingElicitations.splice(0);
    getHandler()?.({
      type: "elicitation.completed",
      data: {
        requestId: "el-cancel",
        action: "cancel",
      },
      timestamp: "2026-07-23T12:00:01.000Z",
    });
    await flushMicrotasks();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "elicitation_requested", requestId: "el-cancel" }),
      expect.objectContaining({ type: "elicitation_canceled", requestId: "el-cancel" }),
    ]));
    expect(manager.getPendingUserInputCount(sessionId)).toBe(0);

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-07-23T12:00:02.000Z",
    });
    await flushMicrotasks();
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

  it("projects the final assistant message identity through terminal events and snapshots", async () => {
    const { manager, eventBusRegistry } = createManager();
    const { session, getHandler, getReleaseSend } = makeSession();
    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const received: any[] = [];
    bus.subscribe((event) => received.push(event));

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    getReleaseSend()?.();
    await flushMicrotasks();

    getHandler()?.({
      id: "turn-start-event",
      type: "assistant.turn_start",
      data: { turnId: "provider-turn-1" },
      timestamp: "2026-07-22T16:00:00.000Z",
    });
    getHandler()?.({
      id: "assistant-event-0",
      type: "assistant.message",
      data: { content: "First segment" },
      timestamp: "2026-07-22T16:00:00.500Z",
    });
    getHandler()?.({
      id: "assistant-event-1",
      type: "assistant.message",
      data: { content: "Final answer" },
      timestamp: "2026-07-22T16:00:01.000Z",
    });
    await flushMicrotasks();

    // Live segments carry the exact source-event id they will be committed under, so the client
    // can hand each one off to disk history by identity instead of merging transcripts.
    expect(bus.getSnapshot()).toMatchObject({
      streamingContent: "",
      liveAssistantSegments: [
        {
          id: "assistant-event-0",
          sourceEventId: "assistant-event-0",
          turnId: "provider-turn-1",
          turnInstanceId: "turn-start-event",
          content: "First segment",
        },
        {
          id: "assistant-event-1",
          sourceEventId: "assistant-event-1",
          turnId: "provider-turn-1",
          turnInstanceId: "turn-start-event",
          content: "Final answer",
        },
      ],
    });
    expect(received.filter((event) => event.type === "history_advanced").length)
      .toBeGreaterThanOrEqual(2);

    getHandler()?.({
      id: "terminal-event-1",
      type: "session.idle",
      data: {},
      timestamp: "2026-07-22T16:00:02.000Z",
    });
    await flushMicrotasks();

    expect(bus.getTerminalState()).toMatchObject({
      complete: true,
      terminalEventId: "terminal-event-1",
      terminalAssistantEventId: "assistant-event-1",
      finalContent: "Final answer",
    });
    expect(received).toContainEqual(expect.objectContaining({
      type: "done",
      sourceEventId: "terminal-event-1",
      assistantSourceEventId: "assistant-event-1",
      content: "Final answer",
    }));
  });

  it("records advisory no-progress telemetry without replacing or disconnecting the active session", async () => {
    const sessionId = "session-no-progress-warning";
    const { manager, telemetryStore } = createManager({ telemetry: true });
    const { session } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork(sessionId, "hello");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(session.disconnect).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(latestSpanMetadata(telemetryStore, "session.run.no_progress", sessionId)).toMatchObject({
      warningThresholdMs: 10 * 60_000,
      abortThresholdMs: 60 * 60_000,
    });
  });

  it("keeps a silent synchronous shell on the original session owner", async () => {
    const sessionId = "session-silent-sync-shell";
    const { manager } = createManager();
    const { session, getHandler } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork(sessionId, "hello");
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
          initial_wait: 3_600,
        },
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(session.disconnect).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("records completion telemetry for live session.idle", async () => {
    const sessionId = "session-live-idle-telemetry";
    const { manager, telemetryStore, sessionMetaStore } = createManager({ telemetry: true });
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
      id: "terminal-event-live-idle",
      type: "session.idle",
      timestamp: new Date(baseTime + 3_000).toISOString(),
      data: {},
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(sessionMetaStore.getTerminalOverlay(sessionId)).toBeUndefined();
    expect(latestSpanMetadata(telemetryStore, "session.run.complete", sessionId)).toMatchObject({
      completionSource: "live_session_idle",
      completionStatus: "done",
      terminalEventType: "session.idle",
      terminalEventOrigin: "live",
      finalContentLength: 4,
      assistantContentKnown: true,
      liveTurnEndCount: 1,
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
      liveTurnStartCount: 1,
      liveTurnEndCount: 1,
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
    expect(bus.getTerminalState()).toMatchObject({
      complete: true,
      terminalType: "done",
      finalContent: "final",
    });
    expect(latestSpanMetadata(telemetryStore, "session.run.complete", sessionId)).toMatchObject({
      completionSource: "live_session_idle",
      completionStatus: "done",
      terminalEventType: "session.idle",
      liveTurnEndCount: 2,
    });
  });

  it("trusts live session.idle after trailing tool activity without a new assistant turn", async () => {
    const sessionId = "session-idle-after-tool-tail";
    const { manager, eventBusRegistry } = createManager();
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
      data: { content: "finishing tool output" },
    });
    getHandler()?.({
      type: "assistant.turn_end",
      timestamp: new Date(baseTime + 2_000).toISOString(),
      data: { turnId: "1" },
    });
    getHandler()?.({
      type: "tool.execution_partial_result",
      data: { toolCallId: "shell-1", partialOutput: "done" },
    });
    getHandler()?.({
      type: "tool.execution_complete",
      timestamp: new Date(baseTime + 3_000).toISOString(),
      data: { toolCallId: "shell-1", success: true },
    });
    getHandler()?.({
      type: "session.idle",
      timestamp: new Date(baseTime + 4_000).toISOString(),
      data: {},
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(bus.getTerminalState()).toMatchObject({
      terminalType: "done",
      finalContent: "finishing tool output",
    });
  });

  describe("watchdog: the runtime decides whether a run is over", () => {
    /** The main agent stopping asks the runtime at once, well inside the runtime's hold on a notice. */
    const mainAgentIdle = (run: { getHandler: () => ((event: any) => void) | undefined }) =>
      run.getHandler()?.({ type: "assistant.idle", timestamp: new Date().toISOString(), data: {} });

    it("finishes a run from the log once the runtime reports it idle twice", async () => {
      const run = await startDeliveredRun("runtime-idle");
      run.session.getActivity.mockResolvedValue({ processing: false });
      // An attached shell defers `session.idle` for as long as it runs, and it never holds a run open.
      run.session.listTasks.mockResolvedValue({ tasks: [{ kind: "shell", id: "dev-server", status: "running" }] });
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "user.message", timestamp: at(run, 500), data: { content: "hello" } },
        { id: "reply-1", type: "assistant.message", timestamp: at(run, 1_000), data: { content: "server is up" } },
        { id: "turn-end-1", type: "assistant.turn_end", timestamp: at(run, 2_000), data: { turnId: "1" } },
      ]);

      await vi.advanceTimersByTimeAsync(60_000);
      await settleWatchdog(run.manager, run.sessionId);

      expect(run.session.getActivity).toHaveBeenCalledTimes(2);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
      expect(run.session.disconnect).not.toHaveBeenCalled();
      expect(run.bus.getTerminalState()).toMatchObject({
        terminalType: "done",
        terminalEventId: "turn-end-1",
        terminalAssistantEventId: "reply-1",
        finalContent: "server is up",
      });
      // The reply is already on disk, so no notice duplicates it.
      expect(run.bus.getSnapshot().runNotice).toBeUndefined();
      expect(latestSpanMetadata(run.telemetryStore, "session.run.complete", run.sessionId)).toMatchObject({
        completionSource: "persisted_assistant_turn_end_recovery",
        completionStatus: "done",
        terminalEventOrigin: "persisted_recovery",
        recoveryReason: "runtime idle",
        lastRuntimeAnswer: "idle",
      });
      expect(latestSpanMetadata(run.telemetryStore, "session.run.recovery", run.sessionId)).toMatchObject({
        outcome: "finished_from_log",
        runtimeAnswer: "idle",
        endingEventType: "assistant.turn_end",
        endingConclusive: false,
      });
    });

    it("keeps the run open while the runtime is processing, whatever the log ends with", async () => {
      const run = await startDeliveredRun("runtime-processing");
      run.session.getActivity.mockResolvedValue({ processing: true });
      // The main agent is mid-turn while a sub-agent's turn end is the newest line in the shared log.
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "user.message", timestamp: at(run, 500), data: { content: "hello" } },
        { type: "assistant.turn_end", timestamp: at(run, 1_000), data: { turnId: "5" } },
        { type: "assistant.turn_start", timestamp: at(run, 1_000), data: { turnId: "6" } },
        { type: "assistant.message", agentId: "explore-1", timestamp: at(run, 2_000), data: { content: "report" } },
        { type: "assistant.turn_end", agentId: "explore-1", timestamp: at(run, 2_000), data: { turnId: "7" } },
      ]);

      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await settleWatchdog(run.manager, run.sessionId);

      expect(run.manager.getSessionRunState(run.sessionId)).toBe("busy");
      expect(run.bus.getSnapshot().complete).toBe(false);

      run.getHandler()?.({ type: "assistant.message", timestamp: at(run, 200_000), data: { content: "finished" } });
      run.getHandler()?.({ type: "session.idle", timestamp: at(run, 201_000), data: {} });
      await flushMicrotasks();
      expect(run.bus.getTerminalState()).toMatchObject({ terminalType: "done", finalContent: "finished" });
    });

    it("keeps the run open while a background agent is running", async () => {
      const run = await startDeliveredRun("runtime-agent-running");
      run.session.getActivity.mockResolvedValue({ processing: false });
      let agentStatus = "running";
      run.session.listTasks.mockImplementation(async () => ({
        tasks: [{ kind: "agent", id: "reviewer", status: agentStatus, executionMode: "background" }],
      }));
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "assistant.message", timestamp: at(run, 1_000), data: { content: "waiting for the reviewer" } },
        { type: "assistant.turn_end", timestamp: at(run, 2_000), data: { turnId: "1" } },
      ]);

      await vi.advanceTimersByTimeAsync(60_000);
      await settleWatchdog(run.manager, run.sessionId);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("busy");

      // An idle agent with no unreported finish wakes nobody.
      agentStatus = "idle";
      await vi.advanceTimersByTimeAsync(60_000);
      await settleWatchdog(run.manager, run.sessionId);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
      expect(run.bus.getTerminalState()).toMatchObject({ terminalType: "done", finalContent: "waiting for the reviewer" });
    });

    it("keeps the run open until a finished background agent's notice reaches the main agent", async () => {
      const run = await startDeliveredRun("runtime-agent-notice");
      run.session.getActivity.mockResolvedValue({ processing: false });
      const idleSince = new Date().toISOString();
      // The shell makes the runtime hold the notice (60 s on CLI 1.0.88) instead of waking the agent at once.
      run.session.listTasks.mockResolvedValue({ tasks: [
        { kind: "agent", id: "reviewer", status: "idle", executionMode: "background", idleSince },
        { kind: "shell", id: "dev-server", status: "running" },
      ] });
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "assistant.message", timestamp: at(run, 1_000), data: { content: "waiting for the reviewer" } },
        { type: "assistant.turn_end", timestamp: at(run, 2_000), data: { turnId: "1" } },
      ]);

      mainAgentIdle(run);
      await settleWatchdog(run.manager, run.sessionId);
      expect(run.session.getActivity).toHaveBeenCalled();
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("busy");

      run.getHandler()?.({
        type: "system.notification",
        timestamp: new Date().toISOString(),
        data: { kind: { type: "agent_idle", agentId: "reviewer" } },
      });
      mainAgentIdle(run);
      await settleWatchdog(run.manager, run.sessionId);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
    });

    it("counts a successful read_agent as the main agent hearing about the agent", async () => {
      const run = await startDeliveredRun("runtime-agent-read");
      run.session.getActivity.mockResolvedValue({ processing: false });
      run.session.listTasks.mockResolvedValue({ tasks: [
        { kind: "agent", id: "reviewer", status: "idle", executionMode: "background", idleSince: new Date().toISOString() },
      ] });
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "assistant.turn_end", timestamp: at(run, 2_000), data: { turnId: "1" } },
      ]);
      const read = (toolCallId: string, success: boolean) => {
        const timestamp = new Date().toISOString();
        run.getHandler()?.({ type: "tool.execution_start", timestamp, data: { toolCallId, toolName: "read_agent", arguments: { agent_id: "reviewer" } } });
        run.getHandler()?.({ type: "tool.execution_complete", timestamp, data: { toolCallId, success } });
      };

      read("read-failed", false);
      mainAgentIdle(run);
      await settleWatchdog(run.manager, run.sessionId);
      expect(run.session.getActivity).toHaveBeenCalled();
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("busy");

      read("read-ok", true);
      mainAgentIdle(run);
      await settleWatchdog(run.manager, run.sessionId);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
    });

    it("does not wait for a notice the runtime will never send", async () => {
      const run = await startDeliveredRun("runtime-agent-no-notice");
      run.session.getActivity.mockResolvedValue({ processing: false });
      const recent = new Date().toISOString();
      run.session.listTasks.mockResolvedValue({ tasks: [
        { kind: "agent", id: "stale", status: "idle", executionMode: "background", idleSince: new Date(Date.now() - 91_000).toISOString() },
        { kind: "agent", id: "cancelled", status: "cancelled", executionMode: "background", completedAt: recent },
        { kind: "agent", id: "inline", status: "idle", executionMode: "sync", idleSince: recent },
      ] });
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "assistant.turn_end", timestamp: at(run, 2_000), data: { turnId: "1" } },
      ]);

      mainAgentIdle(run);
      await settleWatchdog(run.manager, run.sessionId);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
    });

    it("does not end a run on the moment of idleness before an autopilot continuation", async () => {
      const run = await startDeliveredRun("runtime-autopilot-gap");
      run.session.getActivity.mockResolvedValue({ processing: false });
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "assistant.message", timestamp: at(run, 1_000), data: { content: "one" } },
        { type: "assistant.turn_end", timestamp: at(run, 2_000), data: { turnId: "1" } },
      ]);

      // The main agent going idle asks the runtime at once instead of waiting for the next tick.
      run.getHandler()?.({ type: "assistant.idle", timestamp: at(run, 2_000), data: {} });
      while (run.session.getActivity.mock.calls.length === 0) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      await flushMicrotasks();
      // The runtime continues the agent while the watchdog waits to ask a second time.
      run.getHandler()?.({ type: "assistant.turn_start", timestamp: at(run, 2_100), data: { turnId: "2" } });
      await settleWatchdog(run.manager, run.sessionId);

      expect(run.session.getActivity).toHaveBeenCalledTimes(1);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("busy");
    });

    it("keeps the run open when the runtime is working again the second time it is asked", async () => {
      const run = await startDeliveredRun("runtime-working-again");
      run.session.getActivity
        .mockResolvedValueOnce({ processing: false })
        .mockResolvedValue({ processing: true });
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "assistant.turn_end", timestamp: at(run, 2_000), data: { turnId: "1" } },
      ]);

      await vi.advanceTimersByTimeAsync(60_000);
      await settleWatchdog(run.manager, run.sessionId);

      expect(run.session.getActivity).toHaveBeenCalledTimes(2);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("busy");
    });

    it("ignores a sub-agent going idle", async () => {
      const run = await startDeliveredRun("runtime-subagent-idle");
      run.getHandler()?.({ type: "assistant.idle", agentId: "explore-1", timestamp: at(run, 1_000), data: {} });
      await settleWatchdog(run.manager, run.sessionId);
      expect(run.session.getActivity).not.toHaveBeenCalled();
    });

    it("does not ask the runtime before the prompt is delivered", async () => {
      const { manager } = createManager();
      const { session } = makeSession();
      session.getActivity.mockResolvedValue({ processing: false });
      manager.backend = { resumeSession: vi.fn().mockResolvedValue(session) };

      manager.startWork("session-undelivered", "hello");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await settleWatchdog(manager, "session-undelivered");

      expect(session.getActivity).not.toHaveBeenCalled();
      expect(manager.getSessionRunState("session-undelivered")).toBe("busy");
    });

    it("leaves a turn end alone when the runtime cannot answer", async () => {
      const run = await startDeliveredRun("runtime-unknown");
      run.session.getActivity.mockRejectedValue(new Error("rpc channel closed"));
      writeSessionEvents(run.copilotHome, run.sessionId, [
        { type: "assistant.message", timestamp: at(run, 1_000), data: { content: "done?" } },
        { type: "assistant.turn_end", timestamp: at(run, 2_000), data: { turnId: "1" } },
      ]);

      await vi.advanceTimersByTimeAsync(60_000);
      await settleWatchdog(run.manager, run.sessionId);

      expect(run.manager.getSessionRunState(run.sessionId)).toBe("busy");
      expect(run.bus.getSnapshot().complete).toBe(false);
    });
  });

  describe("turns the runtime starts on its own", () => {
    async function waitUntil(condition: () => boolean) {
      for (let i = 0; i < 200 && !condition(); i++) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      expect(condition()).toBe(true);
    }

    function watchSessionStatus(run: { globalBus: any; sessionId: string }) {
      const status = { busy: 0, idlePreviews: [] as unknown[] };
      run.globalBus.subscribe((event: any) => {
        if (event.sessionId !== run.sessionId) return;
        if (event.type === "session:busy") status.busy++;
        if (event.type === "session:idle") status.idlePreviews.push(event.assistantPreview);
      });
      return status;
    }
    async function finishedRun(name: string) {
      const run = await startDeliveredRun(name);
      run.getHandler()?.({ type: "assistant.message", timestamp: at(run, 1_000), data: { content: "first" } });
      run.getHandler()?.({ type: "session.idle", timestamp: at(run, 2_000), data: {} });
      await flushMicrotasks();
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
      return run;
    }

    it("follows a turn the runtime starts after a run has ended, from its first event", async () => {
      const run = await finishedRun("runtime-turn-after-run");

      // Delivered before the followed run subscribes; it must still see them, once each.
      run.getHandler()?.({ type: "system.notification", timestamp: at(run, 60_000), data: { kind: { type: "agent_idle", agentId: "reviewer" } } });
      run.getHandler()?.({ type: "assistant.turn_start", timestamp: at(run, 60_001), data: { turnId: "2" } });
      run.getHandler()?.({ type: "assistant.message_delta", timestamp: at(run, 60_002), data: { deltaContent: "rev" } });
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("busy");
      // Accepted at once, so a crash or disconnect before it subscribes still continues the turn.
      expect(run.manager.sessionRuns.get(run.sessionId)?.promptAccepted).toBe(true);
      // A finished run's bus is replaced for the next run, as for any prompt.
      const bus = run.eventBusRegistry.getOrCreateBus(run.sessionId);
      expect(bus).not.toBe(run.bus);
      await waitUntil(() => bus.getStreamingContent() === "rev");
      // One subscription per cached session: runs register with it rather than subscribing.
      expect(run.session.on).toHaveBeenCalledTimes(1);
      expect(run.session.send).toHaveBeenCalledTimes(1);

      run.getHandler()?.({ type: "assistant.message_delta", timestamp: at(run, 60_003), data: { deltaContent: "iewed" } });
      expect(bus.getStreamingContent()).toBe("reviewed");
      run.getHandler()?.({ type: "assistant.message", timestamp: at(run, 60_004), data: { content: "reviewed" } });
      run.getHandler()?.({ type: "assistant.turn_end", timestamp: at(run, 60_005), data: { turnId: "2" } });
      run.getHandler()?.({ type: "session.idle", timestamp: at(run, 60_006), data: {} });
      await flushMicrotasks();

      expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
      expect(bus.getTerminalState()).toMatchObject({ terminalType: "done", finalContent: "reviewed" });
    });

    it("hands over a turn that starts and ends while the previous run is letting go", async () => {
      const run = await startDeliveredRun("runtime-turn-during-release");
      const status = watchSessionStatus(run);

      run.getHandler()?.({ type: "assistant.message", timestamp: at(run, 1_000), data: { content: "first" } });
      run.getHandler()?.({ type: "session.idle", timestamp: at(run, 2_000), data: {} });
      run.getHandler()?.({ type: "assistant.turn_start", timestamp: at(run, 2_001), data: { turnId: "2" } });
      run.getHandler()?.({ type: "assistant.message", timestamp: at(run, 2_002), data: { content: "second" } });
      run.getHandler()?.({ type: "assistant.turn_end", timestamp: at(run, 2_003), data: { turnId: "2" } });
      run.getHandler()?.({ type: "session.idle", timestamp: at(run, 2_004), data: {} });
      await waitUntil(() => status.idlePreviews.length === 2);

      expect(status.busy).toBe(1);
      expect(status.idlePreviews).toEqual(["first", "second"]);
      expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
    });

    it("holds a turn that starts while the session is resuming until the resume ends", async () => {
      const run = await finishedRun("runtime-turn-during-resume");
      const status = watchSessionStatus(run);
      run.manager.resumingSessions.set(run.sessionId, 1);

      // Two whole turns inside the resume: each is followed by its own run, in order.
      for (const [offset, content] of [[60_000, "woke up"], [61_000, "woke again"]] as const) {
        run.getHandler()?.({ type: "assistant.turn_start", timestamp: at(run, offset), data: { turnId: content } });
        run.getHandler()?.({ type: "assistant.message", timestamp: at(run, offset + 1), data: { content } });
        run.getHandler()?.({ type: "session.idle", timestamp: at(run, offset + 2), data: {} });
      }
      await flushMicrotasks();
      expect(status.busy).toBe(0);

      run.manager.endSessionResume({ sessionId: run.sessionId, token: Symbol("resume") });
      expect(status.busy).toBe(1);
      await waitUntil(() => status.idlePreviews.length === 2);
      expect(status.busy).toBe(2);
      expect(status.idlePreviews).toEqual(["woke up", "woke again"]);
    });

    it("leaves a run's own turns to the run and stops watching an evicted session", async () => {
      const run = await startDeliveredRun("runtime-turn-own-and-evicted");
      run.getHandler()?.({ type: "assistant.turn_start", timestamp: at(run, 1_000), data: { turnId: "1" } });
      run.getHandler()?.({ type: "assistant.message", timestamp: at(run, 1_500), data: { content: "own" } });
      run.getHandler()?.({ type: "session.idle", timestamp: at(run, 2_000), data: {} });
      await flushMicrotasks();
      expect(run.bus.getTerminalState()).toMatchObject({ terminalType: "done", finalContent: "own" });

      await run.manager.evictCachedSession(run.sessionId);
      expect(run.getHandler()).toBeUndefined();
    });
  });
  it("does not recover a persisted subagent error as a parent terminal", async () => {
    const tmpDir = makeTestDir("persisted-subagent-error");
    const sessionId = "session-persisted-subagent-error";
    const sessionStateDir = join(tmpDir, "session-state", sessionId);
    mkdirSync(sessionStateDir, { recursive: true });

    const { manager, eventBusRegistry } = createManager({ copilotHome: tmpDir });
    const initial = makeSession();
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(initial.session) };

    const bus = eventBusRegistry.getOrCreateBus(sessionId);
    manager.startWork(sessionId, "run a reviewer");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();
    const baseTime = Date.now();

    writeFileSync(join(sessionStateDir, "events.jsonl"), [
      JSON.stringify({
        type: "tool.execution_start",
        timestamp: new Date(baseTime + 500).toISOString(),
        data: {
          toolCallId: "persisted-agent-1",
          toolName: "task",
          arguments: { mode: "sync", agent_type: "code-review" },
        },
      }),
      JSON.stringify({
        type: "subagent.started",
        agentId: "persisted-agent-1",
        timestamp: new Date(baseTime + 750).toISOString(),
        data: { toolCallId: "persisted-agent-1", agentName: "code-review" },
      }),
      JSON.stringify({
        id: "persisted-subagent-error-1",
        type: "session.error",
        agentId: "persisted-agent-1",
        timestamp: new Date(baseTime + 1_000).toISOString(),
        data: {
          errorType: "query",
          message: "CAPIError: flagged child request",
        },
      }),
    ].join("\n") + "\n");

    await vi.advanceTimersByTimeAsync(60_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("busy");
    expect(bus.getSnapshot().complete).toBe(false);

    initial.getHandler()?.({
      type: "assistant.message",
      timestamp: new Date(baseTime + 61_000).toISOString(),
      data: { content: "Parent recovered." },
    });
    initial.getHandler()?.({
      type: "session.idle",
      timestamp: new Date(baseTime + 62_000).toISOString(),
      data: {},
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(bus.getTerminalState()).toMatchObject({
      terminalType: "done",
      finalContent: "Parent recovered.",
    });
  });

  it("keeps a persisted root error terminal when a later subagent error is recorded", async () => {
    const tmpDir = makeTestDir("persisted-root-then-subagent-error");
    const sessionId = "session-persisted-root-then-subagent-error";
    const sessionStateDir = join(tmpDir, "session-state", sessionId);
    mkdirSync(sessionStateDir, { recursive: true });

    const { manager, eventBusRegistry } = createManager({ copilotHome: tmpDir });
    const initial = makeSession();
    manager.backend = { resumeSession: vi.fn().mockResolvedValue(initial.session) };

    const bus = eventBusRegistry.getOrCreateBus(sessionId);
    manager.startWork(sessionId, "run parent and child work");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();
    const baseTime = Date.now();

    writeFileSync(join(sessionStateDir, "events.jsonl"), [
      JSON.stringify({
        id: "persisted-root-error",
        type: "session.error",
        timestamp: new Date(baseTime + 1_000).toISOString(),
        data: {
          errorType: "query",
          message: "Root request failed",
        },
      }),
      JSON.stringify({
        id: "persisted-child-error",
        type: "session.error",
        agentId: "background-agent-1",
        timestamp: new Date(baseTime + 2_000).toISOString(),
        data: {
          errorType: "query",
          message: "Child request also failed",
        },
      }),
    ].join("\n") + "\n");

    await vi.advanceTimersByTimeAsync(60_000);
    await manager.waitForSessionWatchdogIdle(sessionId);
    await flushMicrotasks();

    expect(manager.getSessionRunState(sessionId)).toBe("idle");
    expect(bus.getTerminalState()).toMatchObject({
      terminalType: "error",
      errorMessage: "Root request failed",
      terminalEventId: "persisted-root-error",
    });
  });

  it("finishes a run the runtime reports idle even when the log holds no ending", async () => {
    const run = await startDeliveredRun("runtime-idle-no-ending");
    run.session.getActivity.mockResolvedValue({ processing: false });
    const states: string[] = [];
    run.globalBus.subscribe((event: any) => {
      if (event.sessionId === run.sessionId && ["session:busy", "session:stalled", "session:idle"].includes(event.type)) {
        states.push(event.type);
      }
    });
    writeSessionEvents(run.copilotHome, run.sessionId, [
      { type: "user.message", timestamp: at(run, 1_000), data: { content: "hello" } },
      { type: "assistant.message", timestamp: at(run, 2_000), data: { content: "done" } },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    await settleWatchdog(run.manager, run.sessionId);

    expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
    expect(states).toEqual(["session:idle"]);
    expect(run.session.disconnect).not.toHaveBeenCalled();
    expect(run.bus.getTerminalState()).toMatchObject({ terminalType: "done", finalContent: "done" });
    // Telemetry says what the log held, and does not invent a turn end.
    expect(latestSpanMetadata(run.telemetryStore, "session.run.complete", run.sessionId)).toMatchObject({
      completionSource: "persisted_unknown_recovery",
      terminalEventType: "unknown",
      recoveryReason: "runtime idle",
    });
  });

  it("ends a run on a shutdown in the log when the runtime cannot answer", async () => {
    const run = await startDeliveredRun("runtime-unknown-shutdown");
    writeSessionEvents(run.copilotHome, run.sessionId, [
      { type: "user.message", timestamp: at(run, 1_000), data: { content: "hello" } },
      { type: "assistant.message", timestamp: at(run, 2_000), data: { content: "done" } },
      { type: "session.shutdown", timestamp: at(run, 3_000), data: { shutdownType: "graceful" } },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    await settleWatchdog(run.manager, run.sessionId);

    expect(run.manager.getSessionRunState(run.sessionId)).toBe("idle");
    expect(run.bus.getTerminalState()).toMatchObject({ terminalType: "shutdown", finalContent: "done" });
  });
  it("treats session.shutdown as a shutdown terminal event (routine or error)", async () => {
    // treats routine session.shutdown as a shutdown terminal event
    {
    const { manager, eventBusRegistry, sessionMetaStore } = createManager();
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
    expect(bus.getTerminalState()).toMatchObject({
      terminalType: "shutdown",
      finalContent: "partial response",
    });
    }

    // treats error session.shutdown as a terminal error
    {
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
    expect(bus.getTerminalState()).toMatchObject({
      terminalType: "error",
      errorMessage: "runtime failed",
    });
    }
  });
  it("resolves abort locally when the runtime never confirms it", async () => {
    const { manager, eventBusRegistry, sessionMetaStore } = createManager();
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
      id: "turn-start-event",
      type: "assistant.turn_start",
      data: { turnId: "provider-turn-1" },
      timestamp: "2026-04-20T00:00:00.000Z",
    });
    getHandler()?.({
      id: "assistant-event-1",
      type: "assistant.message",
      data: { content: "partial response" },
      timestamp: "2026-04-20T00:00:01.000Z",
    });
    await flushMicrotasks();

    const abortPromise = manager.abortSession("session-1");
    await flushMicrotasks();
    expect(session.abort).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await abortPromise;
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(bus.getTerminalState()).toMatchObject({
      terminalType: "aborted",
      terminalAssistantEventId: "assistant-event-1",
      finalContent: "partial response",
    });
    expect(sessionMetaStore.getTerminalOverlay("session-1")).toMatchObject({
      type: "aborted",
      notice: { kind: "stopped" },
    });
  });

  it("clears run state without disconnecting when an abort event arrives while send is still pending", async () => {
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
    expect(session.disconnect).not.toHaveBeenCalled();
  });

  it("does not send the prompt after a local abort during initial resume", async () => {
    const { manager, eventBusRegistry } = createManager();
    let resolveResume!: (session: any) => void;
    const resumePromise = new Promise<any>((resolve) => {
      resolveResume = resolve;
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const session = makeAgentSessionStub({
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(() => vi.fn()),
      send,
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    });
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
      await vi.advanceTimersByTimeAsync(59_000);
      writeFileSync(eventsPath, JSON.stringify({
        type: "user.message",
        timestamp: new Date(Date.now()).toISOString(),
        data: { content: "hello" },
      }) + "\n");

      await vi.advanceTimersByTimeAsync(1_000);
      await manager.waitForSessionWatchdogIdle(sessionId);
      await flushMicrotasks();

      // The file's real mtime is close to wall-clock time so it will be
      // greater than the fake-timer lastEventTime; the run record should have
      // lastEventAt updated to the file's mtime.
      const activity = manager.getSessionActivity();
      expect(activity).toHaveLength(1);
      expect(activity[0].staleMs).toBeLessThan(60_000);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("a growing log extends the no-progress abort deadline even when its mtime does not move", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-no-progress-disk-"));
    try {
      const sessionId = "session-disk-progress";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const { session } = makeSession();
      const resumeSession = vi.fn().mockResolvedValue(session);
      manager.backend = { resumeSession };

      const eventsPath = join(sessionStateDir, "events.jsonl");
      const intent = JSON.stringify({ type: "assistant.intent", data: { intent: "Still working" } }) + "\n";
      writeFileSync(eventsPath, intent);

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      expect(resumeSession).toHaveBeenCalledTimes(1);
      const preRunMtime = new Date(Date.now() - 1_000);
      utimesSync(eventsPath, preRunMtime, preRunMtime);

      await vi.advanceTimersByTimeAsync(50 * 60_000);
      await manager.waitForSessionWatchdogIdle(sessionId);
      writeFileSync(eventsPath, intent.repeat(2));
      utimesSync(eventsPath, preRunMtime, preRunMtime);
      await vi.advanceTimersByTimeAsync(60_000);
      await manager.waitForSessionWatchdogIdle(sessionId);
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await manager.waitForSessionWatchdogIdle(sessionId);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("busy");
      expect(resumeSession).toHaveBeenCalledTimes(1);
      expect(session.abort).not.toHaveBeenCalled();
      expect(session.disconnect).not.toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("aborts the original session exactly once after the hard no-progress deadline", async () => {
    const { manager, eventBusRegistry, telemetryStore } = createManager({ telemetry: true });
    const { session, getHandler } = makeSession();
    session.abort.mockImplementation(async () => {
      getHandler()?.({
        type: "abort",
        data: { reason: "watchdog no-progress deadline" },
        timestamp: new Date().toISOString(),
      });
    });
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await manager.waitForSessionWatchdogIdle("session-1");
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(bus.getSnapshot().terminalType).toBe("aborted");
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.disconnect).not.toHaveBeenCalled();
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(
      telemetryStore!.querySpans({ name: "session.run.no_progress_abort", sessionId: "session-1" })
        .map((span) => span.metadata),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcome: "completed",
        abortThresholdMs: 60 * 60_000,
      }),
    ]));
  });

  it("does not abort when live progress arrives immediately before the hard deadline", async () => {
    const { manager } = createManager();
    const { session, getHandler } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.backend = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(59 * 60_000);
    getHandler()?.({
      type: "tool.execution_complete",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      data: {
        toolCallId: "tool-sync-shell",
        success: true,
        output: "build complete",
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await manager.waitForSessionWatchdogIdle("session-1");
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.disconnect).not.toHaveBeenCalled();
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

});
