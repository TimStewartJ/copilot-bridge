import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackend, AgentSession } from "../agent-backend/index.js";
import { createEventBusRegistry } from "../event-bus.js";
import type { ProcessTreeSnapshot } from "../platform.js";
import {
  clearRestartPending,
  configureRestartStateStore,
  isRestartPending,
  refreshRestartState,
  SessionBackendUnavailableError,
  SessionCapacityError,
  SessionManager,
  type SessionManagerDeps,
} from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeSession(sessionId: string): AgentSession {
  return {
    sessionId,
    disconnect: vi.fn(async () => {}),
  } as unknown as AgentSession;
}

function fakeBackend(overrides: Partial<AgentBackend> = {}): AgentBackend {
  return {
    id: "copilot",
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
    createSession: vi.fn(async () => fakeSession("created")),
    resumeSession: vi.fn(async (sessionId) => fakeSession(sessionId)),
    deleteSession: vi.fn(async () => {}),
    getSessionMetadata: vi.fn(async () => ({})),
    ...overrides,
  };
}

function processSnapshot(descendantCount: number): ProcessTreeSnapshot {
  return {
    root: { pid: process.pid, startMarker: "root" },
    descendants: Array.from({ length: descendantCount }, (_, index) => ({
      pid: 10_000 + index,
      startMarker: String(index + 1),
    })),
  };
}

async function createManager(
  backends: AgentBackend[],
  sampleProcessTree: SessionManagerDeps["sampleProcessTree"] = async () => processSnapshot(0),
) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const runtimePaths = makeTestRuntimePaths("backend-recovery");
  const backendQueue = [...backends];
  const createBackend = vi.fn(() => {
    const backend = backendQueue.shift();
    if (!backend) throw new Error("No fake backend queued");
    return backend;
  });
  const manager = new SessionManager({
    globalBus,
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: createTaskStore(db, globalBus),
    settingsStore: {
      getMcpServers: () => ({}),
      getSettings: () => ({}),
    } as any,
    config: { sessionMcpServers: {} },
    copilotHome: runtimePaths.copilotHome,
    runtimePaths,
    createBackend,
    sampleProcessTree,
  }) as any;
  await manager.initialize();
  return { manager, createBackend, runtimePaths };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  configureRestartStateStore(undefined);
  clearRestartPending();
  vi.useRealTimers();
});

