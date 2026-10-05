// Live view of a browser session: relays between a Bridge client and the WebSocket stream that
// agent-browser serves for the session, so the user can watch the page and act in it.

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  BROWSER_LIVE_WS_PATH,
  parseBrowserLiveClientMessage,
  type BrowserLiveCheck,
  type BrowserLiveClientMessage,
  type BrowserLiveClosedMessage,
  type BrowserLiveServerMessage,
  type BrowserLiveTicket,
} from "../shared/browser-live.js";
import { ab, type BrowserCommand, type BrowserCommandOptions, type BrowserCommandResult, type BrowserTarget } from "./agent-browser.js";
import type { BrowserBroker } from "./browser-broker.js";
import type { BrowserSessionStore } from "./browser-session-store.js";
import type { TelemetryStore } from "./telemetry-store.js";

/** Long enough to open the socket after asking for it, short enough to be useless if it leaks. */
const TICKET_TTL_MS = 60_000;
const STREAM_COMMAND_TIMEOUT_MS = 10_000;
/** Input messages are tiny; anything larger is not one. */
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
const MAX_CONNECTIONS_PER_SESSION = 3;
const STREAM_MAX_FPS = 15;
/** Text is handed to the browser a character at a time; this many go out before others get a turn. */
const TEXT_BATCH_CHARACTERS = 64;
/** Typing waits while this much is still on its way to the browser. */
const STREAM_BACKLOG_BYTES = 256 * 1024;
/**
 * How often an open live view reads the page's size and address again. Each read also counts as
 * a use of the session, which keeps the browser from being closed as idle while a person is in it.
 */
const PAGE_POLL_MS = 30_000;
const base64 = (script: string): string => Buffer.from(script, "utf-8").toString("base64");
const PAGE_SCRIPT_BASE64 = base64("JSON.stringify([innerWidth, innerHeight, location.href])");
const CHECK_INPUT_ID = "bridge-live-check";
/** A page that is one text box, so that a click anywhere near its corner lands in it. */
const CHECK_PAGE_SCRIPT_BASE64 = base64(
  `document.documentElement.innerHTML = '<body style="margin:0"><input id="${CHECK_INPUT_ID}" style="display:block;width:400px;height:200px"></body>'; 'ready'`,
);
const CHECK_FOCUS_SCRIPT_BASE64 = base64("(document.activeElement && document.activeElement.id) || ''");
const CHECK_VALUE_SCRIPT_BASE64 = base64(`document.getElementById('${CHECK_INPUT_ID}').value`);
const CHECK_TEXT = "ok";
const CHECK_STEP_TIMEOUT_MS = 10_000;
const CHECK_POLL_MS = 250;

/** The session exists but its browser cannot be shown, and why, in words for the user. */
export class BrowserLiveUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserLiveUnavailableError";
  }
}

export class BrowserLiveSessionNotFoundError extends Error {
  constructor(browserSessionId: string) {
    super(`Browser session ${browserSessionId} has ended.`);
    this.name = "BrowserLiveSessionNotFoundError";
  }
}

