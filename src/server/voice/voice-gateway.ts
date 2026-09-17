// Voice mode gateway: owns conversations and bridges browser transports (WebSocket, or
// HTTP POST + SSE through proxies that block upgrades) to the shared speech engine.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppContext } from "../app-context.js";
import type { StatusEvent } from "../global-bus.js";
import { VoiceAgent } from "./voice-agent.js";
import {
  DEFAULT_VOICE_SETTINGS,
  KOKORO_VOICES,
  normalizeVoiceSettings,
  PREFERRED_VOICE_MODELS,
  type VoicePaths,
  type VoiceSettings,
} from "./voice-catalog.js";
import {
  VoiceConversation,
  type VoiceAudioChunk,
  type VoiceClientSink,
  type VoiceServerEvent,
} from "./voice-conversation.js";
import type { VoiceEngine, VoiceEngineStatus } from "./voice-engine.js";
import { VOICE_ENGINE_CAPABILITIES } from "./voice-engine-protocol.js";
import type { VoiceInstaller } from "./voice-installer.js";
import { pruneVoiceLogs, VoiceLog } from "./voice-log.js";
import type { VoiceRuntime } from "./voice-runtime.js";
import { createVoiceToolDefinitions, formatAgo, type VoiceBridgeFacade, type VoiceCardLink } from "./voice-tools.js";

export const VOICE_WS_PATH_SUFFIX = "/voice/ws";
const RECONNECT_GRACE_MS = 60_000;
const WS_HEARTBEAT_MS = 20_000;
const MAX_AUDIO_FRAME_BYTES = 256_000;
const ANNOUNCE_DEBOUNCE_MS = 1_500;

export type VoiceGatewayEvent =
  | VoiceServerEvent
  | { type: "hello"; conversationId: string; transport: "websocket" | "http"; settings: VoiceSettings; state: string }
  | { type: "engine"; state: VoiceEngineStatus["state"]; detail?: string }
  | { type: "agent"; model?: string }
  | { type: "card"; id: string; title: string; body: string; links: VoiceCardLink[] }
  | { type: "bridge_counts"; unread: number; running: number; waiting: number }
  | { type: "pong"; t: number }
  | { type: "ended"; reason: string };

export type VoiceClientMessage =
  | { type: "start"; greet?: boolean }
  | { type: "config"; settings: unknown }
  | { type: "text"; text: string }
  | { type: "control"; action: "sleep" | "wake" | "stop_speaking" | "end" }
  | { type: "playback"; event: "started" | "idle"; genId: number; chunkId?: number }
  | { type: "ping"; t: number };

interface VoiceTransport {
  readonly kind: "websocket" | "http";
  sendJson(event: VoiceGatewayEvent): void;
  sendAudio(chunk: VoiceAudioChunk): void;
  close(reason: string): void;
}

export function encodeAudioFrame(chunk: VoiceAudioChunk): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt8(1, 0);
  header.writeUInt16LE(chunk.chunkId & 0xffff, 2);
  header.writeUInt32LE(chunk.sampleRate, 4);
  header.writeUInt32LE(chunk.genId >>> 0, 8);
  const body = Buffer.from(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength);
  return Buffer.concat([header, body]);
}

export function decodePcmBody(body: Buffer): Int16Array {
  const length = body.byteLength - (body.byteLength % 2);
  const copy = new Int16Array(length / 2);
  for (let i = 0; i < copy.length; i++) copy[i] = body.readInt16LE(i * 2);
  return copy;
}

function tokensMatch(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseClientMessage(raw: unknown): VoiceClientMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as Record<string, unknown>;
  switch (message.type) {
    case "start":
      return { type: "start", greet: message.greet !== false };
    case "config":
      return { type: "config", settings: message.settings };
    case "text":
      return typeof message.text === "string" ? { type: "text", text: message.text.slice(0, 4_000) } : undefined;
    case "control":
      return message.action === "sleep" || message.action === "wake" || message.action === "stop_speaking" || message.action === "end"
        ? { type: "control", action: message.action }
        : undefined;
    case "playback":
      return (message.event === "started" || message.event === "idle") && typeof message.genId === "number"
        ? { type: "playback", event: message.event, genId: message.genId, ...(typeof message.chunkId === "number" ? { chunkId: message.chunkId } : {}) }
        : undefined;
    case "ping":
      return { type: "ping", t: typeof message.t === "number" ? message.t : 0 };
    default:
      return undefined;
  }
}

