import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  BROWSER_LIVE_MODIFIERS,
  BROWSER_LIVE_WS_PATH,
  parseBrowserLiveClientMessage,
  type BrowserLiveClosedMessage,
  type BrowserLiveTicket,
} from "../../shared/browser-live.js";
import type { BrowserCommandResult, BrowserTarget } from "../agent-browser.js";
import {
  BROWSER_SESSION_IDLE_TIMEOUT_MS,
  BrowserBroker,
  BrowserUnavailableError,
  type BrowserBrokerLease,
  type BrowserBrokerOptions,
} from "../browser-broker.js";
import {
  BrowserLiveGateway,
  BrowserLiveSessionNotFoundError,
  BrowserLiveUnavailableError,
  type BrowserLiveGatewayOptions,
} from "../browser-live.js";
import { BrowserSessionStore, type BrowserSessionRecord } from "../browser-session-store.js";
import { makeTestDir } from "./helpers.js";

const T0 = Date.parse("2026-01-15T12:00:00.000Z");
const OWNER = "chat-session-1";
const NOT_FOUND = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

const ALL_MODIFIERS = BROWSER_LIVE_MODIFIERS.alt | BROWSER_LIVE_MODIFIERS.ctrl
  | BROWSER_LIVE_MODIFIERS.meta | BROWSER_LIVE_MODIFIERS.shift;

type RunCommand = NonNullable<BrowserLiveGatewayOptions["runCommand"]>;
type CliAnswer = BrowserCommandResult | Promise<BrowserCommandResult>;
type CliCommandName = "stream status" | "stream enable" | "eval";
type CliCall = { command: string[]; timeout: number | undefined; options: Parameters<RunCommand>[2] };
type ShutdownTarget = NonNullable<BrowserBrokerOptions["shutdownTarget"]>;

/** Hands out what was pushed in order; `next` waits for the following item. */
class Queue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  next(): Promise<T> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get size(): number {
    return this.items.length;
  }
}

/** Everything one end of a socket receives, parsed, and how the socket closed. */
class Inbox {
  private readonly messages = new Queue<unknown>();
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const text = data.toString();
      try {
        this.messages.push(JSON.parse(text));
      } catch {
        this.messages.push(text);
      }
    });
    this.closed = new Promise((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  next(): Promise<unknown> {
    return this.messages.next();
  }

  /** Messages received and not yet read with `next`. */
  get unread(): number {
    return this.messages.size;
  }
}

interface Endpoint {
  socket: WebSocket;
  inbox: Inbox;
}

interface UpstreamEndpoint extends Endpoint {
  /** The request path and query the gateway opened the stream with. */
  url: string;
}

interface View {
  client: Endpoint;
  upstream: UpstreamEndpoint;
}

type UpgradeAttempt = Endpoint | { status: number };

interface ClientRequest {
  origin?: string;
  headers?: Record<string, string>;
}

function successfulShutdown() {
  return { ok: true, closeOk: true, terminatedPids: [], killedPids: [], remainingPids: [], clearedRuntimeFiles: 0 };
}

/** What `eval` answers for the gateway's page script: the script's JSON text. */
function page(width: number, height: number, url: string): BrowserCommandResult {
  return { ok: true, output: JSON.stringify([width, height, url]) };
}

function closed(reason: BrowserLiveClosedMessage["reason"], message: string): BrowserLiveClosedMessage {
  return { type: "closed", reason, message };
}

function send(endpoint: Endpoint, message: unknown): void {
  endpoint.socket.send(typeof message === "string" ? message : JSON.stringify(message));
}

/** Resolves once the other end has handled everything this end sent so far: a ping is answered after it. */
async function handled(endpoint: Endpoint): Promise<void> {
  const pong = once(endpoint.socket, "pong");
  endpoint.socket.ping();
  await pong;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function leaseOf(session: BrowserSessionRecord): BrowserBrokerLease {
  return { context: session.context, browserTarget: session.browserTarget, publicSlot: session.publicSlot };
}

/**
 * A stand-in for the agent-browser CLI. By default the stream is on, at `streamPort`, and the
 * page cannot be read, so a view receives nothing but what a test sends through the stream.
 */
function createFakeCli(streamPort: number, journal: string[] = []) {
  const calls: CliCall[] = [];
  const waiters: Array<{ name: CliCommandName; count: number; resolve: () => void }> = [];
  const nameOf = (command: readonly string[]): string => (command[0] === "eval" ? "eval" : command.join(" "));
  const count = (name: CliCommandName): number => calls.filter((call) => nameOf(call.command) === name).length;
  const streaming: BrowserCommandResult = {
    ok: true,
    output: `Streaming on port ${streamPort}`,
    data: { enabled: true, port: streamPort },
  };
  /** What the CLI answers; a test replaces these. */
  const answers = {
    status: (): CliAnswer => streaming,
    enable: (): CliAnswer => streaming,
    page: (): CliAnswer => ({ ok: false, output: "The page is not ready." }),
  };
  const runCommand: RunCommand = async (command, timeout, options) => {
    calls.push({ command: [...command], timeout, options });
    journal.push(nameOf(command));
    for (const waiter of [...waiters]) {
      if (count(waiter.name) < waiter.count) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const name = nameOf(command);
    if (name === "eval") return answers.page();
    if (name === "stream status") return answers.status();
    if (name === "stream enable") return answers.enable();
    throw new Error(`Unexpected agent-browser command: ${name}`);
  };
  return {
    calls,
    answers,
    runCommand,
    count,
    /** Resolves once the command has been run `total` times. */
    called(name: CliCommandName, total: number): Promise<void> {
      if (count(name) >= total) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ name, count: total, resolve }));
    },
    commands: (): string[] => calls.map((call) => nameOf(call.command)),
  };
}

/**
 * A broker whose browsers are stand-ins: by default every browser is running, so the broker's
 * readiness commands succeed, and closing one succeeds at once. A test replaces `answers`.
 */
function createFakeBrowsers(prefix: string, journal: string[] = []) {
  /** The agent-browser commands the broker ran itself: its readiness check. */
  const commands: CliCall[] = [];
  /** The session name of every browser the broker closed, or made sure was closed, in order. */
  const shutdowns: string[] = [];
  const answers = {
    ready: (): CliAnswer => ({ ok: true, output: "about:blank" }),
    shutdown: (async () => successfulShutdown()) as ShutdownTarget,
  };
  const broker = new BrowserBroker({
    copilotHome: makeTestDir(prefix),
    runCommand: async (command, timeout, options) => {
      commands.push({ command: [...command], timeout, options });
      journal.push(command.join(" "));
      if (command[0] === "get") return answers.ready();
      throw new Error(`The broker must not run this agent-browser command here: ${command.join(" ")}`);
    },
    shutdownTarget: async (target, telemetryStore) => {
      shutdowns.push(target.sessionName);
      return answers.shutdown(target, telemetryStore);
    },
    removeProfile: async () => undefined,
  });
  return { broker, commands, shutdowns, answers };
}

/**
 * The broker waits between its attempts to reach a browser, on real timers. This runs an
 * operation whose browser does not come up without those waits: only the timeouts are faked,
 * sockets stay real, and every round lets both make progress until the operation has settled.
 */
async function withoutReadinessWaits<T>(operation: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const outcome = operation().finally(() => {
      settled = true;
    });
    outcome.catch(() => undefined);
    while (!settled) {
      await vi.advanceTimersByTimeAsync(2_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

/** A `connectStream` that opens the stream the way the gateway does and keeps the gateway's end of each. */
function recordingStreams() {
  const streams: WebSocket[] = [];
  const connectStream = (url: string): WebSocket => {
    const stream = new WebSocket(url, { perMessageDeflate: false });
    streams.push(stream);
    return stream;
  };
  return { streams, connectStream };
}

const teardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const teardown of teardowns.splice(0).reverse()) await teardown();
});

/**
 * A gateway over a real session store and broker, an HTTP server that hands it upgrades the way
 * the Bridge server does, and a WebSocket server standing in for agent-browser's stream.
 */
