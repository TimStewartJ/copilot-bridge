// Live view of a browser session: relays between a Bridge client and the WebSocket stream that
// agent-browser serves for the session, so the user can watch the page and act in it.

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  BROWSER_LIVE_WS_PATH,
  isBrowserLivePageCommand,
  parseBrowserLiveClientMessage,
  type BrowserLiveCheck,
  type BrowserLiveClientMessage,
  type BrowserLiveClosedMessage,
  type BrowserLiveLoginActionMessage,
  type BrowserLivePageCommand,
  type BrowserLiveTab,
  type BrowserLiveServerMessage,
  type BrowserLiveTicket,
} from "../shared/browser-live.js";
import { ab, type BrowserCommand, type BrowserCommandOptions, type BrowserCommandResult, type BrowserTarget } from "./agent-browser.js";
import type { BrowserBroker } from "./browser-broker.js";
import { localDevToolsUrl } from "./browser-devtools.js";
import { LoginWatch, parseSignInForm, SIGN_IN_FORM_PRESENT, SIGN_IN_FORM_VALUES_SCRIPT } from "./browser-login-watch.js";
import type { BrowserLogins, SignInForm } from "./browser-logins.js";
import { sessionLease, type BrowserSessionStore } from "./browser-session-store.js";
import { FileChooserWatch, type FileChooser } from "./browser-upload.js";
import type { TelemetryStore } from "./telemetry-store.js";
import { err, ok, type Result } from "./tool-results.js";

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
 * agent-browser notices a tab or popup that opened or closed only when it runs a command, and
 * until then its stream shows the tab it knew. Reading the page (its size and address) is that
 * command, so an open view reads it this often while tabs are likely to change: for a while
 * after input, and while more than one is open. Otherwise it reads at the slow rate.
 */
const PAGE_POLL_MS = 4_000;
const SLOW_PAGE_POLL_MS = 30_000;
const RECENT_INPUT_MS = 20_000;
/**
 * A click or a key press is what opens and closes tabs, so the page is read again this long
 * after the last one, and once more for a tab that took a moment to appear.
 */
const INPUT_FOLLOW_UP_READS_MS = [600, 2_500] as const;
/**
 * A view nobody has touched for this long is closed; it can be opened again. Its reads keep the
 * session in use, and for some sessions the browser is kept from agents while it is on show, so
 * a view left open in a forgotten tab must not last.
 */
const VIEW_IDLE_MS = 10 * 60_000;
/** A connection that does not answer a ping by the next one is gone, whatever the socket says. */
const HEARTBEAT_MS = 20_000;
/** Opening an address waits for the page to load. */
const PAGE_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TABS = 20;
const MAX_TAB_TITLE_LENGTH = 200;
const MAX_TAB_URL_LENGTH = 2_048;
const base64 = (script: string): string => Buffer.from(script, "utf-8").toString("base64");
// The array is turned into text outside the page. A page can replace its own JSON.stringify, and
// with it what the address field of a view shows; it cannot replace its location.
const PAGE_SCRIPT_BASE64 = base64(`[innerWidth, innerHeight, location.href, document.title, ${SIGN_IN_FORM_PRESENT}]`);
const SIGN_IN_FORM_VALUES_SCRIPT_BASE64 = base64(SIGN_IN_FORM_VALUES_SCRIPT);
/** A key or click waits for the form to be read first, so the read gives up soon. */
const SIGN_IN_FORM_READ_TIMEOUT_MS = 1_500;
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

/** A file chooser a page opened under a view, waiting for the files the viewer picks. */
interface PendingFileChooser {
  browserSessionId: string;
  multiple: boolean;
  /** Files for it are being received. A second upload is refused, and its view counts as in use. */
  claimed: boolean;
  setFiles: (paths: readonly string[]) => Promise<void>;
  /** Tells the view that it is being used. */
  used: () => void;
}

const FILE_CHOOSER_GONE = "The page is no longer asking for a file. Use its button again.";

/**
 * A picked file's name as the page will see it: the one it had on the person's device, without
 * a folder, and different from the names in `taken`, which it joins.
 */
export function liveFileName(original: string, taken: Set<string>): string {
  const base = (original.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  const name = base && base !== "." && base !== ".." ? base : "file";
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let count = 0; ; count++) {
    const candidate = count === 0 ? name : `${stem} (${count})${extension}`;
    // Two names that differ only in case are one file on Windows and macOS.
    if (taken.has(candidate.toLowerCase())) continue;
    taken.add(candidate.toLowerCase());
    return candidate;
  }
}

