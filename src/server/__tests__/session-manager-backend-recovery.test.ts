// Backend disconnect recovery: when the agent backend's RPC channel is lost
// the manager must fail in-flight runs immediately (nothing will answer),
// drop cached handles owned by the dead runtime without talking to it, kill
// the orphan, start a replacement, and re-send a continue prompt to the
// interactive turns it interrupted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBusRegistry } from "../event-bus.js";
import { SessionManager, type SessionManagerDeps } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import {
  BACKEND_DISCONNECTED_MESSAGE,
  BACKEND_RECONNECTING_MESSAGE,
  BACKEND_RECOVERY_CONTINUE_PROMPT,
} from "../backend-availability.js";
import type { AgentBackendDisconnect } from "../agent-backend/types.js";
import { createTestBus, makeAgentSessionStub, makeTestDir, setupTestDb } from "./helpers.js";

function makeSession(sessionId: string) {
  const handlers: Array<(event: any) => void> = [];
  const session = makeAgentSessionStub({
    sessionId,
    setSendMode: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((cb: (event: any) => void) => {
      handlers.push(cb);
      return () => {
        const index = handlers.indexOf(cb);
        if (index >= 0) handlers.splice(index, 1);
      };
    }),
    // A turn that never completes: the backend dies mid-run.
    send: vi.fn(async () => undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue({ tasks: [] }),
  });
  return {
    session,
    emit: (event: any) => { for (const handler of [...handlers]) handler(event); },
  };
}

function createFakeBackend(name: string, sessions: Record<string, ReturnType<typeof makeSession>>) {
  let disconnectHandler: ((info: AgentBackendDisconnect) => void) | undefined;
  const backend = {
    name,
    id: "copilot" as const,
    capabilities: {
      resumeSession: true,
      streamingToolInput: true,
      costUsage: true,
      subAgents: true,
      images: true,
      bidirectionalStdin: false,
      externalToolEvents: true,
      forkBoundaries: true,
    },
    permissionPolicy: undefined,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => { throw new Error("not implemented in test"); }),
    resumeSession: vi.fn(async (sessionId: string) => {
      const entry = sessions[sessionId];
      if (!entry) throw new Error(`no fake session ${sessionId}`);
      return entry.session;
    }),
    deleteSession: vi.fn(async () => {}),
    getSessionMetadata: vi.fn(async () => ({})),
    onDisconnect: vi.fn((handler: (info: AgentBackendDisconnect) => void) => {
      disconnectHandler = handler;
      return () => { disconnectHandler = undefined; };
    }),
    getConnectionStatus: vi.fn(() => ({ state: "connected" as const, pid: 100 })),
    probeHealth: vi.fn(async () => true),
    simulateDisconnect(info: Partial<AgentBackendDisconnect> = {}) {
      disconnectHandler?.({ at: new Date().toISOString(), reason: "connection-closed", ...info });
    },
    hasDisconnectHandler: () => disconnectHandler !== undefined,
  };
  return backend;
}

function createManager(backends: unknown[]) {
  const db = setupTestDb();
  const copilotHome = makeTestDir("backend-recovery");
  const globalBus = createTestBus();
  const telemetryStore = createTelemetryStore(db);
  const statusEvents: any[] = [];
  globalBus.subscribe((event) => statusEvents.push(event));
  const createBackendSpy = vi.fn(() => {
    const backend = backends.shift();
    if (!backend) throw new Error("No fake agent backend queued");
    return backend as any;
  });
  const deps: SessionManagerDeps = {
    globalBus,
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: createTaskStore(db, globalBus),
    config: { sessionMcpServers: {} },
    copilotHome,
    telemetryStore,
    createBackend: createBackendSpy,
  };
  return { manager: new SessionManager(deps) as any, createBackendSpy, statusEvents, telemetryStore };
}