async function createHarness(options: Pick<BrowserLiveGatewayOptions, "connectStream"> = {}) {
  let upstreamAccepts = true;
  const upstreamServer = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
    verifyClient: () => upstreamAccepts,
  });
  await once(upstreamServer, "listening");
  const upstreamPort = (upstreamServer.address() as AddressInfo).port;
  const upstreamConnections = new Queue<UpstreamEndpoint>();
  upstreamServer.on("connection", (socket, req) => {
    socket.on("error", () => undefined);
    upstreamConnections.push({ socket, inbox: new Inbox(socket), url: req.url ?? "" });
  });

  /** Every agent-browser command, the broker's and the gateway's, in the order they were run. */
  const journal: string[] = [];
  const cli = createFakeCli(upstreamPort, journal);
  const browsers = createFakeBrowsers("browser-live", journal);
  const broker = browsers.broker;
  const store = new BrowserSessionStore({ browserBroker: broker });
  const gateway = new BrowserLiveGateway({ sessions: store, broker, runCommand: cli.runCommand, ...options });

  /** What handleUpgrade returned for each upgrade request, in order. */
  const handled: boolean[] = [];
  const server = createServer();
  const serverSockets = new Set<Socket>();
  server.on("connection", (socket) => {
    serverSockets.add(socket);
    socket.on("close", () => serverSockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const result = gateway.handleUpgrade(req, socket, head);
    handled.push(result);
    if (result) return;
    socket.write(NOT_FOUND);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const host = `127.0.0.1:${port}`;

  const clientSockets = new Set<WebSocket>();
  teardowns.push(async () => {
    gateway.shutdown();
    for (const socket of clientSockets) socket.terminate();
    for (const socket of upstreamServer.clients) socket.terminate();
    for (const socket of serverSockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
    ]);
    await store.closeAll();
  });

  const liveUrl = (ticket: Pick<BrowserLiveTicket, "browserSessionId" | "token">, prefix = ""): string => {
    const params = new URLSearchParams({ browserSessionId: ticket.browserSessionId, token: ticket.token });
    return `${prefix}${BROWSER_LIVE_WS_PATH}?${params.toString()}`;
  };

  /** Asks for an upgrade: the open socket, or the HTTP status it was refused with. */
  const connect = (pathAndQuery: string, request: ClientRequest = {}): Promise<UpgradeAttempt> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}${pathAndQuery}`, { ...request, perMessageDeflate: false });
      clientSockets.add(socket);
      const inbox = new Inbox(socket);
      socket.on("error", reject);
      socket.once("open", () => resolve({ socket, inbox }));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
        socket.terminate();
      });
    });

  const open = async (pathAndQuery: string, request?: ClientRequest): Promise<Endpoint> => {
    const attempt = await connect(pathAndQuery, request);
    if (!("socket" in attempt)) throw new Error(`The live view was refused with HTTP ${attempt.status}`);
    return attempt;
  };

  /** Opens a view with a ticket and waits until the gateway relays for it in both directions. */
  const openWithTicket = async (ticket: BrowserLiveTicket, request?: ClientRequest, prefix = ""): Promise<View> => {
    const pageReads = cli.count("eval");
    const client = await open(liveUrl(ticket, prefix), request);
    const upstream = await upstreamConnections.next();
    // The gateway reads the page when its end of the stream opens; from then on it forwards input.
    await cli.called("eval", pageReads + 1);
    return { client, upstream };
  };

  const openView = async (browserSessionId: string, request?: ClientRequest): Promise<View> =>
    openWithTicket(await gateway.createTicket(browserSessionId), request);

  return {
    gateway,
    store,
    broker,
    browsers,
    cli,
    journal,
    host,
    handled,
    upstreamConnections,
    upstreamPort,
    refuseUpstream: () => {
      upstreamAccepts = false;
    },
    createSession: () => store.createSession(OWNER, "public", "live view test"),
    liveUrl,
    connect,
    open,
    openWithTicket,
    openView,
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/** A gateway with only a fake CLI behind it, for what needs no sockets. */
function createCliGateway(options: Pick<BrowserLiveGatewayOptions, "connectStream"> = {}) {
  const cli = createFakeCli(9223);
  const { broker, commands: brokerCommands } = createFakeBrowsers("browser-live-cli");
  const store = new BrowserSessionStore({ browserBroker: broker });
  const gateway = new BrowserLiveGateway({ sessions: store, broker, runCommand: cli.runCommand, ...options });
  teardowns.push(async () => {
    gateway.shutdown();
    await store.closeAll();
  });
  const target: BrowserTarget = { sessionName: "copilot-bridge-public-test-1", profileDir: makeTestDir("browser-live-profile") };
  return { cli, gateway, target, brokerCommands };
}

describe("BrowserLiveGateway.resolveStreamPort", () => {
  it("returns the port of a stream that is already on without enabling it again", async () => {
    const { cli, gateway, target, brokerCommands } = createCliGateway();
    cli.answers.status = () => ({ ok: true, output: "Streaming on port 9333", data: { enabled: true, port: 9333 } });

    await expect(gateway.resolveStreamPort(target)).resolves.toBe(9333);

    expect(cli.commands()).toEqual(["stream status"]);
    // It reads a browser that is running; starting one is not its job.
    expect(cli.calls[0].options).toMatchObject({ browserTarget: target, skipRecovery: true });
    // Given a browser rather than a session, it leaves the broker to its caller.
    expect(brokerCommands).toEqual([]);
  });

  it.each([
    ["does not say whether the stream is on", { ok: true, output: "", data: { port: 9333 } }],
    ["gives the port as text", { ok: true, output: "", data: { enabled: true, port: "9333" } }],
  ] satisfies Array<[string, BrowserCommandResult]>)("returns the port of a status that %s", async (_name, status) => {
    const { cli, gateway, target } = createCliGateway();
    cli.answers.status = () => status;

    await expect(gateway.resolveStreamPort(target)).resolves.toBe(9333);

    expect(cli.commands()).toEqual(["stream status"]);
  });

  it.each([
    ["reports no port", { ok: true, output: "Streaming is off", data: { enabled: false } }],
    ["has no data", { ok: true, output: "Streaming is off" }],
    ["is off but still names its last port", { ok: true, output: "Streaming is off", data: { enabled: false, port: 9333 } }],
  ] satisfies Array<[string, BrowserCommandResult]>)("enables the stream when its status %s", async (_name, status) => {
    const { cli, gateway, target } = createCliGateway();
    cli.answers.status = () => status;
    cli.answers.enable = () => ({ ok: true, output: "Streaming on port 9444", data: { enabled: true, port: 9444 } });

    await expect(gateway.resolveStreamPort(target)).resolves.toBe(9444);

    expect(cli.commands()).toEqual(["stream status", "stream enable"]);
  });

  it("is unavailable, without trying to enable, when the CLI has no stream command", async () => {
    const { cli, gateway, target } = createCliGateway();
    cli.answers.status = () => ({ ok: false, output: "error: unrecognized subcommand 'stream'" });

    const failure = await gateway.resolveStreamPort(target).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserLiveUnavailableError);
    expect((failure as Error).message).toContain("agent-browser");
    expect(cli.commands()).toEqual(["stream status"]);
    // What diagnostics shows until a live view works.
    expect(gateway.getLastCheck()).toEqual({ ok: false, checkedAt: expect.any(String), message: (failure as Error).message });
  });

  it.each([
    ["fails", { ok: false, output: "Could not start streaming" }],
    ["answers without a port", { ok: true, output: "", data: { enabled: true } }],
    ["answers with the port 0", { ok: true, output: "", data: { enabled: true, port: 0 } }],
    ["answers with a port that is not a whole number", { ok: true, output: "", data: { enabled: true, port: 9444.5 } }],
    ["answers that the stream is off", { ok: true, output: "", data: { enabled: false, port: 9444 } }],
  ] satisfies Array<[string, BrowserCommandResult]>)("is unavailable when enabling the stream %s", async (_name, enable) => {
    const { cli, gateway, target } = createCliGateway();
    cli.answers.status = () => ({ ok: true, output: "Streaming is off", data: { enabled: false } });
    cli.answers.enable = () => enable;

    await expect(gateway.resolveStreamPort(target)).rejects.toBeInstanceOf(BrowserLiveUnavailableError);

    expect(cli.commands()).toEqual(["stream status", "stream enable"]);
  });
});

/**
 * The gateway's end of a stream that exists only in the test. What the gateway sends into it
 * goes to `receive`, which stands in for the browser.
 */
class FakeStream extends EventEmitter {
  /** What the gateway sent, parsed. */
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  constructor(readonly url: string, private readonly receive: (message: Record<string, unknown>) => void) {
    super();
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    this.receive(message);
  }

  close(): void {
    this.closed = true;
  }

  /** Hands the gateway a message of the stream. */
  deliver(message: unknown): void {
    this.emit("message", Buffer.from(typeof message === "string" ? message : JSON.stringify(message)), false);
  }
}

describe("BrowserLiveGateway.checkStream", () => {
  const FRAME = { type: "frame", seq: 1, data: "QQ==" };
  /** Longer than the check waits for anything. */
  const LONGER_THAN_THE_CHECK_WAITS_MS = 60_000;
  const isTypedText = (message: Record<string, unknown>): boolean => message.type === "input_keyboard" && message.eventType === "char";

  interface CheckedPage {
    /** How often the page is asked what has the focus before a click shows there. */
    focusesAfterReads?: number;
    ignoresClicks?: boolean;
    ignoresText?: boolean;
  }

  /**
   * A gateway whose browser is a stand-in: a page that the check's own script turns into one
   * text box, which a click through the stream focuses and typed text fills.
   */
  function createStreamCheck(page: CheckedPage = {}) {
    const opened = new Queue<FakeStream>();
    let boxId = "";
    let clicked = false;
    let focusReads = 0;
    let value = "";
    const focused = (): boolean => clicked && focusReads > (page.focusesAfterReads ?? 0);
    const browser = (message: Record<string, unknown>): void => {
      if (message.type === "input_mouse" && message.eventType === "mouseReleased" && !page.ignoresClicks) clicked = true;
      if (isTypedText(message) && focused() && !page.ignoresText) value += String(message.text);
    };
    const { cli, gateway, target } = createCliGateway({
      connectStream: (url) => {
        const stream = new FakeStream(url, browser);
        opened.push(stream);
        return stream as unknown as WebSocket;
      },
    });
    cli.answers.page = () => {
      const script = Buffer.from(cli.calls.at(-1)?.command[2] ?? "", "base64").toString("utf-8");
      if (script.includes("innerHTML")) {
        boxId = /id="([^"]+)"/.exec(script)?.[1] ?? "";
        return { ok: true, output: "ready" };
      }
      if (script.includes("activeElement")) {
        if (clicked) focusReads++;
        return { ok: true, output: focused() ? boxId : "" };
      }
      return { ok: true, output: value };
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    return { cli, gateway, target, opened, typed: () => value };
  }

  it("passes when the stream shows the page and a click and typed text sent through it reach the page", async () => {
    // The click takes a moment to focus the box.
    const check = createStreamCheck({ focusesAfterReads: 2 });

    const running = check.gateway.checkStream(check.target);
    const stream = await check.opened.next();
    expect(check.gateway.getLastCheck()).toBeUndefined();
    stream.deliver({ type: "status", connected: true, screencasting: true });
    stream.deliver("not json");
    stream.deliver(FRAME);
    await vi.advanceTimersByTimeAsync(LONGER_THAN_THE_CHECK_WAITS_MS);
    const result = await running;

    expect(result).toStrictEqual({ ok: true, checkedAt: expect.any(String) });
    expect(check.gateway.getLastCheck()).toBe(result);
    expect(stream.url).toBe("ws://127.0.0.1:9223/?pacing=ack&maxFps=15");
    // It sends what a live view's client sends: a click, then the text a character at a time.
    for (const message of stream.sent) expect(parseBrowserLiveClientMessage(message)).toStrictEqual(message);
    expect(stream.sent.slice(0, 3).map((message) => message.eventType)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    const text = stream.sent.slice(3);
    expect(text.length).toBeGreaterThan(0);
    expect(text.every((message) => isTypedText(message) && [...String(message.text)].length === 1)).toBe(true);
    expect(check.typed()).toBe(text.map((message) => message.text).join(""));
    // It used the browser it was given, as it is, and left nothing behind.
    expect(check.cli.calls.every((call) => call.options.browserTarget === check.target && call.options.skipRecovery)).toBe(true);
    expect(stream.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails when the stream sends no picture of the page", async () => {
    const check = createStreamCheck();

    const running = check.gateway.checkStream(check.target);
    const stream = await check.opened.next();
    // Not a frame a live view could show.
    stream.deliver({ type: "frame", seq: "1", data: "QQ==" });
    stream.deliver({ type: "url", url: "about:blank" });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(LONGER_THAN_THE_CHECK_WAITS_MS);
    const result = await running;

    expect(result).toStrictEqual({ ok: false, checkedAt: expect.any(String), message: expect.stringContaining("no picture of the page") });
    expect(check.gateway.getLastCheck()).toBe(result);
    expect(stream.sent).toEqual([]);
    expect(stream.closed).toBe(true);
  });

  it.each([
    ["could not be opened", (stream: FakeStream) => stream.emit("error", new Error("connect ECONNREFUSED"))],
    ["closed before it sent a picture", (stream: FakeStream) => stream.emit("close", 1006, Buffer.alloc(0))],
  ])("fails at once when the stream %s", async (message, end) => {
    const check = createStreamCheck();

    const running = check.gateway.checkStream(check.target);
    const stream = await check.opened.next();
    end(stream);

    // The message says which.
    await expect(running).resolves.toMatchObject({ ok: false, message: expect.stringContaining(message) });
    expect(stream.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["a click", { ignoresClicks: true }, "click sent through the browser's stream did not reach the page", false],
    ["typed text", { ignoresText: true }, "Text typed through the browser's stream did not reach the page", true],
  ])("fails when %s sent through the stream never reaches the page", async (_name, page, message, typedAnything) => {
    const check = createStreamCheck(page);

    const running = check.gateway.checkStream(check.target);
    const stream = await check.opened.next();
    stream.deliver(FRAME);
    await vi.advanceTimersByTimeAsync(LONGER_THAN_THE_CHECK_WAITS_MS);
    const result = await running;

    expect(result).toStrictEqual({ ok: false, checkedAt: expect.any(String), message: expect.stringContaining(message) });
    expect(check.gateway.getLastCheck()).toBe(result);
    // Text is typed only into a page that took the click.
    expect(stream.sent.some(isTypedText)).toBe(typedAnything);
    expect(stream.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails, without opening the stream, when the page cannot be used", async () => {
    const check = createStreamCheck();
    check.cli.answers.page = () => ({ ok: false, output: "Execution context was destroyed" });

    await expect(check.gateway.checkStream(check.target)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("Execution context was destroyed"),
    });
    expect(check.opened.size).toBe(0);
  });

  it("fails without throwing, and closes the stream, when a command throws while the stream is open", async () => {
    const check = createStreamCheck();
    const answer = check.cli.answers.page;
    check.cli.answers.page = () => (check.cli.count("eval") > 1 ? Promise.reject(new Error("agent-browser timed out")) : answer());

    const running = check.gateway.checkStream(check.target);
    const stream = await check.opened.next();
    stream.deliver(FRAME);

    await expect(running).resolves.toMatchObject({ ok: false, message: "agent-browser timed out" });
    expect(stream.closed).toBe(true);
  });

  it("fails, in words that say how to fix it, when the installed agent-browser has no streaming", async () => {
    const check = createStreamCheck();
    check.cli.answers.status = () => ({ ok: false, output: "error: unrecognized subcommand 'stream'" });

    const result = await check.gateway.checkStream(check.target);

    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("npm install -g agent-browser") });
    expect(check.gateway.getLastCheck()).toBe(result);
    expect(check.cli.commands()).toEqual(["stream status"]);
    expect(check.opened.size).toBe(0);
  });

  it("counts as passed once a live view has relayed a picture, and is not recorded again for every picture after it", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const streaming = h.cli.answers.status;
    h.cli.answers.status = () => ({ ok: false, output: "error: unrecognized subcommand 'stream'" });
    await expect(h.gateway.createTicket(session.id)).rejects.toBeInstanceOf(BrowserLiveUnavailableError);
    const failed = h.gateway.getLastCheck();
    expect(failed).toMatchObject({ ok: false });

    // agent-browser was updated. A view that has opened has not shown anything yet.
    h.cli.answers.status = streaming;
    const view = await h.openView(session.id);
    expect(h.gateway.getLastCheck()).toBe(failed);

    send(view.upstream, FRAME);
    await view.client.inbox.next();
    const passed = h.gateway.getLastCheck();
    expect(passed).toStrictEqual({ ok: true, checkedAt: expect.any(String) });

    send(view.upstream, { ...FRAME, seq: 2 });
    await view.client.inbox.next();
    expect(h.gateway.getLastCheck()).toBe(passed);
  });
});

describe("BrowserLiveGateway tickets", () => {
  it("refuses a ticket for a session that does not exist or has been closed", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    await h.store.closeSession(session.id, OWNER);

    await expect(h.gateway.createTicket("bs_missing")).rejects.toBeInstanceOf(BrowserLiveSessionNotFoundError);
    await expect(h.gateway.createTicket("bs_missing")).rejects.toThrow("Browser session bs_missing has ended.");
    await expect(h.gateway.createTicket(session.id)).rejects.toBeInstanceOf(BrowserLiveSessionNotFoundError);
    // Neither the broker nor the gateway ran a command for them.
    expect(h.journal).toEqual([]);
  });

  it("refuses a ticket when the session's browser cannot stream", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    h.cli.answers.status = () => ({ ok: false, output: "error: unrecognized subcommand 'stream'" });

    await expect(h.gateway.createTicket(session.id)).rejects.toBeInstanceOf(BrowserLiveUnavailableError);

    // The session is let go of again and can still be closed.
    expect(h.store.getSession(session.id)?.activeCount).toBe(0);
    await expect(h.store.closeSession(session.id, OWNER)).resolves.toEqual({ ok: true });
  });

  it("gives a ticket for the session's browser that is valid for 60 seconds", async () => {
    const h = await createHarness();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const session = await h.createSession();

    const ticket = await h.gateway.createTicket(session.id);
    const second = await h.gateway.createTicket(session.id);

    expect(ticket).toEqual({
      browserSessionId: session.id,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      expiresAt: new Date(T0 + 60_000).toISOString(),
    });
    expect(second.token).not.toBe(ticket.token);
  });

  it("upgrades with a valid ticket and opens the browser's stream with paced frames", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);

    const view = await h.openWithTicket(ticket);

    expect(view.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(h.handled).toEqual([true]);
    expect(view.upstream.url).toBe("/?pacing=ack&maxFps=15");
  });

  it("upgrades under a path prefix, as a staged preview serves it", async () => {
    const h = await createHarness();
    const session = await h.createSession();

    const view = await h.openWithTicket(await h.gateway.createTicket(session.id), undefined, "/staging/41728153");

    expect(view.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(h.handled).toEqual([true]);
  });

  it("answers 403 when a ticket is used a second time", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    await h.openWithTicket(ticket);

    await expect(h.connect(h.liveUrl(ticket))).resolves.toEqual({ status: 403 });
    expect(h.handled).toEqual([true, true]);
  });

  it("accepts a ticket until its 60 seconds are over, and answers 403 after that", async () => {
    const h = await createHarness();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    const late = await h.gateway.createTicket(session.id);

    vi.setSystemTime(T0 + 59_999);
    await expect(h.connect(h.liveUrl(ticket))).resolves.toHaveProperty("socket");

    vi.setSystemTime(T0 + 60_000);
    await expect(h.connect(h.liveUrl(late))).resolves.toEqual({ status: 403 });
  });

  it("answers 403 for a made-up ticket and for no ticket", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    await h.gateway.createTicket(session.id);

    await expect(h.connect(h.liveUrl({ browserSessionId: session.id, token: "x".repeat(32) }))).resolves.toEqual({ status: 403 });
    await expect(h.connect(`${BROWSER_LIVE_WS_PATH}?browserSessionId=${session.id}`)).resolves.toEqual({ status: 403 });
    await expect(h.connect(BROWSER_LIVE_WS_PATH)).resolves.toEqual({ status: 403 });
    expect(h.handled).toEqual([true, true, true]);
  });

  it("answers 403 for a ticket presented with another session's id, and the attempt spends the ticket", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const other = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);

    await expect(h.connect(h.liveUrl({ browserSessionId: other.id, token: ticket.token }))).resolves.toEqual({ status: 403 });
    await expect(h.connect(`${BROWSER_LIVE_WS_PATH}?token=${ticket.token}`)).resolves.toEqual({ status: 403 });
    await expect(h.connect(h.liveUrl(ticket))).resolves.toEqual({ status: 403 });
  });

  it("does not handle an upgrade for another path, and leaves the ticket usable", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    const query = h.liveUrl(ticket).slice(BROWSER_LIVE_WS_PATH.length);

    await expect(h.connect(`/api/voice/ws${query}`)).resolves.toEqual({ status: 404 });
    await expect(h.connect(`${BROWSER_LIVE_WS_PATH}/extra${query}`)).resolves.toEqual({ status: 404 });
    expect(h.handled).toEqual([false, false]);

    await expect(h.connect(h.liveUrl(ticket))).resolves.toHaveProperty("socket");
  });
});

describe("BrowserLiveGateway and the session's browser", () => {
  it("holds the session and its browser while it looks for the stream, and lets go of both afterwards", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const answer = h.cli.answers.status;
    const streamFound = deferred();
    h.cli.answers.status = async () => {
      await streamFound.promise;
      return answer();
    };

    const ticket = h.gateway.createTicket(session.id);
    await h.cli.called("stream status", 1);

    expect(h.store.getSession(session.id)?.activeCount).toBe(1);
    expect(h.broker.getSnapshot().public.activeOperations).toBe(1);
    // So the session is not closed under it, neither by its chat nor as idle.
    await expect(h.store.closeSession(session.id, OWNER)).resolves.toEqual({ ok: false, error: "Browser session is busy" });
    await expect(h.store.sweepIdleSessions(Date.now() + BROWSER_SESSION_IDLE_TIMEOUT_MS)).resolves.toBe(0);

    streamFound.resolve();
    await expect(ticket).resolves.toMatchObject({ browserSessionId: session.id });
    expect(h.store.getSession(session.id)?.activeCount).toBe(0);
    expect(h.broker.getSnapshot().public.activeOperations).toBe(0);
  });

  it("gives a ticket and shows the browser while the user holds it, when the agent's own operations are refused", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const handBack = h.broker.holdTarget(leaseOf(session), "Solve the puzzle");
    await expect(
      h.broker.withTarget(leaseOf(session), { toolName: "browser_session_exec", browserOpId: "op-1" }, async () => "ran"),
    ).rejects.toThrow("The user has this browser right now (Solve the puzzle). Try again after they hand it back.");

    const view = await h.openView(session.id);

    send(view.upstream, { type: "frame", seq: 1, data: "QQ==" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });
    handBack();
  });

  it("refuses a ticket, and ends a view opened with an earlier one, while the session is being closed", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    const commands = h.journal.length;
    const browserMayClose = deferred();
    h.browsers.answers.shutdown = async () => {
      await browserMayClose.promise;
      return successfulShutdown();
    };
    const closing = h.store.closeSession(session.id, OWNER);
    // The store still knows the session: its browser has not been closed yet.
    expect(h.store.getSession(session.id)).toBeDefined();

    await expect(h.gateway.createTicket(session.id)).rejects.toBeInstanceOf(BrowserLiveSessionNotFoundError);
    const client = await h.open(h.liveUrl(ticket));
    expect(await client.inbox.next()).toStrictEqual(closed("session_ended", "The browser session has ended."));
    expect(await client.inbox.closed).toEqual({ code: 1000, reason: "session_ended" });

    // Nothing was run on the browser that is going away.
    expect(h.journal).toHaveLength(commands);
    expect(h.upstreamConnections.size).toBe(0);
    browserMayClose.resolve();
    await expect(closing).resolves.toEqual({ ok: true });
  });

  it("refuses a ticket, without looking for the stream, when the session's browser does not start", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    h.browsers.answers.ready = () => ({ ok: false, output: "Chrome exited early" });

    const failure = await withoutReadinessWaits(() => h.gateway.createTicket(session.id).catch((error: unknown) => error));

    // The broker's own error, not the gateway's BrowserLiveUnavailableError.
    expect(failure).toBeInstanceOf(BrowserUnavailableError);
    expect((failure as Error).message).toContain("Chrome exited early");
    expect(h.cli.calls).toEqual([]);
    expect(h.store.getSession(session.id)?.activeCount).toBe(0);
  });

  it("closes the view as unavailable, in the broker's words, when the session's browser no longer starts", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    const statusCalls = h.cli.count("stream status");
    h.browsers.answers.ready = () => ({ ok: false, output: "Chrome exited early" });

    const { client, message } = await withoutReadinessWaits(async () => {
      const opened = await h.open(h.liveUrl(ticket));
      return { client: opened, message: await opened.inbox.next() };
    });

    expect(message).toStrictEqual({
      type: "closed",
      reason: "unavailable",
      message: expect.stringContaining("Chrome exited early"),
    });
    expect(await client.inbox.closed).toEqual({ code: 1000, reason: "unavailable" });
    expect(h.cli.count("stream status")).toBe(statusCalls);
    expect(h.upstreamConnections.size).toBe(0);
  });
});

describe("BrowserLiveGateway origin check", () => {
  it("accepts an upgrade without an Origin, or with one whose host is the request's Host", async () => {
    const h = await createHarness();
    const session = await h.createSession();

    // Only pages of other sites are kept out; a client that is not a page sends no Origin.
    for (const request of [{}, { origin: `http://${h.host}` }]) {
      const ticket = await h.gateway.createTicket(session.id);
      await expect(h.connect(h.liveUrl(ticket), request)).resolves.toHaveProperty("socket");
    }
  });

  it("accepts an Origin whose host is the X-Forwarded-Host of a reverse proxy", async () => {
    const h = await createHarness();
    const session = await h.createSession();

    for (const forwardedHost of ["bridge.example.com", "edge.internal, Bridge.Example.com"]) {
      const ticket = await h.gateway.createTicket(session.id);
      await expect(h.connect(h.liveUrl(ticket), {
        origin: "https://bridge.example.com",
        headers: { "x-forwarded-host": forwardedHost },
      })).resolves.toHaveProperty("socket");
    }
  });

  it.each([
    ["another site", "https://evil.example"],
    ["this host on another port", "http://127.0.0.1:1"],
    ["an opaque origin", "null"],
  ])("answers 403 for an Origin that is %s, and the attempt spends the ticket", async (_name, origin) => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);

    await expect(h.connect(h.liveUrl(ticket), { origin })).resolves.toEqual({ status: 403 });
    await expect(h.connect(h.liveUrl(ticket), { origin: `http://${h.host}` })).resolves.toEqual({ status: 403 });
  });

  it("answers 403 for a foreign Origin even when the proxy forwards the Bridge's own host", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);

    await expect(h.connect(h.liveUrl(ticket), {
      origin: "https://evil.example",
      headers: { "x-forwarded-host": "bridge.example.com" },
    })).resolves.toEqual({ status: 403 });
  });

});