export interface BrowserLiveGatewayOptions {
  sessions: BrowserSessionStore;
  broker: BrowserBroker;
  telemetryStore?: TelemetryStore;
  /**
   * The folder for the files viewers pick for a page's file chooser; it is the gateway's alone
   * and emptied when the gateway starts. Without it a view offers no file choosing.
   */
  filesDir?: string;
  runCommand?: (
    command: BrowserCommand,
    timeout: number | undefined,
    options: BrowserCommandOptions,
  ) => Promise<BrowserCommandResult>;
  /** Opens the socket to agent-browser's stream. Tests supply their own. */
  connectStream?: (url: string) => WebSocket;
  /** With it, a view offers to keep a sign-in the person types, and to sign in with a kept one. */
  logins?: BrowserLogins;
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
function parseStreamMessage(
  data: RawData,
): { type?: unknown; seq?: unknown; data?: unknown; url?: unknown; tabs?: unknown } | null {
  try {
    const message: unknown = JSON.parse(rawDataToString(data));
    return typeof message === "object" && message !== null ? message : null;
  } catch {
    return null;
  }
}

/**
 * Which tab the browser shows and at which address, going by the `tabs` of a stream message.
 * Two messages with the same answer are about the same page.
 */
function visibleTab(tabs: unknown): string {
  const shown: unknown = Array.isArray(tabs)
    ? tabs.find((tab: unknown) => typeof tab === "object" && tab !== null && (tab as { active?: unknown }).active === true)
    : undefined;
  const { tabId, targetId, url } = (shown ?? {}) as { tabId?: unknown; targetId?: unknown; url?: unknown };
  return JSON.stringify([tabId, targetId, url].map((value) => (typeof value === "string" ? value : "")));
}

/** The browser's tabs as a viewer is told them, from the `tabs` of a stream message. */
function liveTabs(tabs: unknown): BrowserLiveTab[] {
  if (!Array.isArray(tabs)) return [];
  const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");
  return tabs.slice(0, MAX_TABS).flatMap((tab: unknown) => {
    const { tabId, title, url, active } = (typeof tab === "object" && tab !== null ? tab : {}) as Record<string, unknown>;
    return typeof tabId === "string" && tabId.length <= 16
      ? [{ id: tabId, title: text(title, MAX_TAB_TITLE_LENGTH), url: text(url, MAX_TAB_URL_LENGTH), active: active === true }]
      : [];
  });
}

/** The agent-browser command that does what a viewer asked of the browser. */
function pageCommand(message: BrowserLivePageCommand): BrowserCommand {
  switch (message.type) {
    case "navigate":
      return ["open", message.url];
    case "history":
      return [message.direction];
    case "reload":
      return ["reload"];
    case "tab":
      return message.action === "close" ? ["tab", "close", message.tabId] : ["tab", message.tabId];
  }
}

/** Input that can submit a form: a click, the Enter key, and typed text that holds a line break. */
function maySubmit(message: BrowserLiveClientMessage): boolean {
  if (message.type === "input_mouse") return message.eventType === "mousePressed";
  return message.type === "input_keyboard" && message.eventType !== "keyUp"
    && (message.key === "Enter" || /[\r\n]/.test(message.text ?? ""));
}

/** Input that can open or close a tab: the end of a click, and keys. */
function mayChangeTabs(message: BrowserLiveClientMessage): boolean {
  return (message.type === "input_mouse" && message.eventType === "mouseReleased")
    || (message.type === "input_keyboard" && message.eventType !== "keyDown");
}

/**
 * `viewers` is how many live views of the session are open now. `dropped` says the one that
 * just ended lost its connection without closing it, so it may be back in a moment.
 */
export type BrowserLiveViewerListener = (browserSessionId: string, viewers: number, dropped: boolean) => void;

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
  private readonly viewerListeners = new Set<BrowserLiveViewerListener>();
  private readonly fileChoosers = new Map<string, PendingFileChooser>();
  private readonly filesDir: string | undefined;
  private readonly logins: BrowserLogins | undefined;
  private readonly loginWatches = new Map<string, LoginWatch>();
  /** Settles once what an earlier run left in `filesDir` is gone. */
  private readonly filesCleared: Promise<void>;
  private lastCheck: BrowserLiveCheck | undefined;

