import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, ConnectionErrors } from "vscode-jsonrpc/node.js";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";

type EmitSdkEvent = (event: any) => void;

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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
      getMcpServers: () => ({ demo: { command: "demo-mcp", args: [] } }),
      getSettings: () => ({ mcpServers: { demo: { command: "demo-mcp", args: [] } } }),
    } as any,
    config: { sessionMcpServers: {} },
  }) as any;

  return { manager, eventBusRegistry };
}

function createSession(sendImpl: (emit: EmitSdkEvent) => Promise<void> | void) {
  const handlers: Array<(event: any) => void> = [];
  const session = {
    rpc: {
      mode: {
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
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

  it("schedules cached session refresh when a configured MCP server regresses from connected to not configured", async () => {
    const { manager, eventBusRegistry } = createManager();
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const cachedSession = createSession((emit) => {
      queueMicrotask(() => {
        emit({
          type: "session.mcp_servers_loaded",
          data: {
            servers: [{ name: "demo", status: "connected", source: "settings" }],
          },
          timestamp: "2026-05-21T19:05:43.659Z",
        });
        emit({
          type: "session.mcp_server_status_changed",
          data: {
            serverName: "demo",
            status: "not_configured",
          },
          timestamp: "2026-05-21T19:08:43.668Z",
        });
        emit({
          type: "assistant.message",
          data: { content: "The MCP call failed." },
          timestamp: "2026-05-21T19:08:44.000Z",
        });
        emit({
          type: "session.idle",
          data: {},
          timestamp: "2026-05-21T19:08:45.000Z",
        });
      });
    });

    manager.sessionObjects.set("session-1", cachedSession);

    await expect(manager._doWork("session-1", "hello", bus)).resolves.toBeUndefined();

    expect(cachedSession.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("session-1")).toBe(false);
    expect(manager.pendingSessionEvictions.has("session-1")).toBe(false);
  });

  it("keeps cached sessions when an unconfigured MCP status regresses", async () => {
    const { manager, eventBusRegistry } = createManager();
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const cachedSession = createSession((emit) => {
      queueMicrotask(() => {
        emit({
          type: "session.mcp_servers_loaded",
          data: {
            servers: [{ name: "external-demo", status: "connected", source: "sdk" }],
          },
          timestamp: "2026-05-21T19:05:43.659Z",
        });
        emit({
          type: "session.mcp_server_status_changed",
          data: {
            serverName: "external-demo",
            status: "not_configured",
          },
          timestamp: "2026-05-21T19:08:43.668Z",
        });
        emit({
          type: "assistant.message",
          data: { content: "The ordinary tool failed." },
          timestamp: "2026-05-21T19:08:44.000Z",
        });
        emit({
          type: "session.idle",
          data: {},
          timestamp: "2026-05-21T19:08:45.000Z",
        });
      });
    });

    manager.sessionObjects.set("session-1", cachedSession);

    await expect(manager._doWork("session-1", "hello", bus)).resolves.toBeUndefined();

    expect(manager.pendingSessionEvictions.has("session-1")).toBe(false);
    expect(manager.sessionObjects.get("session-1")).toBe(cachedSession);
    expect(cachedSession.disconnect).not.toHaveBeenCalled();
  });

  it("keeps cached sessions when a configured MCP server begins as not configured", async () => {
    const { manager, eventBusRegistry } = createManager();
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const cachedSession = createSession((emit) => {
      queueMicrotask(() => {
        emit({
          type: "session.mcp_servers_loaded",
          data: {
            servers: [{ name: "demo", status: "not_configured", source: "settings" }],
          },
          timestamp: "2026-05-21T19:05:43.659Z",
        });
        emit({
          type: "session.mcp_server_status_changed",
          data: {
            serverName: "demo",
            status: "not_configured",
          },
          timestamp: "2026-05-21T19:08:43.668Z",
        });
        emit({
          type: "assistant.message",
          data: { content: "The MCP is still initializing." },
          timestamp: "2026-05-21T19:08:44.000Z",
        });
        emit({
          type: "session.idle",
          data: {},
          timestamp: "2026-05-21T19:08:45.000Z",
        });
      });
    });

    manager.sessionObjects.set("session-1", cachedSession);

    await expect(manager._doWork("session-1", "hello", bus)).resolves.toBeUndefined();

    expect(manager.pendingSessionEvictions.has("session-1")).toBe(false);
    expect(manager.sessionObjects.get("session-1")).toBe(cachedSession);
    expect(cachedSession.disconnect).not.toHaveBeenCalled();
  });

  it("keeps cached sessions when bulk MCP snapshots report not configured", async () => {
    const { manager, eventBusRegistry } = createManager();
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const cachedSession = createSession((emit) => {
      queueMicrotask(() => {
        emit({
          type: "session.mcp_servers_loaded",
          data: {
            servers: [{ name: "demo", status: "connected", source: "settings" }],
          },
          timestamp: "2026-05-21T19:05:43.659Z",
        });
        emit({
          type: "session.mcp_servers_loaded",
          data: {
            servers: [{ name: "demo", status: "not_configured", source: "settings" }],
          },
          timestamp: "2026-05-21T19:08:43.668Z",
        });
        emit({
          type: "session.idle",
          data: {},
          timestamp: "2026-05-21T19:08:45.000Z",
        });
      });
    });

    manager.sessionObjects.set("session-1", cachedSession);

    await expect(manager._doWork("session-1", "hello", bus)).resolves.toBeUndefined();

    expect(manager.pendingSessionEvictions.has("session-1")).toBe(false);
    expect(manager.sessionObjects.get("session-1")).toBe(cachedSession);
    expect(cachedSession.disconnect).not.toHaveBeenCalled();
  });

  it("evicts regressed configured MCP cached sessions after managed runs settle", async () => {
    const { manager } = createManager();
    const cachedSession = createSession((emit) => {
      queueMicrotask(() => {
        emit({
          type: "session.mcp_servers_loaded",
          data: {
            servers: [{ name: "demo", status: "connected", source: "settings" }],
          },
          timestamp: "2026-05-21T19:12:16.061Z",
        });
        emit({
          type: "session.mcp_server_status_changed",
          data: {
            serverName: "demo",
            status: "not_configured",
          },
          timestamp: "2026-05-21T19:12:16.066Z",
        });
        emit({
          type: "session.idle",
          data: {},
          timestamp: "2026-05-21T19:12:17.000Z",
        });
      });
    });

    manager.client = {} as any;
    manager.sessionObjects.set("session-1", cachedSession);
    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await vi.waitFor(() => {
      expect(cachedSession.disconnect).toHaveBeenCalledTimes(1);
      expect(manager.sessionObjects.has("session-1")).toBe(false);
      expect(manager.pendingSessionEvictions.has("session-1")).toBe(false);
    });
  });
});
