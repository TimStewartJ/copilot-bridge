import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, ConnectionErrors } from "vscode-jsonrpc/node.js";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";

type EmitSdkEvent = (event: any) => void;

function createConnectionClosedError(message = "Connection is closed.") {
  return new ConnectionError(ConnectionErrors.Closed, message);
}

function createManager() {
  const db = setupTestDb();
  const eventBusRegistry = createEventBusRegistry();
  const manager = new SessionManager({
    tools: [],
    globalBus: createTestBus(),
    eventBusRegistry,
    sessionTitles: createSessionTitlesStore(db),
    taskStore: {
      findTaskBySessionId: vi.fn().mockReturnValue(null),
    } as any,
    settingsStore: {
      getMcpServers: () => ({}),
      getSettings: () => ({ mcpServers: {} }),
    } as any,
    config: { sessionMcpServers: {} },
  }) as any;

  return { manager, eventBusRegistry };
}

function createSession(sendImpl: (emit: EmitSdkEvent) => Promise<void> | void) {
  const handlers: Array<(event: any) => void> = [];
  const session = {
    on: vi.fn((handler: (event: any) => void) => {
      handlers.push(handler);
      return vi.fn(() => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      });
    }),
    send: vi.fn(async () => {
      await sendImpl((event) => {
        for (const handler of [...handlers]) handler(event);
      });
    }),
    disconnect: vi.fn(),
  };
  return session;
}

describe("SessionManager stale cached session recovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts a cached closed SDK connection and retries on a fresh session", async () => {
    const { manager, eventBusRegistry } = createManager();
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const events: any[] = [];
    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    const cachedSession = createSession(async () => {
      throw createConnectionClosedError();
    });
    const freshSession = createSession((emit) => {
      queueMicrotask(() => {
        emit({
          type: "assistant.message",
          data: { content: "Recovered on a fresh session." },
          timestamp: "2026-05-13T20:00:00.000Z",
        });
        emit({
          type: "session.idle",
          data: {},
          timestamp: "2026-05-13T20:00:01.000Z",
        });
      });
    });

    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(freshSession),
    };
    manager.sessionObjects.set("session-1", cachedSession);

    await expect(manager._doWork("session-1", "hello", bus)).resolves.toBeUndefined();

    expect(cachedSession.send).toHaveBeenCalledTimes(1);
    expect(cachedSession.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.client.resumeSession).toHaveBeenCalledTimes(1);
    expect(freshSession.send).toHaveBeenCalledTimes(1);
    expect(freshSession.send).toHaveBeenCalledWith({ prompt: "hello" });
    expect(manager.sessionObjects.get("session-1")).toBe(freshSession);
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      content: "Recovered on a fresh session.",
    }));
  });

  it("does not retry closed-connection failures from a cold resume", async () => {
    const { manager, eventBusRegistry } = createManager();
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const resumedSession = createSession(async () => {
      throw createConnectionClosedError();
    });

    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(resumedSession),
    };

    await expect(manager._doWork("session-1", "hello", bus)).rejects.toThrow("Connection is closed");

    expect(manager.client.resumeSession).toHaveBeenCalledTimes(1);
    expect(resumedSession.send).toHaveBeenCalledTimes(1);
  });
});