async function flushMicrotasks(rounds = 80) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("SessionManager backend disconnect recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails in-flight runs, drops cached handles, replaces the backend, and resumes interrupted interactive turns", async () => {
    vi.useFakeTimers();
    const interactive = makeSession("session-interactive");
    const quiet = makeSession("session-quiet");
    const idleCached = makeSession("session-idle");
    const resumedInteractive = makeSession("session-interactive");
    const dead = createFakeBackend("dead", { "session-interactive": interactive, "session-quiet": quiet });
    const fresh = createFakeBackend("fresh", { "session-interactive": resumedInteractive });
    const { manager, statusEvents, telemetryStore } = createManager([dead, fresh]);
    await manager.initialize();
    expect(dead.hasDisconnectHandler()).toBe(true);
    expect(manager.getBackendStatus()).toMatchObject({ state: "ready", connection: "connected", pid: 100, disconnectCount: 0 });

    // Two live turns (one interactive, one quiet defer turn) plus an idle cached handle.
    manager.startWork("session-interactive", "do the thing");
    manager.startWork("session-quiet", "poll", undefined, { attentionMode: "quiet" });
    await vi.waitFor(() => {
      expect(interactive.session.send).toHaveBeenCalled();
      expect(quiet.session.send).toHaveBeenCalled();
    });
    interactive.emit({ type: "user.message", data: {}, timestamp: new Date().toISOString() });
    quiet.emit({ type: "user.message", data: {}, timestamp: new Date().toISOString() });
    manager.sessionObjects.set("session-idle", idleCached.session);
    expect(manager.getSessionRunState("session-interactive")).toBe("busy");
    expect(manager.sessionObjects.size).toBe(3);

    dead.simulateDisconnect({ reason: "connection-closed", detail: "JSON-RPC connection closed" });

    // In-flight runs fail immediately with the retryable disconnect message.
    const interactiveBus = manager.deps.eventBusRegistry.getBus("session-interactive");
    expect(interactiveBus.getTerminalState()).toMatchObject({ complete: true, terminalType: "error", errorMessage: BACKEND_DISCONNECTED_MESSAGE });
    expect(manager.getBackendStatus()).toMatchObject({
      state: expect.stringMatching(/disconnected|reconnecting/),
      disconnectCount: 1,
      lastDisconnect: expect.objectContaining({ reason: "connection-closed", detail: "JSON-RPC connection closed" }),
      lastInterruptedSessionCount: 2,
    });
    expect(manager.getBackendUnavailableReason()).toBe(BACKEND_RECONNECTING_MESSAGE);
    expect(() => manager.startWork("session-idle", "hello")).toThrow(BACKEND_RECONNECTING_MESSAGE);

    // Cached handles are dropped without any RPC to the dead runtime; the orphan is force-stopped; a replacement starts.
    await vi.waitFor(() => expect(manager.sessionObjects.has("session-idle")).toBe(false));
    expect(manager.sessionObjects.get("session-interactive")).not.toBe(interactive.session);
    expect(manager.sessionObjects.has("session-quiet")).toBe(false);
    expect(idleCached.session.disconnect).not.toHaveBeenCalled();
    expect(interactive.session.disconnect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fresh.start).toHaveBeenCalledOnce());
    expect(dead.forceStop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(manager.getBackendStatus()).toMatchObject({ state: "ready", recoveryCount: 1 }));
    expect(fresh.hasDisconnectHandler()).toBe(true);
    expect(manager.getBackendUnavailableReason()).toBeUndefined();

    // The interactive turn gets a continue prompt on the new backend; the quiet defer turn does not.
    await vi.waitFor(() => expect(resumedInteractive.session.send).toHaveBeenCalledWith({ prompt: BACKEND_RECOVERY_CONTINUE_PROMPT }));
    expect(fresh.resumeSession).toHaveBeenCalledWith("session-interactive", expect.anything());
    expect(fresh.resumeSession).not.toHaveBeenCalledWith("session-quiet", expect.anything());
    await vi.waitFor(() => expect(manager.getBackendStatus().lastAutoResumedSessionCount).toBe(1));

    // Status events were published for the dashboard.
    const backendStates = statusEvents.filter((event) => event.type === "backend:status").map((event) => event.agentBackend.state);
    expect(backendStates).toContain("disconnected");
    expect(backendStates).toContain("reconnecting");
    expect(backendStates[backendStates.length - 1]).toBe("ready");
    expect(telemetryStore.querySpans({ name: "backend.disconnect", limit: 5 })).toHaveLength(1);
    expect(telemetryStore.querySpans({ name: "backend.recover", limit: 5 })[0]?.metadata).toMatchObject({ outcome: "recovered" });
    const autoResume = telemetryStore.querySpans({ name: "backend.autoResume", limit: 10 });
    expect(autoResume.map((span) => [span.sessionId, span.metadata?.outcome, span.metadata?.reason])).toEqual(expect.arrayContaining([
      ["session-interactive", "resumed", undefined],
      ["session-quiet", "skipped", "quiet_turn"],
    ]));

    // Finish the resumed turn so the run settles.
    resumedInteractive.emit({ type: "session.idle", data: {}, timestamp: new Date().toISOString() });
    await flushMicrotasks();
  });

  it("does not resume turns whose prompt was never accepted and ignores disconnects from superseded backends", async () => {
    vi.useFakeTimers();
    const pendingSession = makeSession("session-pending");
    pendingSession.session.send = vi.fn(() => new Promise(() => {}));
    const dead = createFakeBackend("dead", { "session-pending": pendingSession });
    const fresh = createFakeBackend("fresh", { "session-pending": makeSession("session-pending") });
    const { manager, telemetryStore } = createManager([dead, fresh]);
    await manager.initialize();

    manager.startWork("session-pending", "hello");
    await vi.waitFor(() => expect(pendingSession.session.send).toHaveBeenCalled());
    // send never resolved, so the prompt was not accepted.
    dead.simulateDisconnect({ reason: "process-exit", detail: "runtime process exited (code=1, signal=null)" });
    await vi.waitFor(() => expect(manager.getBackendStatus()).toMatchObject({ state: "ready", recoveryCount: 1 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fresh.resumeSession).not.toHaveBeenCalled();
    expect(telemetryStore.querySpans({ name: "backend.autoResume", limit: 5 })[0]?.metadata).toMatchObject({
      outcome: "skipped",
      reason: "prompt_not_accepted",
    });

    // A late disconnect from the replaced backend must not tear down the fresh one.
    dead.simulateDisconnect({ reason: "connection-closed" });
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.getBackendStatus()).toMatchObject({ state: "ready", disconnectCount: 1, recoveryCount: 1 });
    expect(fresh.forceStop).not.toHaveBeenCalled();
  });

  it("retries the replacement backend with backoff when it fails to start", async () => {
    vi.useFakeTimers();
    const dead = createFakeBackend("dead", {});
    const broken = createFakeBackend("broken", {});
    broken.start = vi.fn(async () => { throw new Error("CLI failed to start"); });
    const fresh = createFakeBackend("fresh", {});
    const { manager } = createManager([dead, broken, fresh]);
    await manager.initialize();

    dead.simulateDisconnect({ reason: "stdin-error", detail: "EPIPE" });
    await vi.waitFor(() => expect(broken.start).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(manager.getBackendStatus()).toMatchObject({ state: "disconnected", lastRecoveryError: "CLI failed to start" }));
    expect(manager.getBackendUnavailableReason()).toBe(BACKEND_DISCONNECTED_MESSAGE);
    expect(fresh.start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(fresh.start).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(manager.getBackendStatus()).toMatchObject({ state: "ready", recoveryCount: 1, lastRecoveryError: null }));
  });

  it("reports defer delivery readiness: held right after a backend start, ready once the hold elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T20:00:00.000Z"));
    const backend = createFakeBackend("only", {});
    const { manager } = createManager([backend]);
    expect(manager.getDeferDeliveryReadiness()).toMatchObject({ ready: false });
    await manager.initialize();
    expect(manager.getDeferDeliveryReadiness()).toMatchObject({ ready: false, reason: "agent backend startup hold" });
    vi.setSystemTime(new Date("2026-08-24T20:01:00.000Z"));
    expect(manager.getDeferDeliveryReadiness()).toEqual({ ready: true });
  });
});
