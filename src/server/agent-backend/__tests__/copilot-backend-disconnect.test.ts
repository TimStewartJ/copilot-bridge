// Disconnect detection for CopilotBackend: the SDK only flips `client.state`
// when its JSON-RPC connection drops, so the backend wrapper watches the
// transport itself and reports the loss exactly once, never for an
// intentional stop.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKEND_DISCONNECTED_MESSAGE } from "../../backend-availability.js";
import { BACKEND_PING_ATTEMPTS, BACKEND_PING_RETRY_DELAY_MS, CopilotBackend } from "../copilot-backend.js";
import { AGENT_RPC_TIMEOUTS_MS } from "../rpc-timeouts.js";

const PING_TIMEOUT_MS = AGENT_RPC_TIMEOUTS_MS["backend.ping"];
/** Every consecutive ping timing out, with the retry delay between them. */
const PING_DETECTION_WINDOW_MS = PING_TIMEOUT_MS * BACKEND_PING_ATTEMPTS
  + BACKEND_PING_RETRY_DELAY_MS * (BACKEND_PING_ATTEMPTS - 1);

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
      return [];
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CopilotBackend diagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  it.each(["resolve", "reject"] as const)("bounds a hanging diagnostic ping without disconnecting on late %s", async (settlement) => {
    vi.useFakeTimers();
    const work = deferred<unknown>();
    const { client } = createFakeClient({ ping: () => work.promise });
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();
    const probeHealth = vi.spyOn(backend, "probeHealth");

    const ping = backend.diagnosticPing();
    let settled = false;
    void ping.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(ping).resolves.toBe("timeout");
    work[settlement](new Error("private late payload"));
    await vi.advanceTimersByTimeAsync(0);

    expect(client.ping).toHaveBeenCalledOnce();
    expect(probeHealth).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(silentLogger.warn).not.toHaveBeenCalled();
    expect(silentLogger.error).not.toHaveBeenCalled();
    expect(backend.getConnectionStatus().state).toBe("connected");
    expect(backend.getDiagnostics()).toEqual({ pendingCount: 0, omittedCount: 0, pending: [] });
    await backend.stop();
  });

  it.each(["responsive", "failed"] as const)("classifies a diagnostic ping as %s without recovery", async (outcome) => {
    vi.useFakeTimers();
    const { client } = createFakeClient({
      ping: async () => {
        if (outcome === "failed") throw new Error("private error");
        return { message: "private payload" };
      },
    });
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();
    const probeHealth = vi.spyOn(backend, "probeHealth");
    await expect(backend.diagnosticPing()).resolves.toBe(outcome);
    expect(client.start).toHaveBeenCalledOnce();
    expect(client.ping).toHaveBeenCalledOnce();
    expect(probeHealth).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(silentLogger.warn).not.toHaveBeenCalled();
    expect(silentLogger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await backend.stop();
  });

  it.each(["unstarted", "disconnected", "closed", "missing-connection", "stopping", "fenced"] as const)(
    "skips diagnostic ping when %s without starting or recovering",
    async (state) => {
      vi.useFakeTimers();
      const { client, connection } = createFakeClient();
      const backend = new CopilotBackend(client, { logger: silentLogger });
      if (state !== "unstarted") await backend.start();
      if (state === "disconnected") client.state = "disconnected";
      if (state === "closed") connection.fireClose();
      if (state === "missing-connection") client.connection = null;
      if (state === "stopping") {
        client.stop.mockImplementation(async () => []);
        await backend.stop();
      }
      if (state === "fenced") await expect(backend.fence()).rejects.toThrow("Cannot fence");
      const onDisconnect = vi.fn();
      backend.onDisconnect(onDisconnect);
      const probeHealth = vi.spyOn(backend, "probeHealth");
      await expect(backend.diagnosticPing()).resolves.toBe("skipped");
      expect(client.start).toHaveBeenCalledTimes(state === "unstarted" ? 0 : 1);
      expect(client.ping).not.toHaveBeenCalled();
      expect(probeHealth).not.toHaveBeenCalled();
      expect(onDisconnect).not.toHaveBeenCalled();
      await backend.stop();
    },
  );

  it.each(["resolve", "reject"] as const)("retains underlying guarded work past timeout until %s", async (settlement) => {
    vi.useFakeTimers();
    const work = deferred<unknown>();
    const { client } = createFakeClient();
    client.getSessionMetadata.mockImplementation(() => work.promise);
    const backend = new CopilotBackend(client, { logger: silentLogger });
    await backend.start();
    const request = backend.getSessionMetadata("private-session");
    const rejected = expect(request).rejects.toMatchObject({ code: "AGENT_RPC_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["backend.getSessionMetadata"]);
    await rejected;
    expect(backend.getDiagnostics()).toEqual({
      pendingCount: 1,
      omittedCount: 0,
      pending: [{ operation: "backend.getSessionMetadata", ageMs: 60_000 }],
    });
    work[settlement](new Error("private result"));
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.getDiagnostics()).toEqual({ pendingCount: 0, omittedCount: 0, pending: [] });
    await backend.stop();
  });

  it("tracks external-use probes past their timeout without probing health", async () => {
    vi.useFakeTimers();
    const work = deferred<unknown>();
    const { client } = createFakeClient();
    client.rpc.sessions.checkInUse.mockImplementation(() => work.promise);
    const backend = new CopilotBackend(client, { logger: silentLogger });
    await backend.start();
    const request = backend.checkSessionsInUse(["private-session"]);
    const rejected = expect(request).rejects.toMatchObject({ code: "AGENT_RPC_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(backend.getDiagnostics()).toEqual({
      pendingCount: 1,
      omittedCount: 0,
      pending: [{ operation: "backend.checkSessionsInUse", ageMs: 10_000 }],
    });
    expect(client.ping).not.toHaveBeenCalled();
    work.reject(new Error("private result"));
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.getDiagnostics().pendingCount).toBe(0);
    await backend.stop();
  });

  it("bounds retained metadata to 64 and snapshots to the oldest 20, counting omitted work", async () => {
    vi.useFakeTimers();
    const { client } = createFakeClient();
    const backend = new CopilotBackend(client, { logger: silentLogger });
    await backend.start();
    const work = Array.from({ length: 70 }, () => deferred<unknown>());
    const requests: Promise<unknown>[] = [];
    for (const entry of work) {
      client.getSessionMetadata.mockImplementationOnce(() => entry.promise);
      requests.push(backend.getSessionMetadata("private-session"));
      await vi.advanceTimersByTimeAsync(1);
    }
    const snapshot = backend.getDiagnostics();
    expect(snapshot).toEqual({
      pendingCount: 70,
      omittedCount: 50,
      pending: Array.from({ length: 20 }, (_, i) => ({ operation: "backend.getSessionMetadata", ageMs: 70 - i })),
    });
    snapshot.pending[0]!.operation = "mutated";
    expect(backend.getDiagnostics().pending[0]!.operation).toBe("backend.getSessionMetadata");
    for (const entry of work.slice(0, 60)) entry.resolve({ secret: "private payload" });
    await Promise.all(requests.slice(0, 60));
    expect(backend.getDiagnostics()).toEqual({
      pendingCount: 10,
      omittedCount: 6,
      pending: Array.from({ length: 4 }, (_, i) => ({ operation: "backend.getSessionMetadata", ageMs: 10 - i })),
    });
    for (const entry of work.slice(60)) entry.resolve({});
    await Promise.all(requests);
    expect(backend.getDiagnostics()).toEqual({ pendingCount: 0, omittedCount: 0, pending: [] });
    await backend.stop();
  });

  it("tracks create, resume, and session RPCs without exposing config or arguments", async () => {
    vi.useFakeTimers();
    const create = deferred<unknown>();
    const resume = deferred<unknown>();
    const send = deferred<unknown>();
    const { client } = createFakeClient();
    client.createSession.mockImplementation(() => create.promise);
    client.resumeSession.mockImplementation(() => resume.promise);
    const backend = new CopilotBackend(client, { logger: silentLogger });
    await backend.start();
    const creating = backend.createSession({ privateConfig: "secret" });
    await vi.advanceTimersByTimeAsync(10);
    const resuming = backend.resumeSession("private-session", { privateConfig: "secret" });
    const resumeRejected = expect(resuming).rejects.toThrow("private error");
    await vi.advanceTimersByTimeAsync(10);
    expect(backend.getDiagnostics()).toEqual({
      pendingCount: 2,
      omittedCount: 0,
      pending: [
        { operation: "backend.createSession", ageMs: 20 },
        { operation: "backend.resumeSession", ageMs: 10 },
      ],
    });
    create.resolve({ sessionId: "private-session", send: () => send.promise });
    resume.reject(new Error("private error"));
    const session = await creating;
    await resumeRejected;
    expect(backend.getDiagnostics().pendingCount).toBe(0);
    const sending = session.send({ prompt: "private prompt" });
    const sendRejected = expect(sending).rejects.toMatchObject({ code: "AGENT_RPC_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["session.send"]);
    await sendRejected;
    expect(backend.getDiagnostics()).toEqual({
      pendingCount: 1,
      omittedCount: 0,
      pending: [{ operation: "session.send", ageMs: 120_000 }],
    });
    send.resolve("private response");
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.getDiagnostics().pendingCount).toBe(0);
    await backend.stop();
  });

  it.each(["stop", "forceStop", "fence"] as const)("clears tracking on %s and ignores late settlements", async (method) => {
    vi.useFakeTimers();
    const work = deferred<unknown>();
    const { client } = createFakeClient();
    client.getSessionMetadata.mockImplementation(() => work.promise);
    const backend = new CopilotBackend(client, { logger: silentLogger });
    await backend.start();
    const request = backend.getSessionMetadata("private-session");
    const rejected = expect(request).rejects.toThrow("late error");
    expect(backend.getDiagnostics().pendingCount).toBe(1);
    if (method === "fence") await expect(backend.fence()).rejects.toThrow("Cannot fence");
    else await backend[method]();
    expect(backend.getDiagnostics()).toEqual({ pendingCount: 0, omittedCount: 0, pending: [] });
    work.reject(new Error("late error"));
    await rejected;
    expect(backend.getDiagnostics()).toEqual({ pendingCount: 0, omittedCount: 0, pending: [] });
    client.getSessionMetadata.mockResolvedValue({});
    await backend.getSessionMetadata("after-retirement");
    expect(backend.getDiagnostics()).toEqual({ pendingCount: 0, omittedCount: 0, pending: [] });
  });
});

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
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect(onDisconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PING_DETECTION_WINDOW_MS - PING_TIMEOUT_MS - 1);
    expect(client.ping).toHaveBeenCalledTimes(BACKEND_PING_ATTEMPTS);
    expect(onDisconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: "health-probe-failed",
      detail: expect.stringContaining("connection-error"),
    }));
    expect(onDisconnect.mock.calls[0]![0].detail).toContain(`${BACKEND_PING_ATTEMPTS} consecutive pings`);
  });

  it("keeps a slow but alive backend when a retried ping answers", async () => {
    vi.useFakeTimers();
    let pings = 0;
    const { client } = createFakeClient({
      ping: () => (++pings === 1 ? new Promise(() => {}) : Promise.resolve({ message: "pong" })),
    });
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();

    const probe = backend.probeHealth(undefined, "watchdog no-progress");
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS + BACKEND_PING_RETRY_DELAY_MS);
    await expect(probe).resolves.toBe(true);
    expect(client.ping).toHaveBeenCalledTimes(2);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(backend.getConnectionStatus()).toMatchObject({ state: "connected" });
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`timed out (attempt 1/${BACKEND_PING_ATTEMPTS})`));
  });

  it("reports a runtime exit between ping retries immediately and stops pinging", async () => {
    vi.useFakeTimers();
    const { client, cliProcess } = createFakeClient({ ping: () => new Promise(() => {}) });
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();

    const probe = backend.probeHealth();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect(onDisconnect).not.toHaveBeenCalled();
    cliProcess.emit("exit", 1, null);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ reason: "process-exit" }));
    await vi.advanceTimersByTimeAsync(BACKEND_PING_RETRY_DELAY_MS);
    await expect(probe).resolves.toBe(false);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("does not retry a ping that fails for a reason other than a timeout", async () => {
    const { client } = createFakeClient({
      ping: async () => { throw new Error("Pending response rejected since connection got disposed"); },
    });
    const backend = new CopilotBackend(client, { logger: silentLogger });
    const onDisconnect = vi.fn();
    backend.onDisconnect(onDisconnect);
    await backend.start();

    await expect(backend.probeHealth()).resolves.toBe(false);
    expect(client.ping).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: "health-probe-failed",
      detail: expect.stringContaining("connection got disposed"),
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
    await vi.advanceTimersByTimeAsync(PING_DETECTION_WINDOW_MS);
    expect(client.ping).toHaveBeenCalledTimes(BACKEND_PING_ATTEMPTS);
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
