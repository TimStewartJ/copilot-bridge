// Hands-free gateway: owns voice conversations and bridges browser transports (WebSocket, or
// HTTP POST + SSE through proxies that block upgrades) to the shared speech engine. Each
// conversation speaks for one chat (any chat, Helm's included) through the hands-free layer; the
// chat holds all the context.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppContext } from "../app-context.js";
import type { StatusEvent } from "../global-bus.js";
import type { HelmService } from "../helm/helm-service.js";
import { countBridgeSessions, type HelmBridgeFacade } from "../helm/helm-tools.js";
import { sendChatMessage } from "../chat-message-delivery.js";
import { HandsFreeLayer, type ReadbackPreference } from "./hands-free-layer.js";
import { HandsFreeModel } from "./hands-free-model.js";
import {
  DEFAULT_VOICE_SETTINGS,
  KOKORO_VOICES,
  normalizeVoiceSettings,
  type VoicePaths,
  type VoiceSettings,
} from "./voice-catalog.js";
import {
  VoiceConversation,
  type TypedTextDelivery,
  type VoiceAudioChunk,
  type VoiceClientSink,
  type VoiceServerEvent,
} from "./voice-conversation.js";
import type { VoiceEngine, VoiceEngineStatus } from "./voice-engine.js";
import { VOICE_ENGINE_CAPABILITIES } from "./voice-engine-protocol.js";
import type { VoiceInstaller } from "./voice-installer.js";
import { pruneVoiceLogs, VoiceLog } from "./voice-log.js";
import type { VoiceRuntime } from "./voice-runtime.js";

export const VOICE_WS_PATH_SUFFIX = "/voice/ws";
const RECONNECT_GRACE_MS = 60_000;
const WS_HEARTBEAT_MS = 20_000;
const MAX_AUDIO_FRAME_BYTES = 256_000;
const ANNOUNCE_DEBOUNCE_MS = 1_500;

