import { EventEmitter, once } from "node:events";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  BROWSER_LIVE_MODIFIERS,
  BROWSER_LIVE_WS_PATH,
  parseBrowserLiveClientMessage,
  type BrowserLiveClosedMessage,
  type BrowserLiveTab,
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
  liveFileName,
  type BrowserLiveGatewayOptions,
} from "../browser-live.js";
import { BrowserLogins, type BrowserLoginVault, type SignInForm } from "../browser-logins.js";
import { BrowserSessionStore, type BrowserSessionRecord } from "../browser-session-store.js";
import type { TelemetryStore } from "../telemetry-store.js";
import { FakeChrome } from "./fake-chrome.js";
import { makeTestDir } from "./helpers.js";

const T0 = Date.parse("2026-01-15T12:00:00.000Z");
const OWNER = "chat-session-1";
const NOT_FOUND = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

const ALL_MODIFIERS = BROWSER_LIVE_MODIFIERS.alt | BROWSER_LIVE_MODIFIERS.ctrl
  | BROWSER_LIVE_MODIFIERS.meta | BROWSER_LIVE_MODIFIERS.shift;

type RunCommand = NonNullable<BrowserLiveGatewayOptions["runCommand"]>;
type CliAnswer = BrowserCommandResult | Promise<BrowserCommandResult>;
/** `eval` for a script run in the page, whatever the script; any other command in full, as "tab close t2". */
type CliCommandName = string;
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
  /**
   * Every list of tabs received, in order. They are kept out of `next`, so that a test about
   * the page does not depend on when the view is told its tabs.
   */
  readonly tabLists: BrowserLiveTab[][] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const text = data.toString();
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        message = text;
      }
      const tabs = (message as { type?: unknown; tabs?: unknown } | null)?.type === "tabs"
        ? (message as { tabs?: unknown }).tabs
        : undefined;
      if (Array.isArray(tabs)) this.tabLists.push(tabs as BrowserLiveTab[]);
      else this.messages.push(message);
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
  /** False for a client that does not answer the gateway's pings. */
  autoPong?: boolean;
}

function successfulShutdown() {
  return { ok: true, closeOk: true, terminatedPids: [], killedPids: [], remainingPids: [], clearedRuntimeFiles: 0 };
}

/** What `eval` answers for the gateway's page script: the script's JSON text. */
function page(width: number, height: number, url: string, title = ""): BrowserCommandResult {
  return { ok: true, output: JSON.stringify([width, height, url, title]) };
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

/**
 * A view's own timers (its reads of the page, its pings, its idle limit) then run only when a
 * test lets time pass. Call it before the view is opened. Sockets stay real.
 */
function freezeViewTimers(): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"], now: T0 });
}

/**
 * Lets time pass for a view opened after `freezeViewTimers`, at most ten seconds at a time, and
 * gives its client the chance to answer each ping the gateway sent meanwhile, as a real one does.
 */
