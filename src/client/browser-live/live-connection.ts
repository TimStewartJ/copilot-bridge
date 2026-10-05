import { requestBrowserLiveTicket } from "../api";
import type {
  BrowserLiveClientMessage,
  BrowserLiveClosedMessage,
  BrowserLiveServerMessage,
  BrowserLiveTicket,
} from "../../shared/browser-live.js";
import { buildBrowserLiveWebSocketUrl, type LiveViewport } from "./live-input";
import { systemTimers, type LiveTimers } from "./mouse-input";

/**
 * The connection behind a live browser view: it gets a ticket, opens the socket, keeps the latest
 * page state, paces frames and reconnects. It knows nothing about React or the DOM, so the view
 * and its tests drive it through plain calls.
 */

export type BrowserLivePhase = "connecting" | "live" | "reconnecting" | "ended";

export interface BrowserLiveSnapshot {
  phase: BrowserLivePhase;
  /** Why the view ended, in words for the reader. Set when `phase` is `ended`. */
  message?: string;
  /** False when asking again cannot help, because the browser session itself is over. */
  canRetry: boolean;
  viewport: LiveViewport | null;
  url: string | null;
  /** Whether a picture of the page has arrived yet. */
  hasFrame: boolean;
}

/** The part of a WebSocket the connection uses. */
export interface LiveSocket {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface BrowserLiveDeps {
  requestTicket: (browserSessionId: string) => Promise<BrowserLiveTicket>;
  buildUrl: (ticket: BrowserLiveTicket) => string;
  createSocket: (url: string) => LiveSocket;
  timers: LiveTimers;
}

/** Draws one frame (base64 JPEG) and resolves when it is on screen, or could not be drawn. */
export type BrowserLiveFrameSink = (data: string) => Promise<void> | void;

const SOCKET_OPEN = 1;
/** The wait before each new attempt after the connection drops. After the last one, it gives up. */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;
/** A socket that has not opened by now is treated as a failed attempt. */
export const SOCKET_OPEN_TIMEOUT_MS = 15_000;
const LOST_MESSAGE = "The connection to the browser was lost.";

function defaultDeps(): BrowserLiveDeps {
  return {
    requestTicket: requestBrowserLiveTicket,
    buildUrl: (ticket) => buildBrowserLiveWebSocketUrl(ticket),
    createSocket: (url) => new WebSocket(url) as unknown as LiveSocket,
    timers: systemTimers,
  };
}

/** A refusal (the session ended, or live view is not available here) will not change on a retry. */
function isRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "The browser could not be opened.";
}

function parseServerMessage(data: unknown): BrowserLiveServerMessage | null {
  if (typeof data !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "frame":
      return typeof message.seq === "number" && typeof message.data === "string"
        ? { type: "frame", seq: message.seq, data: message.data }
        : null;
    case "viewport":
      return typeof message.width === "number" && typeof message.height === "number"
        && message.width > 0 && message.height > 0
        ? { type: "viewport", width: message.width, height: message.height }
        : null;
    case "url":
      return typeof message.url === "string" ? { type: "url", url: message.url } : null;
    case "closed":
      return {
        type: "closed",
        reason: message.reason as BrowserLiveClosedMessage["reason"],
        message: typeof message.message === "string" && message.message ? message.message : "The live view ended.",
      };
    default:
      return null;
  }
}

interface QueuedFrame {
  seq: number;
  data: string;
  socket: LiveSocket;
}

export class BrowserLiveConnection {
  private readonly deps: BrowserLiveDeps;
  private readonly listeners = new Set<() => void>();
  private snapshot: BrowserLiveSnapshot = { phase: "connecting", canRetry: true, viewport: null, url: null, hasFrame: false };
  /** Bumped on every start and stop, so work begun for an earlier run notices it is stale. */
  private run = 0;
  private running = false;
  private socket: LiveSocket | null = null;
  /** Pointer positions are in the page's units, so none are sent until this socket has reported them. */
  private socketHasViewport = false;
  private failedAttempts = 0;
  private reconnectTimer: unknown = null;
  private openTimer: unknown = null;
  private sink: BrowserLiveFrameSink | null = null;
  private latestFrame: string | null = null;
  private drawing = false;
  private waitingFrame: QueuedFrame | null = null;
  /** A sink arrived while the previous one was still drawing, and has not been given the picture. */
  private sinkNeedsFrame = false;