  constructor(options: BrowserLiveGatewayOptions) {
    this.sessions = options.sessions;
    this.broker = options.broker;
    this.telemetryStore = options.telemetryStore;
    this.filesDir = options.filesDir;
    this.filesCleared = this.removeFiles();
    this.runCommand = options.runCommand ?? ((command, timeout, commandOptions) => ab(command, timeout, commandOptions));
    this.connectStream = options.connectStream ?? ((url) => new WebSocket(url, { perMessageDeflate: false }));
    this.logins = options.logins;
    this.stopListening = this.sessions.onSessionClosing((browserSessionId) => {
      this.loginWatches.delete(browserSessionId);
      this.closeConnections(browserSessionId, {
        type: "closed",
        reason: "session_ended",
        message: "The browser session has ended.",
      });
      // A browser reads a chosen file when the page does, so the files stay for as long as the
      // session that got them.
      void this.removeFiles(browserSessionId);
    });
  }

  /** Removes the picked files of one browser session, or all of them. */
  private async removeFiles(browserSessionId = ""): Promise<void> {
    if (!this.filesDir) return;
    await rm(join(this.filesDir, browserSessionId), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  /**
   * Takes a file chooser a view was told of for one upload, and says where the upload's files
   * go. Undefined when the page is not waiting for them (any more), or an upload for the same
   * chooser is under way. The claim ends with chooseFiles or releaseFileChooser.
   */
  async claimFileChooser(id: string): Promise<{ folder: string; multiple: boolean } | undefined> {
    const chooser = this.fileChoosers.get(id);
    if (!chooser || chooser.claimed || !this.filesDir) return undefined;
    chooser.claimed = true;
    chooser.used();
    try {
      await this.filesCleared;
      const sessionFolder = join(this.filesDir, chooser.browserSessionId);
      await mkdir(sessionFolder, { recursive: true });
      // A folder for each upload, so that a file keeps the name it had on the person's device.
      return { folder: await mkdtemp(join(sessionFolder, "files-")), multiple: chooser.multiple };
    } catch (error) {
      chooser.claimed = false;
      throw error;
    }
  }

  /** Ends a claim whose files did not arrive. The chooser stays open for another try. */
  releaseFileChooser(id: string): void {
    const chooser = this.fileChoosers.get(id);
    if (!chooser) return;
    chooser.claimed = false;
    chooser.used();
  }

  /**
   * Gives the page the files received for a claimed chooser, which is thereby answered: also
   * when the page did not take them, because the element that asked is gone then (the page
   * moved on, or its tab was closed). The files stay where they are.
   */
  async chooseFiles(id: string, paths: readonly string[]): Promise<Result<void>> {
    const chooser = this.fileChoosers.get(id);
    if (!chooser) return err(FILE_CHOOSER_GONE);
    this.fileChoosers.delete(id);
    chooser.used();
    return chooser.setFiles(paths).then(() => ok(undefined), () => err(FILE_CHOOSER_GONE));
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
    void this.removeFiles();
  }

  /** Calls the listener whenever a live view of a session opens or ends. */
  onViewersChanged(listener: BrowserLiveViewerListener): () => void {
    this.viewerListeners.add(listener);
    return () => this.viewerListeners.delete(listener);
  }

  private viewersChanged(browserSessionId: string, dropped = false): void {
    const viewers = this.connections.get(browserSessionId)?.size ?? 0;
    for (const listener of this.viewerListeners) {
      try {
        listener(browserSessionId, viewers, dropped);
      } catch (error) {
        console.error("[browser-live] Viewer listener failed:", error);
      }
    }
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
    let lastVisibleTab: string | undefined;
    let lastShownTab: string | undefined;
    let lastTabs = "[]";
    let streamTabs: BrowserLiveTab[] = [];
    // agent-browser reports a tab's title and address as they were when it first saw the tab.
    // The tab on show is described by the latest read of it instead, and what two reads in a
    // row found in a tab is kept for when it is no longer on show. One read is not enough to go
    // by: its result and the news of which tab is on show arrive in either order.
    let page: { tabId: string | undefined; title: string; url: string } | undefined;
    const seenInTab = new Map<string, { title: string; url: string }>();
    let tabCount = 1;
    let followUpReads: NodeJS.Timeout[] = [];
    const openedAt = Date.now();
    let lastInputAt = 0;
    let lastReadAt = 0;
    let answersPings = true;
    let ended = false;
    let fileChoosers: Promise<FileChooserWatch | undefined> = Promise.resolve(undefined);
    let fileChooserId: string | undefined;
    // One per browser session, so that what it offers is still there for a view that reconnects.
    let login = this.loginWatches.get(browserSessionId);
    if (this.logins && !login && this.sessions.getSession(browserSessionId)) {
      login = new LoginWatch(this.logins);
      this.loginWatches.set(browserSessionId, login);
    }
    const stopLoginWatch = login?.watch(send);

    const end = (message: BrowserLiveClosedMessage, dropped = false): void => {
      if (ended) return;
      ended = true;
      clearInterval(pageTimer);
      clearInterval(heartbeat);
      for (const timer of followUpReads) clearTimeout(timer);
      const open = this.connections.get(browserSessionId);
      open?.delete(end);
      if (open?.size === 0) this.connections.delete(browserSessionId);
      send(message);
      client.close(1000, message.reason);
      stream?.close();
      if (fileChooserId) this.fileChoosers.delete(fileChooserId);
      void fileChoosers.then((watch) => watch?.close());
      stopLoginWatch?.();
      this.viewersChanged(browserSessionId, dropped);
    };
    const heartbeat = setInterval(() => {
      if (!answersPings) {
        client.terminate();
        return;
      }
      answersPings = false;
      client.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    client.on("pong", () => {
      answersPings = true;
    });
    const peers = this.connections.get(browserSessionId) ?? new Set<(message: BrowserLiveClosedMessage) => void>();
    peers.add(end);
    this.connections.set(browserSessionId, peers);
    this.viewersChanged(browserSessionId);

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
      // A socket that is being closed still delivers what was already on its way.
      if (!message || ended) return;
      if (message.type !== "ack") {
        lastInputAt = Date.now();
        this.sessions.touch(browserSessionId);
      }
      const accepted = message;
      if (accepted.type === "login") {
        void answerLogin(accepted.action).catch(() => undefined);
        return;
      }
      if (isBrowserLivePageCommand(accepted)) {
        login?.left();
        queuePageCommand(accepted);
        return;
      }
      inputTail = inputTail.then(async () => {
        // A form is read before the key or click that submits it: the page is gone right after.
        // Whatever becomes of the read, the input goes on to the page.
        if (login && maySubmit(accepted)) await login.submitting(readSignInForm).catch(() => undefined);
        else if (accepted.type === "input_keyboard") login?.keyPressed();
        await forward(accepted);
      }).catch(() => undefined);
      if (mayChangeTabs(accepted)) readSoon();
    });
    // A view that is closed, or whose page is left, says so (1000, 1001). Anything else is a
    // connection that broke.
    client.on("close", (code) => end(
      { type: "closed", reason: "stream_ended", message: "The live view was closed." },
      code !== 1000 && code !== 1001,
    ));
    client.on("error", () => end({ type: "closed", reason: "stream_ended", message: "The live view connection failed." }, true));

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
    const readSignInForm = async (): Promise<SignInForm | undefined> => {
      if (ended || stream?.readyState !== WebSocket.OPEN) return undefined;
      // What this returns holds a password. It goes to the watch and nowhere else: no span, no
      // log, and no error that quotes it.
      const result = await this.runCommand(
        ["eval", "-b", SIGN_IN_FORM_VALUES_SCRIPT_BASE64],
        SIGN_IN_FORM_READ_TIMEOUT_MS,
        { ...commandOptions, telemetryStore: undefined },
      ).catch(() => undefined);
      return result?.ok ? parseSignInForm(result.output) : undefined;
    };
    const answerLogin = async (action: BrowserLiveLoginActionMessage["action"]): Promise<void> => {
      if (!login || ended) return;
      if (action === "dismiss") {
        login.dismiss();
        return;
      }
      // One operation on the browser at a time, as for a page command.
      await this.sessions.holdSession(browserSessionId, (current) => this.broker.withTarget(
        sessionLease(current),
        { toolName: "browser_live", browserOpId: randomBytes(8).toString("hex"), duringHold: true, skipReadiness: true },
        async () => {
          // The wait for the browser may have outlasted the view.
          if (ended) return;
          await (action === "save" ? login.save(current.browserTarget) : login.fill(commandOptions));
        },
      ));
      await readPage();
    };
    let readAgain = false;
    const readPage = (): Promise<void> => {
      if (ended) return Promise.resolve();
      // What prompted this read may have happened after the one under way looked at the page.
      if (pageRead) readAgain = true;
      pageRead ??= (async () => {
        try {
          lastReadAt = Date.now();
          // Too frequent to be worth a span each.
          const result = await this.runCommand(
            ["eval", "-b", PAGE_SCRIPT_BASE64],
            STREAM_COMMAND_TIMEOUT_MS,
            { ...commandOptions, telemetryStore: undefined },
          );
          if (!result.ok || ended) return;
          const [width, height, url, title, signInForm] = JSON.parse(result.output) as [number, number, string, string, number?];
          this.sessions.touch(browserSessionId);
          if (typeof url === "string") {
            sendUrl(url);
            void login?.pageRead(url, signInForm === 1).catch(() => undefined);
            const read = {
              tabId: streamTabs.find((tab) => tab.active)?.id,
              title: typeof title === "string" ? title.slice(0, MAX_TAB_TITLE_LENGTH) : "",
              url: url.slice(0, MAX_TAB_URL_LENGTH),
            };
            if (read.tabId) {
              if (page?.tabId === read.tabId && page.title === read.title && page.url === read.url) {
                seenInTab.set(read.tabId, { title: read.title, url: read.url });
              } else {
                seenInTab.delete(read.tabId);
              }
            }
            page = read;
            sendTabs();
          }
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

    const sendTabs = (): void => {
      const tabs = streamTabs.map((tab) => ({
        ...tab,
        ...(tab.active && page?.tabId === tab.id ? { title: page.title, url: page.url } : seenInTab.get(tab.id)),
      }));
      const listed = JSON.stringify(tabs);
      if (listed === lastTabs) return;
      lastTabs = listed;
      send({ type: "tabs", tabs });
    };
    const readSoon = (): void => {
      for (const timer of followUpReads) clearTimeout(timer);
      followUpReads = INPUT_FOLLOW_UP_READS_MS.map((delay) => {
        const timer = setTimeout(() => void readPage(), delay);
        timer.unref?.();
        return timer;
      });
    };
    // Apart from input: opening an address takes as long as the page takes to load, and the
    // page is there to be clicked meanwhile. One runs at a time; of those asked for meanwhile
    // only the last is run, as a browser treats a second address typed while the first loads.
    let commandRunning = false;
    let nextCommand: BrowserLivePageCommand | undefined;
    const runPageCommand = async (message: BrowserLivePageCommand): Promise<void> => {
      // Before the stream is open there is no page on show to act on.
      if (ended || stream?.readyState !== WebSocket.OPEN) return;
      // One operation on the browser at a time, like an agent's own, and none on a session
      // that is being closed. A command that fails changes nothing; the page shows what is.
      await this.sessions.holdSession(browserSessionId, (current) => this.broker.withTarget(
        sessionLease(current),
        { toolName: "browser_live", browserOpId: randomBytes(8).toString("hex"), duringHold: true, skipReadiness: true },
        async () => {
          // The wait for the browser may have outlasted the view, and with it the user's hold
          // on the browser.
          if (ended) return;
          if (message.type === "tab" && message.action === "close") {
            // A browser without a tab has nothing to show, and its window closes.
            const listed = await this.runCommand(["tab", "list"], STREAM_COMMAND_TIMEOUT_MS, commandOptions);
            const tabs = listed.ok ? listed.data?.tabs : undefined;
            if (ended || !Array.isArray(tabs) || tabs.length <= 1) return;
          }
          await this.runCommand(pageCommand(message), PAGE_COMMAND_TIMEOUT_MS, commandOptions);
        },
      ));
      await readPage();
    };
    const queuePageCommand = (message: BrowserLivePageCommand): void => {
      if (commandRunning) {
        nextCommand = message;
        return;
      }
      commandRunning = true;
      void (async () => {
        for (let command: BrowserLivePageCommand | undefined = message; command; command = nextCommand, nextCommand = undefined) {
          await runPageCommand(command).catch(() => undefined);
        }
        commandRunning = false;
      })();
    };

    // A page's file chooser is drawn outside the page, where the view cannot show it. The
    // browser hands it over instead, and the viewer is asked for the files on their own device.
    const receivingFiles = (): boolean => fileChooserId !== undefined && this.fileChoosers.get(fileChooserId)?.claimed === true;
    const offerFileChooser = async (chooser: FileChooser): Promise<void> => {
      // Files on their way are for the chooser they were picked for; a tap meanwhile opens nothing.
      if (receivingFiles()) return;
      const watch = await fileChoosers;
      const accept = await watch?.accept(chooser);
      if (!watch || ended || receivingFiles()) return;
      if (fileChooserId) this.fileChoosers.delete(fileChooserId);
      const id = randomBytes(16).toString("hex");
      fileChooserId = id;
      this.fileChoosers.set(id, {
        browserSessionId,
        multiple: chooser.multiple,
        claimed: false,
        setFiles: (paths) => watch.setFiles(chooser, paths),
        used: () => {
          lastInputAt = Date.now();
          this.sessions.touch(browserSessionId);
        },
      });
      send({ type: "file_chooser", id, multiple: chooser.multiple, ...(accept ? { accept } : {}) });
    };
    const watchFileChoosers = async (): Promise<FileChooserWatch | undefined> => {
      try {
        const endpoint = await this.sessions.holdSession(browserSessionId, (current) => this.broker.withTarget(
          sessionLease(current),
          { toolName: "browser_live", browserOpId: randomBytes(8).toString("hex"), duringHold: true, skipReadiness: true },
          () => this.runCommand(["get", "cdp-url"], STREAM_COMMAND_TIMEOUT_MS, commandOptions),
        ));
        const url = endpoint.ok && endpoint.value.ok ? localDevToolsUrl(endpoint.value.data?.cdpUrl) : undefined;
        if (!url || ended) return undefined;
        const watch = await FileChooserWatch.open(url, { onChooser: (chooser) => void offerFileChooser(chooser) });
        if (!ended) return watch;
        await watch.close();
      } catch {
        // The view works without it; a file chooser then opens on the browser's own screen.
      }
      return undefined;
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
      if (this.filesDir) fileChoosers = watchFileChoosers();
      pageTimer = setInterval(() => {
        const now = Date.now();
        if (!receivingFiles() && now - Math.max(openedAt, lastInputAt) >= VIEW_IDLE_MS) {
          end({ type: "closed", reason: "stream_ended", message: "The view was closed because nobody used it for a while." });
          return;
        }
        const tabsMayChange = tabCount > 1 || now - lastInputAt < RECENT_INPUT_MS;
        if (tabsMayChange || now - lastReadAt >= SLOW_PAGE_POLL_MS) void readPage();
      }, PAGE_POLL_MS);
      pageTimer.unref?.();
    });
    stream.on("message", (data) => {
      const message = parseStreamMessage(data);
      if (!message) return;
      if (message.type === "frame" && typeof message.seq === "number" && typeof message.data === "string") {
        if (!this.lastCheck?.ok) this.recordCheck(true);
        send({ type: "frame", seq: message.seq, data: message.data });
      } else if (message.type === "url" && typeof message.url === "string") {
        const navigated = message.url !== lastUrl;
        sendUrl(message.url);
        if (navigated) void readPage();
      } else if (message.type === "tabs") {
        // agent-browser sends its tabs after every command it runs, and reading the page is
        // one. Only another visible tab, or another address of it, is a reason to read again:
        // a read for every message would cause the next message, without end.
        streamTabs = liveTabs(message.tabs);
        tabCount = streamTabs.length;
        for (const id of seenInTab.keys()) {
          if (!streamTabs.some((tab) => tab.id === id)) seenInTab.delete(id);
        }
        // What the last read found was in the tab that was on show until now.
        if (page && page.tabId !== streamTabs.find((tab) => tab.active)?.id) page = undefined;
        sendTabs();
        // What was typed into one tab is not a sign-in to the page of another.
        const shownTab = streamTabs.find((tab) => tab.active)?.id;
        if (lastShownTab !== undefined && shownTab !== lastShownTab) login?.left();
        lastShownTab = shownTab;
        const visible = visibleTab(message.tabs);
        if (visible === lastVisibleTab) return;
        lastVisibleTab = visible;
        void readPage();
      }
    });
    stream.on("close", () => end({ type: "closed", reason: "stream_ended", message: "The browser was closed." }));
    stream.on("error", () => end({ type: "closed", reason: "stream_ended", message: "The browser's live stream failed." }));
  }
}