export interface BrowserLiveGatewayOptions {
  sessions: BrowserSessionStore;
  broker: BrowserBroker;
  telemetryStore?: TelemetryStore;
  runCommand?: (
    command: BrowserCommand,
    timeout: number | undefined,
    options: BrowserCommandOptions,
  ) => Promise<BrowserCommandResult>;
  /** Opens the socket to agent-browser's stream. Tests supply their own. */
  connectStream?: (url: string) => WebSocket;
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function headerValues(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : [value ?? ""])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** A page of another site must not be able to open the view, even with a ticket it got hold of. */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host.toLowerCase();
    return [...headerValues(req.headers["x-forwarded-host"]), ...headerValues(req.headers.host)].includes(host);
  } catch {
    return false;
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  return (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString("utf-8");
}

/** A message of agent-browser's stream, or null for anything that is not a JSON object. */
function parseStreamMessage(data: RawData): { type?: unknown; seq?: unknown; data?: unknown; url?: unknown } | null {
  try {
    const message: unknown = JSON.parse(rawDataToString(data));
    return typeof message === "object" && message !== null ? message : null;
  } catch {
    return null;
  }
}

export class BrowserLiveGateway {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private readonly tickets = new Map<string, { browserSessionId: string; expiresAt: number }>();
  private readonly connections = new Map<string, Set<(message: BrowserLiveClosedMessage) => void>>();
  private readonly sessions: BrowserSessionStore;
  private readonly broker: BrowserBroker;
  private readonly telemetryStore?: TelemetryStore;
  private readonly runCommand: NonNullable<BrowserLiveGatewayOptions["runCommand"]>;
  private readonly connectStream: NonNullable<BrowserLiveGatewayOptions["connectStream"]>;
  private readonly stopListening: () => void;
  private lastCheck: BrowserLiveCheck | undefined;

  constructor(options: BrowserLiveGatewayOptions) {
    this.sessions = options.sessions;
    this.broker = options.broker;
    this.telemetryStore = options.telemetryStore;
    this.runCommand = options.runCommand ?? ((command, timeout, commandOptions) => ab(command, timeout, commandOptions));
    this.connectStream = options.connectStream ?? ((url) => new WebSocket(url, { perMessageDeflate: false }));
    this.stopListening = this.sessions.onSessionClosing((browserSessionId) => {
      this.closeConnections(browserSessionId, {
        type: "closed",
        reason: "session_ended",
        message: "The browser session has ended.",
      });
    });
  }

  /**
   * The loopback port of the stream agent-browser serves for a browser, starting the stream when
   * it is off. Throws BrowserLiveUnavailableError when this agent-browser cannot stream.
   */
  async resolveStreamPort(browserTarget: BrowserTarget): Promise<number> {
    const options: BrowserCommandOptions = {
      browserTarget,
      telemetryStore: this.telemetryStore,
      toolName: "browser_live",
      skipRecovery: true,
    };
    const port = (result: BrowserCommandResult): number | undefined => {
      const value = result.ok && result.data?.enabled !== false ? Number(result.data?.port) : NaN;
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    };
    const status = await this.runCommand(["stream", "status"], STREAM_COMMAND_TIMEOUT_MS, options);
    const running = port(status);
    if (running) return running;
    // Older versions have no `stream` command at all; newer ones answer and may have it off.
    const enabled = status.ok
      ? port(await this.runCommand(["stream", "enable"], STREAM_COMMAND_TIMEOUT_MS, options))
      : undefined;
    if (enabled) return enabled;
    const message = "This Bridge cannot show a live browser: the installed agent-browser has no streaming. "
      + "Update it with: npm install -g agent-browser@latest";
    this.recordCheck(false, message);
    throw new BrowserLiveUnavailableError(message);
  }

  /** What is known about whether live views work here. Undefined until something has shown it. */
  getLastCheck(): BrowserLiveCheck | undefined {
    return this.lastCheck;
  }

  private recordCheck(ok: boolean, message?: string): BrowserLiveCheck {
    this.lastCheck = { ok, checkedAt: new Date().toISOString(), ...(message ? { message } : {}) };
    return this.lastCheck;
  }

  /**
   * Finds out whether a live view would work, on a browser the caller has for itself: the stream
   * sends a picture of the page, and a click and typed text sent through it reach the page. This
   * is everything the Bridge relies on agent-browser's stream for, so it is the check to run
   * after agent-browser was updated. Replaces the page the browser shows.
   */
  async checkStream(browserTarget: BrowserTarget): Promise<BrowserLiveCheck> {
    try {
      await this.runStreamCheck(browserTarget);
      return this.recordCheck(true);
    } catch (error) {
      return this.recordCheck(false, error instanceof Error ? error.message : String(error));
    }
  }

  private async runStreamCheck(browserTarget: BrowserTarget): Promise<void> {
    const options: BrowserCommandOptions = {
      browserTarget,
      telemetryStore: this.telemetryStore,
      toolName: "browser_live_check",
      skipRecovery: true,
    };
    const evaluate = async (script: string): Promise<string> => {
      const result = await this.runCommand(["eval", "-b", script], STREAM_COMMAND_TIMEOUT_MS, options);
      if (!result.ok) throw new Error(`The check could not use the page: ${result.output.slice(0, 200)}`);
      return result.output;
    };
    const port = await this.resolveStreamPort(browserTarget);
    await evaluate(CHECK_PAGE_SCRIPT_BASE64);
    const stream = this.connectStream(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=${STREAM_MAX_FPS}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (message: string) => {
          clearTimeout(timer);
          reject(new Error(message));
        };
        const timer = setTimeout(() => fail("The browser's stream sent no picture of the page."), CHECK_STEP_TIMEOUT_MS);
        stream.on("message", (data) => {
          const frame = parseStreamMessage(data);
          if (frame?.type !== "frame" || typeof frame.seq !== "number" || typeof frame.data !== "string") return;
          clearTimeout(timer);
          resolve();
        });
        stream.on("error", () => fail("The browser's stream could not be opened."));
        stream.on("close", () => fail("The browser's stream closed before it sent a picture of the page."));
      });
      const send = (message: BrowserLiveClientMessage): void => stream.send(JSON.stringify(message));
      const click = { type: "input_mouse", x: 40, y: 40, button: "left", clickCount: 1 } as const;
      send({ type: "input_mouse", eventType: "mouseMoved", x: 40, y: 40 });
      send({ ...click, eventType: "mousePressed" });
      send({ ...click, eventType: "mouseReleased" });
      // The click takes a moment to focus the box, and text typed before then goes nowhere.
      const reaches = async (script: string, expected: string): Promise<boolean> => {
        for (const deadline = Date.now() + CHECK_STEP_TIMEOUT_MS; Date.now() < deadline;) {
          if (await evaluate(script) === expected) return true;
          await new Promise<void>((resolve) => setTimeout(resolve, CHECK_POLL_MS));
        }
        return false;
      };
      if (!await reaches(CHECK_FOCUS_SCRIPT_BASE64, CHECK_INPUT_ID)) {
        throw new Error("A click sent through the browser's stream did not reach the page.");
      }
      for (const character of CHECK_TEXT) send({ type: "input_keyboard", eventType: "char", text: character });
      if (!await reaches(CHECK_VALUE_SCRIPT_BASE64, CHECK_TEXT)) {
        throw new Error("Text typed through the browser's stream did not reach the page.");
      }
    } finally {
      stream.close();
    }
  }

  /**
   * The stream port of a browser session. The session cannot be closed meanwhile and no other
   * operation runs on its browser, so the stream is never started on a browser that is going away.
   */
  private async resolveSessionStreamPort(browserSessionId: string): Promise<number> {
    const held = await this.sessions.holdSession(browserSessionId, (record) => this.broker.withTarget(
      { context: record.context, browserTarget: record.browserTarget, publicSlot: record.publicSlot },
      { toolName: "browser_live", browserOpId: randomBytes(8).toString("hex"), duringHold: true },
      () => this.resolveStreamPort(record.browserTarget),
    ));
    if (!held.ok) throw new BrowserLiveSessionNotFoundError(browserSessionId);
    return held.value;
  }

  /** Permission to open one live view, checked to be possible before it is given. */
  async createTicket(browserSessionId: string): Promise<BrowserLiveTicket> {
    await this.resolveSessionStreamPort(browserSessionId);
    const now = Date.now();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(token);
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAt = now + TICKET_TTL_MS;
    this.tickets.set(token, { browserSessionId, expiresAt });
    return { browserSessionId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Handles live-view upgrades. Returns false when the request is for something else. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://bridge.local");
    } catch {
      return false;
    }
    if (!url.pathname.endsWith(BROWSER_LIVE_WS_PATH)) return false;
    const token = url.searchParams.get("token") ?? "";
    const ticket = this.tickets.get(token);
    // A ticket opens one socket.
    this.tickets.delete(token);
    const browserSessionId = url.searchParams.get("browserSessionId");
    if (!ticket || ticket.expiresAt <= Date.now() || ticket.browserSessionId !== browserSessionId || !isSameOrigin(req)) {
      rejectUpgrade(socket, "403 Forbidden");
      return true;
    }
    if ((this.connections.get(browserSessionId)?.size ?? 0) >= MAX_CONNECTIONS_PER_SESSION) {
      rejectUpgrade(socket, "429 Too Many Requests");
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (client) => {
      void this.serve(browserSessionId, client);
    });
    return true;
  }

  shutdown(): void {
    this.stopListening();
    for (const browserSessionId of [...this.connections.keys()]) {
      this.closeConnections(browserSessionId, {
        type: "closed",
        reason: "session_ended",
        message: "The Bridge is restarting.",
      });
    }
    this.wss.close();
  }

  private closeConnections(browserSessionId: string, message: BrowserLiveClosedMessage): void {
    for (const close of [...(this.connections.get(browserSessionId) ?? [])]) close(message);
  }

  private async serve(browserSessionId: string, client: WebSocket): Promise<void> {
    const send = (message: BrowserLiveServerMessage): void => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    };
    let stream: WebSocket | undefined;
    let pageTimer: NodeJS.Timeout | undefined;
    let pageRead: Promise<void> | undefined;
    let lastViewport = "";
    let lastUrl = "";
    let ended = false;

    const end = (message: BrowserLiveClosedMessage): void => {
      if (ended) return;
      ended = true;
      clearInterval(pageTimer);
      const open = this.connections.get(browserSessionId);
      open?.delete(end);
      if (open?.size === 0) this.connections.delete(browserSessionId);
      send(message);
      client.close(1000, message.reason);
      stream?.close();
    };
    const peers = this.connections.get(browserSessionId) ?? new Set<(message: BrowserLiveClosedMessage) => void>();
    peers.add(end);
    this.connections.set(browserSessionId, peers);

    // Input goes to the browser in the order it came, text a few characters at a time so that a
    // long paste neither holds the server up nor piles up in front of a slow browser.
    let inputTail: Promise<void> = Promise.resolve();
    const forward = async (message: BrowserLiveClientMessage): Promise<void> => {
      const upstream = stream;
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      if (message.type !== "input_keyboard" || message.eventType !== "char" || message.text === undefined) {
        upstream.send(JSON.stringify(message));
        return;
      }
      // Chrome drops a key event that carries more than one character.
      let sent = 0;
      for (const character of message.text) {
        if (ended || upstream.readyState !== WebSocket.OPEN) return;
        upstream.send(JSON.stringify({ type: message.type, eventType: "char", text: character, modifiers: message.modifiers }));
        if (++sent % TEXT_BATCH_CHARACTERS === 0 || upstream.bufferedAmount > STREAM_BACKLOG_BYTES) {
          await new Promise<void>((resolve) => setTimeout(resolve, upstream.bufferedAmount > STREAM_BACKLOG_BYTES ? 50 : 0));
        }
      }
    };
    // Registered before anything is awaited, so that a message sent meanwhile has a listener.
    // Input that arrives before the browser's stream is open has no page to go to and is dropped.
    client.on("message", (data) => {
      let message: BrowserLiveClientMessage | undefined;
      try {
        message = parseBrowserLiveClientMessage(JSON.parse(rawDataToString(data)));
      } catch {
        return;
      }
      if (!message) return;
      if (message.type !== "ack") this.sessions.touch(browserSessionId);
      const accepted = message;
      inputTail = inputTail.then(() => forward(accepted)).catch(() => undefined);
    });
    client.on("close", () => end({ type: "closed", reason: "stream_ended", message: "The live view was closed." }));
    client.on("error", () => end({ type: "closed", reason: "stream_ended", message: "The live view connection failed." }));

    const record = this.sessions.getSession(browserSessionId);
    if (!record) {
      end({ type: "closed", reason: "session_ended", message: "The browser session has ended." });
      return;
    }
    const commandOptions: BrowserCommandOptions = {
      browserTarget: record.browserTarget,
      telemetryStore: this.telemetryStore,
      toolName: "browser_live",
      skipRecovery: true,
    };
    const sendUrl = (url: string): void => {
      if (url === lastUrl) return;
      lastUrl = url;
      send({ type: "url", url });
    };
    let readAgain = false;
    const readPage = (): Promise<void> => {
      if (ended) return Promise.resolve();
      // What prompted this read may have happened after the one under way looked at the page.
      if (pageRead) readAgain = true;
      pageRead ??= (async () => {
        try {
          const result = await this.runCommand(["eval", "-b", PAGE_SCRIPT_BASE64], STREAM_COMMAND_TIMEOUT_MS, commandOptions);
          if (!result.ok || ended) return;
          const [width, height, url] = JSON.parse(result.output) as [number, number, string];
          this.sessions.touch(browserSessionId);
          if (typeof url === "string") sendUrl(url);
          const viewport = `${width}x${height}`;
          if (!(width > 0 && height > 0) || viewport === lastViewport) return;
          lastViewport = viewport;
          send({ type: "viewport", width, height });
        } catch {
          // The page may be navigating; the next read tries again.
        } finally {
          pageRead = undefined;
          if (readAgain) {
            readAgain = false;
            void readPage();
          }
        }
      })();
      return pageRead;
    };

    let port: number;
    try {
      port = await this.resolveSessionStreamPort(browserSessionId);
    } catch (error) {
      end(error instanceof BrowserLiveSessionNotFoundError
        ? { type: "closed", reason: "session_ended", message: "The browser session has ended." }
        : {
            type: "closed",
            reason: "unavailable",
            message: error instanceof Error ? error.message : "The browser cannot be shown.",
          });
      return;
    }
    if (ended) return;

    // One frame at a time, each sent only after the client drew the one before, so a slow
    // connection shows the latest page rather than a growing backlog.
    stream = this.connectStream(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=${STREAM_MAX_FPS}`);
    stream.on("open", () => {
      void readPage();
      pageTimer = setInterval(() => void readPage(), PAGE_POLL_MS);
      pageTimer.unref?.();
    });
    stream.on("message", (data) => {
      const message = parseStreamMessage(data);
      if (!message) return;
      if (message.type === "frame" && typeof message.seq === "number" && typeof message.data === "string") {
        if (!this.lastCheck?.ok) this.recordCheck(true);
        send({ type: "frame", seq: message.seq, data: message.data });
      } else if (message.type === "url" && typeof message.url === "string") {
        sendUrl(message.url);
        void readPage();
      } else if (message.type === "tabs") {
        // Another tab became the visible one; it may have another size and address.
        void readPage();
      }
    });
    stream.on("close", () => end({ type: "closed", reason: "stream_ended", message: "The browser was closed." }));
    stream.on("error", () => end({ type: "closed", reason: "stream_ended", message: "The browser's live stream failed." }));
  }
}
