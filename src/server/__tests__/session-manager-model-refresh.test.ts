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

function createClient(models: Array<{ id: string; name: string }>) {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
    listModels: vi.fn(async () => models),
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

function createManager(clients: unknown[]) {
  const db = setupTestDb();
  const copilotHome = makeTestDir("model-refresh");
  const globalBus = createTestBus();
  const deps: SessionManagerDeps = {
    tools: [],
    globalBus,
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    taskStore: createTaskStore(db, globalBus),
    config: { sessionMcpServers: {} },
    copilotHome,
    createCopilotClient: vi.fn(() => {
      const client = clients.shift();
      if (!client) throw new Error("No fake Copilot client queued");
      return client as any;
    }),
  };
  return new SessionManager(deps);
}

describe("SessionManager model refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates the SDK client and returns models from the fresh client", async () => {
    const oldClient = createClient([{ id: "old-model", name: "Old Model" }]);
    const freshClient = createClient([{ id: "fresh-model", name: "Fresh Model" }]);
    const manager = createManager([oldClient, freshClient]);

    await manager.initialize();
    const result = await manager.refreshModels();

    expect(oldClient.stop).toHaveBeenCalledOnce();
    expect(freshClient.start).toHaveBeenCalledOnce();
    expect(freshClient.listModels).toHaveBeenCalledOnce();
    expect(result.models).toEqual([{ id: "fresh-model", name: "Fresh Model" }]);
  });

  it("disconnects idle cached sessions before rotating the client", async () => {
    const oldClient = createClient([]);
    const freshClient = createClient([]);
    const manager = createManager([oldClient, freshClient]);
    const disconnect = vi.fn();

    await manager.initialize();
    (manager as any).sessionObjects.set("idle-session", { disconnect });

    await manager.refreshModels();

    expect(disconnect).toHaveBeenCalledOnce();
    expect((manager as any).sessionObjects.has("idle-session")).toBe(false);
  });

  it("blocks refresh while sessions are active", async () => {
    const oldClient = createClient([]);
    const freshClient = createClient([]);
    const manager = createManager([oldClient, freshClient]);

    await manager.initialize();
    (manager as any).modelSwitchingSessions.add("active-session");

    await expect(manager.refreshModels()).rejects.toBeInstanceOf(ModelRefreshBlockedError);
    expect(oldClient.stop).not.toHaveBeenCalled();
    expect(freshClient.start).not.toHaveBeenCalled();
  });

  it("restores the previous client when the fresh client fails to start", async () => {
    const oldClient = createClient([{ id: "old-model", name: "Old Model" }]);
    const freshClient = createClient([{ id: "fresh-model", name: "Fresh Model" }]);
    freshClient.start.mockRejectedValueOnce(new Error("start failed"));
    const manager = createManager([oldClient, freshClient]);

    await manager.initialize();

    await expect(manager.refreshModels()).rejects.toThrow("start failed");
    expect(oldClient.stop).toHaveBeenCalledOnce();
    expect(oldClient.start).toHaveBeenCalledTimes(2);
    await expect(manager.listModels()).resolves.toEqual([{ id: "old-model", name: "Old Model" }]);
  });

  it("times out a stalled previous client stop and clears the rotation", async () => {
    const oldClient = createClient([{ id: "old-model", name: "Old Model" }]);
    oldClient.stop.mockImplementationOnce(neverResolves);
    const freshClient = createClient([{ id: "fresh-model", name: "Fresh Model" }]);
    const manager = createManager([oldClient, freshClient]);

    await manager.initialize();
    vi.useFakeTimers();

    const refreshPromise = manager.refreshModels();
    const listDuringRotationPromise = manager.listModels();
    const refreshExpectation = expectRotationTimeout(refreshPromise, "stopping the previous client");
    const listDuringRotationExpectation = expectRotationTimeout(listDuringRotationPromise, "stopping the previous client");

    await advancePastRotationTimeout();

    await refreshExpectation;
    await listDuringRotationExpectation;
    expect((manager as any).clientRotation).toBeNull();
    expect(oldClient.forceStop).toHaveBeenCalledOnce();
    expect(freshClient.start).not.toHaveBeenCalled();
    await expect(manager.listModels()).rejects.toThrow("SessionManager not initialized");
  });

  it("times out a stalled fresh client start and restores the previous client", async () => {
    const oldClient = createClient([{ id: "old-model", name: "Old Model" }]);
    const freshClient = createClient([{ id: "fresh-model", name: "Fresh Model" }]);
    freshClient.start.mockImplementationOnce(neverResolves);
    const manager = createManager([oldClient, freshClient]);

    await manager.initialize();
    vi.useFakeTimers();

    const refreshPromise = manager.refreshModels();
    const listDuringRotationPromise = manager.listModels();
    const refreshExpectation = expectRotationTimeout(refreshPromise, "starting the refreshed client");
    const listDuringRotationExpectation = expectRotationTimeout(listDuringRotationPromise, "starting the refreshed client");

    await advancePastRotationTimeout();

    await refreshExpectation;
    await listDuringRotationExpectation;
    expect((manager as any).clientRotation).toBeNull();
    expect(freshClient.forceStop).toHaveBeenCalledOnce();
    expect(oldClient.start).toHaveBeenCalledTimes(2);
    await expect(manager.listModels()).resolves.toEqual([{ id: "old-model", name: "Old Model" }]);
  });

  it("times out a stalled previous client restore and leaves later SDK calls unblocked", async () => {
    const oldClient = createClient([{ id: "old-model", name: "Old Model" }]);
    oldClient.start
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(neverResolves);
    const freshClient = createClient([{ id: "fresh-model", name: "Fresh Model" }]);
    freshClient.start.mockRejectedValueOnce(new Error("start failed"));
    const manager = createManager([oldClient, freshClient]);

    await manager.initialize();
    vi.useFakeTimers();

    const refreshPromise = manager.refreshModels();
    const listDuringRotationPromise = manager.listModels();
    const refreshExpectation = expectRotationTimeout(refreshPromise, "restoring the previous client");
    const listDuringRotationExpectation = expectRotationTimeout(listDuringRotationPromise, "restoring the previous client");

    await advancePastRotationTimeout();

    await refreshExpectation;
    await listDuringRotationExpectation;
    expect((manager as any).clientRotation).toBeNull();
    expect(oldClient.forceStop).toHaveBeenCalledOnce();
    await expect(manager.listModels()).rejects.toThrow("SessionManager not initialized");
  });
});