describe("SessionManager backend generation recovery", () => {
  it("fails six concurrent hung creates with one recovery and releases every reservation", async () => {
    vi.useFakeTimers();
    const oldBackend = fakeBackend({
      createSession: vi.fn(() => new Promise<AgentSession>(() => {})),
    });
    const replacement = fakeBackend();
    const { manager, createBackend } = await createManager([oldBackend, replacement]);
    manager.sessionCreateTimeoutMs = 25;
    manager.maxProcessTreeDescendants = 1_000;

    const creates = Array.from({ length: 6 }, () => manager.createSession());
    const resultsPromise = Promise.allSettled(creates);
    await flush();
    expect(oldBackend.createSession).toHaveBeenCalledTimes(6);

    await vi.advanceTimersByTimeAsync(25);
    const results = await resultsPromise;
    await flush();

    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(SessionBackendUnavailableError);
        expect(result.reason).toMatchObject({ code: "session_backend_unavailable" });
      }
    }
    expect(oldBackend.stop).toHaveBeenCalledOnce();
    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(manager.creatingCapacityReservations.size).toBe(0);
    expect(manager.resumingCapacityReservations.size).toBe(0);
    expect(manager.getRuntimeActivity().capacity.processes.projectedReservations).toBe(0);
    manager.stopSessionCacheSweep();
  });

  it("cleans up a late create through the backend generation that created it", async () => {
    vi.useFakeTimers();
    const lateCreate = deferred<AgentSession>();
    const oldBackend = fakeBackend({
      createSession: vi.fn(() => lateCreate.promise),
    });
    const replacement = fakeBackend();
    const { manager } = await createManager([oldBackend, replacement]);
    manager.sessionCreateTimeoutMs = 20;

    const create = manager.createSession();
    const createResult = create.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(20);
    await expect(createResult).resolves.toBeInstanceOf(SessionBackendUnavailableError);
    await flush();

    const lateSession = fakeSession("late-created");
    lateCreate.resolve(lateSession);
    await flush();

    expect(lateSession.disconnect).toHaveBeenCalledOnce();
    expect(oldBackend.deleteSession).toHaveBeenCalledWith("late-created");
    expect(replacement.deleteSession).not.toHaveBeenCalled();
    manager.stopSessionCacheSweep();
  });

  it("does not create or use a replacement until the old backend stop is verified", async () => {
    vi.useFakeTimers();
    const lateCreate = deferred<AgentSession>();
    const verifiedStop = deferred<void>();
    const oldBackend = fakeBackend({
      createSession: vi.fn()
        .mockResolvedValueOnce(fakeSession("settled-before-recovery"))
        .mockImplementationOnce(() => lateCreate.promise),
      stop: vi.fn(() => verifiedStop.promise),
    });
    const replacement = fakeBackend({
      createSession: vi.fn(async () => fakeSession("replacement-session")),
    });
    const { manager, createBackend } = await createManager([oldBackend, replacement]);
    manager.sessionCreateTimeoutMs = 20;

    await expect(manager.createSession()).resolves.toEqual({ sessionId: "settled-before-recovery" });
    expect(manager.getRuntimeActivity().capacity.processes.projectedReservations).toBe(1);

    const create = manager.createSession();
    const createResult = create.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(20);
    await expect(createResult).resolves.toBeInstanceOf(SessionBackendUnavailableError);
    await flush();

    expect(createBackend).toHaveBeenCalledOnce();
    expect(replacement.start).not.toHaveBeenCalled();
    await expect(manager.createSession()).rejects.toBeInstanceOf(SessionBackendUnavailableError);

    verifiedStop.resolve();
    await flush();
    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(replacement.start).toHaveBeenCalledOnce();
    expect(manager.getRuntimeActivity().capacity.processes.projectedReservations).toBe(0);
    await expect(manager.createSession()).resolves.toEqual({ sessionId: "replacement-session" });

    lateCreate.resolve(fakeSession("late-old-session"));
    await flush();
    manager.stopSessionCacheSweep();
  });

  it("keeps a failed-stop generation fenced and escalates to a full restart", async () => {
    vi.useFakeTimers();
    const oldBackend = fakeBackend({
      createSession: vi.fn(() => new Promise<AgentSession>(() => {})),
      stop: vi.fn(async () => {
        throw new Error("stop verification failed");
      }),
    });
    const replacement = fakeBackend();
    const { manager, createBackend, runtimePaths } = await createManager([oldBackend, replacement]);
    await refreshRestartState();
    manager.sessionCreateTimeoutMs = 20;

    const createResult = manager.createSession().then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(20);
    await expect(createResult).resolves.toBeInstanceOf(SessionBackendUnavailableError);
    await flush();

    expect(oldBackend.forceStop).toHaveBeenCalledOnce();
    expect(createBackend).toHaveBeenCalledOnce();
    expect(replacement.start).not.toHaveBeenCalled();
    expect(isRestartPending()).toBe(true);
    expect(existsSync(join(runtimePaths.dataDir, "restart.signal"))).toBe(true);
    await expect(manager.createSession()).rejects.toBeInstanceOf(SessionBackendUnavailableError);
    clearRestartPending();
    await refreshRestartState();
    manager.stopSessionCacheSweep();
  });

  it("treats non-empty backend stop errors as unverified and does not start a replacement", async () => {
    vi.useFakeTimers();
    const stopErrors = [new Error("SDK child process remained alive")];
    const oldBackend = fakeBackend({
      createSession: vi.fn(() => new Promise<AgentSession>(() => {})),
      stop: vi.fn(async () => stopErrors),
    });
    const replacement = fakeBackend();
    const { manager, createBackend, runtimePaths } = await createManager([oldBackend, replacement]);
    await refreshRestartState();
    manager.sessionCreateTimeoutMs = 20;

    const createResult = manager.createSession().then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(20);
    await expect(createResult).resolves.toBeInstanceOf(SessionBackendUnavailableError);
    await flush();

    expect(oldBackend.forceStop).toHaveBeenCalledOnce();
    expect(createBackend).toHaveBeenCalledOnce();
    expect(replacement.start).not.toHaveBeenCalled();
    expect(isRestartPending()).toBe(true);
    expect(existsSync(join(runtimePaths.dataDir, "restart.signal"))).toBe(true);
    await expect(manager.createSession()).rejects.toBeInstanceOf(SessionBackendUnavailableError);
    clearRestartPending();
    await refreshRestartState();
    manager.stopSessionCacheSweep();
  });

  it("rejects an in-flight resume when a concurrent create recycles its generation", async () => {
    vi.useFakeTimers();
    const lateResume = deferred<AgentSession>();
    const lateCreate = deferred<AgentSession>();
    const oldBackend = fakeBackend({
      resumeSession: vi.fn(() => lateResume.promise),
      createSession: vi.fn(() => lateCreate.promise),
    });
    const replacement = fakeBackend();
    const { manager, createBackend } = await createManager([oldBackend, replacement]);
    manager.sessionCreateTimeoutMs = 30;
    manager.sessionResumeTimeoutMs = 1_000;

    const warm = manager.warmSession("resume-session");
    const warmResult = warm.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    expect(oldBackend.resumeSession).toHaveBeenCalledOnce();

    const createResult = manager.createSession().then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(30);
    await expect(warmResult).resolves.toMatchObject({
      reason: "create-timeout",
      code: "session_backend_unavailable",
    });
    await expect(createResult).resolves.toMatchObject({
      reason: "create-timeout",
      code: "session_backend_unavailable",
    });
    await flush();

    expect(oldBackend.stop).toHaveBeenCalledOnce();
    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(manager.resumingCapacityReservations.size).toBe(0);

    const lateSession = fakeSession("resume-session");
    lateResume.resolve(lateSession);
    lateCreate.resolve(fakeSession("late-created-during-resume"));
    await flush();
    expect(lateSession.disconnect).toHaveBeenCalledOnce();
    expect(oldBackend.deleteSession).not.toHaveBeenCalledWith("resume-session");
    manager.stopSessionCacheSweep();
  });

  it("reserves projected process slots atomically across a concurrent create burst", async () => {
    vi.useFakeTimers();
    const firstCreate = deferred<AgentSession>();
    const secondCreate = deferred<AgentSession>();
    const pendingCreates = [firstCreate, secondCreate];
    const backend = fakeBackend({
      createSession: vi.fn(() => {
        const next = pendingCreates.shift();
        if (!next) throw new Error("process admission allowed too many creates");
        return next.promise;
      }),
    });
    const { manager } = await createManager([backend], async () => processSnapshot(8));
    manager.maxProcessTreeDescendants = 10;
    manager.sessionCapacityWaitTimeoutMs = 0;

    const creates = Array.from({ length: 6 }, () => manager.createSession());
    const resultsPromise = Promise.allSettled(creates);
    await flush();

    expect(backend.createSession).toHaveBeenCalledTimes(2);
    expect(manager.getRuntimeActivity().capacity.processes).toMatchObject({
      actualDescendants: 8,
      projectedReservations: 2,
      used: 10,
      limit: 10,
    });

    firstCreate.resolve(fakeSession("burst-1"));
    secondCreate.resolve(fakeSession("burst-2"));
    await flush();
    const results = await resultsPromise;

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(SessionCapacityError);
      expect(result.reason).toMatchObject({ reason: "process-pressure" });
    }
    expect(manager.getRuntimeActivity().capacity.processes.projectedReservations).toBe(2);
    manager.stopSessionCacheSweep();
  });

  it("holds a creation reservation until the created session is owned by the cache", async () => {
    vi.useFakeTimers();
    const backend = fakeBackend({
      createSession: vi.fn(async () => fakeSession("cache-owned")),
    });
    const { manager } = await createManager([backend]);
    const cacheGate = deferred<void>();
    manager.cacheQueue = cacheGate.promise;

    const create = manager.createSession();
    await flush();

    expect(backend.createSession).toHaveBeenCalledOnce();
    expect(manager.creatingCapacityReservations.size).toBe(1);
    expect(manager.getRuntimeActivity().capacity.processes.projectedReservations).toBe(1);
    expect(manager.sessionObjects.has("cache-owned")).toBe(false);

    cacheGate.resolve();
    await flush();
    await expect(create).resolves.toEqual({ sessionId: "cache-owned" });
    expect(manager.creatingCapacityReservations.size).toBe(0);
    expect(manager.sessionObjects.has("cache-owned")).toBe(true);
    expect(manager.getRuntimeActivity().capacity.processes.projectedReservations).toBe(1);
    manager.stopSessionCacheSweep();
  });

  it("retains successful create projections until a fresh sample prevents stale-sample overshoot", async () => {
    vi.useFakeTimers();
    const sampleProcessTree = vi.fn()
      .mockResolvedValueOnce(processSnapshot(8))
      .mockResolvedValueOnce(processSnapshot(10));
    const backend = fakeBackend({
      createSession: vi.fn()
        .mockResolvedValueOnce(fakeSession("rapid-1"))
        .mockResolvedValueOnce(fakeSession("rapid-2")),
    });
    const { manager } = await createManager([backend], sampleProcessTree);
    manager.maxProcessTreeDescendants = 10;
    manager.sessionCapacityWaitTimeoutMs = 0;

    await expect(manager.createSession()).resolves.toEqual({ sessionId: "rapid-1" });
    await expect(manager.createSession()).resolves.toEqual({ sessionId: "rapid-2" });
    expect(sampleProcessTree).toHaveBeenCalledOnce();
    expect(manager.getRuntimeActivity().capacity.processes).toMatchObject({
      actualDescendants: 8,
      projectedReservations: 2,
      used: 10,
    });

    await expect(manager.createSession()).rejects.toMatchObject({
      reason: "process-pressure",
    });
    expect(backend.createSession).toHaveBeenCalledTimes(2);

    manager.processTreeSampleMaxAgeMs = 1;
    await vi.advanceTimersByTimeAsync(2);
    await manager.refreshProcessPressureForAdmission();
    expect(sampleProcessTree).toHaveBeenCalledTimes(2);
    expect(manager.getRuntimeActivity().capacity.processes).toMatchObject({
      actualDescendants: 10,
      projectedReservations: 0,
      used: 10,
    });
    manager.stopSessionCacheSweep();
  });

  it("admits without a first sample but retains a last-known-high block when sampling is unavailable", async () => {
    vi.useFakeTimers();
    const slowSample = vi.fn(() => new Promise<ProcessTreeSnapshot | null>(() => {}));
    const backend = fakeBackend({
      createSession: vi.fn(async () => fakeSession("no-sample")),
    });
    const first = await createManager([backend], slowSample);
    first.manager.processTreeAdmissionSampleTimeoutMs = 10;
    first.manager.maxProcessTreeDescendants = 1;
    first.manager.sessionCapacityWaitTimeoutMs = 0;

    const admitted = first.manager.createSession();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await expect(admitted).resolves.toEqual({ sessionId: "no-sample" });
    expect(first.manager.getRuntimeActivity().capacity.processes).toMatchObject({
      actualDescendants: null,
      projectedReservations: 1,
      sampleStatus: "timed-out",
    });
    const blockedBySettledProjection = first.manager.createSession().then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await expect(blockedBySettledProjection).resolves.toMatchObject({
      reason: "process-pressure",
    });
    expect(backend.createSession).toHaveBeenCalledOnce();
    first.manager.stopSessionCacheSweep();

    const unavailableSample = vi.fn()
      .mockResolvedValueOnce(processSnapshot(96))
      .mockResolvedValueOnce(null);
    const blockedBackend = fakeBackend();
    const second = await createManager([blockedBackend], unavailableSample);
    second.manager.maxProcessTreeDescendants = 96;
    second.manager.sessionCapacityWaitTimeoutMs = 0;
    await second.manager.refreshProcessPressureForAdmission();
    second.manager.processTreeSampleMaxAgeMs = 1;
    await vi.advanceTimersByTimeAsync(2);

    await expect(second.manager.createSession()).rejects.toMatchObject({
      reason: "process-pressure",
    });
    expect(blockedBackend.createSession).not.toHaveBeenCalled();
    expect(second.manager.getRuntimeActivity().capacity.processes).toMatchObject({
      actualDescendants: 96,
      sampleStatus: "unavailable",
    });
    second.manager.stopSessionCacheSweep();
  });
});
