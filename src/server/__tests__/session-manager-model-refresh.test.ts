import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBusRegistry } from "../event-bus.js";
import {
  MODEL_REFRESH_CLIENT_ROTATION_TIMEOUT_MS,
  ModelRefreshBlockedError,
  ModelRefreshClientRotationTimeoutError,
  SessionManager,
  type SessionManagerDeps,
} from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestDir, setupTestDb } from "./helpers.js";

function createBackend(models: Array<{ id: string; name: string }>) {
  return {
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
    listModels: vi.fn(async () => models),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => { throw new Error("not implemented in test"); }),
    resumeSession: vi.fn(async () => { throw new Error("not implemented in test"); }),
    deleteSession: vi.fn(async () => {}),
    getSessionMetadata: vi.fn(async () => ({})),
  };
}

function neverResolves(): Promise<void> {
  return new Promise(() => {});
}

async function advancePastRotationTimeout(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(MODEL_REFRESH_CLIENT_ROTATION_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(0);
}

async function expectRotationTimeout(promise: Promise<unknown>, operation: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error("Expected model-refresh rotation to time out");
    },
    (error) => {
      expect(error).toBeInstanceOf(ModelRefreshClientRotationTimeoutError);
      expect(error).toMatchObject({
        operation,
        timeoutMs: MODEL_REFRESH_CLIENT_ROTATION_TIMEOUT_MS,
      });
    },
  );
}

function createManager(backends: unknown[]) {
  const db = setupTestDb();
  const copilotHome = makeTestDir("model-refresh");
  const globalBus = createTestBus();
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
    createBackend: createBackendSpy,
  };
  return { manager: new SessionManager(deps), createBackendSpy };
}