export type VoiceGatewayEvent =
  | VoiceServerEvent
  // `helmSessionId` is the same chat as `sessionId`, kept for Tether.
  | { type: "hello"; conversationId: string; sessionId: string; helmSessionId: string; transport: "websocket" | "http"; settings: VoiceSettings; state: string; resendsAudio?: boolean }
  | { type: "run"; working: boolean; startedAt?: number }
  | { type: "engine"; state: VoiceEngineStatus["state"]; detail?: string }
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
  private unbindHandsFree?: () => void;
  private readonly announceTimers = new Map<string, NodeJS.Timeout>();
  private countsTimer?: NodeJS.Timeout;
  private readonly agent: HandsFreeLayer;
  readonly conversation: VoiceConversation;
  readonly log: VoiceLog;
  disposed = false;

  constructor(
    private readonly gateway: VoiceGateway,
    readonly sessionId: string,
    private settings: VoiceSettings,
  ) {
    this.log = new VoiceLog(gateway.paths.logsDir, this.id);
    const ctx = gateway.ctx;
    this.agent = new HandsFreeLayer({
      sessionId,
      chat: {
        isBusy: () => ctx.sessionManager.isSessionBusy(sessionId),
        getBus: () => ctx.eventBusRegistry.getBus(sessionId),
        deliver: async (text, clientMessageId) => {
          const { delivery } = await sendChatMessage(ctx, sessionId, text, clientMessageId ? { clientMessageId } : {});
          try { ctx.taskStore.recordUserMessage(sessionId); } catch { /* bookkeeping only */ }
          return delivery === "accepted" ? "started" : delivery;
        },
        abort: () => ctx.sessionManager.abortSession(sessionId),
        title: async () => {
          const [session] = await ctx.sessionManager.readSessionsFromDisk([sessionId], { includeArchived: true });
          const title = typeof session?.summary === "string" ? session.summary.trim() : "";
          return title || undefined;
        },
        warm: () => ctx.sessionManager.warmSession(sessionId),
      },
      model: new HandsFreeModel({
        listModels: () => ctx.sessionManager.listModels(),
        getSettings: () => ctx.settingsStore.getSettings(),
        createHelperSession: (config) => ctx.sessionManager.createHelperSession(config),
        logger: console,
        onTiming: (timing) => this.log.write("layer_model", { ...timing }),
      }),
      subscribeStatus: (listener) => ctx.globalBus.subscribe(listener),
      glossary: () => ctx.settingsStore.getSettings().helm?.glossary,
      preference: {
        get: () => gateway.readbackPreferences.get(sessionId),
        set: (value) => gateway.readbackPreferences.set(sessionId, value),
      },
      onRunState: (state) => this.sendJson({ type: "run", working: state.working, ...(state.startedAt ? { startedAt: state.startedAt } : {}) }),
      log: (event, details) => this.log.write(`layer_${event}`, details),
    });
    this.conversation = new VoiceConversation({
      streamId: this.streamId,
      engine: gateway.engine,
      agent: this.agent,
      sink: this,
      settings,
      log: (event, details) => this.log.write(event, details),
    });
    this.log.write("created", { settings, sessionId });
  }

  /** What the last connection for this chat said, so "say that again" works after a reconnect. */
  restoreLastSaid(text: string): void {
    this.agent.restoreLastSaid(text);
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
      sessionId: this.sessionId,
      helmSessionId: this.sessionId,
      transport: transport.kind,
      settings: this.settings,
      state: this.conversation.state,
      // An HTTP client (the phone app) that reconnects mid-reply is sent the parts it has not started
      // playing again. The web page keeps its own scheduled audio across reconnects, so it is not.
      ...(transport.kind === "http" ? { resendsAudio: true } : {}),
    });
    const engineStatus = this.gateway.engine.status;
    transport.sendJson({ type: "engine", state: engineStatus.state, ...(engineStatus.detail ? { detail: engineStatus.detail } : {}) });
    if (this.started) {
      transport.sendJson({ type: "state", state: this.conversation.state });
      void this.pushCounts();
      if (transport.kind === "http") {
        const resent = this.conversation.resendUnplayedAudio();
        if (resent > 0) this.log.write("reattach_resend", { chunks: resent });
      }
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
      case "config":
        this.settings = normalizeVoiceSettings(message.settings, this.settings);
        this.conversation.updateSettings(this.settings);
        this.log.write("settings", { settings: this.settings });
        break;
      case "text":
        void this.submitTypedText(message.text);
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

  /**
   * A message typed while hands-free is on (Tether's text box): sent to the chat as it is, and its
   * reply read back. Resolves once the message has reached the chat (or is known not to have).
   */
  submitTypedText(text: string, clientMessageId?: string): Promise<TypedTextDelivery> | undefined {
    if (!this.started || this.disposed) return undefined;
    return new Promise((resolve) => {
      this.conversation.submitText(text, { ...(clientMessageId ? { clientMessageId } : {}), onDelivery: resolve });
    });
  }

  private onControl(action: "sleep" | "wake" | "stop_speaking" | "end"): void {
    if (action === "end") {
      void this.end("user left hands-free");
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
        this.sendJson({ type: "notice", level: "error", message: "Hands-free isn't set up yet. Install the speech models first." });
        return;
      }
      this.releaseEngine = this.gateway.engine.retain();
      this.unsubscribeEngine = this.gateway.engine.onStatus((status) => {
        this.sendJson({ type: "engine", state: status.state, ...(status.detail ? { detail: status.detail } : {}) });
        if (status.state === "failed" && this.started) {
          this.sendJson({ type: "notice", level: "error", message: "The speech engine stopped unexpectedly. Start hands-free again to continue." });
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
      if (this.disposed) return;
      this.started = true;
      if (this.gateway.helm.isHelmSession(this.sessionId)) this.unbindHandsFree = this.gateway.helm.bindHandsFree(this.sessionId);
      this.subscribeToBridge();
      this.conversation.start({ greet });
      void this.pushCounts();
      this.log.write("started", { greet, engine: this.gateway.engine.status.info });
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
    if (!event.sessionId || event.sessionId === this.sessionId || this.settings.announce === "off") return;
    if (this.gateway.helm.isHelmSession(event.sessionId)) return;
    const watched = this.settings.announce === "all" || this.gateway.helm.isWatched(this.sessionId, event.sessionId);
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
    this.log.write("announce", { sessionId, kind });
    await this.agent.announce(session.title, kind, preview);
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
      this.sendJson({ type: "bridge_counts", ...countBridgeSessions(await this.gateway.facade.listSessions()) });
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
    this.unbindHandsFree?.();
    this.gateway.noteEnded(this.sessionId, reason, this.conversation.lastReply());
    // Leaving hands-free must not cut off a reply: detach first so the session keeps writing it into the chat.
    this.agent.detach();
    this.conversation.dispose();
    this.gateway.engine.closeStream(this.streamId);
    this.releaseEngine?.();
    this.sendJson({ type: "ended", reason });
    const transport = this.transport;
    this.transport = undefined;
    transport?.close(reason);
    this.gateway.forget(this);
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

export type VoiceGatewayHelm = Pick<HelmService, "isHelmSession" | "bindHandsFree" | "isWatched">;

export interface VoiceGatewayOptions {
  ctx: AppContext;
  facade: HelmBridgeFacade;
  helm: VoiceGatewayHelm;
  runtime: Pick<VoiceRuntime, "paths" | "engine" | "installer">;
}

/** A hands-free connection that starts again within this long of the last one gets a resume note. */
const RESUME_NOTE_WINDOW_MS = 5 * 60_000;

/**
 * What the hands-free layer is told when hands-free comes back right after it ended, most often
 * because a phone's connection dropped mid-reply (24 Sep 2026: "What's the most recent message you
 * heard from me?", "I missed it, can you say it again?"), so it can tell such a question is "repeat".
 */
export function buildResumeNote(sinceMs: number, reply: { text: string; finished: boolean } | undefined): string {
  const seconds = Math.max(1, Math.round(sinceMs / 1000));
  const gap = seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
  const lead = `Hands-free just reconnected, ${gap} after the previous connection ended (often a dropped phone connection).`;
  if (!reply) return lead;
  return reply.finished
    ? `${lead} The last thing said aloud was heard to the end.`
    : `${lead} The last thing said aloud was cut off before it finished playing; asking what was said means repeat.`;
}

export class VoiceConversationNotFoundError extends Error {
  constructor() {
    super("Chat not found");
  }
}

export class VoiceGateway {
  readonly ctx: AppContext;
  readonly facade: HelmBridgeFacade;
  readonly helm: VoiceGatewayHelm;
  readonly paths: VoicePaths;
  readonly engine: VoiceEngine;
  readonly installer: VoiceInstaller;
  private readonly conversations = new Map<string, ConversationSession>();
  /** Whether each chat's long replies are read in full or summarized, as the user last said. */
  readonly readbackPreferences = new Map<string, ReadbackPreference>();
  /** When each chat's last hands-free connection ended, for the next one's resume note. */
  private readonly recentEnds = new Map<string, { at: number; reply?: { text: string; finished: boolean } }>();
  private readonly httpTransports = new WeakMap<ConversationSession, HttpTransport>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_FRAME_BYTES, perMessageDeflate: false });

  constructor(options: VoiceGatewayOptions) {
    this.ctx = options.ctx;
    this.facade = options.facade;
    this.helm = options.helm;
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
      defaults: normalizeVoiceSettings(this.ctx.settingsStore.getSettings().helm, DEFAULT_VOICE_SETTINGS),
      activeConversations: this.conversations.size,
    };
  }

  /**
   * Starts hands-free for a chat. One voice conversation speaks for a chat at a time: starting
   * another for the same chat takes over from the first. Conversations for other chats are left alone.
   */
  async createConversation(sessionId: string, settings: unknown): Promise<{ conversationId: string; token: string }> {
    const [session] = await this.ctx.sessionManager.readSessionsFromDisk([sessionId], { includeArchived: true });
    if (!session && !this.helm.isHelmSession(sessionId)) throw new VoiceConversationNotFoundError();
    for (const existing of this.conversations.values()) {
      if (existing.sessionId === sessionId) void existing.end("hands-free started somewhere else");
    }
    const defaults = normalizeVoiceSettings(this.ctx.settingsStore.getSettings().helm, DEFAULT_VOICE_SETTINGS);
    const conversation = new ConversationSession(this, sessionId, normalizeVoiceSettings(settings, defaults));
    const ended = this.recentEnds.get(sessionId);
    this.recentEnds.delete(sessionId);
    if (ended && Date.now() - ended.at <= RESUME_NOTE_WINDOW_MS) {
      conversation.conversation.setResumeNote(buildResumeNote(Date.now() - ended.at, ended.reply));
      if (ended.reply?.text.trim()) conversation.restoreLastSaid(ended.reply.text);
    }
    this.conversations.set(conversation.id, conversation);
    conversation.armGraceTimer();
    return { conversationId: conversation.id, token: conversation.token };
  }

  /** Records that a hands-free connection ended; a takeover is not a drop and leaves no note. */
  noteEnded(sessionId: string, reason: string, reply: { text: string; finished: boolean } | undefined): void {
    if (reason === "hands-free started somewhere else") return;
    this.recentEnds.set(sessionId, { at: Date.now(), ...(reply ? { reply } : {}) });
  }

  /** The chats hands-free is on for right now. */
  activeSessionIds(): string[] {
    return [...new Set([...this.conversations.values()].filter((session) => !session.disposed).map((session) => session.sessionId))];
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
