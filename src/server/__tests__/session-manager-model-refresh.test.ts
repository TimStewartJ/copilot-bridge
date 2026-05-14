import { describe, expect, it, vi } from "vitest";
import { createEventBusRegistry } from "../event-bus.js";
import {
  ModelRefreshBlockedError,
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
    listModels: vi.fn(async () => models),
  };
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
});