describe("SessionManager model refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates the SDK client and returns models from the fresh client", async () => {
    const oldBackend = createBackend([{ id: "old-model", name: "Old Model" }]);
    const freshBackend = createBackend([{ id: "fresh-model", name: "Fresh Model" }]);
    const { manager } = createManager([oldBackend, freshBackend]);

    await manager.initialize();
    const result = await manager.refreshModels();

    expect(oldBackend.stop).toHaveBeenCalledOnce();
    expect(freshBackend.start).toHaveBeenCalledOnce();
    expect(freshBackend.listModels).toHaveBeenCalledOnce();
    expect(result.models).toEqual([{ id: "fresh-model", name: "Fresh Model" }]);
  });

  it("tracks the backend creation timestamp and updates it after a successful rotation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const oldBackend = createBackend([{ id: "old-model", name: "Old Model" }]);
    const freshBackend = createBackend([{ id: "fresh-model", name: "Fresh Model" }]);
    const { manager } = createManager([oldBackend, freshBackend]);

    expect(manager.getBackendCreatedAt()).toBeNull();

    await manager.initialize();
    expect(manager.getBackendCreatedAt()).toBe("2026-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    const result = await manager.refreshModels();

    expect(manager.getBackendCreatedAt()).toBe("2026-01-01T00:05:00.000Z");
    expect(result.clientCreatedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("constructs the agent backend through a zero-argument factory", async () => {
    const oldBackend = createBackend([]);
    const freshBackend = createBackend([]);
    const { manager, createBackendSpy } = createManager([oldBackend, freshBackend]);

    await manager.initialize();
    await manager.refreshModels();

    expect(createBackendSpy).toHaveBeenCalledTimes(2);
    for (const call of createBackendSpy.mock.calls) {
      expect(call).toHaveLength(0);
    }
  });

  it("disconnects idle cached sessions before rotating the client", async () => {
    const oldBackend = createBackend([]);
    const freshBackend = createBackend([]);
    const { manager } = createManager([oldBackend, freshBackend]);
    const disconnect = vi.fn();

    await manager.initialize();
    (manager as any).sessionObjects.set("idle-session", { disconnect });

    await manager.refreshModels();

    expect(disconnect).toHaveBeenCalledOnce();
    expect((manager as any).sessionObjects.has("idle-session")).toBe(false);
  });

  it("blocks refresh while sessions are active", async () => {
    const oldBackend = createBackend([]);
    const freshBackend = createBackend([]);
    const { manager } = createManager([oldBackend, freshBackend]);

    await manager.initialize();
    (manager as any).modelSwitchingSessions.add("active-session");

    await expect(manager.refreshModels()).rejects.toBeInstanceOf(ModelRefreshBlockedError);
    expect(oldBackend.stop).not.toHaveBeenCalled();
    expect(freshBackend.start).not.toHaveBeenCalled();
  });

  it("restores the previous client when the fresh client fails to start", async () => {
    const oldBackend = createBackend([{ id: "old-model", name: "Old Model" }]);
    const freshBackend = createBackend([{ id: "fresh-model", name: "Fresh Model" }]);
    freshBackend.start.mockRejectedValueOnce(new Error("start failed"));
    const { manager } = createManager([oldBackend, freshBackend]);

    await manager.initialize();

    await expect(manager.refreshModels()).rejects.toThrow("start failed");
    expect(oldBackend.stop).toHaveBeenCalledOnce();
    expect(oldBackend.start).toHaveBeenCalledTimes(2);
    await expect(manager.listModels()).resolves.toEqual([{ id: "old-model", name: "Old Model" }]);
  });

  it("times out a stalled previous client stop and clears the rotation", async () => {
    const oldBackend = createBackend([{ id: "old-model", name: "Old Model" }]);
    oldBackend.stop.mockImplementationOnce(neverResolves);
    const freshBackend = createBackend([{ id: "fresh-model", name: "Fresh Model" }]);
    const { manager } = createManager([oldBackend, freshBackend]);

    await manager.initialize();
    vi.useFakeTimers();

    const refreshPromise = manager.refreshModels();
    const listDuringRotationPromise = manager.listModels();
    const refreshExpectation = expectRotationTimeout(refreshPromise, "stopping the previous client");
    const listDuringRotationExpectation = expectRotationTimeout(listDuringRotationPromise, "stopping the previous client");

    await advancePastRotationTimeout();

    await refreshExpectation;
    await listDuringRotationExpectation;
    expect((manager as any).backendRotation).toBeNull();
    expect(oldBackend.forceStop).toHaveBeenCalledOnce();
    expect(freshBackend.start).not.toHaveBeenCalled();
    expect(manager.getBackendCreatedAt()).toBeNull();
    await expect(manager.listModels()).rejects.toThrow("SessionManager not initialized");
  });

  it("times out a stalled fresh client start and restores the previous client", async () => {
    const oldBackend = createBackend([{ id: "old-model", name: "Old Model" }]);
    const freshBackend = createBackend([{ id: "fresh-model", name: "Fresh Model" }]);
    freshBackend.start.mockImplementationOnce(neverResolves);
    const { manager } = createManager([oldBackend, freshBackend]);

    await manager.initialize();
    vi.useFakeTimers();

    const refreshPromise = manager.refreshModels();
    const listDuringRotationPromise = manager.listModels();
    const refreshExpectation = expectRotationTimeout(refreshPromise, "starting the refreshed client");
    const listDuringRotationExpectation = expectRotationTimeout(listDuringRotationPromise, "starting the refreshed client");

    await advancePastRotationTimeout();

    await refreshExpectation;
    await listDuringRotationExpectation;
    expect((manager as any).backendRotation).toBeNull();
    expect(freshBackend.forceStop).toHaveBeenCalledOnce();
    expect(oldBackend.start).toHaveBeenCalledTimes(2);
    expect(manager.getBackendCreatedAt()).not.toBeNull();
    await expect(manager.listModels()).resolves.toEqual([{ id: "old-model", name: "Old Model" }]);
  });

  it("times out a stalled previous client restore and leaves later SDK calls unblocked", async () => {
    const oldBackend = createBackend([{ id: "old-model", name: "Old Model" }]);
    oldBackend.start
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(neverResolves);
    const freshBackend = createBackend([{ id: "fresh-model", name: "Fresh Model" }]);
    freshBackend.start.mockRejectedValueOnce(new Error("start failed"));
    const { manager } = createManager([oldBackend, freshBackend]);

    await manager.initialize();
    vi.useFakeTimers();

    const refreshPromise = manager.refreshModels();
    const listDuringRotationPromise = manager.listModels();
    const refreshExpectation = expectRotationTimeout(refreshPromise, "restoring the previous client");
    const listDuringRotationExpectation = expectRotationTimeout(listDuringRotationPromise, "restoring the previous client");

    await advancePastRotationTimeout();

    await refreshExpectation;
    await listDuringRotationExpectation;
    expect((manager as any).backendRotation).toBeNull();
    expect(oldBackend.forceStop).toHaveBeenCalledOnce();
    expect(manager.getBackendCreatedAt()).toBeNull();
    await expect(manager.listModels()).rejects.toThrow("SessionManager not initialized");
  });
});
