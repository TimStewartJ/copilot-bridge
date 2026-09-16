// Backend disconnect recovery: when the agent backend's RPC channel is lost
// the manager must fail in-flight runs immediately (nothing will answer),
// fence the orphan, drop cached handles only after confirmed fencing,
// start a replacement, and re-send a continue prompt to the
// interactive turns it interrupted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createEventBusRegistry } from "../server/event-bus.js";
import { SessionManager, type SessionManagerDeps } from "../server/session-manager.js";
import { createSessionTitlesStore } from "../server/session-titles.js";
import { createSessionMetaStore } from "../server/session-meta-store.js";
import { createTaskStore } from "../server/task-store.js";
import { createTelemetryStore } from "../server/telemetry-store.js";
import {
  BACKEND_DISCONNECTED_MESSAGE,
  BACKEND_RECONNECTING_MESSAGE,
  BACKEND_RECOVERY_BLOCKED_MESSAGE,
  BACKEND_RECOVERY_CONTINUE_PROMPT,
} from "../server/backend-availability.js";
import type { AgentBackendDisconnect } from "../server/agent-backend/types.js";
import { RUNTIME_FENCE_BUDGET_MS, RuntimeFenceError, type RuntimeFenceOptions } from "../server/agent-backend/runtime-fence.js";
import { createDeadline } from "../server/deadline.js";
import { createTestBus, makeAgentSessionStub, makeTestDir, setupTestDb } from "../server/__tests__/helpers.js";

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
    fence: vi.fn(async (_options?: RuntimeFenceOptions) => {}),
    listModels: vi.fn(async (): Promise<Array<{ id: string; name: string }>> => []),
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
    sessionMetaStore: createSessionMetaStore(db),
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

  it.each(["connection-closed", "cleanup-stalled"] as const)(
    "fences %s recovery before resuming accepted interactive turns exactly once", async (reason) => {
    vi.useFakeTimers();
    const interactive = makeSession("session-interactive");
    const quiet = makeSession("session-quiet");
    const idleCached = makeSession("session-idle");
    const resumedInteractive = makeSession("session-interactive");
    const dead = createFakeBackend("dead", { "session-interactive": interactive, "session-quiet": quiet });
    let finishFence!: () => void;
    dead.fence.mockImplementation(() => new Promise<void>((resolve) => { finishFence = resolve; }));
    const fresh = createFakeBackend("fresh", { "session-interactive": resumedInteractive });
    dead.listModels.mockResolvedValue([{ id: "old-model", name: "Old Model" }]);
    fresh.listModels.mockResolvedValue([{ id: "new-model", name: "New Model" }]);
    const { manager, statusEvents, telemetryStore } = createManager([dead, fresh]);
    await manager.initialize();
    const transcriptPath = manager.getSessionEventsPath("session-interactive");
    const transcript = JSON.stringify({
      id: "persisted-user-message", type: "user.message",
      timestamp: new Date().toISOString(), data: { content: "durable original request" },
    }) + "\n";
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, transcript);
    await expect(manager.validateModelSelection({ model: "old-model" })).resolves.toEqual({ ok: true });
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

    if (reason === "cleanup-stalled") {
      idleCached.session.disconnect.mockImplementation(() => new Promise(() => {}));
      await manager.evictCachedSession("session-idle");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(manager.getSessionRunState("session-interactive")).toBe("busy");
      expect(dead.fence).not.toHaveBeenCalled();
      expect(() => manager.startWork("new-session", "hello")).toThrow(BACKEND_RECONNECTING_MESSAGE);
      await vi.advanceTimersByTimeAsync(55_000);
    } else {
      dead.simulateDisconnect({ reason, detail: "JSON-RPC connection closed" });
    }

    // In-flight runs fail immediately with the retryable disconnect message.
    const interactiveBus = manager.deps.eventBusRegistry.getBus("session-interactive");
    expect(interactiveBus.getTerminalState()).toMatchObject({ complete: true, terminalType: "error", errorMessage: BACKEND_DISCONNECTED_MESSAGE });
    expect(manager.deps.sessionMetaStore.getTerminalOverlay("session-interactive")).toMatchObject({ type: "error" });
    expect(manager.getBackendStatus()).toMatchObject({
      disconnectCount: 1,
      lastDisconnect: expect.objectContaining({ reason }),
      lastInterruptedSessionCount: 2,
    });
    expect(manager.getBackendUnavailableReason()).toBe(BACKEND_RECONNECTING_MESSAGE);
    expect(() => manager.startWork("session-idle", "hello")).toThrow(BACKEND_RECONNECTING_MESSAGE);
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.start).not.toHaveBeenCalled();
    finishFence();

    // Cached handles are dropped without any RPC to the dead runtime; the orphan is force-stopped; a replacement starts.
    await vi.waitFor(() => expect(manager.sessionObjects.has("session-idle")).toBe(false));
    await vi.waitFor(() => expect(manager.sessionObjects.get("session-interactive")).not.toBe(interactive.session));
    expect(manager.sessionObjects.has("session-quiet")).toBe(false);
    expect(idleCached.session.disconnect).toHaveBeenCalledTimes(reason === "cleanup-stalled" ? 1 : 0);
    expect(interactive.session.disconnect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fresh.start).toHaveBeenCalledOnce());
    expect(dead.fence).toHaveBeenCalledOnce();
    expect(dead.fence.mock.invocationCallOrder[0]).toBeLessThan(fresh.start.mock.invocationCallOrder[0]);
    expect(dead.deleteSession).not.toHaveBeenCalled();
    expect(fresh.deleteSession).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, "utf8")).toBe(transcript);
    await vi.waitFor(() => expect(manager.getBackendStatus()).toMatchObject({ state: "ready", recoveryCount: 1 }));
    expect(fresh.hasDisconnectHandler()).toBe(true);
    expect(manager.getBackendUnavailableReason()).toBeUndefined();
    await expect(manager.validateModelSelection({ model: "new-model" })).resolves.toEqual({ ok: true });
    expect(fresh.listModels).toHaveBeenCalledOnce();

    // The interactive turn gets a continue prompt on the new backend; the quiet defer turn does not.
    await vi.waitFor(() => expect(resumedInteractive.session.send).toHaveBeenCalledWith({ prompt: BACKEND_RECOVERY_CONTINUE_PROMPT }));
    expect(resumedInteractive.session.send).toHaveBeenCalledOnce();
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

  it("waits past five seconds for identity-verified fencing with the same deadline passed to the backend", async () => {
    vi.useFakeTimers();
    const dead = createFakeBackend("dead", {});
    const fresh = createFakeBackend("fresh", {});
    let finishFence!: () => void;
    let options: RuntimeFenceOptions | undefined;
    dead.fence.mockImplementation((input) => {
      options = input;
      return new Promise<void>((resolve) => { finishFence = resolve; });
    });
    const { manager, telemetryStore } = createManager([dead, fresh]);
    try {
      await manager.initialize();
      dead.simulateDisconnect({ reason: "rpc-timeout" });
      await flushMicrotasks();
      expect(options?.deadline).toBeDefined();
      expect(options!.deadline!.expiresAtUnixMs - Date.now()).toBe(RUNTIME_FENCE_BUDGET_MS);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(manager.getBackendStatus().state).toBe("reconnecting");
      expect(fresh.start).not.toHaveBeenCalled();
      options?.onPhase?.({ phase: "snapshot", durationMs: 6_000, outcome: "completed", pid: 100 });
      finishFence();
      await vi.waitFor(() => expect(manager.getBackendStatus()).toMatchObject({ state: "ready", recoveryCount: 1 }));
      expect(dead.fence).toHaveBeenCalledOnce();
      expect(fresh.start).toHaveBeenCalledOnce();
      expect(telemetryStore.querySpans({ name: "backend.fence.phase" })[0]?.metadata)
        .toMatchObject({ phase: "snapshot", outcome: "completed", pid: 100 });
      expect(telemetryStore.querySpans({ name: "backend.fence" })[0]?.metadata)
        .toMatchObject({ outcome: "acknowledged" });
    } finally {
      finishFence?.();
      await manager.gracefulShutdown();
    }
  });

  it("retries after the aggregate fence deadline and accepts a late acknowledgement without fencing twice", async () => {
    vi.useFakeTimers();
    const dead = createFakeBackend("dead", {});
    const fresh = createFakeBackend("fresh", {});
    let finishFence!: () => void;
    dead.fence.mockImplementation(() => new Promise<void>((resolve) => { finishFence = resolve; }));
    const { manager } = createManager([dead, fresh]);
    try {
      await manager.initialize();
      dead.simulateDisconnect();
      await vi.advanceTimersByTimeAsync(RUNTIME_FENCE_BUDGET_MS);
      expect(manager.getBackendStatus()).toMatchObject({ state: "disconnected", recoveryBlockedAt: null });
      expect(manager.getBackendStatus().lastRecoveryError).toContain("Runtime fencing timed-out");
      expect(manager.getBackendUnavailableReason()).toBe(BACKEND_RECONNECTING_MESSAGE);
      expect(fresh.start).not.toHaveBeenCalled();
      finishFence();
      await flushMicrotasks();
      // Ownership is still retained until the scheduled retry observes the acknowledgement.
      expect(fresh.start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(manager.getBackendStatus()).toMatchObject({ state: "ready", recoveryCount: 1, lastRecoveryError: null }));
      expect(fresh.start).toHaveBeenCalledOnce();
      expect(dead.fence).toHaveBeenCalledOnce();
    } finally {
      finishFence?.();
      await manager.gracefulShutdown();
    }
  });

  it("retries transient fencing failures with backoff until the runtime is proven gone", async () => {
    vi.useFakeTimers();
    const dead = createFakeBackend("dead", {});
    const fresh = createFakeBackend("fresh", {});
    dead.fence
      .mockRejectedValueOnce(new RuntimeFenceError("Runtime fencing failed: snapshot-unavailable: CIM process snapshot timed out after 20000ms", true))
      .mockRejectedValueOnce(new RuntimeFenceError("Runtime fencing failed: deadline-exceeded", true))
      .mockResolvedValueOnce(undefined);
    const { manager, telemetryStore } = createManager([dead, fresh]);
    try {
      await manager.initialize();
      dead.simulateDisconnect({ reason: "health-probe-failed", detail: "watchdog no-progress" });
      await vi.waitFor(() => expect(dead.fence).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(manager.getBackendStatus().lastRecoveryError).toContain("snapshot-unavailable"));
      expect(manager.getBackendUnavailableReason()).toBe(BACKEND_RECONNECTING_MESSAGE);
      expect(fresh.start).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(dead.fence).toHaveBeenCalledTimes(2));
      expect(fresh.start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(manager.getBackendStatus()).toMatchObject({ state: "ready", recoveryCount: 1 }));
      expect(dead.fence).toHaveBeenCalledTimes(3);
      expect(dead.fence.mock.invocationCallOrder[2]).toBeLessThan(fresh.start.mock.invocationCallOrder[0]);
      expect(manager.getBackendStatus()).toMatchObject({ lastRecoveryError: null, recoveryBlockedAt: null });
      expect(telemetryStore.querySpans({ name: "backend.recover", limit: 5 }).map((span) => span.metadata?.outcome).sort())
        .toEqual(["failed", "failed", "recovered"]);
    } finally {
      await manager.gracefulShutdown();
    }
  });

  it("blocks and publishes when transient fencing never succeeds within the retry window", async () => {
    vi.useFakeTimers();
    const dead = createFakeBackend("dead", {});
    const fresh = createFakeBackend("fresh", {});
    dead.fence.mockRejectedValue(new RuntimeFenceError("Runtime fencing failed: snapshot-unavailable", true));
    const { manager, statusEvents } = createManager([dead, fresh]);
    try {
      await manager.initialize();
      dead.simulateDisconnect();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(manager.getBackendUnavailableReason()).toBe(BACKEND_RECONNECTING_MESSAGE);
      expect(manager.getBackendStatus().recoveryBlockedAt).toBeNull();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(manager.getBackendUnavailableReason()).toBe(BACKEND_RECOVERY_BLOCKED_MESSAGE);
      const blockedAt = manager.getBackendStatus().recoveryBlockedAt;
      expect(Number.isFinite(Date.parse(blockedAt))).toBe(true);
      expect(manager.backendRecoveryRetryTimer).toBeNull();
      const fenceCalls = dead.fence.mock.calls.length;
      expect(fenceCalls).toBeGreaterThan(3);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(dead.fence).toHaveBeenCalledTimes(fenceCalls);
      expect(fresh.start).not.toHaveBeenCalled();
      expect(manager.getBackendStatus().recoveryBlockedAt).toBe(blockedAt);
      const lastStatus = statusEvents.filter((event) => event.type === "backend:status").at(-1);
      expect(lastStatus?.agentBackend.recoveryBlockedAt).toBe(blockedAt);
    } finally {
      await manager.gracefulShutdown();
    }
  });

  it("blocks immediately on a terminal fencing failure without retrying it", async () => {
    vi.useFakeTimers();
    const dead = createFakeBackend("dead", {});
    const fresh = createFakeBackend("fresh", {});
    dead.fence.mockRejectedValue(new RuntimeFenceError("Runtime fencing failed: survivors (4243, alive)", false));
    const { manager } = createManager([dead, fresh]);
    try {
      await manager.initialize();
      dead.simulateDisconnect();
      await vi.waitFor(() => expect(manager.getBackendUnavailableReason()).toBe(BACKEND_RECOVERY_BLOCKED_MESSAGE));
      expect(manager.getBackendStatus().recoveryBlockedAt).toEqual(expect.any(String));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(dead.fence).toHaveBeenCalledOnce();
      expect(fresh.start).not.toHaveBeenCalled();
    } finally {
      await manager.gracefulShutdown();
    }
  });

  it("shares the first caller's shorter absolute fence deadline without extending it", async () => {
    vi.useFakeTimers();
    const dead = createFakeBackend("dead", {});
    let finishFence!: () => void;
    let options: RuntimeFenceOptions | undefined;
    dead.fence.mockImplementation((input) => {
      options = input;
      return new Promise<void>((resolve) => { finishFence = resolve; });
    });
    const { manager } = createManager([dead]);
    try {
      await manager.initialize();
      const deadline = createDeadline(1_000);
      const fence = manager.fenceBackend(dead, deadline);
      await flushMicrotasks();
      expect(options?.deadline).toBe(deadline);
      expect(manager.fenceBackend(dead, createDeadline(RUNTIME_FENCE_BUDGET_MS))).toBe(fence);
      finishFence();
      await fence;
      expect(dead.fence).toHaveBeenCalledOnce();
    } finally {
      finishFence?.();
      await manager.gracefulShutdown();
    }
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
    expect(manager.getBackendUnavailableReason()).toBe(BACKEND_RECONNECTING_MESSAGE);
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
