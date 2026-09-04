// Disconnect detection for CopilotBackend: the SDK only flips `client.state`
// when its JSON-RPC connection drops, so the backend wrapper watches the
// transport itself and reports the loss exactly once, never for an
// intentional stop.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKEND_DISCONNECTED_MESSAGE } from "../../backend-availability.js";
import { CopilotBackend } from "../copilot-backend.js";
import { AGENT_RPC_TIMEOUTS_MS } from "../rpc-timeouts.js";

type Listener = (...args: any[]) => void;

function createFakeConnection() {
  const closeListeners = new Set<Listener>();
  const errorListeners = new Set<Listener>();
  return {
    onClose: vi.fn((listener: Listener) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    }),
    onError: vi.fn((listener: Listener) => {
      errorListeners.add(listener);
      return { dispose: () => errorListeners.delete(listener) };
    }),
    fireClose: () => { for (const listener of [...closeListeners]) listener(); },
    fireError: (error: unknown) => { for (const listener of [...errorListeners]) listener(error); },
    listenerCount: () => closeListeners.size + errorListeners.size,
  };
}

function createFakeClient(options: { ping?: () => Promise<unknown> } = {}) {
  const connection = createFakeConnection();
  const cliProcess = Object.assign(new EventEmitter(), { pid: 4242, stdin: new EventEmitter() });
  const client: any = {
    state: "disconnected",
    connection: null as ReturnType<typeof createFakeConnection> | null,
    cliProcess: null as typeof cliProcess | null,
    start: vi.fn(async () => {
      client.state = "connected";
      client.connection = connection;
      client.cliProcess = cliProcess;
    }),
    stop: vi.fn(async () => {
      connection.fireClose();
      client.state = "disconnected";
      client.connection = null;
    }),
    forceStop: vi.fn(async () => {
      connection.fireClose();
      client.state = "disconnected";
      client.connection = null;
    }),
    ping: vi.fn(options.ping ?? (async () => ({ message: "pong" }))),
    listModels: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(),
    resumeSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
    getSessionMetadata: vi.fn(async () => ({})),
    rpc: {
      sessions: {
        checkInUse: vi.fn(async () => ({ inUse: [] })),
      },
    },
  };
  return { client, connection, cliProcess };
}

const silentLogger = { warn: vi.fn(), error: vi.fn() };