describe("BrowserLiveGateway connection limit", () => {
  it("answers 429 to a fourth view of one session and allows one again after a view closes", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const other = await h.createSession();
    const views = [await h.openView(session.id), await h.openView(session.id), await h.openView(session.id)];

    await expect(h.connect(h.liveUrl(await h.gateway.createTicket(session.id)))).resolves.toEqual({ status: 429 });

    // The limit is per browser session.
    const otherView = await h.openView(other.id);
    expect(otherView.client.socket.readyState).toBe(WebSocket.OPEN);

    views[0].client.socket.close();
    // The gateway closes a view's stream once it has dropped the view.
    await views[0].upstream.inbox.closed;

    const fourth = await h.openView(session.id);
    expect(fourth.client.socket.readyState).toBe(WebSocket.OPEN);
    await expect(h.connect(h.liveUrl(await h.gateway.createTicket(session.id)))).resolves.toEqual({ status: 429 });
  });
});

describe("BrowserLiveGateway relay to the client", () => {
  it("forwards a frame without its metadata", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    send(view.upstream, {
      type: "frame",
      seq: 7,
      data: "anBlZw==",
      metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0, timestamp: 1 },
    });

    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 7, data: "anBlZw==" });
  });

  it("forwards the page's address when the browser navigates, once per address", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    send(view.upstream, { type: "url", url: "https://example.com/next", title: "Next" });
    send(view.upstream, { type: "url", url: "https://example.com/next" });
    send(view.upstream, { type: "frame", seq: 1, data: "QQ==" });

    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/next" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });
  });

  it("drops every other message of the stream, and malformed ones", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    for (const dropped of [
      { type: "status", connected: true, screencasting: true, viewportWidth: 1280, viewportHeight: 720 },
      { type: "error", message: "Screencast failed" },
      { type: "tabs", tabs: [{ id: "t1", url: "https://example.com/", active: true }] },
      { type: "closed", reason: "session_ended", message: "Not from the Bridge" },
      { type: "viewport", width: 1, height: 1 },
      { type: "frame", seq: "1", data: "QQ==" },
      { type: "frame", seq: 1 },
      { type: "url" },
      { type: "url", url: 5 },
      [{ type: "frame", seq: 1, data: "QQ==" }],
      "not json",
      "1",
      // A listener that throws on this one is an uncaught exception in the process.
      "null",
      '"frame"',
    ]) {
      send(view.upstream, dropped);
    }
    send(view.upstream, { type: "frame", seq: 2, data: "Qg==" });

    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 2, data: "Qg==" });
  });

});