export function buildBridgeSnapshotLine(sessions: Awaited<ReturnType<VoiceBridgeFacade["listSessions"]>>, now = Date.now()): string {
  const active = sessions.filter((session) => !session.archived);
  const waiting = active.filter((session) => session.needsUserInput);
  const running = active.filter((session) => session.runState !== "idle" && !session.needsUserInput);
  const unread = active.filter((session) => session.unread && session.runState === "idle" && !session.needsUserInput);
  const describe = (list: typeof active, withAgo: boolean) => list.slice(0, 3)
    .map((session) => `"${session.title}"${withAgo && formatAgo(session.lastActivityAt, now) ? ` (${formatAgo(session.lastActivityAt, now)})` : ""}`)
    .join(", ");
  const parts = [
    waiting.length ? `${waiting.length} waiting on you: ${describe(waiting, false)}` : "nothing waiting on you",
    running.length ? `${running.length} running: ${describe(running, false)}` : "nothing running",
    unread.length ? `${unread.length} unread: ${describe(unread, true)}` : "no unread replies",
  ];
  return parts.join("; ");
}

class ConversationSession implements VoiceClientSink {
  readonly id = randomUUID();
  readonly token = randomBytes(32).toString("base64url");
  readonly streamId = `voice-${this.id}`;
  private transport?: VoiceTransport;
  private graceTimer?: NodeJS.Timeout;
  private started = false;
  private starting?: Promise<void>;
  private releaseEngine?: () => void;
  private unsubscribeBus?: () => void;
  private unsubscribeEngine?: () => void;
  private readonly watched = new Set<string>();
  private readonly announceTimers = new Map<string, NodeJS.Timeout>();
  private countsTimer?: NodeJS.Timeout;
  private readonly agent: VoiceAgent;
  readonly conversation: VoiceConversation;
  readonly log: VoiceLog;
  disposed = false;

  constructor(
    private readonly gateway: VoiceGateway,
    private settings: VoiceSettings,
  ) {
    this.log = new VoiceLog(gateway.paths.logsDir, this.id);
    const tools = createVoiceToolDefinitions(gateway.ctx, gateway.facade, {
      watchSession: (sessionId) => this.watched.add(sessionId),
      showCard: (card) => this.sendJson({ type: "card", id: randomUUID(), ...card }),
      requestVoiceMode: (action) => setTimeout(() => this.onControl(action === "sleep" ? "sleep" : "end"), 1_500).unref(),
    });
    this.agent = new VoiceAgent({
      factory: gateway.ctx.sessionManager,
      tools,
      stateDir: gateway.paths.agentStateDir,
      requestedModel: settings.model,
      defaultWorkModel: gateway.ctx.settingsStore.getSettings().model,
      snapshot: async () => buildBridgeSnapshotLine(await gateway.facade.listSessions()),
      logger: console,
      onTiming: (timing) => this.log.write("agent_timing", { ...timing }),
    });
    this.conversation = new VoiceConversation({
      streamId: this.streamId,
      engine: gateway.engine,
      agent: this.agent,
      sink: this,
      settings,
      log: (event, details) => this.log.write(event, details),
    });
    this.log.write("created", { settings });
  }

  send(event: VoiceServerEvent): void {
    if (event.type === "end_voice_mode") {
      void this.end("voice command");
      return;
    }
    this.sendJson(event);
  }

  sendJson(event: VoiceGatewayEvent): void {
    this.transport?.sendJson(event);
  }

  sendAudio(chunk: VoiceAudioChunk): void {
    this.transport?.sendAudio(chunk);
  }

  attach(transport: VoiceTransport): void {
    if (this.disposed) {
      transport.close("conversation ended");
      return;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    const previous = this.transport;
    this.transport = transport;
    previous?.close("replaced by a new connection");
    this.log.write("transport_attached", { kind: transport.kind });
    transport.sendJson({
      type: "hello",
      conversationId: this.id,
      transport: transport.kind,
      settings: this.settings,
      state: this.conversation.state,
    });
    const engineStatus = this.gateway.engine.status;
    transport.sendJson({ type: "engine", state: engineStatus.state, ...(engineStatus.detail ? { detail: engineStatus.detail } : {}) });
    if (this.started) {
      transport.sendJson({ type: "state", state: this.conversation.state });
      void this.pushCounts();
    }
  }

  detach(transport: VoiceTransport): void {
    if (this.transport !== transport) return;
    this.transport = undefined;
    this.log.write("transport_detached", { kind: transport.kind });
    this.armGraceTimer();
  }

  /** Ends the conversation if no client (re)connects within the grace period. */
  armGraceTimer(): void {
    if (this.disposed || this.transport) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => void this.end("client disconnected"), RECONNECT_GRACE_MS);
    this.graceTimer.unref();
  }