  constructor(readonly browserSessionId: string, deps: Partial<BrowserLiveDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): BrowserLiveSnapshot => this.snapshot;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.run += 1;
    this.failedAttempts = 0;
    this.update({ phase: "connecting", message: undefined, canRetry: true });
    void this.connect(this.run);
  }

  stop(): void {
    this.running = false;
    this.run += 1;
    this.clearTimers();
    this.dropSocket();
    this.waitingFrame = null;
  }

  /** Starts over after the view ended. */
  retry(): void {
    this.stop();
    this.start();
  }

  /**
   * Where frames are drawn. A frame that arrived before the sink did is drawn at once, because the
   * server only sends another when the page changes.
   */
  setFrameSink(sink: BrowserLiveFrameSink | null): void {
    this.sink = sink;
    this.sinkNeedsFrame = false;
    if (!sink || this.latestFrame === null) return;
    if (this.drawing) this.sinkNeedsFrame = true;
    else void this.draw(null, this.latestFrame);
  }

  /** Sends input to the page. Returns false when it was dropped because the view is not ready for it. */
  send(message: BrowserLiveClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    if (message.type === "input_mouse" && !this.socketHasViewport) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private update(patch: Partial<BrowserLiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.deps.timers.clearTimeout(this.reconnectTimer);
    if (this.openTimer !== null) this.deps.timers.clearTimeout(this.openTimer);
    this.reconnectTimer = null;
    this.openTimer = null;
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketHasViewport = false;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      // Already closed.
    }
  }

  private end(message: string, canRetry: boolean): void {
    this.running = false;
    this.run += 1;
    this.clearTimers();
    this.dropSocket();
    this.update({ phase: "ended", message, canRetry });
  }

  private async connect(run: number): Promise<void> {
    let ticket: BrowserLiveTicket;
    try {
      ticket = await this.deps.requestTicket(this.browserSessionId);
    } catch (error) {
      if (run !== this.run) return;
      if (isRefusal(error)) this.end(errorText(error), true);
      else this.attemptFailed(run);
      return;
    }
    if (run !== this.run) return;

    let socket: LiveSocket;
    try {
      socket = this.deps.createSocket(this.deps.buildUrl(ticket));
    } catch {
      this.attemptFailed(run);
      return;
    }
    this.socket = socket;
    this.socketHasViewport = false;
    this.openTimer = this.deps.timers.setTimeout(() => {
      this.openTimer = null;
      if (run === this.run && this.socket === socket) this.attemptFailed(run);
    }, SOCKET_OPEN_TIMEOUT_MS);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      if (this.openTimer !== null) this.deps.timers.clearTimeout(this.openTimer);
      this.openTimer = null;
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const message = parseServerMessage(event.data);
      if (message) this.handleMessage(message, socket);
    };
    // A socket that fails also closes, so the close alone triggers the next attempt.
    socket.onclose = () => {
      if (run === this.run && this.socket === socket) this.attemptFailed(run);
    };
  }

  /** The connection dropped or never came up: wait and try again with a new ticket, a bounded number of times. */
  private attemptFailed(run: number): void {
    if (run !== this.run) return;
    this.dropSocket();
    this.clearTimers();
    const delay = RECONNECT_DELAYS_MS[this.failedAttempts];
    if (delay === undefined) {
      this.end(LOST_MESSAGE, true);
      return;
    }
    this.failedAttempts += 1;
    this.update({ phase: "reconnecting" });
    this.reconnectTimer = this.deps.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (run === this.run) void this.connect(run);
    }, delay);
  }

  private handleMessage(message: BrowserLiveServerMessage, socket: LiveSocket): void {
    if (message.type === "closed") {
      this.end(message.message, message.reason !== "session_ended");
      return;
    }
    // Any message proves this connection works, so the next drop starts its retries afresh.
    this.failedAttempts = 0;
    if (message.type === "viewport") {
      this.socketHasViewport = true;
      const current = this.snapshot.viewport;
      const changed = !current || current.width !== message.width || current.height !== message.height;
      if (changed || this.snapshot.phase !== "live") {
        this.update({
          phase: "live",
          ...(changed ? { viewport: { width: message.width, height: message.height } } : {}),
        });
      }
      return;
    }
    if (message.type === "url") {
      if (this.snapshot.url !== message.url || this.snapshot.phase !== "live") {
        this.update({ phase: "live", url: message.url });
      }
      return;
    }
    if (this.snapshot.phase !== "live" || !this.snapshot.hasFrame) this.update({ phase: "live", hasFrame: true });
    this.latestFrame = message.data;
    const frame: QueuedFrame = { seq: message.seq, data: message.data, socket };
    if (this.drawing) {
      // Only the newest waiting frame is worth drawing. The one it replaces is still acknowledged,
      // or the server would wait for it forever.
      if (this.waitingFrame) this.acknowledge(this.waitingFrame);
      this.waitingFrame = frame;
      return;
    }
    void this.draw(frame, frame.data);
  }

  private acknowledge(frame: QueuedFrame): void {
    if (frame.socket !== this.socket || frame.socket.readyState !== SOCKET_OPEN) return;
    try {
      frame.socket.send(JSON.stringify({ type: "ack", seq: frame.seq } satisfies BrowserLiveClientMessage));
    } catch {
      // The socket closed under us; its close handler reconnects.
    }
  }

  /** Draws one frame at a time. `frame` is null when redrawing the last picture for a new sink. */
  private async draw(frame: QueuedFrame | null, data: string): Promise<void> {
    this.drawing = true;
    try {
      await this.sink?.(data);
    } catch {
      // A frame that cannot be drawn is skipped; the next one replaces it.
    }
    this.drawing = false;
    if (frame) this.acknowledge(frame);
    const next = this.waitingFrame;
    this.waitingFrame = null;
    const redraw = this.sinkNeedsFrame && this.latestFrame !== null;
    this.sinkNeedsFrame = false;
    if (next) void this.draw(next, next.data);
    else if (redraw) void this.draw(null, this.latestFrame!);
  }
}