describe("BrowserLiveGateway relay to the browser", () => {
  const mouse = (fields: Record<string, unknown> = {}) => ({ type: "input_mouse", eventType: "mouseMoved", x: 10, y: 20, ...fields });
  const typed = (fields: Record<string, unknown> = {}) => ({ type: "input_keyboard", eventType: "char", ...fields });

  it("forwards acks and mouse and keyboard input in order, with the protocol's fields and nothing else", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);
    const allowed = [
      { type: "ack", seq: 7 },
      { type: "input_mouse", eventType: "mousePressed", x: 12.5, y: 40, button: "left", clickCount: 1, modifiers: 8 },
      { type: "input_keyboard", eventType: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    ];

    for (const message of allowed) send(view.client, { ...message, script: "document.cookie", data: "QQ==" });

    for (const message of allowed) expect(await view.upstream.inbox.next()).toStrictEqual(message);
  });

  it("drops every other client message, and what is not a JSON object", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    for (const dropped of [
      { type: "eval", script: "document.cookie" },
      { type: "stream", action: "disable" },
      // No longer part of the protocol: the client turns touches into mouse input.
      { type: "input_touch", eventType: "touchStart", touchPoints: [{ x: 3, y: 4 }] },
      { type: "frame", seq: 1, data: "QQ==" },
      { type: "input_mouse", eventType: "click", x: 1, y: 1 },
      [{ type: "ack", seq: 1 }],
    ]) {
      send(view.client, dropped);
    }
    for (const text of ["null", '"ack"', "7", "{}", "not json", '{"type":"ack"']) send(view.client, text);
    view.client.socket.send(Buffer.from([0xff, 0x00, 0xfe]));
    send(view.client, { type: "ack", seq: 9 });

    expect(await view.upstream.inbox.next()).toStrictEqual({ type: "ack", seq: 9 });
  });

  it("hands typed text to the browser one code point at a time, carrying its modifiers and nothing else", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    // A character and the accent combined with it are two code points; a surrogate pair is one.
    send(view.client, typed({ text: "he\u0301\u{1f600}", key: "h", code: "KeyH", windowsVirtualKeyCode: 72, modifiers: 8 }));
    // Empty text is nothing to type; a char event without text goes on as it came.
    send(view.client, typed({ text: "" }));
    send(view.client, typed({ key: "a" }));
    send(view.client, typed({ text: "!" }));

    for (const text of ["h", "e", "\u0301", "\u{1f600}"]) {
      expect(await view.upstream.inbox.next()).toStrictEqual(typed({ text, modifiers: 8 }));
    }
    expect(await view.upstream.inbox.next()).toStrictEqual(typed({ key: "a" }));
    expect(await view.upstream.inbox.next()).toStrictEqual(typed({ text: "!" }));
  });

  it("forwards a long text whole and in order, ahead of the input that came after it", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);
    const characters = Array.from({ length: 200 }, (_unused, index) => String.fromCodePoint(0x100 + index));

    send(view.client, typed({ text: characters.join(""), modifiers: 8 }));
    send(view.client, mouse());
    send(view.client, { type: "ack", seq: 1 });

    for (const text of characters) expect(await view.upstream.inbox.next()).toStrictEqual(typed({ text, modifiers: 8 }));
    expect(await view.upstream.inbox.next()).toStrictEqual(mouse());
    expect(await view.upstream.inbox.next()).toStrictEqual({ type: "ack", seq: 1 });
  });

  it("holds the rest of a text back while much is still on its way to the browser", async () => {
    const { streams, connectStream } = recordingStreams();
    const h = await createHarness({ connectStream });
    const view = await h.openView((await h.createSession()).id);
    const stream = streams[0];
    let backlog = 256 * 1024 + 1;
    Object.defineProperty(stream, "bufferedAmount", { configurable: true, get: () => backlog });
    const toBrowser = vi.spyOn(stream, "send");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    send(view.client, typed({ text: "abc" }));
    await handled(view.client);
    expect(toBrowser).toHaveBeenCalledTimes(1);

    backlog = 0;
    await vi.runOnlyPendingTimersAsync();
    for (const text of ["a", "b", "c"]) expect(await view.upstream.inbox.next()).toStrictEqual(typed({ text }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops input that arrives before the browser's stream is open", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    const answer = h.cli.answers.status;
    let releaseStatus!: () => void;
    h.cli.answers.status = () => new Promise((resolve) => {
      releaseStatus = () => resolve(answer());
    });
    const statusCalls = h.cli.count("stream status");

    const client = await h.open(h.liveUrl(ticket));
    await h.cli.called("stream status", statusCalls + 1);
    send(client, { type: "input_mouse", eventType: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 });
    await handled(client);

    releaseStatus();
    const upstream = await h.upstreamConnections.next();
    await h.cli.called("eval", 1);
    send(client, { type: "ack", seq: 1 });

    expect(await upstream.inbox.next()).toStrictEqual({ type: "ack", seq: 1 });
  });

  it("closes a client that sends a message larger than 16 KiB without forwarding it", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);
    // JSON may end in white space, which makes a message of any size.
    const ackOfBytes = (bytes: number): string => JSON.stringify({ type: "ack", seq: 1 }).padEnd(bytes, " ");

    send(view.client, ackOfBytes(16 * 1024));
    expect(await view.upstream.inbox.next()).toStrictEqual({ type: "ack", seq: 1 });

    send(view.client, ackOfBytes(16 * 1024 + 1));

    expect((await view.client.inbox.closed).code).toBe(1009);
    await view.upstream.inbox.closed;
    expect(view.upstream.inbox.unread).toBe(0);
  });

  it("counts input, but not acks or dropped messages, as a use of the session", async () => {
    const h = await createHarness();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const session = await h.createSession();
    const view = await h.openView(session.id);

    vi.setSystemTime(T0 + 10 * 60_000);
    send(view.client, { type: "eval", script: "1" });
    send(view.client, { type: "input_mouse", eventType: "mousePressed", button: "left" });
    send(view.client, { type: "input_keyboard", eventType: "paste", text: "x" });
    send(view.client, { type: "ack", seq: 1 });
    expect(await view.upstream.inbox.next()).toStrictEqual({ type: "ack", seq: 1 });
    expect(h.store.getSession(session.id)?.lastUsedAt).toBe(T0);

    send(view.client, { type: "input_mouse", eventType: "mouseMoved", x: 1, y: 1 });
    expect(await view.upstream.inbox.next()).toMatchObject({ type: "input_mouse" });
    expect(h.store.getSession(session.id)?.lastUsedAt).toBe(T0 + 10 * 60_000);

    // Idle since the input, not since the session was created.
    await expect(h.store.sweepIdleSessions(T0 + BROWSER_SESSION_IDLE_TIMEOUT_MS + 60_000)).resolves.toBe(0);
    expect(h.store.getSession(session.id)).toBeDefined();
  });
});