  onAudio(pcm: Int16Array): void {
    if (!this.started || this.disposed) return;
    this.conversation.pushAudio(pcm);
  }

  onMessage(message: VoiceClientMessage): void {
    switch (message.type) {
      case "start":
        void this.start(message.greet !== false);
        break;
      case "config": {
        const previousModel = this.settings.model;
        this.settings = normalizeVoiceSettings(message.settings, this.settings);
        this.conversation.updateSettings(this.settings);
        this.log.write("settings", { settings: this.settings });
        this.sendJson({ type: "notice", level: "info", message: previousModel !== this.settings.model ? "Model changes apply the next time voice mode starts." : "Settings updated." });
        break;
      }
      case "text":
        if (this.started) this.conversation.submitText(message.text);
        break;
      case "control":
        this.onControl(message.action);
        break;
      case "playback":
        if (message.event === "started" && message.chunkId !== undefined) this.conversation.onPlaybackStarted(message.genId, message.chunkId);
        if (message.event === "idle") this.conversation.onPlaybackIdle(message.genId);
        break;
      case "ping":
        this.sendJson({ type: "pong", t: message.t });
        break;
    }
  }

  private onControl(action: "sleep" | "wake" | "stop_speaking" | "end"): void {
    if (action === "end") {
      void this.end("user ended voice mode");
      return;
    }
    if (!this.started) return;
    if (action === "sleep") this.conversation.sleep({ announce: false });
    if (action === "wake") this.conversation.wake();
    if (action === "stop_speaking") this.conversation.stopSpeaking();
  }

  private start(greet: boolean): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.starting) return this.starting;
    const run = (async () => {
      const installStatus = this.gateway.installer.getStatus();
      if (!installStatus.installed) {
        this.sendJson({ type: "notice", level: "error", message: "Voice mode isn't set up yet. Install the speech models first." });
        return;
      }
      this.releaseEngine = this.gateway.engine.retain();
      this.unsubscribeEngine = this.gateway.engine.onStatus((status) => {
        this.sendJson({ type: "engine", state: status.state, ...(status.detail ? { detail: status.detail } : {}) });
        if (status.state === "failed" && this.started) {
          this.sendJson({ type: "notice", level: "error", message: "The speech engine stopped unexpectedly. Restart voice mode to continue." });
          void this.end("speech engine failed");
        }
      });
      const warm = this.agent.warm();
      try {
        await this.gateway.engine.ensureCapabilities(VOICE_ENGINE_CAPABILITIES);
        await this.gateway.engine.openStream(this.streamId, (speech, sampleIndex) => this.conversation.onVad(speech, sampleIndex));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log.write("engine_error", { error: detail });
        this.sendJson({ type: "engine", state: "failed", detail });
        this.sendJson({ type: "notice", level: "error", message: `The speech engine couldn't start: ${detail}` });
        return;
      }
      if (this.disposed) return;
      await warm;
      this.sendJson({ type: "agent", ...(this.agent.modelInfo.model ? { model: this.agent.modelInfo.model } : {}) });
      this.started = true;
      this.subscribeToBridge();
      this.conversation.start({ greet });
      void this.pushCounts();
      this.log.write("started", { greet, model: this.agent.modelInfo.model, engine: this.gateway.engine.status.info });
    })().finally(() => {
      this.starting = undefined;
    });
    this.starting = run;
    return run;
  }

  private subscribeToBridge(): void {
    this.unsubscribeBus = this.gateway.ctx.globalBus.subscribe((event) => this.onBridgeEvent(event));
  }

  private onBridgeEvent(event: StatusEvent): void {
    if (event.type === "sessions:changed" || event.type === "session:idle" || event.type === "session:busy"
      || event.type === "readstate:changed" || event.type === "session:user-input") {
      this.scheduleCounts();
    }
    if (!event.sessionId || this.settings.announce === "off") return;
    const watched = this.settings.announce === "all" || this.watched.has(event.sessionId);
    if (!watched) return;
    if (event.type === "session:idle") {
      this.scheduleAnnouncement(event.sessionId, "finished", event.assistantPreview);
    } else if (event.type === "session:user-input" && event.needsUserInput) {
      this.scheduleAnnouncement(event.sessionId, "waiting");
    }
  }

  private scheduleAnnouncement(sessionId: string, kind: "finished" | "waiting", preview?: string): void {
    const existing = this.announceTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.announceTimers.delete(sessionId);
      void this.announce(sessionId, kind, preview);
    }, ANNOUNCE_DEBOUNCE_MS);
    timer.unref();
    this.announceTimers.set(sessionId, timer);
  }

  private async announce(sessionId: string, kind: "finished" | "waiting", preview?: string): Promise<void> {
    if (this.disposed) return;
    const sessions = await this.gateway.facade.listSessions().catch(() => []);
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) return;
    if (kind === "finished" && (session.needsUserInput || session.runState !== "idle")) return;
    const text = kind === "waiting"
      ? `Session "${session.title}" is waiting on the user with a question.`
      : `Session "${session.title}" finished${preview ? `. Its reply starts: "${preview.slice(0, 280)}"` : "."}`;
    this.log.write("announce", { sessionId, kind });
    this.conversation.enqueueEvent(text);
  }

  private scheduleCounts(): void {
    if (this.countsTimer) return;
    this.countsTimer = setTimeout(() => {
      this.countsTimer = undefined;
      void this.pushCounts();
    }, 1_000);
    this.countsTimer.unref();
  }

  private async pushCounts(): Promise<void> {
    try {
      const sessions = (await this.gateway.facade.listSessions()).filter((session) => !session.archived);
      this.sendJson({
        type: "bridge_counts",
        waiting: sessions.filter((session) => session.needsUserInput).length,
        running: sessions.filter((session) => session.runState !== "idle" && !session.needsUserInput).length,
        unread: sessions.filter((session) => session.unread && session.runState === "idle" && !session.needsUserInput).length,
      });
    } catch {
      // Counts are decorative.
    }
  }

  async end(reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.log.write("ended", { reason });
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.countsTimer) clearTimeout(this.countsTimer);
    for (const timer of this.announceTimers.values()) clearTimeout(timer);
    this.unsubscribeBus?.();
    this.unsubscribeEngine?.();
    this.conversation.dispose();
    this.gateway.engine.closeStream(this.streamId);
    this.releaseEngine?.();
    this.sendJson({ type: "ended", reason });
    const transport = this.transport;
    this.transport = undefined;
    transport?.close(reason);
    this.gateway.forget(this);
    await this.agent.dispose().catch(() => undefined);
    this.log.close();
  }
}

