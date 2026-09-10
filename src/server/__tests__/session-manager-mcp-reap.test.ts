import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, ConnectionErrors } from "vscode-jsonrpc/node.js";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createTestBus, makeAgentSessionStub, makeTestDir, setupTestDb } from "./helpers.js";
import { join } from "node:path";
import { readSessionLaunchContext } from "../session-launch-context.js";
import type { AgentBackendDisconnect } from "../agent-backend/types.js";

type FakeSession = {
  sessionId?: string;
  disconnect: ReturnType<typeof vi.fn>;
};

function fakeSession(sessionId?: string): FakeSession {
  return makeAgentSessionStub({
    sessionId: sessionId as string,
    disconnect: vi.fn().mockResolvedValue(undefined),
  });
}

function fakeSessionWithAgent(
  sessionId: string,
  initialStatus: "running" | "idle" | "completed" = "idle",
): FakeSession & {
  listTasks: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
  removeTask: ReturnType<typeof vi.fn>;
  setStatus(status: "running" | "idle" | "completed" | "cancelled"): void;
} {
  let status: "running" | "idle" | "completed" | "cancelled" | "removed" = initialStatus;
  return makeAgentSessionStub({
    sessionId,
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn(async () => ({
      tasks: status === "removed"
        ? []
        : [{ kind: "agent", id: `${sessionId}-agent`, status, executionMode: "background" }],
    })),
    cancelTask: vi.fn(async () => {
      status = "cancelled";
      return { cancelled: true };
    }),
    removeTask: vi.fn(async () => {
      status = "removed";
      return { removed: true };
    }),
    setStatus(nextStatus) {
      status = nextStatus;
    },
  });
}

function createManager(options: { telemetry?: boolean } = {}): {
  manager: any;
  telemetryStore?: ReturnType<typeof createTelemetryStore>;
} {
  const db = setupTestDb();
  const telemetryStore = options.telemetry ? createTelemetryStore(db) : undefined;
  const manager = new SessionManager({
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: {
      findTaskBySessionId: vi.fn().mockReturnValue(null),
      getTask: vi.fn().mockReturnValue(null),
    } as any,
    settingsStore: {
      getMcpServers: () => ({}),
      getSettings: () => ({ model: "claude-opus-4.7" }),
    } as any,
    telemetryStore,
    config: { sessionMcpServers: {} },
    clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
  }) as any;
  const stateRoot = makeTestDir("prompt-session-state");
  manager.getSessionStateDir = (sessionId: string) => join(stateRoot, sessionId);
  return { manager, telemetryStore };
}