// What a client sends goes on to the browser's input, so the gateway forwards only what this
// makes of it: the fields the protocol defines, each of the kind it defines.
describe("parseBrowserLiveClientMessage", () => {
  const parse = parseBrowserLiveClientMessage;
  const mouse = (fields: Record<string, unknown> = {}) => ({ type: "input_mouse", eventType: "mouseMoved", x: 10, y: 20, ...fields });
  const key = (fields: Record<string, unknown> = {}) => ({ type: "input_keyboard", eventType: "keyDown", ...fields });
  const typed = (fields: Record<string, unknown> = {}) => ({ type: "input_keyboard", eventType: "char", ...fields });
  const NOT_NUMBERS = [undefined, "7", null, true, [7], Infinity, NaN];

  it("accepts an ack whose seq is a finite number", () => {
    for (const seq of [0, 7, -1, 1.5]) expect(parse({ type: "ack", seq })).toStrictEqual({ type: "ack", seq });
    for (const seq of NOT_NUMBERS) expect(parse({ type: "ack", seq }), String(seq)).toBeUndefined();
  });

  it("accepts mouse and keyboard messages of each event type with every field the protocol defines", () => {
    for (const eventType of ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]) {
      const full = { type: "input_mouse", eventType, x: -3.5, y: 0, button: "left", clickCount: 2, deltaX: 0, deltaY: -120.5, modifiers: 10 };
      expect(parse(full)).toStrictEqual(full);
      expect(parse({ type: "input_mouse", eventType, x: 10, y: 20 })).toStrictEqual({ type: "input_mouse", eventType, x: 10, y: 20 });
    }
    for (const eventType of ["keyDown", "keyUp", "char"]) {
      const full = { type: "input_keyboard", eventType, key: "A", code: "KeyA", text: "A", windowsVirtualKeyCode: 65, modifiers: 8 };
      expect(parse(full)).toStrictEqual(full);
      expect(parse({ type: "input_keyboard", eventType })).toStrictEqual({ type: "input_keyboard", eventType });
    }
  });

  it("rejects a message whose event type is not one its kind has", () => {
    for (const eventType of [undefined, "", "click", "MOUSEMOVED", "mouseMoved ", "keyDown", "touchStart", 1, null, ["mousePressed"]]) {
      expect(parse(mouse({ eventType })), String(eventType)).toBeUndefined();
    }
    for (const eventType of [undefined, "", "rawKeyDown", "KEYDOWN", "paste", "mousePressed", 1, null, ["keyDown"]]) {
      expect(parse(key({ eventType, key: "a" })), String(eventType)).toBeUndefined();
    }
  });

  it("rejects a mouse message whose position is not two finite numbers", () => {
    for (const value of NOT_NUMBERS) {
      expect(parse(mouse({ x: value })), `x: ${String(value)}`).toBeUndefined();
      expect(parse(mouse({ y: value })), `y: ${String(value)}`).toBeUndefined();
    }
  });

  const allModifiers = Array.from({ length: ALL_MODIFIERS + 1 }, (_unused, modifiers) => modifiers);
  const notModifiers = [ALL_MODIFIERS + 1, 32, -1, 1.5, "8", null, true, [8]];
  const longestName = "k".repeat(32);
  it.each([
    ["a mouse button", mouse, "button", ["none", "left", "middle", "right"], ["back", "LEFT", "", 0, null, ["left"]]],
    ["a click count", mouse, "clickCount", [0, 1, 2, 3], [4, -1, 1.5, "1", null, true]],
    ["a horizontal scroll distance", mouse, "deltaX", [-40, 0, 0.25], ["40", null, Infinity, NaN]],
    ["a vertical scroll distance", mouse, "deltaY", [-40, 0, 0.25], ["40", null, Infinity, NaN]],
    ["a mouse message's modifiers", mouse, "modifiers", allModifiers, notModifiers],
    ["a key press's modifiers", key, "modifiers", allModifiers, notModifiers],
    ["typed text's modifiers", typed, "modifiers", allModifiers, notModifiers],
    ["a key name", key, "key", ["", "a", "Backspace", longestName], [`${longestName}k`, 65, null, true, ["a"]]],
    ["a key's code", key, "code", ["", "KeyA", longestName], [`${longestName}k`, 65, null, true, ["KeyA"]]],
    ["a key code", key, "windowsVirtualKeyCode", [0, 8, 255], [256, -1, 8.5, "8", null, true]],
    // One character is one code point: an emoji is two UTF-16 units, a letter with a combining accent two characters.
    ["a key press's text", key, "text", ["", "a", "\r", "\u00e9", "\u{1f600}"], ["ab", "\u{1f600}\u{1f600}", "e\u0301", 5, null, ["a"]]],
    // Only typed text may be several characters; the gateway hands them on one at a time.
    ["typed text", typed, "text", ["", "a", "ab", "e\u0301\u{1f600}"], [5, null, ["a"]]],
  ] as Array<[string, typeof mouse, string, unknown[], unknown[]]>)(
    "keeps %s the protocol allows, and leaves any other out of the message",
    (_name, message, field, allowed, others) => {
      const parsed = (value: unknown) => expect(parse(message({ [field]: value })), JSON.stringify(value));
      for (const value of allowed) parsed(value).toStrictEqual(message({ [field]: value }));
      for (const value of others) parsed(value).toStrictEqual(message());
    },
  );

  it("takes nothing of a message but the fields its kind defines", () => {
    expect(parse({ type: "ack", seq: 7, data: "QQ==", eventType: "mousePressed", x: 1, y: 1, modifiers: 8 }))
      .toStrictEqual({ type: "ack", seq: 7 });
    expect(parse(mouse({ key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65, touchPoints: [{ x: 1, y: 2 }], seq: 1, script: "x" })))
      .toStrictEqual(mouse());
    expect(parse(key({ key: "a", x: 1, y: 2, button: "left", clickCount: 1, deltaX: 1, deltaY: 1, seq: 1, script: "x" })))
      .toStrictEqual(key({ key: "a" }));
  });

  it("rejects every other kind of message, and what is not an object", () => {
    for (const message of [
      { type: "eval", script: "document.cookie" },
      { type: "input_touch", eventType: "touchStart", touchPoints: [{ x: 1, y: 2 }] },
      { type: "input_clipboard", text: "paste" },
      { type: "ACK", seq: 1 },
      // String(["input_mouse"]) is "input_mouse", so a check that coerces the type lets this through.
      { type: ["input_mouse"], eventType: "mousePressed", x: 1, y: 1 },
      { seq: 1 },
      {},
      [{ type: "ack", seq: 1 }],
      null,
      undefined,
      "ack",
      7,
      true,
    ]) {
      expect(parse(message), JSON.stringify(message)).toBeUndefined();
    }
  });
});