class WebSocketTransport implements VoiceTransport {
  readonly kind = "websocket" as const;
  private alive = true;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly socket: WebSocket, private readonly session: ConversationSession) {
    socket.on("message", (data, isBinary) => {
      this.alive = true;
      if (isBinary) {
        const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (buffer.byteLength <= MAX_AUDIO_FRAME_BYTES) session.onAudio(decodePcmBody(buffer));
        return;
      }
      try {
        const message = parseClientMessage(JSON.parse(String(data)));
        if (message) session.onMessage(message);
      } catch {
        // Ignore malformed control frames.
      }
    });
    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("close", () => {
      clearInterval(this.heartbeat);
      session.detach(this);
    });
    socket.on("error", () => socket.terminate());
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        socket.terminate();
        return;
      }
      this.alive = false;
      socket.ping();
    }, WS_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  sendJson(event: VoiceGatewayEvent): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(event));
  }

  sendAudio(chunk: VoiceAudioChunk): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(encodeAudioFrame(chunk), { binary: true });
  }

  close(reason: string): void {
    clearInterval(this.heartbeat);
    if (this.socket.readyState === this.socket.OPEN) this.socket.close(1000, reason.slice(0, 100));
  }
}

export interface HttpEventSink {
  send(data: unknown): boolean;
  close(): void;
  readonly closed: boolean;
}

class HttpTransport implements VoiceTransport {
  readonly kind = "http" as const;
  private expectedSeq = -1;
  private readonly reorder = new Map<number, Int16Array>();

  constructor(private readonly events: HttpEventSink, private readonly session: ConversationSession) {}

  sendJson(event: VoiceGatewayEvent): void {
    if (!this.events.closed) this.events.send(event);
  }

  sendAudio(chunk: VoiceAudioChunk): void {
    if (this.events.closed) return;
    this.events.send({
      type: "audio",
      genId: chunk.genId,
      chunkId: chunk.chunkId,
      sampleRate: chunk.sampleRate,
      data: Buffer.from(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength).toString("base64"),
    });
  }