describe("SessionManager retirement fencing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function runtime(manager: any, fence = vi.fn(async () => {})) {
    const backend = { fence, deleteSession: vi.fn(), resumeSession: vi.fn(), createSession: vi.fn(), stop: vi.fn(async () => {}) };
    const next = { start: vi.fn(async () => {}), fence: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    manager.backend = backend;
    manager.attachBackendLifecycle(backend);
    manager.deps.createBackend = vi.fn(() => next);
    return { backend, next };
  }

  it("fences a stuck idle lease by 60s, with no repeated cleanup or transcript deletion", async () => {
    const { manager, telemetryStore } = createManager({ telemetry: true });
    const { backend, next } = runtime(manager);
    const stuck = makeAgentSessionStub({
      listTasks: vi.fn(() => new Promise(() => {})),
      release: vi.fn(() => new Promise(() => {})),
      disconnect: vi.fn(),
    });
    await manager.cacheResumedSession("stuck", stuck);
    const cleanup = manager.evictAllCachedSessions();
    await vi.advanceTimersByTimeAsync(5_000);
    await cleanup;
    expect(stuck.listTasks).not.toHaveBeenCalled();
    expect(stuck.release).toHaveBeenCalledOnce();
    expect(stuck.disconnect).not.toHaveBeenCalled();
    expect(manager.cleanupOwnership.get(stuck)).toMatchObject({ phase: "quarantined" });
    await expect(manager.awaitSessionCleanup("stuck")).rejects.toThrow("could not complete");
    await vi.advanceTimersByTimeAsync(54_999);
    expect(backend.fence).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.fence).toHaveBeenCalledOnce();
    expect(next.start).toHaveBeenCalledOnce();
    expect(manager.cleanupOwnership.size).toBe(0);
    expect(manager.getBackendStatus().lastDisconnect.reason).toBe("cleanup-stalled");
    expect(backend.deleteSession).not.toHaveBeenCalled();
    expect(telemetryStore!.querySpans({ name: "session.cache.disconnect" })[0].metadata)
      .toMatchObject({ outcome: "timed-out", generation: 1 });
  });

  it("keeps all barriers until fencing resolves and coalesces concurrent retirement deadlines", async () => {
    const { manager } = createManager();
    let finishFence!: () => void;
    const { backend, next } = runtime(manager, vi.fn(() => new Promise<void>((resolve) => { finishFence = resolve; })));
    let finishRelease!: () => void;
    const first = makeAgentSessionStub({
      disconnect: vi.fn(() => new Promise<void>((resolve) => { finishRelease = resolve; })),
    });
    const second = makeAgentSessionStub({ disconnect: vi.fn(() => new Promise(() => {})) });
    await manager.cacheResumedSession("one", first);
    await manager.cacheResumedSession("two", second);
    const cleanup = manager.evictAllCachedSessions();
    await vi.advanceTimersByTimeAsync(60_000);
    await cleanup;
    expect(backend.fence).toHaveBeenCalledOnce();
    expect(next.start).not.toHaveBeenCalled();
    expect(manager.cleanupOwnership.size).toBe(2);
    await expect(manager.awaitSessionCleanup("one")).rejects.toThrow();
    finishRelease();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.cleanupOwnership.size).toBe(2);
    finishFence();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.cleanupOwnership.size).toBe(0);
    expect(next.start).toHaveBeenCalledOnce();
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(second.disconnect).toHaveBeenCalledOnce();
  });

  it("fails closed without retrying when process fencing is uncertain", async () => {
    const { manager } = createManager();
    const { backend, next } = runtime(manager, vi.fn(async () => { throw new Error("process still alive"); }));
    const stuck = makeAgentSessionStub({ disconnect: vi.fn().mockRejectedValue(new Error("detach failed")) });
    await manager.cacheResumedSession("stuck", stuck);
    await manager.evictAllCachedSessions();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(backend.fence).toHaveBeenCalledOnce();
    expect(next.start).not.toHaveBeenCalled();
    expect(manager.cleanupOwnership.get(stuck)).toMatchObject({ phase: "operator-blocked" });
    expect(manager.getBackendStatus().lastRecoveryError).toContain("fencing rejected");
    expect(manager.backendRecoveryRetryTimer).toBeNull();
  });

  it("accepts late release before the deadline without retrying detach or recycling", async () => {
    const { manager } = createManager();
    const { backend } = runtime(manager);
    let finish!: () => void;
    const stuck = makeAgentSessionStub({
      disconnect: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
    });
    await manager.cacheResumedSession("stuck", stuck);
    const cleanup = manager.evictAllCachedSessions();
    await vi.advanceTimersByTimeAsync(5_000);
    await cleanup;
    expect(manager.cleanupOwnership.get(stuck).phase).toBe("quarantined");
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.cleanupOwnership.size).toBe(0);
    expect(backend.fence).not.toHaveBeenCalled();
    expect(stuck.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: "agent", status: "running" },
    { kind: "agent", status: "idle" },
    { kind: "shell", status: "running" },
    { kind: "shell", status: "completed" },
  ] as const)("leaves $kind task $status cleanup to the runtime during retirement", async (task) => {
    const { manager } = createManager();
    runtime(manager);
    const stuck = makeAgentSessionStub({
      listTasks: vi.fn(async () => ({ tasks: [{ ...task, id: "child" }] })),
      cancelTask: vi.fn(async () => ({ cancelled: false })),
      removeTask: vi.fn(async () => ({ removed: false })),
      disconnect: vi.fn(async () => {}),
    });
    await manager.cacheResumedSession("stuck", stuck);
    await manager.evictAllCachedSessions();
    expect(stuck.listTasks).not.toHaveBeenCalled();
    expect(stuck.cancelTask).not.toHaveBeenCalled();
    expect(stuck.removeTask).not.toHaveBeenCalled();
    expect(stuck.disconnect).toHaveBeenCalledOnce();
    expect(manager.cleanupOwnership.size).toBe(0);
  });

  it("rejects a late no-timeout resume from a fenced generation before cache admission", async () => {
    const { manager } = createManager();
    const { backend } = runtime(manager);
    let finish!: (session: ReturnType<typeof makeAgentSessionStub>) => void;
    backend.resumeSession.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const resume = manager.withSessionResumeLifecycle({
      backend, sessionId: "late", sessionConfig: {}, cancellationMessage: "cancelled",
    });
    const rejected = expect(resume).rejects.toThrow("backend disconnected");
    await vi.advanceTimersByTimeAsync(0);
    manager.handleBackendDisconnect(backend, { at: new Date().toISOString(), reason: "connection-closed" });
    await vi.advanceTimersByTimeAsync(0);
    finish(makeAgentSessionStub({ sessionId: "late" }));
    await rejected;
    expect(manager.sessionObjects.has("late")).toBe(false);
    expect(backend.deleteSession).not.toHaveBeenCalled();
  });

  it("fences a failed replacement before attempting another and bounds recovery attempts", async () => {
    const { manager } = createManager();
    const { backend, next } = runtime(manager);
    const candidates = [next, ...Array.from({ length: 2 }, () => ({
      start: vi.fn(async () => {}), fence: vi.fn(async () => {}),
    }))];
    for (const candidate of candidates) candidate.start.mockRejectedValue(new Error("startup failed"));
    const queued = [...candidates];
    manager.deps.createBackend = vi.fn(() => queued.shift());
    manager.handleBackendDisconnect(backend, { at: new Date().toISOString(), reason: "connection-closed" });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(backend.fence).toHaveBeenCalledOnce();
    expect(next.fence).toHaveBeenCalledOnce();
    expect(next.fence.mock.invocationCallOrder[0]).toBeLessThan(candidates[1].start.mock.invocationCallOrder[0]);
    for (const candidate of candidates) {
      expect(candidate.start).toHaveBeenCalledOnce();
      expect(candidate.fence).toHaveBeenCalledOnce();
    }
    expect(manager.backendRecoveryRetryTimer).toBeNull();
  });

  it("does not recreate cleanup ownership from a late finally after acknowledged fencing", async () => {
    const { manager } = createManager();
    const { backend } = runtime(manager);
    const old = makeAgentSessionStub({ disconnect: vi.fn().mockRejectedValue(new Error("old transport closed")) });
    await manager.cacheResumedSession("old", old);
    manager.handleBackendDisconnect(backend, { at: new Date().toISOString(), reason: "connection-closed" });
    await vi.advanceTimersByTimeAsync(0);
    await manager.disposeSession("old", old, "late temporary name RPC finally");
    expect(old.disconnect).not.toHaveBeenCalled();
    expect(manager.cleanupOwnership.size).toBe(0);
    expect(manager.getBackendUnavailableReason()).toBeUndefined();
    expect(manager.getSessionCacheState().retainedContextWeight).toBe(0);
  });

  it("releases create and resume reservations after fencing even when raw RPCs never settle", async () => {
    const { manager } = createManager();
    const { backend } = runtime(manager);
    backend.resumeSession.mockImplementation(() => new Promise(() => {}));
    backend.createSession.mockImplementation(() => new Promise(() => {}));
    const resume = manager.withSessionResumeLifecycle({
      backend, sessionId: "never-resumed", sessionConfig: {}, cancellationMessage: "cancelled",
    });
    const resumeRejected = expect(resume).rejects.toThrow("backend disconnected");
    const reservation = await manager.beginSessionCreation({});
    const creation = manager.finishSessionCreation({
      client: backend, sessionConfig: {}, creationReservation: reservation, startedAt: Date.now(),
      cacheReason: "test", spanName: "test", logMessage: () => "created", cleanupLabel: "test",
    });
    const creationRejected = expect(creation).rejects.toThrow("backend disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.creatingSessions).toBe(1);
    expect(manager.resumingCapacityReservations.size).toBe(1);
    manager.handleBackendDisconnect(backend, { at: new Date().toISOString(), reason: "connection-closed" });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([resumeRejected, creationRejected]);
    expect(manager.creatingSessions).toBe(0);
    expect(manager.resumingCapacityReservations.size).toBe(0);
    expect(manager.isSessionBusy("never-resumed")).toBe(false);
    expect(manager.getLifecycleBlockingSessionCount()).toBe(0);
    expect(backend.deleteSession).not.toHaveBeenCalled();
  });

  it("retains an unfenced failed replacement for operator shutdown", async () => {
    const { manager } = createManager();
    const { backend, next } = runtime(manager);
    next.start.mockRejectedValue(new Error("startup failed"));
    next.fence.mockRejectedValue(new Error("candidate still alive"));
    manager.handleBackendDisconnect(backend, { at: new Date().toISOString(), reason: "connection-closed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.backendTransition).toEqual({ owner: next, phase: "blocked" });
    await manager.gracefulShutdown();
    expect(next.stop).toHaveBeenCalledOnce();
    expect(backend.stop).not.toHaveBeenCalled();
  });

  it("does not lose a candidate disconnect reported during lifecycle publication", async () => {
    const { manager } = createManager();
    const { backend, next } = runtime(manager);
    const disconnected = {
      ...next,
      onDisconnect: vi.fn((handler: (info: AgentBackendDisconnect) => void) => {
        handler({ at: new Date().toISOString(), reason: "connection-closed" });
        expect(manager.getBackendUnavailableReason()).toBeDefined();
        return () => {};
      }),
    };
    const healthy = { start: vi.fn(async () => {}), fence: vi.fn(async () => {}) };
    manager.deps.createBackend = vi.fn().mockReturnValueOnce(disconnected).mockReturnValueOnce(healthy);
    manager.handleBackendDisconnect(backend, { at: new Date().toISOString(), reason: "connection-closed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(disconnected.fence).toHaveBeenCalledOnce();
    expect(healthy.start).toHaveBeenCalledOnce();
    expect(manager.backend).toBe(healthy);
    expect(manager.getBackendStatus().disconnectCount).toBe(2);
    expect(manager.getBackendUnavailableReason()).toBeUndefined();
  });

  it("keeps candidate ownership when lifecycle registration itself throws", async () => {
    const { manager } = createManager();
    const { backend, next } = runtime(manager);
    const candidate = { ...next, onDisconnect: vi.fn(() => { throw new Error("registration failed"); }) };
    manager.deps.createBackend = vi.fn(() => candidate);
    manager.handleBackendDisconnect(backend, { at: new Date().toISOString(), reason: "connection-closed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(candidate.fence).toHaveBeenCalledOnce();
    expect(manager.backendTransition).toMatchObject({ owner: candidate, phase: "blocked" });
    expect(manager.deps.createBackend).toHaveBeenCalledOnce();
    expect(manager.getBackendUnavailableReason()).toContain("blocked");
  });

  it.each(["uncertain", "unsupported"] as const)("quarantines a typed %s release without falling back to disconnect", async (status) => {
    const { manager } = createManager();
    runtime(manager);
    const session = makeAgentSessionStub({
      release: vi.fn(async () => ({ status })),
      disconnect: vi.fn(),
    });
    await manager.cacheResumedSession("typed", session);
    await manager.evictAllCachedSessions();
    expect(session.release).toHaveBeenCalledOnce();
    expect(session.disconnect).not.toHaveBeenCalled();
    expect(manager.cleanupOwnership.get(session)).toMatchObject({ phase: "quarantined" });
  });
});

describe("SessionManager bounded session lifecycle", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it("persists launch context and renders the same PR and schedule prompt on resume", async () => {
    const { manager } = createManager();
    const task = {
      id: "task-1", title: "New Task", kind: "task", muted: false, status: "active",
      notes: "", workItems: [], pullRequests: [{ repoId: "repo", repoName: "owner/repo", prId: 42, provider: "github" }],
    };
    manager.deps.taskStore.getTask.mockReturnValue(task);
    const createSession = vi.fn(async (_config: unknown) => fakeSession("launch-test"));
    manager.backend = { createSession };
    await manager.createTaskSession("task-1", "New Task", [], ["owner/repo PR #42"], "", undefined,
      { name: "Daily", type: "cron", runCount: 2 });
    const initial = createSession.mock.calls[0]?.[0] as any;
    const persisted = readSessionLaunchContext(manager.getSessionStateDir("launch-test"));
    expect(persisted).toEqual({ isNewTask: true, scheduleContext: { name: "Daily", type: "cron", runCount: 2 } });
    const resumed = manager.buildSessionConfig({ sessionId: "launch-test", task, forResume: true });
    expect(resumed.systemMessage).toEqual(initial.systemMessage);
    expect(resumed.systemMessage.content).toContain("Currently linked PRs: owner/repo #42.");
    expect(resumed.systemMessage.content).toContain("run #3");
    expect(resumed.systemMessage.content).toContain("use the task update tool");
    await manager.evictAllCachedSessions();
  });

  it("records only accepted applied configs and retains comparison across handle eviction", async () => {
    const { manager, telemetryStore } = createManager({ telemetry: true });
    const config = { systemMessage: { mode: "customize", content: "first" }, mcpServers: {} };
    const spans = () => telemetryStore!.querySpans({ name: "session.prompt.applied", sessionId: "fingerprint" });
    const session = fakeSession("fingerprint");
    await manager.cacheSession("fingerprint", session, config, "create");
    manager.buildSessionConfig({ sessionId: "fingerprint", forResume: true });
    await manager.cacheSession("fingerprint", session, { ...config, systemMessage: { content: "not applied" } });
    const backend = { resumeSession: vi.fn() };
    manager.backend = backend;
    await manager.withSessionResumeLifecycle({
      backend, sessionId: "fingerprint", sessionConfig: config,
      reuseCachedSession: true, cancellationMessage: "cancelled",
    });
    expect(backend.resumeSession).not.toHaveBeenCalled();
    expect(spans()).toHaveLength(1);
    await manager.evictAllCachedSessions();
    await manager.cacheResumedSession("fingerprint", fakeSession("fingerprint"), config);
    expect(spans()).toHaveLength(2);
    expect(spans().map((span) => span.metadata)).toContainEqual(expect.objectContaining({
      comparison: "previous_applied", cacheBreakCandidate: false, changedCategories: [],
    }));
    await manager.evictAllCachedSessions();
    await manager.cacheResumedSession("fingerprint", fakeSession("fingerprint"), {
      ...config, systemMessage: { mode: "customize", content: "changed" },
    });
    expect(spans().map((span) => span.metadata)).toContainEqual(expect.objectContaining({
      cacheBreakCandidate: true, changedCategories: ["systemMessage", "content"],
    }));
    expect(JSON.stringify(spans())).not.toContain('"content":"changed"');
    await manager.evictAllCachedSessions();
  });

  it("awaits cleanup for explicit evict-all operations", async () => {
    const { manager } = createManager();
    const session = fakeSession();
    manager.sessionObjects.set("s1", session);

    await manager.evictAllCachedSessions();

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("s1")).toBe(false);
    expect(manager.cleanupOwnership.size).toBe(0);
  });

  it("forcibly evicts only idle cached session trees", async () => {
    const { manager } = createManager();
    const idle = fakeSession("idle");
    const active = fakeSession("active");
    const running = fakeSessionWithAgent("running", "running");
    manager.sessionObjects.set("idle", idle);
    manager.sessionObjects.set("active", active);
    manager.sessionObjects.set("running", running);
    manager.getActiveSessions = () => ["active"];
    await manager.agentRegistry.refresh("running", "test");

    await expect(manager.evictIdleCachedSessions()).resolves.toEqual({
      evictedSessions: 1,
      protectedSessions: 2,
    });

    expect(idle.disconnect).toHaveBeenCalledTimes(1);
    expect(active.disconnect).not.toHaveBeenCalled();
    expect(running.disconnect).not.toHaveBeenCalled();
    expect([...manager.sessionObjects.keys()]).toEqual(["active", "running"]);
  });

  it("forgets tracked agents only after releasing the parent handle", async () => {
    const { manager } = createManager();
    const session = fakeSessionWithAgent("s1");
    manager.sessionObjects.set("s1", session);
    await manager.agentRegistry.refresh("s1", "test");
    session.listTasks.mockClear();

    await manager.evictAllCachedSessions();

    expect(session.listTasks).not.toHaveBeenCalled();
    expect(session.cancelTask).not.toHaveBeenCalled();
    expect(session.removeTask).not.toHaveBeenCalled();
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.agentRegistry.getTrackedAgentCount("s1")).toBe(0);
  });

  it("evicts by total parent plus agent context weight", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 10;
    manager.maxCachedContexts = 2;
    const first = fakeSessionWithAgent("first");
    const second = fakeSession("second") as FakeSession & { sessionId: string };

    await manager.cacheResumedSession("first", first);
    await manager.agentRegistry.refresh("first", "test");
    await manager._drainCacheQueue();
    await manager.cacheResumedSession("second", second);
    await manager._drainCacheQueue();

    expect([...manager.sessionObjects.keys()]).toEqual(["second"]);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getSessionCacheState()).toMatchObject({
      readyParents: 1,
      trackedAgents: 0,
      readyContextWeight: 1,
    });
  });

  it("protects a tree with a running agent until the agent becomes idle", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 10;
    manager.maxCachedContexts = 2;
    const first = fakeSessionWithAgent("first", "running");
    const second = fakeSession("second") as FakeSession & { sessionId: string };

    await manager.cacheResumedSession("first", first);
    await manager.agentRegistry.refresh("first", "running");
    await manager.cacheResumedSession("second", second);
    await manager._drainCacheQueue();
    expect(manager.sessionObjects.has("first")).toBe(true);
    expect(manager.sessionObjects.has("second")).toBe(true);

    first.setStatus("idle");
    await manager.agentRegistry.refresh("first", "idle");
    await manager._drainCacheQueue();

    expect(manager.sessionObjects.has("first")).toBe(true);
    expect(manager.sessionObjects.has("second")).toBe(false);
    expect(second.disconnect).toHaveBeenCalledTimes(1);
  });

  it("evicts an entirely idle session tree after the general TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { manager } = createManager();
    manager.sessionCacheIdleTtlMs = 1_000;
    const session = fakeSession();

    await manager.cacheResumedSession("idle", session);
    vi.setSystemTime(1_001);
    await manager.trimSessionCache("test TTL");
    await manager._drainCacheQueue();

    expect(manager.sessionObjects.has("idle")).toBe(false);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
  });

  it("refreshes the general TTL when the parent session is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { manager } = createManager();
    manager.sessionCacheIdleTtlMs = 1_000;
    const session = fakeSession();

    await manager.cacheResumedSession("active", session);
    vi.setSystemTime(900);
    manager.sessionRunner.touchSessionRun("active", 900);
    vi.setSystemTime(1_500);
    await manager.trimSessionCache("before refreshed TTL");
    expect(manager.sessionObjects.has("active")).toBe(true);

    vi.setSystemTime(1_901);
    await manager.trimSessionCache("after refreshed TTL");
    await manager._drainCacheQueue();
    expect(manager.sessionObjects.has("active")).toBe(false);
  });

  it("starts a fresh idle TTL when a stale active run completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { manager } = createManager();
    manager.sessionCacheIdleTtlMs = 1_000;
    const completed = fakeSession("completed");
    const expired = fakeSession("expired");
    await manager.cacheResumedSession("completed", completed);
    await manager.cacheResumedSession("expired", expired);
    manager.setSessionRunState("completed", "busy", { now: 0, lastEventAt: 0 });

    vi.setSystemTime(1_001);
    manager.setSessionRunState("completed", "idle", { now: 1_001 });
    await manager.trimSessionCache("completion grace period");
    await manager._drainCacheQueue();

    expect(manager.sessionObjects.has("completed")).toBe(true);
    expect(completed.disconnect).not.toHaveBeenCalled();
    expect(manager.sessionObjects.has("expired")).toBe(false);
    expect(expired.disconnect).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2_000);
    await manager.trimSessionCache("inside completion grace period");
    expect(manager.sessionObjects.has("completed")).toBe(true);

    vi.setSystemTime(2_001);
    await manager.trimSessionCache("completed grace period");
    await manager._drainCacheQueue();
    expect(manager.sessionObjects.has("completed")).toBe(false);
    expect(completed.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps fresh scheduled-session creation responsive while cleanup runs independently", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 2;
    let releaseOldest!: () => void;
    const sessions: Array<FakeSession & { sessionId: string }> = [];
    manager.backend = {
      createSession: vi.fn(async () => {
        const session = fakeSession(`scheduled-${sessions.length}`) as FakeSession & { sessionId: string };
        if (sessions.length === 0) {
          session.disconnect.mockImplementation(() => new Promise<void>((resolve) => {
            releaseOldest = resolve;
          }));
        }
        sessions.push(session);
        return session;
      }),
    };

    await manager.createTaskSession("task-1", "Scheduled task", [], [], "");
    await manager.createTaskSession("task-1", "Scheduled task", [], [], "");
    await manager.createTaskSession("task-1", "Scheduled task", [], [], "");
    await vi.waitFor(() => expect(sessions[0].disconnect).toHaveBeenCalledTimes(1));

    expect([...manager.sessionObjects.keys()]).toEqual(["scheduled-1", "scheduled-2"]);
    expect(manager.cleanupOwnership.has(sessions[0])).toBe(true);

    releaseOldest();
    await manager._drainCacheQueue();
    expect(manager.cleanupOwnership.size).toBe(0);
  });

  it("returns concurrent cache insertions before a hung disconnect finishes", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    let releaseFirst!: () => void;
    const first = makeAgentSessionStub({
      disconnect: vi.fn(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })),
    });
    const second = fakeSession();
    const third = fakeSession();
    await manager.cacheResumedSession("first", first);

    await manager.cacheResumedSession("second", second);
    await manager.cacheResumedSession("third", third);

    expect([...manager.sessionObjects.keys()]).toEqual(["third"]);
    expect(manager.cleanupOwnership.has(first)).toBe(true);
    await vi.waitFor(() => expect(first.disconnect).toHaveBeenCalled());
    await vi.waitFor(() => expect(second.disconnect).toHaveBeenCalledOnce());
    releaseFirst();
    await manager._drainCacheQueue();
    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.cleanupOwnership.size).toBe(0);
  });

  it("keeps the existing same-id owner without disconnecting a duplicate handle", async () => {
    const { manager } = createManager();
    const existing = fakeSession();
    const duplicate = fakeSession();

    await manager.cacheResumedSession("same", existing);
    const cached = await manager.cacheResumedSession("same", duplicate);

    expect(cached).toBe(existing);
    expect(manager.sessionObjects.get("same")).toBe(existing);
    expect(existing.disconnect).not.toHaveBeenCalled();
    expect(duplicate.disconnect).not.toHaveBeenCalled();
    expect(manager.sessionObjects.get("same")).toBe(existing);
  });

  it("never retries a rejected disconnect during later cache sweeps", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const first = makeAgentSessionStub({
      disconnect: vi.fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue(undefined),
    });

    await manager.cacheResumedSession("first", first);
    await manager.cacheResumedSession("second", fakeSession());
    await manager._drainCacheQueue();

    await manager.trimSessionCache("later sweep");
    await manager._drainCacheQueue();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.cleanupOwnership.get(first)).toMatchObject({ phase: "quarantined" });
    expect(manager.cumulativeCleanupFailures).toBe(1);
  });

  it("retains agent capacity until a pending release completes without polling tasks", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const vanished = fakeSessionWithAgent("vanished");
    let releaseDisconnect!: () => void;
    vanished.disconnect.mockImplementation(() => {
      return new Promise<void>((resolve) => {
        releaseDisconnect = resolve;
      });
    });
    await manager.cacheResumedSession("vanished", vanished);
    await manager.agentRegistry.refresh("vanished", "test");
    expect(manager.agentRegistry.getTrackedAgentCount("vanished")).toBe(1);
    vanished.listTasks.mockClear();

    await manager.cacheResumedSession("next", fakeSession());
    await vi.waitFor(() => expect(vanished.disconnect).toHaveBeenCalledTimes(1));

    expect(vanished.listTasks).not.toHaveBeenCalled();
    expect(vanished.cancelTask).not.toHaveBeenCalled();
    expect(vanished.removeTask).not.toHaveBeenCalled();
    expect(manager.cleanupOwnership.has(vanished)).toBe(true);
    expect(manager.agentRegistry.getTrackedAgentCount("vanished")).toBe(1);

    releaseDisconnect();
    await manager._drainCacheQueue();

    expect(manager.cleanupOwnership.has(vanished)).toBe(false);
    expect(manager.agentRegistry.getTrackedAgentCount("vanished")).toBe(0);
    expect(manager.cumulativeCleanupFailures).toBe(0);
    expect(() => manager.assertSessionCapacityAvailable({
      capacityUnits: 1,
      localMcpInstances: 0,
    })).not.toThrow();
  });

  it("does not mistake an untyped missing-session error for release acknowledgement", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const vanished = makeAgentSessionStub({
      disconnect: vi.fn().mockRejectedValue(new Error("Session not found: vanished")),
    });
    await manager.cacheResumedSession("vanished", vanished);
    await manager.cacheResumedSession("next", fakeSession());
    await manager._drainCacheQueue();

    expect(vanished.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.cleanupOwnership.has(vanished)).toBe(true);
    expect(manager.cumulativeCleanupFailures).toBe(1);

    const createSession = vi.fn().mockResolvedValue(fakeSession("created"));
    manager.maxCachedSessions = 16;
    manager.backend = { createSession };
    await expect(manager.createTaskSession("task-1", "Scheduled task", [], [], ""))
      .rejects.toThrow("reconnecting");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("retains cleanup after the SDK connection closes without process fencing", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const disconnected = makeAgentSessionStub({
      disconnect: vi.fn().mockRejectedValue(
        new ConnectionError(ConnectionErrors.Closed, "Connection is closed."),
      ),
    });
    await manager.cacheResumedSession("disconnected", disconnected);
    await manager.cacheResumedSession("next", fakeSession());
    await manager._drainCacheQueue();

    expect(disconnected.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.cleanupOwnership.has(disconnected)).toBe(true);
    expect(manager.cumulativeCleanupFailures).toBe(1);
    expect(() => manager.assertSessionCapacityAvailable({
      capacityUnits: 1,
      localMcpInstances: 0,
    })).toThrow();
  });

  it("retains failed cleanup ownership and blocks new SDK session creation", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxCachedSessions = 1;
    const stuck = makeAgentSessionStub({ disconnect: vi.fn().mockRejectedValue(new Error("still running")) });
    await manager.cacheResumedSession("stuck", stuck);
    await manager.cacheResumedSession("next", fakeSession());
    await manager._drainCacheQueue();

    expect(manager.cleanupOwnership.get(stuck)).toMatchObject({
      sessionId: "stuck",
      phase: "quarantined",
    });
    const createSession = vi.fn();
    manager.backend = { createSession };
    await expect(manager.createTaskSession("task-1", "Scheduled task", [], [], ""))
      .rejects.toThrow("reconnecting");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("retains timed-out cleanup ownership without blocking the cache insertion", async () => {
    vi.useFakeTimers();
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const stuck = makeAgentSessionStub({ disconnect: vi.fn(() => new Promise<void>(() => {})) });
    await manager.cacheResumedSession("stuck", stuck);

    await manager.cacheResumedSession("next", fakeSession());
    expect([...manager.sessionObjects.keys()]).toEqual(["next"]);

    const drain = manager._drainCacheQueue();
    await vi.advanceTimersByTimeAsync(10_500);
    await drain;
    expect(stuck.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.cleanupOwnership.get(stuck)).toMatchObject({
      sessionId: "stuck",
      phase: "quarantined",
    });
  });

  it("blocks new SDK sessions when the cleanup backlog reaches its cap", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxCachedSessions = 1;
    manager.maxPendingSessionCleanups = 1;
    let release!: () => void;
    const first = makeAgentSessionStub({
      disconnect: vi.fn(() => new Promise<void>((resolve) => {
        release = resolve;
      })),
    });
    await manager.cacheResumedSession("first", first);
    await manager.cacheResumedSession("second", fakeSession());
    await vi.waitFor(() => expect(first.disconnect).toHaveBeenCalledTimes(1));

    const createSession = vi.fn();
    manager.backend = { createSession };
    await expect(manager.createTaskSession("task-1", "Scheduled task", [], [], ""))
      .rejects.toMatchObject({ reason: "cleanup-demand" });
    expect(createSession).not.toHaveBeenCalled();

    release();
    await manager._drainCacheQueue();
  });

  it("blocks new SDK sessions while retained context weight exceeds the budget", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxCachedSessions = 1;
    manager.maxCachedContexts = 1;
    manager.maxPendingSessionCleanups = 10;
    let release!: () => void;
    const first = makeAgentSessionStub({
      disconnect: vi.fn(() => new Promise<void>((resolve) => {
        release = resolve;
      })),
    });
    await manager.cacheResumedSession("first", first);
    await manager.cacheResumedSession("second", fakeSession());
    await vi.waitFor(() => expect(first.disconnect).toHaveBeenCalledTimes(1));

    const createSession = vi.fn();
    manager.backend = { createSession };
    await expect(manager.createTaskSession("task-1", "Scheduled task", [], [], ""))
      .rejects.toMatchObject({ reason: "context-limit" });
    expect(createSession).not.toHaveBeenCalled();

    release();
    await manager._drainCacheQueue();
  });

  it("reaps idle sync agents before rejecting a new resume for context pressure", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxCachedContexts = 2;
    let status: "idle" | "cancelled" | "removed" = "idle";
    const parent = makeAgentSessionStub({
      sessionId: "parent",
      disconnect: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn(async () => ({
        tasks: status === "removed"
          ? []
          : [{
              kind: "agent",
              id: "sync-agent",
              status,
              executionMode: "sync",
            }],
      })),
      cancelTask: vi.fn(async () => {
        status = "cancelled";
        return { cancelled: true };
      }),
      removeTask: vi.fn(async () => {
        if (status !== "cancelled") return { removed: false };
        status = "removed";
        return { removed: true };
      }),
    });
    await manager.cacheResumedSession("parent", parent);
    await manager.agentRegistry.refresh("parent", "test");
    manager.getActiveSessions = () => ["parent"];

    const lease = await manager.beginSessionResume("next", { mcpServers: {} });

    expect(parent.cancelTask).toHaveBeenCalledWith("sync-agent");
    expect(parent.removeTask).toHaveBeenCalledWith("sync-agent");
    expect(manager.getSessionCacheState()).toMatchObject({
      trackedAgents: 0,
      readyContextWeight: 1,
      reservedContexts: 1,
    });
    manager.endSessionResume(lease);
  });

  it("rechecks admission after a capacity sweep refreshes stale sync-agent accounting", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxCachedContexts = 2;
    let taskPresent = true;
    const parent = makeAgentSessionStub({
      sessionId: "parent",
      disconnect: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn(async () => ({
        tasks: taskPresent
          ? [{
              kind: "agent",
              id: "already-removed",
              status: "idle",
              executionMode: "sync",
            }]
          : [],
      })),
      cancelTask: vi.fn().mockResolvedValue({ cancelled: false }),
      removeTask: vi.fn().mockResolvedValue({ removed: false }),
    });
    await manager.cacheResumedSession("parent", parent);
    await manager.agentRegistry.refresh("parent", "test");
    manager.getActiveSessions = () => ["parent"];
    taskPresent = false;

    const lease = await manager.beginSessionResume("next", { mcpServers: {} });

    expect(parent.cancelTask).not.toHaveBeenCalled();
    expect(parent.removeTask).not.toHaveBeenCalled();
    expect(manager.getSessionCacheState()).toMatchObject({
      trackedAgents: 0,
      readyContextWeight: 1,
      reservedContexts: 1,
    });
    manager.endSessionResume(lease);
  });

  it("counts uncached resume reservations against the hard context limit", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxCachedContexts = 1;

    const firstLease = await manager.beginSessionResume("first", { mcpServers: {} });
    await expect(manager.beginSessionResume("second", { mcpServers: {} }))
      .rejects.toMatchObject({
        name: "SessionCapacityError",
        reason: "context-limit",
        snapshot: {
          contexts: 2,
          contextLimit: 1,
        },
      });
    manager.endSessionResume(firstLease);
  });

  it("weights local MCP instances across every context in a session tree", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 10;
    manager.maxCachedContexts = 10;
    manager.maxSessionCapacityUnits = 3;
    manager.localMcpCapacityWeight = 0.25;
    const session = fakeSessionWithAgent("weighted");
    const sessionConfig = {
      mcpServers: {
        localOne: { command: "one", args: [] },
        localTwo: { type: "stdio", command: "two", args: [] },
        remote: { type: "http", url: "https://example.test/mcp" },
      },
    };

    await manager.cacheResumedSession("weighted", session, sessionConfig);
    await manager.agentRegistry.refresh("weighted", "test");

    expect(manager.getSessionCacheState()).toMatchObject({
      readyContextWeight: 2,
      readyLocalMcpInstances: 4,
      readyCapacityUnits: 3,
    });
  });

  it("retains the creation capacity profile when a mismatched session is rejected", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 10;
    manager.maxCachedContexts = 10;
    manager.maxSessionCapacityUnits = 10;
    manager.localMcpCapacityWeight = 0.25;

    const sessionConfig = {
      mcpServers: {
        localOne: { command: "one", args: [] },
        remote: { type: "http", url: "https://example.test/mcp" },
      },
    };

    // The backend hands back a different session ID than requested, and its
    // disconnect never settles, so cleanup ownership stays pending.
    const rejected = makeAgentSessionStub({
      sessionId: "backend-chose-this",
      disconnect: vi.fn(() => new Promise<void>(() => {})),
    });

    manager.rejectMismatchedCreatedSession(
      "bridge-requested-this",
      rejected,
      sessionConfig,
    ).catch(() => {});

    await vi.waitFor(() => {
      const state = manager.getSessionCacheState();
      expect(state.cleanupOwnershipCount ?? manager.cleanupOwnership.size).toBeGreaterThan(0);
    });

    const state = manager.getSessionCacheState();
    // One context plus one local MCP (the remote server never counts):
    // 1 + 1 * 0.25 = 1.25 retained units, not the bare 1.0 an empty profile
    // would have produced.
    expect(state.retainedLocalMcpInstances).toBe(1);
    expect(state.retainedCapacityUnits).toBe(1.25);
  });

  it("blocks on weighted capacity before the hard context limit", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxCachedContexts = 10;
    manager.maxSessionCapacityUnits = 2.5;
    const config = {
      mcpServers: {
        one: { command: "one", args: [] },
        two: { command: "two", args: [] },
        remote: { type: "http", url: "https://example.test/mcp" },
      },
    };

    const firstLease = await manager.beginSessionResume("first", config);
    await expect(manager.beginSessionResume("second", config))
      .rejects.toMatchObject({
        reason: "weighted-capacity",
        snapshot: {
          contexts: 2,
          localMcpInstances: 4,
          capacityUnits: 3,
          capacityLimit: 2.5,
        },
      });
    manager.endSessionResume(firstLease);
  });

  it("waits for capacity and admits the next resume when a slot is released", async () => {
    const { manager } = createManager();
    manager.maxCachedContexts = 1;
    manager.sessionCapacityWaitTimeoutMs = 5_000;

    const firstLease = await manager.beginSessionResume("first", { mcpServers: {} });
    const second = manager.beginSessionResume("second", { mcpServers: {} });
    await vi.waitFor(() => expect(manager.sessionCapacityWaiters.size).toBe(1));

    manager.endSessionResume(firstLease);
    const secondLease = await second;

    expect(manager.resumingSessions.has("second")).toBe(true);
    manager.endSessionResume(secondLease);
  });

  it("does not double count a session that is already marked active", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxCachedContexts = 1;
    manager.sessionOverlayBusyReasons.set("switching", "model-switching");

    const switchingLease = await manager.beginSessionResume(
      "switching",
      { mcpServers: {} },
    );

    manager.endSessionResume(switchingLease);
    manager.sessionOverlayBusyReasons.delete("switching");
  });

  it("rejects concurrent and queued duplicate resumes for the same session id", async () => {
    // rejects concurrent resume admission for the same session id
    {
      const { manager } = createManager();
      const firstLease = await manager.beginSessionResume("same", { mcpServers: {} });

      await expect(manager.beginSessionResume("same", { mcpServers: {} }))
        .rejects.toThrow("Session same already has a resume in progress");

      manager.endSessionResume(firstLease);
    }

    // rejects a duplicate resume while the first admission is waiting for capacity
    {
      const { manager } = createManager();
      manager.maxCachedContexts = 1;
      manager.sessionCapacityWaitTimeoutMs = 5_000;
      const blockerLease = await manager.beginSessionResume("blocker", { mcpServers: {} });
      const pendingLease = manager.beginSessionResume("same", { mcpServers: {} });
      await vi.waitFor(() => expect(manager.pendingSessionResumeAdmissions.has("same")).toBe(true));

      await expect(manager.beginSessionResume("same", { mcpServers: {} }))
        .rejects.toThrow("Session same already has a resume in progress");

      manager.endSessionResume(blockerLease);
      manager.endSessionResume(await pendingLease);
    }
  });
  it("protects a cached session operation without reserving a second context", async () => {
    const { manager } = createManager();
    manager.maxCachedContexts = 1;
    await manager.cacheResumedSession("cached", fakeSession(), { mcpServers: {} });

    const cachedLease = await manager.beginSessionResume("cached", { mcpServers: {} });

    expect(manager.getSessionCacheState()).toMatchObject({
      readyContextWeight: 1,
      reservedContexts: 0,
    });
    manager.endSessionResume(cachedLease);
  });

  it("releases only the capacity lease owned by each overlapping cached operation", async () => {
    const { manager } = createManager();
    manager.maxCachedContexts = 2;
    await manager.cacheResumedSession("cached", fakeSession(), { mcpServers: {} });

    const reloadLease = await manager.beginSessionResume(
      "cached",
      { mcpServers: {} },
      { reserveCachedSession: true },
    );
    const cachedLease = await manager.beginSessionResume("cached", { mcpServers: {} });
    expect(manager.getSessionCacheState().reservedContexts).toBe(1);

    manager.endSessionResume(cachedLease);
    expect(manager.getSessionCacheState().reservedContexts).toBe(1);

    manager.endSessionResume(reloadLease);
    expect(manager.getSessionCacheState().reservedContexts).toBe(0);
  });

  it("reserves cleanup capacity across concurrent session creation", async () => {
    const { manager } = createManager();
    manager.sessionCapacityWaitTimeoutMs = 0;
    manager.maxPendingSessionCleanups = 1;
    let resolveCreate!: (session: FakeSession & { sessionId: string }) => void;
    const createSession = vi.fn(() => new Promise<FakeSession & { sessionId: string }>((resolve) => {
      resolveCreate = resolve;
    }));
    manager.backend = { createSession };

    const first = manager.createTaskSession("task-1", "Scheduled task", [], [], "");
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await expect(manager.createTaskSession("task-1", "Scheduled task", [], [], ""))
      .rejects.toMatchObject({ reason: "cleanup-demand" });

    resolveCreate(fakeSession("created") as FakeSession & { sessionId: string });
    await first;
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("protects active, resuming, and model-switching sessions, then trims after protection ends", async () => {
    const { manager } = createManager();
    manager.maxCachedSessions = 1;
    const active = fakeSession();
    const resuming = fakeSession();
    const switching = fakeSession();
    manager.sessionObjects.set("active", active);
    manager.sessionObjects.set("resuming", resuming);
    manager.sessionObjects.set("switching", switching);
    manager.sessionRuns.set("active", { state: "busy", startedAt: Date.now(), lastEventAt: Date.now() });
    manager.resumingSessions.set("resuming", 1);
    manager.sessionOverlayBusyReasons.set("switching", "model-switching");

    await manager.cacheResumedSession("new", fakeSession());
    expect(manager.sessionObjects.size).toBe(4);
    expect(active.disconnect).not.toHaveBeenCalled();

    manager.sessionRuns.delete("active");
    manager.resumingSessions.clear();
    manager.sessionOverlayBusyReasons.clear();
    await manager.trimSessionCache("test protection ended");
    await manager._drainCacheQueue();

    expect([...manager.sessionObjects.keys()]).toEqual(["new"]);
    expect(active.disconnect).toHaveBeenCalledTimes(1);
    expect(resuming.disconnect).toHaveBeenCalledTimes(1);
    expect(switching.disconnect).toHaveBeenCalledTimes(1);
  });

  it("records state operations separately from cleanup duration", async () => {
    const { manager, telemetryStore } = createManager({ telemetry: true });
    manager.maxCachedSessions = 1;
    manager.lastProcessTreeSampleAt = Date.now();
    await manager.cacheResumedSession("first", fakeSession());
    await manager.cacheResumedSession("second", fakeSession());

    const operation = telemetryStore!.querySpans({ name: "session.cache.operation" })[0];
    expect(operation.metadata).toMatchObject({
      operation: "insert",
      outcome: "succeeded",
      ready: 1,
    });

    await manager._drainCacheQueue();
    const disconnect = telemetryStore!.querySpans({ name: "session.cache.disconnect" })[0];
    expect(disconnect.metadata).toMatchObject({
      outcome: "fulfilled",
      reason: "enforcing session-tree cache limit",
    });
  });

  it("defaults to a generous context ceiling while keeping the idle parent cache bounded", () => {
    vi.stubEnv("BRIDGE_MAX_CACHED_SESSIONS", "");
    vi.stubEnv("BRIDGE_MAX_CACHED_CONTEXTS", "");
    vi.stubEnv("BRIDGE_MAX_PENDING_SESSION_CLEANUPS", "");
    vi.stubEnv("BRIDGE_MAX_SESSION_CAPACITY_UNITS", "");
    try {
      const { manager } = createManager();
      expect(manager.maxCachedSessions).toBe(16);
      expect(manager.maxCachedContexts).toBe(32);
      expect(manager.maxPendingSessionCleanups).toBe(32);
      expect(manager.maxSessionCapacityUnits).toBe(64);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults limits from environment variables", () => {
    vi.stubEnv("BRIDGE_MAX_CACHED_SESSIONS", "4");
    vi.stubEnv("BRIDGE_MAX_CACHED_CONTEXTS", "6");
    vi.stubEnv("BRIDGE_SESSION_CACHE_IDLE_TTL_SECONDS", "120");
    vi.stubEnv("BRIDGE_MAX_PENDING_SESSION_CLEANUPS", "3");
    vi.stubEnv("BRIDGE_MAX_SESSION_CAPACITY_UNITS", "40");
    vi.stubEnv("BRIDGE_LOCAL_MCP_CAPACITY_WEIGHT", "0.5");
    vi.stubEnv("BRIDGE_SESSION_CAPACITY_WAIT_SECONDS", "9");
    try {
      const { manager } = createManager();
      expect(manager.maxCachedSessions).toBe(4);
      expect(manager.maxCachedContexts).toBe(6);
      expect(manager.sessionCacheIdleTtlMs).toBe(120_000);
      expect(manager.maxPendingSessionCleanups).toBe(3);
      expect(manager.maxSessionCapacityUnits).toBe(40);
      expect(manager.localMcpCapacityWeight).toBe(0.5);
      expect(manager.sessionCapacityWaitTimeoutMs).toBe(9_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