describe("BrowserLiveGateway page size and address", () => {
  it("sends the page's address and viewport, read with eval, when the stream opens", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    h.cli.answers.page = () => page(1280, 720, "https://example.com/");

    const view = await h.openView(session.id);

    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1280, height: 720 });
    expect(h.cli.calls.find((call) => call.command[0] === "eval")?.options)
      .toMatchObject({ browserTarget: session.browserTarget, skipRecovery: true });
  });

  it("reads the page again when the browser navigates or shows another tab, and sends only what changed", async () => {
    const h = await createHarness();
    h.cli.answers.page = () => page(1280, 720, "https://example.com/");
    const view = await h.openView((await h.createSession()).id);
    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1280, height: 720 });

    h.cli.answers.page = () => page(800, 600, "https://example.com/");
    send(view.upstream, { type: "tabs", tabs: [] });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 800, height: 600 });

    h.cli.answers.page = () => page(800, 600, "https://example.com/other");
    send(view.upstream, { type: "url", url: "https://example.com/other" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/other" });
    await h.cli.called("eval", 3);

    // The third read found nothing new, so the next thing the client gets is the frame.
    send(view.upstream, { type: "frame", seq: 1, data: "QQ==" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });
  });

  it.each([
    ["fails", (): CliAnswer => ({ ok: false, output: "Execution context was destroyed" })],
    ["throws", (): CliAnswer => Promise.reject(new Error("agent-browser timed out"))],
    ["answers with something else than the script's JSON", (): CliAnswer => ({ ok: true, output: "undefined" })],
  ])("sends no viewport and keeps relaying when the eval %s, and reads the page again later", async (_name, failing) => {
    const h = await createHarness();
    h.cli.answers.page = failing;
    const view = await h.openView((await h.createSession()).id);

    send(view.upstream, { type: "frame", seq: 1, data: "QQ==" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });

    h.cli.answers.page = () => page(1024, 768, "https://example.com/");
    send(view.upstream, { type: "tabs", tabs: [] });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1024, height: 768 });
  });

  it("does not read the page again for the tabs agent-browser announces after each of its commands", async () => {
    const h = await createHarness();
    let afterCommand = (): void => undefined;
    h.cli.answers.page = () => {
      afterCommand();
      return page(1280, 720, "https://example.com/");
    };
    const view = await h.openView((await h.createSession()).id);
    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1280, height: 720 });
    let stamp = 0;
    const announceTabs = (): void => send(view.upstream, {
      type: "tabs",
      tabs: [{ tabId: "t1", targetId: "A", title: "Example", url: "https://example.com/", active: true }],
      timestamp: ++stamp,
    });
    afterCommand = announceTabs;

    // What agent-browser sends when the stream opens. The read it prompts is a command too.
    announceTabs();
    await h.cli.called("eval", 2);

    // The frame comes after the announcement of that read, so the gateway has seen both.
    send(view.upstream, { type: "frame", seq: 1, data: "QQ==" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });
    expect(stamp).toBe(2);
    expect(h.cli.count("eval")).toBe(2);
  });

  it("reads the page again for tabs that show another tab or another address, and for nothing else in them", async () => {
    const h = await createHarness();
    h.cli.answers.page = () => page(1280, 720, "https://example.com/");
    const view = await h.openView((await h.createSession()).id);
    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1280, height: 720 });
    const first = { tabId: "t1", targetId: "A", title: "Example", url: "https://example.com/", active: true };
    const second = { tabId: "t2", targetId: "B", title: "Other", url: "https://example.org/", active: false };
    const unchanged = async (reads: number): Promise<void> => {
      await handled(view.upstream);
      expect(h.cli.count("eval")).toBe(reads);
    };

    send(view.upstream, { type: "tabs", tabs: [first], timestamp: 1 });
    await h.cli.called("eval", 2);
    send(view.upstream, { type: "tabs", tabs: [{ ...first, title: "Renamed" }], timestamp: 2 });
    send(view.upstream, { type: "tabs", tabs: [first, second], timestamp: 3 });
    await unchanged(2);

    send(view.upstream, { type: "tabs", tabs: [{ ...first, active: false }, { ...second, active: true }], timestamp: 4 });
    await h.cli.called("eval", 3);
    send(view.upstream, { type: "tabs", tabs: [{ ...second, url: "https://example.org/next", active: true }], timestamp: 5 });
    await h.cli.called("eval", 4);
    await unchanged(4);
  });

  it("does not read the page for an address of the stream it already sent", async () => {
    const h = await createHarness();
    h.cli.answers.page = () => page(1280, 720, "https://example.com/");
    const view = await h.openView((await h.createSession()).id);
    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1280, height: 720 });

    send(view.upstream, { type: "url", url: "https://example.com/" });
    await handled(view.upstream);

    expect(h.cli.count("eval")).toBe(1);
  });

  it("does not read the page twice at once", async () => {
    const h = await createHarness();
    const pageRead = deferred<BrowserCommandResult>();
    h.cli.answers.page = () => pageRead.promise;
    const view = await h.openView((await h.createSession()).id);

    send(view.upstream, { type: "tabs", tabs: [] });
    send(view.upstream, { type: "url", url: "https://example.com/" });
    send(view.upstream, { type: "frame", seq: 1, data: "QQ==" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });
    // Both asked for a read while the one from the stream's opening was still running.
    expect(h.cli.count("eval")).toBe(1);

    pageRead.resolve(page(1280, 720, "https://example.com/"));
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1280, height: 720 });
  });

  it("sends the address but no viewport for a page without a size", async () => {
    const h = await createHarness();
    h.cli.answers.page = () => page(0, 0, "about:blank");
    const view = await h.openView((await h.createSession()).id);

    send(view.upstream, { type: "frame", seq: 1, data: "QQ==" });

    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "about:blank" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });
  });

  it("reads the page again every 30 seconds, and each read counts as a use of the session", async () => {
    const h = await createHarness();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T0);
    const session = await h.createSession();
    h.cli.answers.page = () => page(1280, 720, "https://example.com/");
    const view = await h.openView(session.id);
    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/" });
    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1280, height: 720 });
    expect(h.cli.count("eval")).toBe(1);

    h.cli.answers.page = () => page(1024, 768, "https://example.com/");
    vi.advanceTimersByTime(29_999);
    expect(h.cli.count("eval")).toBe(1);
    vi.advanceTimersByTime(1);

    expect(await view.client.inbox.next()).toStrictEqual({ type: "viewport", width: 1024, height: 768 });
    expect(h.cli.count("eval")).toBe(2);
    expect(h.store.getSession(session.id)?.lastUsedAt).toBe(T0 + 30_000);

    // A closed view stops reading the page.
    view.client.socket.close();
    await view.upstream.inbox.closed;
    vi.advanceTimersByTime(60_000);
    expect(h.cli.count("eval")).toBe(2);
  });
});