  acceptAudio(seq: number, pcm: Int16Array): void {
    // A reattached event stream resumes wherever the client's upload sequence currently is.
    if (this.expectedSeq < 0) this.expectedSeq = seq;
    if (seq < this.expectedSeq) return;
    this.reorder.set(seq, pcm);
    // Missing batches are skipped after a short backlog so a lost request never stalls audio.
    if (this.reorder.size > 8 && !this.reorder.has(this.expectedSeq)) {
      this.expectedSeq = Math.min(...this.reorder.keys());
    }
    while (this.reorder.has(this.expectedSeq)) {
      const next = this.reorder.get(this.expectedSeq)!;
      this.reorder.delete(this.expectedSeq);
      this.expectedSeq++;
      this.session.onAudio(next);
    }
  }

  close(): void {
    this.events.close();
  }
}

export interface VoiceGatewayOptions {
  ctx: AppContext;
  facade: VoiceBridgeFacade;
  runtime: Pick<VoiceRuntime, "paths" | "engine" | "installer">;
}

export class VoiceGateway {
  readonly ctx: AppContext;
  readonly facade: VoiceBridgeFacade;
  readonly paths: VoicePaths;
  readonly engine: VoiceEngine;
  readonly installer: VoiceInstaller;
  private readonly conversations = new Map<string, ConversationSession>();
  private readonly httpTransports = new WeakMap<ConversationSession, HttpTransport>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_FRAME_BYTES, perMessageDeflate: false });

  constructor(options: VoiceGatewayOptions) {
    this.ctx = options.ctx;
    this.facade = options.facade;
    this.paths = options.runtime.paths;
    this.engine = options.runtime.engine;
    this.installer = options.runtime.installer;
    void pruneVoiceLogs(options.runtime.paths.logsDir);
  }

  getStatus() {
    return {
      install: this.installer.getStatus(),
      engine: this.engine.status,
      voices: KOKORO_VOICES,
      defaults: DEFAULT_VOICE_SETTINGS,
      preferredModels: PREFERRED_VOICE_MODELS,
      activeConversations: this.conversations.size,
    };
  }

  createConversation(settings: unknown): { conversationId: string; token: string } {
    const session = new ConversationSession(this, normalizeVoiceSettings(settings));
    this.conversations.set(session.id, session);
    session.armGraceTimer();
    return { conversationId: session.id, token: session.token };
  }

  private find(conversationId: unknown, token: unknown): ConversationSession | undefined {
    if (typeof conversationId !== "string") return undefined;
    const session = this.conversations.get(conversationId);
    return session && tokensMatch(session.token, token) ? session : undefined;
  }

  forget(session: ConversationSession): void {
    if (this.conversations.get(session.id) === session) this.conversations.delete(session.id);
  }

  attachHttpEvents(conversationId: unknown, token: unknown, events: HttpEventSink): (() => void) | undefined {
    const session = this.find(conversationId, token);
    if (!session) return undefined;
    const transport = new HttpTransport(events, session);
    this.httpTransports.set(session, transport);
    session.attach(transport);
    return () => session.detach(transport);
  }

  acceptHttpAudio(conversationId: unknown, token: unknown, seq: number, body: Buffer): boolean {
    const session = this.find(conversationId, token);
    const transport = session ? this.httpTransports.get(session) : undefined;
    if (!session || !transport) return false;
    transport.acceptAudio(seq, decodePcmBody(body));
    return true;
  }

  acceptHttpControl(conversationId: unknown, token: unknown, body: unknown): boolean {
    const session = this.find(conversationId, token);
    if (!session) return false;
    const message = parseClientMessage(body);
    if (message) session.onMessage(message);
    return true;
  }

  /** Handles `…/api/voice/ws` upgrades. Returns false when the request is not for voice mode. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://bridge.local");
    } catch {
      return false;
    }
    if (!url.pathname.endsWith(`/api${VOICE_WS_PATH_SUFFIX}`)) return false;
    const session = this.find(url.searchParams.get("conversationId"), url.searchParams.get("token"));
    if (!session) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      session.attach(new WebSocketTransport(ws, session));
    });
    return true;
  }

  /** Ends every conversation. The shared speech engine is stopped by its owner after other users finish. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.conversations.values()].map((session) => session.end("server shutting down")));
    this.wss.close();
  }
}