async function elapse(view: View, ms: number): Promise<void> {
  const client = view.client;
  for (let left = ms; left > 0; left -= 10_000) {
    await vi.advanceTimersByTimeAsync(Math.min(left, 10_000));
    // The first round trip ends after the client has seen the ping, the second after the gateway has its answer.
    for (let round = 0; round < 2; round++) await Promise.race([handled(client), client.inbox.closed]);
  }
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

const TOOLBAR_COMMANDS: ReadonlySet<string> = new Set(["open", "back", "forward", "reload", "tab"]);

/** Whether an `eval` runs the script that reads a sign-in form's fields, not the page script. */
function readsSignInForm(command: readonly string[]): boolean {
  return Buffer.from(command[2] ?? "", "base64").toString("utf-8").includes("password.bridgePassword = true");
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
    /** `eval` for the script that reads what a sign-in form holds. */
    signInForm: (): CliAnswer => ({ ok: true, output: "null" }),
    /** `get cdp-url`: where the browser's DevTools endpoint is. */
    devTools: (): CliAnswer => ({ ok: false, output: "The browser has no DevTools address." }),
    /** For what a viewer's toolbar asks of the browser: an address, a step in history, a tab. */
    toolbar: (_command: string[]): CliAnswer => ({ ok: true, output: "" }),
    /** How many tabs `tab list` finds. */
    tabCount: (): number | Promise<number> => 1,
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
    if (name === "eval" && readsSignInForm(command)) return answers.signInForm();
    if (name === "eval") return answers.page();
    if (name === "stream status") return answers.status();
    if (name === "stream enable") return answers.enable();
    if (name === "get cdp-url") return answers.devTools();
    if (name === "tab list") {
      const tabs = Array.from({ length: await answers.tabCount() }, (_unused, index) => ({ tabId: `t${index + 1}` }));
      return { ok: true, output: "", data: { tabs } };
    }
    if (TOOLBAR_COMMANDS.has(command[0])) return answers.toolbar([...command]);
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
    /** What was run for a viewer's toolbar, in order. */
    toolbarCommands: (): string[] => calls
      .filter((call) => TOOLBAR_COMMANDS.has(call.command[0]) && nameOf(call.command) !== "tab list")
      .map((call) => nameOf(call.command)),
    /** The telemetry store each run of the command was given. */
    telemetryOf: (name: CliCommandName): unknown[] => calls
      .filter((call) => nameOf(call.command) === name)
      .map((call) => call.options.telemetryStore),
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
async function createHarness(options: Pick<BrowserLiveGatewayOptions, "connectStream" | "telemetryStore" | "filesDir" | "logins"> = {}) {
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

describe("BrowserLiveGateway file choosers", () => {
  const chrome = new FakeChrome();
  const GONE = "The page is no longer asking for a file. Use its button again.";

  afterEach(() => chrome.reset());
  afterAll(() => {
    chrome.server.close();
  });

  /** A view of a browser whose pages hand their file choosers to the gateway. */
  async function openFileView() {
    const filesDir = makeTestDir("browser-live-files");
    // What an earlier run of the Bridge left behind.
    await mkdir(join(filesDir, "bs_before"), { recursive: true });
    const h = await createHarness({ filesDir });
    h.cli.answers.devTools = () => ({ ok: true, output: "", data: { cdpUrl: chrome.url } });
    const session = await h.createSession();
    const view = await h.openView(session.id);
    await vi.waitFor(() => expect(chrome.sent("Page.setInterceptFileChooserDialog")).toHaveLength(2));
    /** The page opens a chooser, and the viewer is told. */
    const choose = async (mode = "selectSingle"): Promise<{ type: string; id: string; multiple: boolean; accept?: string }> => {
      chrome.event("Page.fileChooserOpened", { mode, backendNodeId: 14 }, "frame");
      return await view.client.inbox.next() as { type: string; id: string; multiple: boolean; accept?: string };
    };
    return { h, session, view, filesDir, choose };
  }

  it("asks the viewer for the files of a chooser a page opened, and gives the page what was received", async () => {
    chrome.attributes = ["type", "file", "accept", "image/*"];
    const { h, session, filesDir, choose } = await openFileView();

    const asked = await choose("selectMultiple");
    expect(asked).toStrictEqual({ type: "file_chooser", id: expect.stringMatching(/^[0-9a-f]{32}$/), multiple: true, accept: "image/*" });

    const claim = await h.gateway.claimFileChooser(asked.id);
    expect(claim).toStrictEqual({ folder: expect.stringContaining(join(filesDir, session.id, "files-")), multiple: true });
    // The folder is the gateway's alone: what was there before it started is gone.
    await expect(readdir(filesDir)).resolves.toEqual([session.id]);
    // One upload at a time for a chooser.
    await expect(h.gateway.claimFileChooser(asked.id)).resolves.toBeUndefined();
    const photo = join(claim!.folder, "photo.jpg");
    await writeFile(photo, "photo");

    await expect(h.gateway.chooseFiles(asked.id, [photo])).resolves.toEqual({ ok: true, value: undefined });

    expect(chrome.sent("DOM.setFileInputFiles", (params) => `${params.backendNodeId} ${params.files}`)).toEqual([`frame:14 ${photo}`]);
    // The browser reads the file when the page does, so it stays; the chooser is answered.
    await expect(stat(photo)).resolves.toBeTruthy();
    await expect(h.gateway.claimFileChooser(asked.id)).resolves.toBeUndefined();
    await expect(h.gateway.chooseFiles(asked.id, [photo])).resolves.toEqual({ ok: false, error: GONE });
  });

  it("leaves a chooser open when its files did not arrive, and ends it when the page would not take them", async () => {
    const { h, choose } = await openFileView();
    const asked = await choose();
    expect(asked).toStrictEqual({ type: "file_chooser", id: expect.any(String), multiple: false });

    await h.gateway.claimFileChooser(asked.id);
    h.gateway.releaseFileChooser(asked.id);
    await expect(h.gateway.claimFileChooser(asked.id)).resolves.toMatchObject({ multiple: false });

    // The page moved on meanwhile: Chrome no longer finds the element that asked, and the
    // request is over. Chrome would report success for setting its files all the same.
    chrome.failing = ["DOM.resolveNode"];
    await expect(h.gateway.chooseFiles(asked.id, ["a.jpg"])).resolves.toEqual({ ok: false, error: GONE });
    expect(chrome.sent("DOM.setFileInputFiles")).toEqual([]);
    await expect(h.gateway.claimFileChooser(asked.id)).resolves.toBeUndefined();
  });

  it("keeps only the latest chooser of a view, and none once the view is over", async () => {
    const { h, view, choose } = await openFileView();
    const first = await choose();
    const second = await choose();

    await expect(h.gateway.claimFileChooser(first.id)).resolves.toBeUndefined();
    await expect(h.gateway.claimFileChooser(second.id)).resolves.toBeDefined();
    // While files are on their way, a tap that opens another chooser changes nothing. The
    // gateway has dealt with it by the time it asks about the tab Chrome announces after it.
    chrome.event("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 15 }, "page");
    chrome.event("Target.attachedToTarget", { sessionId: "popup", targetInfo: { type: "page" } });
    await vi.waitFor(() => expect(chrome.sent("Page.enable")).toContain("popup:"));
    expect(chrome.sent("DOM.describeNode")).toHaveLength(2);
    expect(view.client.inbox.unread).toBe(0);

    view.client.socket.close(1000);
    await view.upstream.inbox.closed;
    // The files on their way have no page to go to, and the browser's pages show their own choosers again.
    await expect(h.gateway.chooseFiles(second.id, ["a.jpg"])).resolves.toEqual({ ok: false, error: GONE });
    await chrome.disconnected();
    expect(chrome.sent("Page.setInterceptFileChooserDialog", (params) => params.enabled).filter((sent) => sent.endsWith("false")))
      .toEqual(["page:false", "frame:false", "popup:false"]);
  });

  it("removes a session's files when the session closes", async () => {
    const { h, session, filesDir, choose } = await openFileView();
    const claim = await h.gateway.claimFileChooser((await choose()).id);
    await writeFile(join(claim!.folder, "photo.jpg"), "photo");

    await h.store.closeSession(session.id, OWNER);

    await vi.waitFor(async () => expect(await readdir(filesDir)).toEqual([]));
  });

  it("counts a view as in use while files for its chooser are being received", async () => {
    freezeViewTimers();
    const { h, view, choose } = await openFileView();
    const asked = await choose();
    await elapse(view, 9 * 60_000);

    // A large file over a slow connection takes longer than a view may sit unused.
    await h.gateway.claimFileChooser(asked.id);
    await elapse(view, 12 * 60_000);
    expect(view.client.socket.readyState).toBe(WebSocket.OPEN);

    // The end of the upload is a use of the view like any other.
    h.gateway.releaseFileChooser(asked.id);
    await elapse(view, 9 * 60_000);
    expect(view.client.socket.readyState).toBe(WebSocket.OPEN);
    await elapse(view, 64_000);
    expect(await view.client.inbox.next()).toMatchObject({ type: "closed", message: expect.stringContaining("nobody used it") });
  });

  it("offers no file choosing without a folder for the files, or when the browser's DevTools cannot be reached", async () => {
    const withoutFolder = await createHarness();
    await withoutFolder.openView((await withoutFolder.createSession()).id);
    expect(withoutFolder.cli.commands()).not.toContain("get cdp-url");

    const unreachable = await createHarness({ filesDir: makeTestDir("browser-live-files") });
    unreachable.cli.answers.devTools = () => ({ ok: true, output: "", data: { cdpUrl: "ws://203.0.113.7:9222/devtools/browser/x" } });
    const view = await unreachable.openView((await unreachable.createSession()).id);
    await unreachable.cli.called("get cdp-url", 1);
    // The view itself works as before.
    send(view.upstream, { type: "frame", seq: 1, data: "QQ==" });
    expect(await view.client.inbox.next()).toMatchObject({ type: "frame" });
    expect(chrome.requests).toEqual([]);
  });
});

describe("liveFileName", () => {
  it("keeps a file's own name, without a folder, and tells files of one name apart", () => {
    const taken = new Set<string>();

    expect([
      "Photo.JPG", "photo.jpg", "../../etc/passwd", "C:\\Users\\tim\\été 2026.png", "..", "", "notes", "notes", "a<b>:c?.txt",
    ].map((name) => liveFileName(name, taken))).toEqual([
      "Photo.JPG", "photo (1).jpg", "passwd", "été 2026.png", "file", "file (1)", "notes", "notes (1)", "a_b__c_.txt",
    ]);
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
      // agent-browser echoes what it runs, scripts included.
      { type: "command", action: "evaluate", script: "document.cookie" },
      { type: "result", success: true, data: "session=1" },
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
    expect(view.client.inbox.tabLists).toEqual([]);
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

  it("drops input, and what the toolbar asks for, that arrives before the browser's stream is open", async () => {
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
    send(client, { type: "reload" });
    await handled(client);

    releaseStatus();
    const upstream = await h.upstreamConnections.next();
    await h.cli.called("eval", 1);
    send(client, { type: "ack", seq: 1 });

    expect(await upstream.inbox.next()).toStrictEqual({ type: "ack", seq: 1 });
    expect(h.cli.toolbarCommands()).toEqual([]);
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

describe("BrowserLiveGateway saved logins", () => {
  const FORM: SignInForm = { url: "https://accounts.example.com/login", username: "tim@example.com", password: "correct horse" };
  const typed = (text: string) => ({ type: "input_keyboard", eventType: "char", text });
  const ENTER = { type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  const formRead = (form: SignInForm): BrowserCommandResult => ({ ok: true, output: JSON.stringify([form.url, form.username, form.password]) });
  const formReads = (h: Harness): number => h.cli.calls.filter((call) => call.command[0] === "eval" && readsSignInForm(call.command)).length;

  function createLogins() {
    const vault = {
      save: vi.fn<BrowserLoginVault["save"]>(async () => ({ ok: true, output: "" })),
      signIn: vi.fn<BrowserLoginVault["signIn"]>(async () => ({ ok: true, output: "" })),
      remove: vi.fn<BrowserLoginVault["remove"]>(async () => ({ ok: true, output: "" })),
    };
    const dir = makeTestDir("browser-live-logins");
    return { vault, logins: new BrowserLogins({ file: join(dir, "browser-logins.json"), scope: dir, vault }) };
  }

  /** Reads what the view is told until it is told about a sign-in. */
  async function nextLogin(view: View): Promise<unknown> {
    for (;;) {
      const message = await view.client.inbox.next();
      if ((message as { type?: unknown }).type === "login") return message;
    }
  }

  it("reads a typed sign-in before the key that submits it reaches the browser, and offers it without the password", async () => {
    const { logins } = createLogins();
    const h = await createHarness({ logins });
    const view = await h.openView((await h.createSession()).id);
    let waitingAtRead: number | undefined;
    h.cli.answers.signInForm = () => {
      waitingAtRead ??= view.upstream.inbox.unread;
      return formRead(FORM);
    };

    send(view.client, typed("pw"));
    expect(await view.upstream.inbox.next()).toStrictEqual(typed("p"));
    expect(await view.upstream.inbox.next()).toStrictEqual(typed("w"));
    send(view.client, ENTER);

    const offer = await nextLogin(view);
    expect(offer).toStrictEqual({ type: "login", state: "save", host: "accounts.example.com", username: "tim@example.com" });
    expect(await view.upstream.inbox.next()).toStrictEqual(ENTER);
    // The page is gone once the key arrives, so the key had not been sent when the form was read.
    expect(waitingAtRead).toBe(0);
    // Reads of a password are recorded nowhere.
    expect(h.cli.calls.filter((call) => readsSignInForm(call.command)).every((call) => call.options.telemetryStore === undefined)).toBe(true);
  });

  it("keeps the offered sign-in when the viewer asks for it, through the session's own browser", async () => {
    const { logins, vault } = createLogins();
    const h = await createHarness({ logins });
    const session = await h.createSession();
    const view = await h.openView(session.id);
    h.cli.answers.signInForm = () => formRead(FORM);
    send(view.client, typed("pw"));
    send(view.client, { type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left" });
    await nextLogin(view);

    send(view.client, { type: "login", action: "save" });

    expect(await nextLogin(view)).toStrictEqual({ type: "login", state: "saved", host: "accounts.example.com", username: "tim@example.com" });
    expect(vault.save).toHaveBeenCalledWith(expect.any(String), { ...FORM, url: "https://accounts.example.com/" }, session.browserTarget);
    expect(await logins.forPage(FORM.url)).toMatchObject({ username: "tim@example.com" });
  });

  it("reads no form for a click or a key when nothing was typed", async () => {
    const { logins } = createLogins();
    const h = await createHarness({ logins });
    const view = await h.openView((await h.createSession()).id);
    const click = { type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left" };

    send(view.client, click);

    expect(await view.upstream.inbox.next()).toStrictEqual(click);
    expect(formReads(h)).toBe(0);
  });

  it("forgets the offer when the viewer opens another address", async () => {
    const { logins } = createLogins();
    const h = await createHarness({ logins });
    const view = await h.openView((await h.createSession()).id);
    h.cli.answers.signInForm = () => formRead(FORM);
    send(view.client, typed("pw"));
    send(view.client, ENTER);
    await nextLogin(view);

    send(view.client, { type: "navigate", url: "https://example.com/" });

    expect(await nextLogin(view)).toStrictEqual({ type: "login", state: "none" });
  });

  it("offers the saved login of a page that shows its form, and signs in with it when asked", async () => {
    const { logins, vault } = createLogins();
    const saved = await logins.save(FORM, { sessionName: "any", profileDir: "any" });
    const h = await createHarness({ logins });
    h.cli.answers.page = () => ({ ok: true, output: JSON.stringify([1280, 720, FORM.url, "Sign in", 1]) });
    const session = await h.createSession();
    const view = await h.openView(session.id);

    expect(await nextLogin(view)).toStrictEqual({ type: "login", state: "fill", host: "accounts.example.com", username: "tim@example.com" });
    send(view.client, { type: "login", action: "fill" });

    await vi.waitFor(() => expect(vault.signIn).toHaveBeenCalledTimes(1));
    expect(vault.signIn).toHaveBeenCalledWith(saved!.id, expect.objectContaining({ browserTarget: session.browserTarget }));
  });

  it("ignores an answer about a sign-in when logins are not kept here", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    send(view.client, { type: "login", action: "save" });
    send(view.client, typed("a"));
    send(view.client, ENTER);

    expect(await view.upstream.inbox.next()).toStrictEqual(typed("a"));
    expect(await view.upstream.inbox.next()).toStrictEqual(ENTER);
    expect(formReads(h)).toBe(0);
  });
});

// What a client sends goes on to the browser's input, so the gateway forwards only what this
// makes of it: the fields the protocol defines, each of the kind it defines.
describe("parseBrowserLiveClientMessage", () => {
  it("accepts the three answers to a sign-in offer and nothing else of that kind", () => {
    for (const action of ["save", "fill", "dismiss"]) {
      expect(parseBrowserLiveClientMessage({ type: "login", action, password: "x" })).toStrictEqual({ type: "login", action });
    }
    for (const action of [undefined, "", "remove", "SAVE", 1, null]) {
      expect(parseBrowserLiveClientMessage({ type: "login", action }), String(action)).toBeUndefined();
    }
  });

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

  it("accepts what a viewer's toolbar asks of the browser, and an address as the browser will open it", () => {
    for (const message of [
      { type: "history", direction: "back" },
      { type: "history", direction: "forward" },
      { type: "reload" },
      { type: "tab", action: "select", tabId: "t1" },
      { type: "tab", action: "close", tabId: "t23" },
      { type: "navigate", url: "http://localhost:3000/a?b=c#d" },
    ]) {
      expect(parse({ ...message, script: "document.cookie", seq: 1 })).toStrictEqual(message);
    }
    expect(parse({ type: "navigate", url: "HTTPS://Example.com" })).toStrictEqual({ type: "navigate", url: "https://example.com/" });
  });

  it("rejects an address that is not a web page's, or is longer than 2048 characters", () => {
    const longest = `https://example.com/${"a".repeat(2028)}`;
    expect(parse({ type: "navigate", url: longest })).toStrictEqual({ type: "navigate", url: longest });
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<p>hi</p>",
      "chrome://settings",
      "about:blank",
      "example.com",
      "",
      `${longest}a`,
      5,
      null,
      undefined,
      ["https://example.com/"],
    ]) {
      expect(parse({ type: "navigate", url }), String(url)).toBeUndefined();
    }
  });

  it("rejects a step in history or a tab message that names anything else than the protocol has", () => {
    for (const direction of [undefined, "", "up", "BACK", -1, ["back"]]) {
      expect(parse({ type: "history", direction }), String(direction)).toBeUndefined();
    }
    for (const action of [undefined, "", "new", "list", "CLOSE", ["close"]]) {
      expect(parse({ type: "tab", action, tabId: "t1" }), String(action)).toBeUndefined();
    }
    // The id goes into an agent-browser command line.
    for (const tabId of [undefined, "", "1", "t", "T1", "t1;rm", "t1 t2", "--help", "t1234567", 1, ["t1"]]) {
      for (const action of ["select", "close"]) {
        expect(parse({ type: "tab", action, tabId }), `${action} ${String(tabId)}`).toBeUndefined();
      }
    }
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
  // A view also reads the page every few seconds. Here that happens only when a test lets time pass.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

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

  it("records no telemetry span for its reads of the page, which are too frequent for one each", async () => {
    const telemetryStore = {} as TelemetryStore;
    const h = await createHarness({ telemetryStore });
    const view = await h.openView((await h.createSession()).id);

    send(view.client, { type: "reload" });
    await h.cli.called("eval", 2);

    expect(h.cli.telemetryOf("reload")).toEqual([telemetryStore]);
    expect(h.cli.telemetryOf("eval")).toEqual([undefined, undefined]);
  });
});

describe("BrowserLiveGateway reading the page over time", () => {
  const TWO_TABS = [
    { tabId: "t1", targetId: "A", title: "Example", url: "https://example.com/", active: true },
    { tabId: "t2", targetId: "B", title: "Other", url: "https://example.org/", active: false },
  ];

  it("reads the page every 4 seconds while input was recent or several tabs are open, and otherwise every 30 seconds", async () => {
    freezeViewTimers();
    const h = await createHarness();
    const session = await h.createSession();
    h.cli.answers.page = () => page(1280, 720, "https://example.com/");
    const view = await h.openView(session.id);
    expect(h.cli.count("eval")).toBe(1);

    // Nobody has done anything in the view yet, so nothing in it can have opened a tab.
    await elapse(view, 28_000);
    expect(h.cli.count("eval")).toBe(1);
    await elapse(view, 4_000);
    expect(h.cli.count("eval")).toBe(2);
    // Each read counts as a use of the session.
    expect(h.store.getSession(session.id)?.lastUsedAt).toBe(T0 + 32_000);

    // Something was done in it: every 4 seconds for the next 20.
    send(view.client, { type: "input_mouse", eventType: "mouseMoved", x: 1, y: 1 });
    await view.upstream.inbox.next();
    await elapse(view, 3_999);
    expect(h.cli.count("eval")).toBe(2);
    await elapse(view, 1);
    expect(h.cli.count("eval")).toBe(3);
    await elapse(view, 12_000);
    expect(h.cli.count("eval")).toBe(6);

    // Then no read for the next 28 seconds, and one soon after.
    await elapse(view, 28_000);
    expect(h.cli.count("eval")).toBe(6);
    await elapse(view, 4_000);
    expect(h.cli.count("eval")).toBe(7);

    // A second tab can close, or a third open, without anything being done in the view.
    send(view.upstream, { type: "tabs", tabs: TWO_TABS });
    await h.cli.called("eval", 8);
    await elapse(view, 8_000);
    expect(h.cli.count("eval")).toBe(10);

    // A closed view stops reading the page.
    view.client.socket.close(1000);
    await view.upstream.inbox.closed;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.cli.count("eval")).toBe(10);
  });

  it.each([
    ["the end of a click", { type: "input_mouse", eventType: "mouseReleased", x: 1, y: 1, button: "left", clickCount: 1 }, true],
    ["a key going up", { type: "input_keyboard", eventType: "keyUp", key: "Enter" }, true],
    ["typed text", { type: "input_keyboard", eventType: "char", text: "a" }, true],
    ["the pointer moving", { type: "input_mouse", eventType: "mouseMoved", x: 1, y: 1 }, false],
    ["the start of a click", { type: "input_mouse", eventType: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 }, false],
    ["a key going down", { type: "input_keyboard", eventType: "keyDown", key: "Enter" }, false],
  ])("after %s, reads the page 600 ms and 2.5 s later: %s", async (_name, input, reads) => {
    freezeViewTimers();
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    send(view.client, input);
    await view.upstream.inbox.next();
    await vi.advanceTimersByTimeAsync(599);
    expect(h.cli.count("eval")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.cli.count("eval")).toBe(reads ? 2 : 1);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(h.cli.count("eval")).toBe(reads ? 3 : 1);
  });

  it("waits for the last of several clicks and keys before it reads the page", async () => {
    freezeViewTimers();
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);
    const typed = { type: "input_keyboard", eventType: "char", text: "a" };

    send(view.client, typed);
    await view.upstream.inbox.next();
    await vi.advanceTimersByTimeAsync(599);
    send(view.client, typed);
    await view.upstream.inbox.next();
    await vi.advanceTimersByTimeAsync(599);
    expect(h.cli.count("eval")).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.cli.count("eval")).toBe(2);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(h.cli.count("eval")).toBe(3);
  });

  it("closes a view nobody has used for 10 minutes, where acks are not a use of it", async () => {
    freezeViewTimers();
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    await elapse(view, 5 * 60_000);
    send(view.client, { type: "input_mouse", eventType: "mouseMoved", x: 1, y: 1 });
    expect(await view.upstream.inbox.next()).toMatchObject({ type: "input_mouse" });
    await elapse(view, 7 * 60_000);
    send(view.client, { type: "ack", seq: 1 });
    expect(await view.upstream.inbox.next()).toStrictEqual({ type: "ack", seq: 1 });
    // Ten minutes after it was opened and not yet ten after the pointer moved.
    await elapse(view, 2 * 60_000);
    expect(view.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(view.client.inbox.unread).toBe(0);

    await elapse(view, 64_000);

    expect(await view.client.inbox.next()).toStrictEqual({
      type: "closed",
      reason: "stream_ended",
      message: expect.stringContaining("nobody used it"),
    });
    expect(await view.client.inbox.closed).toEqual({ code: 1000, reason: "stream_ended" });
    await view.upstream.inbox.closed;
  });

  it("ends a view whose client no longer answers its pings, and keeps one whose client does", async () => {
    freezeViewTimers();
    const h = await createHarness();
    const session = await h.createSession();
    const answering = await h.openView(session.id);
    const silent = await h.openView(session.id, { autoPong: false });

    await elapse(answering, 20_000);
    expect(silent.client.socket.readyState).toBe(WebSocket.OPEN);
    await elapse(answering, 20_000);

    // Not a close the gateway and the client agreed on: the connection is cut.
    expect((await silent.client.inbox.closed).code).toBe(1006);
    await silent.upstream.inbox.closed;
    send(answering.upstream, { type: "frame", seq: 1, data: "QQ==" });
    expect(await answering.client.inbox.next()).toStrictEqual({ type: "frame", seq: 1, data: "QQ==" });
  });
});

describe("BrowserLiveGateway toolbar", () => {
  // The page is read after each command. Its other reads happen only when a test lets time pass.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  it.each([
    ["opens an address", { type: "navigate", url: "https://example.com/next" }, "open https://example.com/next"],
    ["goes back", { type: "history", direction: "back" }, "back"],
    ["goes forward", { type: "history", direction: "forward" }, "forward"],
    ["reloads", { type: "reload" }, "reload"],
    ["shows another tab", { type: "tab", action: "select", tabId: "t2" }, "tab t2"],
  ])("%s in the browser and reads the page again", async (_name, message, command) => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);
    h.cli.answers.page = () => page(1280, 720, "https://example.com/next");

    send(view.client, message);

    expect(await view.client.inbox.next()).toStrictEqual({ type: "url", url: "https://example.com/next" });
    expect(h.cli.toolbarCommands()).toEqual([command]);
  });

  it.each([
    ["closes a tab while another is open", 2, ["tab close t2"]],
    ["does not close the last tab", 1, []],
  ])("%s", async (_name, tabCount, commands) => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);
    h.cli.answers.tabCount = () => tabCount;

    send(view.client, { type: "tab", action: "close", tabId: "t2" });
    await h.cli.called("eval", 2);

    expect(h.cli.toolbarCommands()).toEqual(commands);
  });

  it("runs a command while the browser is the user's, when an agent's own operations are refused", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const handBack = h.broker.holdTarget(leaseOf(session), "Sign in to the store");
    const view = await h.openView(session.id);

    send(view.client, { type: "reload" });
    await h.cli.called("eval", 2);

    expect(h.cli.toolbarCommands()).toEqual(["reload"]);
    handBack();
  });

  it.each([
    [
      "waiting for the browser",
      { type: "reload" },
      (h: Harness, session: BrowserSessionRecord, view: View) => {
        const done = deferred();
        void h.broker.withTarget(leaseOf(session), { toolName: "test", browserOpId: "op-1", skipReadiness: true }, () => done.promise);
        return { underWay: () => handled(view.client), carryOn: () => done.resolve() };
      },
    ],
    [
      "finding out whether its tab is the last one",
      { type: "tab", action: "close", tabId: "t2" },
      (h: Harness) => {
        const listed = deferred<number>();
        h.cli.answers.tabCount = () => listed.promise;
        return { underWay: () => h.cli.called("tab list", 1), carryOn: () => listed.resolve(2) };
      },
    ],
  ])("does not run a command that was still %s when the view ended", async (_name, message, holdUp) => {
    const h = await createHarness();
    const session = await h.createSession();
    const view = await h.openView(session.id);
    const held = holdUp(h, session, view);

    send(view.client, message);
    await held.underWay();
    view.client.socket.close(1000);
    await view.upstream.inbox.closed;
    held.carryOn();
    // The browser runs one operation at a time, so this one comes after what was held up.
    await h.broker.withTarget(leaseOf(session), { toolName: "test", browserOpId: "op-2", skipReadiness: true }, async () => undefined);

    expect(h.cli.toolbarCommands()).toEqual([]);
  });

  it("runs one command at a time and then only the last of those asked for meanwhile, without holding up input", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const view = await h.openView(session.id);
    const loaded = deferred<BrowserCommandResult>();
    h.cli.answers.toolbar = (command) => (command[1] === "https://example.com/slow" ? loaded.promise : { ok: true, output: "" });
    const move = { type: "input_mouse", eventType: "mouseMoved", x: 10, y: 20 };

    send(view.client, { type: "navigate", url: "https://example.com/slow" });
    await h.cli.called("open https://example.com/slow", 1);
    send(view.client, { type: "reload" });
    send(view.client, { type: "history", direction: "back" });
    send(view.client, { type: "navigate", url: "https://example.com/last" });
    send(view.client, move);

    // The page is there to be clicked while it loads.
    expect(await view.upstream.inbox.next()).toStrictEqual(move);
    // The session is not closed under a command.
    await expect(h.store.closeSession(session.id, OWNER)).resolves.toEqual({ ok: false, error: "Browser session is busy" });
    expect(h.cli.toolbarCommands()).toEqual(["open https://example.com/slow"]);

    loaded.resolve({ ok: true, output: "" });
    // The page is read after each of the two commands that ran.
    await h.cli.called("eval", 3);
    expect(h.cli.toolbarCommands()).toEqual(["open https://example.com/slow", "open https://example.com/last"]);
  });
});

describe("BrowserLiveGateway tabs", () => {
  // The page is read every few seconds only when a test lets time pass.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  const tab = (number: number, fields: Record<string, unknown> = {}) => ({
    tabId: `t${number}`,
    targetId: `target-${number}`,
    title: `Tab ${number}`,
    url: `https://example.com/${number}`,
    active: number === 1,
    ...fields,
  });
  /** What a view is told about `tab(number)`. */
  const told = (number: number, fields: Partial<BrowserLiveTab> = {}): BrowserLiveTab => ({
    id: `t${number}`,
    title: `Tab ${number}`,
    url: `https://example.com/${number}`,
    active: number === 1,
    ...fields,
  });
  /** Resolves once the view has everything the gateway made of what the stream sent so far. */
  const relayed = async (view: View): Promise<void> => {
    await handled(view.upstream);
    await handled(view.client);
  };

  it("tells the view the browser's tabs when they change: at most 20, with titles of at most 200 characters", async () => {
    const h = await createHarness();
    const view = await h.openView((await h.createSession()).id);

    send(view.upstream, { type: "tabs", tabs: [tab(1), tab(2, { title: "x".repeat(300) })], timestamp: 1 });
    send(view.upstream, { type: "tabs", tabs: [tab(1), tab(2, { title: "x".repeat(300) })], timestamp: 2 });
    await relayed(view);
    expect(view.client.inbox.tabLists).toStrictEqual([[told(1), told(2, { title: "x".repeat(200) })]]);

    send(view.upstream, { type: "tabs", tabs: Array.from({ length: 25 }, (_unused, index) => tab(index + 1)), timestamp: 3 });
    await relayed(view);
    expect(view.client.inbox.tabLists).toHaveLength(2);
    expect(view.client.inbox.tabLists[1]).toStrictEqual(Array.from({ length: 20 }, (_unused, index) => told(index + 1)));
  });

  /**
   * A view of a browser whose one tab, `tab(1)`, has been read twice since it was on show, and
   * what the view is told about that tab.
   */
  async function openOnFirstTab() {
    // Longer than the address a view is told.
    const address = `https://example.com/1/now?${"q".repeat(2_100)}`;
    const h = await createHarness();
    h.cli.answers.page = () => page(1280, 720, address, "Tab 1 now");
    const view = await h.openView((await h.createSession()).id);
    send(view.upstream, { type: "tabs", tabs: [tab(1)] });
    await h.cli.called("eval", 2);
    // The page is read again soon only while the view is in use.
    send(view.client, { type: "input_mouse", eventType: "mouseMoved", x: 1, y: 1 });
    await view.upstream.inbox.next();
    await vi.advanceTimersByTimeAsync(4_000);
    await h.cli.called("eval", 3);
    await relayed(view);
    return { h, view, readNow: told(1, { title: "Tab 1 now", url: address.slice(0, 2_048) }) };
  }
  const SECOND_SHOWN = [tab(1, { active: false }), tab(2, { active: true })];

  it("describes the tab on show by what the page says now, and a tab no longer on show by what two reads in a row found in it", async () => {
    // agent-browser's own title and address of a tab are those it had when the tab was first seen.
    const { h, view, readNow } = await openOnFirstTab();
    expect(view.client.inbox.tabLists.at(-1)).toStrictEqual([readNow]);

    const secondRead = deferred<BrowserCommandResult>();
    h.cli.answers.page = () => secondRead.promise;
    send(view.upstream, { type: "tabs", tabs: SECOND_SHOWN });
    await h.cli.called("eval", 4);
    await relayed(view);
    // What was read in the first tab says nothing about the second.
    expect(view.client.inbox.tabLists.at(-1)).toStrictEqual([{ ...readNow, active: false }, told(2, { active: true })]);

    secondRead.resolve(page(1280, 720, "https://example.com/2/now", "Tab 2 now"));
    await relayed(view);
    expect(view.client.inbox.tabLists.at(-1)).toStrictEqual([
      { ...readNow, active: false },
      told(2, { title: "Tab 2 now", url: "https://example.com/2/now", active: true }),
    ]);
  });

  it("does not describe a tab no longer on show by what a later read of it found changed", async () => {
    const { h, view } = await openOnFirstTab();
    h.cli.answers.page = () => page(1280, 720, "https://example.com/1/later", "Tab 1 later");
    await vi.advanceTimersByTimeAsync(4_000);
    await h.cli.called("eval", 4);
    await relayed(view);
    expect(view.client.inbox.tabLists.at(-1)).toStrictEqual([told(1, { title: "Tab 1 later", url: "https://example.com/1/later" })]);

    h.cli.answers.page = () => page(1280, 720, "https://example.com/2/now", "Tab 2 now");
    send(view.upstream, { type: "tabs", tabs: SECOND_SHOWN });
    await h.cli.called("eval", 5);
    await relayed(view);

    // One read is not enough to go by, so the first tab is back to what agent-browser says of it.
    expect(view.client.inbox.tabLists.at(-1)).toStrictEqual([
      told(1, { active: false }),
      told(2, { title: "Tab 2 now", url: "https://example.com/2/now", active: true }),
    ]);
  });
});

describe("BrowserLiveGateway.onViewersChanged", () => {
  it("says how many views of a session are open when one opens or ends, and whether the one that ended was cut off", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const changes: Array<[string, number, boolean]> = [];
    h.gateway.onViewersChanged((browserSessionId, viewers, dropped) => changes.push([browserSessionId, viewers, dropped]));

    const views = [await h.openView(session.id), await h.openView(session.id), await h.openView(session.id)];
    // A view that is closed, a page that is left, and a connection that broke.
    const endings = [
      (socket: WebSocket) => socket.close(1000),
      (socket: WebSocket) => socket.close(1001),
      (socket: WebSocket) => socket.terminate(),
    ];
    for (const [index, view] of views.entries()) {
      endings[index](view.client.socket);
      // The gateway closes a view's stream once it has dropped the view.
      await view.upstream.inbox.closed;
    }

    expect(changes).toEqual([
      [session.id, 1, false],
      [session.id, 2, false],
      [session.id, 3, false],
      [session.id, 2, false],
      [session.id, 1, false],
      [session.id, 0, true],
    ]);
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

  it("closes the view as ended when the session was closed between the ticket and the socket, and ignores what its client sent meanwhile", async () => {
    const h = await createHarness();
    const session = await h.createSession();
    const ticket = await h.gateway.createTicket(session.id);
    await h.store.closeSession(session.id, OWNER);
    const statusCalls = h.cli.count("stream status");

    const client = await h.open(h.liveUrl(ticket));
    // What the client sent before it heard is ignored. A listener that throws on it is an
    // uncaught exception in the process.
    send(client, { type: "reload" });
    send(client, { type: "input_mouse", eventType: "mouseReleased", x: 1, y: 1, button: "left", clickCount: 1 });

    expect(await client.inbox.next()).toStrictEqual(closed("session_ended", "The browser session has ended."));
    expect(await client.inbox.closed).toEqual({ code: 1000, reason: "session_ended" });
    expect(h.cli.count("stream status")).toBe(statusCalls);
    expect(h.cli.toolbarCommands()).toEqual([]);
    expect(h.upstreamConnections.size).toBe(0);
  });
});