describe("BrowserLiveGateway closing", () => {
  it("tells every view of a session that the session ended when the store closes it, then closes them", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const other = await h.createSession();
    const first = await h.openView(session.id);
    const second = await h.openView(session.id);
    const unrelated = await h.openView(other.id);

    await expect(h.store.closeSession(session.id, OWNER)).resolves.toEqual({ ok: true });

    for (const view of [first, second]) {
      expect(await view.client.inbox.next()).toStrictEqual(closed("session_ended", "The browser session has ended."));
      expect(await view.client.inbox.closed).toEqual({ code: 1000, reason: "session_ended" });
      expect(view.client.inbox.unread).toBe(0);
      await view.upstream.inbox.closed;
    }
    send(unrelated.upstream, { type: "frame", seq: 1, data: "QQ==" });
    expect(await unrelated.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });
  });

  it.each([
    ["its chat closes it", (h: Harness, session: BrowserSessionRecord): Promise<unknown> => h.store.closeSession(session.id, OWNER)],
    ["it expires as idle", (h: Harness): Promise<unknown> => h.store.sweepIdleSessions(Date.now() + BROWSER_SESSION_IDLE_TIMEOUT_MS)],
    ["the Bridge closes every session", (h: Harness): Promise<unknown> => h.store.closeAll()],
  ])("ends a session's views before its browser is closed, when %s", async (_name, close) => {
    const { streams, connectStream } = recordingStreams();
    const h = await createHarness({ connectStream });
    const session = await h.createSession();
    const view = await h.openView(session.id);
    const browserMayClose = deferred();
    /** The gateway's end of each stream at the moment the browser is told to close. */
    const streamStatesAtClose = deferred<number[]>();
    h.browsers.answers.shutdown = async () => {
      streamStatesAtClose.resolve(streams.map((stream) => stream.readyState));
      await browserMayClose.promise;
      return successfulShutdown();
    };

    const closing = close(h, session);

    expect(await streamStatesAtClose.promise).toEqual([WebSocket.CLOSING]);
    // The view is told, and closed, while the browser is still open.
    expect(await view.client.inbox.next()).toStrictEqual(closed("session_ended", "The browser session has ended."));
    expect(await view.client.inbox.closed).toEqual({ code: 1000, reason: "session_ended" });
    await view.upstream.inbox.closed;
    expect(h.store.getSession(session.id)).toBeDefined();

    browserMayClose.resolve();
    await closing;
    expect(h.store.getSession(session.id)).toBeUndefined();
    expect(h.browsers.shutdowns.at(-1)).toBe(session.browserTarget.sessionName);
  });

  it("tells the view that the stream ended when the browser's stream closes, then closes it", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    view.upstream.socket.close();

    expect(await view.client.inbox.next()).toStrictEqual(closed("stream_ended", "The browser was closed."));
    expect(await view.client.inbox.closed).toEqual({ code: 1000, reason: "stream_ended" });
    expect(view.client.inbox.unread).toBe(0);
  });

  it("tells the view that the stream ended when the browser's stream cannot be opened", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    h.refuseUpstream();

    const client = await h.open(h.liveUrl(ticket));

    expect(await client.inbox.next()).toStrictEqual(closed("stream_ended", "The browser's live stream failed."));
    expect(await client.inbox.closed).toEqual({ code: 1000, reason: "stream_ended" });
  });

  it("tells every view that the Bridge is restarting on shutdown, closes them, and opens no more", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const other = await h.createSession();
    const views = [await h.openView(session.id), await h.openView(session.id), await h.openView(other.id)];
    const ticket = await h.gateway.createTicket(session.id);

    h.gateway.shutdown();

    for (const view of views) {
      expect(await view.client.inbox.next()).toStrictEqual(closed("session_ended", "The Bridge is restarting."));
      expect(await view.client.inbox.closed).toEqual({ code: 1000, reason: "session_ended" });
      expect(view.client.inbox.unread).toBe(0);
      await view.upstream.inbox.closed;
    }
    await expect(h.connect(h.liveUrl(ticket))).resolves.toEqual({ status: expect.any(Number) });
  });

  it("closes the view as unavailable when the browser can no longer stream once the socket is open", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    h.cli.answers.status = () => ({ ok: false, output: "error: unrecognized subcommand 'stream'" });

    const client = await h.open(h.liveUrl(ticket));

    expect(await client.inbox.next()).toStrictEqual({
      type: "closed",
      reason: "unavailable",
      message: expect.stringContaining("agent-browser"),
    });
    expect(await client.inbox.closed).toEqual({ code: 1000, reason: "unavailable" });
    expect(h.upstreamConnections.size).toBe(0);
  });

  it("closes the view as ended when the session was closed between the ticket and the socket", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    await h.store.closeSession(session.id, OWNER);
    const statusCalls = h.cli.count("stream status");

    const client = await h.open(h.liveUrl(ticket));

    expect(await client.inbox.next()).toStrictEqual(closed("session_ended", "The browser session has ended."));
    expect(await client.inbox.closed).toEqual({ code: 1000, reason: "session_ended" });
    expect(h.cli.count("stream status")).toBe(statusCalls);
    expect(h.upstreamConnections.size).toBe(0);
  });
});