describe("CopilotBackend disconnect detection", () => {
  afterEach(() => {
    vi.useRealTimers();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  it("reports a closed JSON-RPC connection once and exposes it in the connection status", async () => {
    const { client, connection } = createFakeClient();
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();
    expect(backend.getConnectionStatus()).toMatchObject({ state: "connected", pid: 4242 });

    connection.fireClose();
    connection.fireClose();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: "connection-closed",
      at: expect.any(String),
    }));
    expect(backend.getConnectionStatus()).toMatchObject({
      state: "disconnected",
      lastDisconnect: expect.objectContaining({ reason: "connection-closed" }),
    });
    expect(silentLogger.error).toHaveBeenCalledWith(expect.stringContaining("Backend RPC channel lost"));
    await expect(backend.probeHealth()).resolves.toBe(false);
  });

  it("reports the runtime child exiting and stdin pipe errors", async () => {
    {
      const { client, cliProcess } = createFakeClient();
      const backend = new CopilotBackend(client, { logger: silentLogger });
      const onDisconnect = vi.fn();
      backend.onDisconnect(onDisconnect);
      await backend.start();
      cliProcess.emit("exit", 1, null);
      expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
        reason: "process-exit",
        detail: expect.stringContaining("code=1"),
      }));
    }
    {
      const { client, cliProcess } = createFakeClient();
      const backend = new CopilotBackend(client, { logger: silentLogger });
      const onDisconnect = vi.fn();
      backend.onDisconnect(onDisconnect);
      await backend.start();
      cliProcess.stdin.emit("error", new Error("EPIPE"));
      expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
        reason: "stdin-error",
        detail: expect.stringContaining("EPIPE"),
      }));
    }
  });

  it("never reports a disconnect for an intentional stop or force stop and detaches its watchers", async () => {
    for (const method of ["stop", "forceStop"] as const) {
      const { client, connection, cliProcess } = createFakeClient();
      const backend = new CopilotBackend(client, { logger: silentLogger });
      const onDisconnect = vi.fn();
      backend.onDisconnect(onDisconnect);
      await backend.start();
      expect(connection.listenerCount()).toBe(2);
      await backend[method]();
      cliProcess.emit("exit", 0, null);
      expect(onDisconnect).not.toHaveBeenCalled();
      expect(connection.listenerCount()).toBe(0);
      expect(backend.getConnectionStatus().lastDisconnect).toBeUndefined();
    }
  });

  it("treats a connection error as suspicion: probes, and only reports when the ping fails", async () => {
    vi.useFakeTimers();
    const { client, connection } = createFakeClient({ ping: () => new Promise(() => {}) });
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();

    connection.fireError(new Error("bad frame"));
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(client.ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["backend.ping"]);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: "health-probe-failed",
      detail: expect.stringContaining("connection-error"),
    }));
  });

  it("keeps a healthy backend when a connection error is followed by a successful ping", async () => {
    const { client, connection } = createFakeClient();
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();

    connection.fireError(new Error("bad frame"));
    await expect(backend.probeHealth()).resolves.toBe(true);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(backend.getConnectionStatus()).toMatchObject({ state: "connected" });
  });

  it("turns a hung session RPC into a liveness probe and a disconnect when the channel is dead", async () => {
    vi.useFakeTimers();
    const { client } = createFakeClient({ ping: () => new Promise(() => {}) });
    const session = {
      sessionId: "s1",
      send: vi.fn(() => new Promise(() => {})),
      abort: vi.fn(),
      setModel: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn(() => () => undefined),
      registerElicitationHandler: vi.fn(),
      rpc: {},
    };
    client.resumeSession = vi.fn(async () => session);
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();
    const wrapped = await backend.resumeSession("s1", {} as any);

    const sendPromise = wrapped.send({ prompt: "hello" });
    const rejection = expect(sendPromise).rejects.toMatchObject({ code: "AGENT_RPC_TIMEOUT", rpc: "session.send" });
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["session.send"]);
    await rejection;
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining("RPC session.send timed out"));
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["backend.ping"]);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: "rpc-timeout",
      detail: expect.stringContaining("rpc-timeout:session.send"),
    }));
  });

  it("rejects an unbounded natural-completion wait when the backend disconnects", async () => {
    const { client, connection } = createFakeClient();
    const handlers = new Set<(event: any) => void>();
    const session = {
      sessionId: "s1",
      send: vi.fn(async () => undefined),
      abort: vi.fn(),
      setModel: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn((handler: (event: any) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      }),
      registerElicitationHandler: vi.fn(),
      rpc: {},
    };
    client.resumeSession = vi.fn(async () => session);
    const backend = new CopilotBackend(client, { logger: silentLogger });
    await backend.start();
    const wrapped = await backend.resumeSession("s1", {} as any);

    const wait = wrapped.sendAndWait({ prompt: "hello" }, null);
    const rejection = expect(wait).rejects.toThrow(BACKEND_DISCONNECTED_MESSAGE);
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
    connection.fireClose();

    await rejection;
    expect(handlers.size).toBe(0);
  });

  it("fails a hung external-use probe without declaring the backend disconnected", async () => {
    vi.useFakeTimers();
    const { client } = createFakeClient();
    client.rpc.sessions.checkInUse.mockImplementation(() => new Promise(() => {}));
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();

    const check = backend.checkSessionsInUse!(["s1"]);
    const rejection = expect(check).rejects.toMatchObject({
      code: "AGENT_RPC_TIMEOUT",
      rpc: "backend.checkSessionsInUse",
    });
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["backend.checkSessionsInUse"]);
    await rejection;

    expect(client.ping).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(backend.getConnectionStatus()).toMatchObject({ state: "connected" });
  });

  it("coalesces concurrent health probes into one ping", async () => {
    const { client } = createFakeClient();
    const backend = new CopilotBackend(client, { logger: silentLogger });
    await backend.start();
    const results = await Promise.all([backend.probeHealth(), backend.probeHealth(), backend.probeHealth()]);
    expect(results).toEqual([true, true, true]);
    expect(client.ping).toHaveBeenCalledTimes(1);
  });

  it("reports health-probe-failed when the SDK state is no longer connected", async () => {
    const { client } = createFakeClient();
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();
    client.state = "disconnected";
    await expect(backend.probeHealth(undefined, "watchdog")).resolves.toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: "health-probe-failed",
      detail: expect.stringContaining("client state is disconnected"),
    }));
    expect(client.ping).not.toHaveBeenCalled();
  });
});
