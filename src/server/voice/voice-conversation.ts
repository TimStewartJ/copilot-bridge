// Hands-free conversation state machine: turn detection, interruption handling and
// speech output pacing. Speech models, the Copilot agent and the client transport are
// injected so the timing logic can be exercised deterministically in tests.
import {
  classifyBargeIn,
  countWords,
  detectLocalCommand,
  isFillerUtterance,
  matchWakePhrase,
  ON_SCREEN_PHRASE,
  SpokenTextFilter,
  stripLeadingWakePhrase,
  takeSpeechChunks,
  toSpeakableText,
} from "./voice-text.js";
import { resolveKokoroVoice, type VoiceSettings } from "./voice-catalog.js";

export const VOICE_SAMPLE_RATE = 16_000;

export type VoiceState =
  | "starting"
  | "listening"
  | "hearing"
  | "endpointing"
  | "thinking"
  | "speaking"
  | "asleep"
  | "ended";

export const VOICE_TIMING = {
  prerollMs: 450,
  continuationPrerollMs: 350,
  bargeInPrerollMs: 300,
  smartTurnCheckOffsetsMs: [0, 250, 550, 900],
  /** Extra wait when every end-of-turn check says the user is clearly mid-thought ("so I was thinking, um"). */
  unfinishedExtensionMs: 1_500,
  unfinishedProbability: 0.15,
  /** Speak a short lead-in if nothing has been said this long after the user finished. */
  fillerDelayMs: 2_000,
  bargeInDuckMs: 250,
  bargeInFirstCheckMs: 450,
  bargeInSecondCheckMs: 1_000,
  bargeInThirdCheckMs: 2_000,
  maxBufferedSpeechSeconds: 6,
  pacingRetryMs: 250,
  playbackIdleGraceMs: 1_200,
  autoSleepMs: 120_000,
  maxTurnSeconds: 60,
  wakeCheckMaxSeconds: 8,
} as const;

export function endpointThreshold(patience: number): number {
  return 0.4 + 0.3 * Math.min(1, Math.max(0, patience));
}

export function endpointFallbackMs(patience: number): number {
  return 700 + 1_100 * Math.min(1, Math.max(0, patience));
}

export interface SpeechSynthesisRequest {
  text: string;
  sid: number;
  speed: number;
  lang: string;
}

export interface SpeechSynthesisHandle {
  done: Promise<{ firstChunkMs: number; totalMs: number }>;
  cancel(): void;
}

export interface VoiceEngineApi {
  pushAudio(streamId: string, pcm: Int16Array): void;
  predictTurn(streamId: string, fromSample: number, toSample: number): Promise<{ probability: number; ms: number }>;
  transcribe(streamId: string, fromSample: number, toSample: number): Promise<{ text: string; ms: number }>;
  synthesize(request: SpeechSynthesisRequest, onChunk: (pcm: Int16Array, sampleRate: number) => void): SpeechSynthesisHandle;
}

export type AgentTurnKind = "user" | "continuation" | "interrupted" | "event" | "greeting";

export interface AgentTurnInput {
  kind: AgentTurnKind;
  text: string;
  /** What the assistant had already said when it was interrupted. */
  interruptedSpeech?: string;
  /** Identity of a typed message, so the chat can reconcile its optimistic copy. */
  clientMessageId?: string;
}

export interface AgentTurnListener {
  /** The turn was handed to the model session; from here on it shows up in the transcript. */
  onStarted?(): void;
  onDelta(text: string): void;
  /** One assistant message within the turn ended; the next one starts a fresh spoken part. */
  onMessageEnd?(): void;
  onToolStart(info: { toolCallId: string; name: string }): void;
  onToolEnd(info: { toolCallId: string; name: string; success: boolean }): void;
  onDone(result: { aborted: boolean; error?: string }): void;
}

export interface AgentTurnHandle {
  abort(): Promise<void>;
}

export interface VoiceAgentApi {
  startTurn(input: AgentTurnInput, listener: AgentTurnListener): AgentTurnHandle;
}

export type VoiceServerEvent =
  | { type: "state"; state: VoiceState }
  | { type: "vad"; speech: boolean }
  | { type: "duck"; on: boolean }
  | { type: "earcon"; kind: "commit" | "wake" | "sleep" | "error" }
  | { type: "smart_turn"; probability: number }
  | { type: "user"; turnId: number; text: string; handled?: "sleep" | "stop" | "end" | "ignored" }
  | { type: "assistant_delta"; genId: number; text: string }
  | { type: "assistant_chunk"; genId: number; chunkId: number; text: string }
  | { type: "assistant_done"; genId: number; text: string; interrupted: boolean }
  | { type: "assistant_discarded"; genId: number }
  | { type: "stop_audio"; genId: number; reason: string }
  | { type: "tool"; genId: number; toolCallId: string; name: string; status: "running" | "done" | "failed" }
  | { type: "metrics"; metrics: TurnMetrics }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string }
  | { type: "end_voice_mode" };

export interface VoiceAudioChunk {
  genId: number;
  chunkId: number;
  sampleRate: number;
  pcm: Int16Array;
}

/** Outcome of handing a typed message to the agent. */
export interface TypedTextDelivery {
  delivered: boolean;
  error?: string;
}

export interface VoiceClientSink {
  send(event: VoiceServerEvent): void;
  sendAudio(chunk: VoiceAudioChunk): void;
}

export interface TurnMetrics {
  turnId: number;
  reason: "smart_turn" | "fallback" | "wake" | "typed" | "event" | "greeting";
  smartTurn: number[];
  endpointMs?: number;
  sttMs?: number;
  llmFirstTextMs?: number;
  /** Time from the end of speech until a spoken lead-in ("One sec.") started while tools ran. */
  fillerMs?: number;
  ttsFirstMs?: number;
  speechEndToFirstAudioMs?: number;
}

export interface VoiceConversationLog {
  (event: string, details?: Record<string, unknown>): void;
}

export interface VoiceTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: VoiceTimers = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

interface EndpointState {
  id: number;
  speechEndSample: number;
  startedAt: number;
  checks: number[];
  timers: unknown[];
  extended?: boolean;
  stt?: { endSample: number; promise: Promise<{ text: string; ms: number }> };
}

interface TurnState {
  id: number;
  startSample: number;
  continuation: boolean;
  endpoint?: EndpointState;
}

interface GenerationState {
  id: number;
  turnId: number;
  kind: AgentTurnKind | "local";
  handle?: AgentTurnHandle;
  text: string;
  pending: string;
  /** Separates what is spoken (sentences) from what is only shown in the chat (structure). */
  speech: SpokenTextFilter;
  /** Whether the assistant message being streamed has produced anything to say yet. */
  messageSpoke: boolean;
  chunkCount: number;
  textChunkCount: number;
  fillerChunkId?: number;
  firstSpeechAudioSent: boolean;
  chunks: Map<number, string>;
  queue: Array<{ chunkId: number; text: string }>;
  synthesis?: SpeechSynthesisHandle;
  agentDone: boolean;
  cancelled: boolean;
  held: boolean;
  heldAudio: VoiceAudioChunk[];
  audioSecondsSent: number;
  firstAudioAt?: number;
  playedChunkIds: Set<number>;
  sleepAfter: boolean;
  metricsSent: boolean;
  metrics: TurnMetrics;
  speechEndAt: number;
  sentAt: number;
  playbackIdleTimer?: unknown;
  pacingTimer?: unknown;
  fillerTimer?: unknown;
}

interface BargeInState {
  startSample: number;
  startedAt: number;
  ended: boolean;
  checking: boolean;
  timers: unknown[];
  duckTimer?: unknown;
}

export interface VoiceConversationOptions {
  streamId: string;
  engine: VoiceEngineApi;
  agent: VoiceAgentApi;
  sink: VoiceClientSink;
  settings: VoiceSettings;
  log?: VoiceConversationLog;
  timers?: VoiceTimers;
}

export class VoiceConversation {
  private readonly streamId: string;
  private readonly engine: VoiceEngineApi;
  private readonly agent: VoiceAgentApi;
  private readonly sink: VoiceClientSink;
  private readonly log: VoiceConversationLog;
  private readonly timers: VoiceTimers;
  private settings: VoiceSettings;
  private stateValue: VoiceState = "starting";
  private sampleIndex = 0;
  private turnSeq = 0;
  private genSeq = 0;
  private endpointSeq = 0;
  private turn?: TurnState;
  private gen?: GenerationState;
  private bargeIn?: BargeInState;
  private sleepSegmentStart?: number;
  private carryText?: string;
  private interruptedSpeech?: string;
  private fillerSeq = 0;
  private lastSpeechAt: number;
  private autoSleepTimer?: unknown;
  private readonly pendingEvents: string[] = [];
  private disposed = false;

  constructor(options: VoiceConversationOptions) {
    this.streamId = options.streamId;
    this.engine = options.engine;
    this.agent = options.agent;
    this.sink = options.sink;
    this.settings = options.settings;
    this.log = options.log ?? (() => {});
    this.timers = options.timers ?? defaultTimers;
    this.lastSpeechAt = this.timers.now();
  }

  get state(): VoiceState {
    return this.stateValue;
  }

  get currentSettings(): VoiceSettings {
    return this.settings;
  }

  updateSettings(settings: VoiceSettings): void {
    this.settings = settings;
  }

  /** Begins listening, optionally greeting the user through the agent first. */
  start(options: { greet: boolean }): void {
    if (options.greet) {
      this.setState("thinking");
      this.startGeneration({ kind: "greeting", text: "" }, { turnId: ++this.turnSeq, reason: "greeting", smartTurn: [] }, this.timers.now());
    } else {
      this.setState("listening");
    }
    this.scheduleAutoSleep();
  }

  pushAudio(pcm: Int16Array): void {
    if (this.disposed || this.stateValue === "ended") return;
    this.sampleIndex += pcm.length;
    this.engine.pushAudio(this.streamId, pcm);
  }

  /** VAD transition reported by the engine for this stream. */
  onVad(speech: boolean, sampleIndex: number): void {
    if (this.disposed) return;
    this.sink.send({ type: "vad", speech });
    if (speech) {
      this.lastSpeechAt = this.timers.now();
      this.scheduleAutoSleep();
    }
    switch (this.stateValue) {
      case "asleep":
        this.onAsleepVad(speech, sampleIndex);
        break;
      case "listening":
        if (speech) this.beginTurn(sampleIndex, VOICE_TIMING.prerollMs, false);
        break;
      case "hearing":
        if (!speech) this.beginEndpointing(sampleIndex);
        break;
      case "endpointing":
        if (speech) {
          this.clearEndpoint();
          this.setState("hearing");
        }
        break;
      case "thinking":
        if (speech) this.onSpeechWhileThinking(sampleIndex);
        break;
      case "speaking":
        this.onSpeakingVad(speech, sampleIndex);
        break;
      default:
        break;
    }
  }

  onPlaybackStarted(genId: number, chunkId: number): void {
    const gen = this.gen;
    if (gen && gen.id === genId) gen.playedChunkIds.add(chunkId);
  }

  onPlaybackIdle(genId: number): void {
    const gen = this.gen;
    if (!gen || gen.id !== genId) return;
    this.maybeFinishGeneration(gen, { playbackIdle: true });
  }

  /**
   * A typed message from the chat composer while hands-free is active. It is always sent to
   * the agent (never treated as filler or a local command) and the reply is spoken.
   */
  submitText(text: string, options: { clientMessageId?: string; onDelivery?: (delivery: TypedTextDelivery) => void } = {}): void {
    const trimmed = text.trim();
    if (this.disposed || !trimmed) {
      options.onDelivery?.({ delivered: false });
      return;
    }
    this.cancelGeneration("typed message");
    this.clearEndpoint();
    this.clearBargeIn();
    this.turn = undefined;
    this.carryText = undefined;
    this.interruptedSpeech = undefined;
    this.lastSpeechAt = this.timers.now();
    this.scheduleAutoSleep();
    const metrics: TurnMetrics = { turnId: ++this.turnSeq, reason: "typed", smartTurn: [] };
    this.sink.send({ type: "user", turnId: metrics.turnId, text: trimmed });
    this.setState("thinking");
    this.startGeneration(
      { kind: "user", text: trimmed, ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}) },
      metrics,
      this.timers.now(),
      options.onDelivery,
    );
  }

  /** Queues a Bridge update for the agent to mention the next time the conversation is idle. */
  enqueueEvent(text: string): void {
    if (this.pendingEvents.length >= 5) this.pendingEvents.shift();
    this.pendingEvents.push(text);
    this.flushPendingEvents();
  }

  sleep(options: { announce: boolean }): void {
    this.cancelGeneration("sleep");
    this.clearEndpoint();
    this.clearBargeIn();
    this.turn = undefined;
    this.carryText = undefined;
    this.sleepSegmentStart = undefined;
    this.setState("asleep");
    this.sink.send({ type: "earcon", kind: "sleep" });
    if (options.announce) this.log("sleep", { reason: "announced" });
  }

  wake(remainder = ""): void {
    if (this.stateValue !== "asleep") return;
    this.sink.send({ type: "earcon", kind: "wake" });
    this.lastSpeechAt = this.timers.now();
    this.scheduleAutoSleep();
    if (countWords(remainder) >= 2) {
      this.setState("thinking");
      void this.handleUserText(remainder, { turnId: ++this.turnSeq, reason: "wake", smartTurn: [] }, this.timers.now(), false);
    } else {
      this.setState("listening");
      this.flushPendingEvents();
    }
  }

  stopSpeaking(): void {
    if (!this.gen) return;
    this.cancelGeneration("user stop");
    if (this.stateValue === "speaking" || this.stateValue === "thinking") this.setState("listening");
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelGeneration("conversation ended");
    this.clearEndpoint();
    this.clearBargeIn();
    if (this.autoSleepTimer) this.timers.clearTimeout(this.autoSleepTimer);
    this.setState("ended");
    this.disposed = true;
  }

  private setState(state: VoiceState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.sink.send({ type: "state", state });
    this.log("state", { state });
    if (state === "listening") this.flushPendingEvents();
  }

  private msToSamples(ms: number): number {
    return Math.round((ms / 1000) * VOICE_SAMPLE_RATE);
  }

  private scheduleAutoSleep(): void {
    if (this.autoSleepTimer) this.timers.clearTimeout(this.autoSleepTimer);
    this.autoSleepTimer = this.timers.setTimeout(() => {
      this.autoSleepTimer = undefined;
      if (this.stateValue === "listening" && this.timers.now() - this.lastSpeechAt >= VOICE_TIMING.autoSleepMs - 50) {
        this.sink.send({ type: "notice", level: "info", message: "Quiet for two minutes, so I'm going to sleep. Say “Hey Bridge” to wake me." });
        this.sleep({ announce: false });
      } else if (this.stateValue !== "asleep" && this.stateValue !== "ended") {
        this.scheduleAutoSleep();
      }
    }, VOICE_TIMING.autoSleepMs);
  }

  // ── Turn detection ─────────────────────────────────────────────

  private beginTurn(sampleIndex: number, prerollMs: number, continuation: boolean): void {
    this.clearEndpoint();
    this.turn = {
      id: ++this.turnSeq,
      startSample: Math.max(0, sampleIndex - this.msToSamples(prerollMs)),
      continuation,
    };
    this.setState("hearing");
  }

  private beginEndpointing(speechEndSample: number): void {
    const turn = this.turn;
    if (!turn) {
      this.setState("listening");
      return;
    }
    const maxSamples = this.msToSamples(VOICE_TIMING.maxTurnSeconds * 1000);
    if (speechEndSample - turn.startSample > maxSamples) turn.startSample = speechEndSample - maxSamples;
    const endpoint: EndpointState = {
      id: ++this.endpointSeq,
      speechEndSample,
      startedAt: this.timers.now(),
      checks: [],
      timers: [],
    };
    turn.endpoint = endpoint;
    this.setState("endpointing");
    endpoint.stt = {
      endSample: speechEndSample,
      promise: this.engine.transcribe(this.streamId, turn.startSample, speechEndSample),
    };
    endpoint.stt.promise.catch(() => undefined);
    for (const offset of VOICE_TIMING.smartTurnCheckOffsetsMs) {
      endpoint.timers.push(this.timers.setTimeout(() => void this.runSmartTurnCheck(turn, endpoint), offset));
    }
    endpoint.timers.push(this.timers.setTimeout(() => this.onEndpointFallback(turn, endpoint), endpointFallbackMs(this.settings.patience)));
  }

  private onEndpointFallback(turn: TurnState, endpoint: EndpointState): void {
    if (this.turn !== turn || turn.endpoint !== endpoint || this.stateValue !== "endpointing") return;
    const clearlyUnfinished = endpoint.checks.length > 0
      && Math.max(...endpoint.checks) < VOICE_TIMING.unfinishedProbability;
    if (clearlyUnfinished && !endpoint.extended) {
      endpoint.extended = true;
      this.log("endpoint_extended", { checks: endpoint.checks });
      endpoint.timers.push(this.timers.setTimeout(() => void this.runSmartTurnCheck(turn, endpoint), VOICE_TIMING.unfinishedExtensionMs / 2));
      endpoint.timers.push(this.timers.setTimeout(() => void this.commitTurn(turn, endpoint, "fallback"), VOICE_TIMING.unfinishedExtensionMs));
      return;
    }
    void this.commitTurn(turn, endpoint, "fallback");
  }

  private async runSmartTurnCheck(turn: TurnState, endpoint: EndpointState): Promise<void> {
    if (this.turn !== turn || turn.endpoint !== endpoint || this.stateValue !== "endpointing") return;
    let probability: number;
    try {
      ({ probability } = await this.engine.predictTurn(this.streamId, turn.startSample, this.sampleIndex));
    } catch (error) {
      this.log("smart_turn_error", { error: String(error) });
      return;
    }
    if (this.turn !== turn || turn.endpoint !== endpoint || this.stateValue !== "endpointing") return;
    endpoint.checks.push(Math.round(probability * 1000) / 1000);
    this.sink.send({ type: "smart_turn", probability });
    if (probability >= endpointThreshold(this.settings.patience)) {
      void this.commitTurn(turn, endpoint, "smart_turn");
    }
  }

  private clearEndpoint(): void {
    const endpoint = this.turn?.endpoint;
    if (!endpoint) return;
    for (const timer of endpoint.timers) this.timers.clearTimeout(timer);
    this.turn!.endpoint = undefined;
  }

  private async commitTurn(turn: TurnState, endpoint: EndpointState, reason: "smart_turn" | "fallback"): Promise<void> {
    if (this.turn !== turn || turn.endpoint !== endpoint || this.stateValue !== "endpointing") return;
    for (const timer of endpoint.timers) this.timers.clearTimeout(timer);
    const committedAt = this.timers.now();
    this.setState("thinking");
    this.sink.send({ type: "earcon", kind: "commit" });
    const metrics: TurnMetrics = {
      turnId: turn.id,
      reason,
      smartTurn: endpoint.checks,
      endpointMs: Math.round(committedAt - endpoint.startedAt + 200),
    };
    let text = "";
    try {
      const result = await endpoint.stt!.promise;
      text = result.text.trim();
      metrics.sttMs = Math.round(result.ms);
    } catch (error) {
      this.log("stt_error", { error: String(error) });
      this.sink.send({ type: "notice", level: "error", message: "Speech recognition failed. Try that again?" });
    }
    if (this.turn !== turn) {
      // The user resumed talking while we were transcribing; merge into the next turn.
      if (text && !isFillerUtterance(text)) this.carryText = [this.carryText, text].filter(Boolean).join(" ");
      return;
    }
    this.turn = undefined;
    this.log("turn", { turnId: turn.id, reason, checks: endpoint.checks, text, sttMs: metrics.sttMs });
    await this.handleUserText(text, metrics, endpoint.startedAt - 200, turn.continuation);
  }

  private async handleUserText(rawText: string, metrics: TurnMetrics, speechEndAt: number, continuation: boolean): Promise<void> {
    let text = stripLeadingWakePhrase(rawText);
    if (this.carryText) {
      text = `${this.carryText} ${text}`.trim();
      this.carryText = undefined;
    }
    const heldGen = this.gen && this.gen.held && !this.gen.cancelled ? this.gen : undefined;

    if (isFillerUtterance(text)) {
      this.sink.send({ type: "user", turnId: metrics.turnId, text: rawText, handled: "ignored" });
      if (heldGen) {
        this.releaseHeld(heldGen);
      } else if (this.stateValue === "thinking" && (!this.gen || this.gen.cancelled)) {
        this.setState("listening");
      }
      return;
    }

    const command = detectLocalCommand(text);
    if (command) {
      this.sink.send({ type: "user", turnId: metrics.turnId, text, handled: command });
      this.log("local_command", { command, text });
      if (command === "end") {
        this.cancelGeneration("end hands-free");
        this.sink.send({ type: "end_voice_mode" });
        return;
      }
      if (command === "sleep") {
        this.cancelGeneration("sleep");
        this.speakLocal("Okay, going quiet.", { sleepAfter: true });
        return;
      }
      this.cancelGeneration("stop command");
      this.setState("listening");
      return;
    }

    this.sink.send({ type: "user", turnId: metrics.turnId, text });
    let kind: AgentTurnKind = "user";
    let interruptedSpeech: string | undefined;
    if (heldGen) this.cancelGeneration("user kept talking");
    if (continuation) {
      kind = "continuation";
    } else if (this.interruptedSpeech) {
      kind = "interrupted";
      interruptedSpeech = this.interruptedSpeech;
    }
    this.interruptedSpeech = undefined;
    this.setState("thinking");
    this.startGeneration({ kind, text, ...(interruptedSpeech ? { interruptedSpeech } : {}) }, metrics, speechEndAt);
  }

  private onSpeechWhileThinking(sampleIndex: number): void {
    const gen = this.gen;
    if (gen && !gen.cancelled && gen.kind !== "local") {
      gen.held = true;
      this.log("hold", { genId: gen.id });
    }
    const continuesUserTurn = !!gen && (gen.kind === "user" || gen.kind === "continuation" || gen.kind === "interrupted");
    this.beginTurn(sampleIndex, VOICE_TIMING.continuationPrerollMs, continuesUserTurn);
  }

  // ── Interruptions ──────────────────────────────────────────────

  private onSpeakingVad(speech: boolean, sampleIndex: number): void {
    const gen = this.gen;
    if (!gen) return;
    if (speech) {
      if (!this.settings.bargeIn || this.bargeIn) return;
      const barge: BargeInState = {
        startSample: sampleIndex,
        startedAt: this.timers.now(),
        ended: false,
        checking: false,
        timers: [],
      };
      this.bargeIn = barge;
      barge.duckTimer = this.timers.setTimeout(() => {
        if (this.bargeIn === barge && !barge.ended) this.sink.send({ type: "duck", on: true });
      }, VOICE_TIMING.bargeInDuckMs);
      barge.timers.push(this.timers.setTimeout(() => void this.checkBargeIn(barge, false), VOICE_TIMING.bargeInFirstCheckMs));
      barge.timers.push(this.timers.setTimeout(() => void this.checkBargeIn(barge, false), VOICE_TIMING.bargeInSecondCheckMs));
      barge.timers.push(this.timers.setTimeout(() => void this.checkBargeIn(barge, false), VOICE_TIMING.bargeInThirdCheckMs));
      return;
    }
    const barge = this.bargeIn;
    if (!barge || barge.ended) return;
    barge.ended = true;
    void this.checkBargeIn(barge, true, sampleIndex);
  }

  private async checkBargeIn(barge: BargeInState, final: boolean, endSample = this.sampleIndex): Promise<void> {
    if (this.bargeIn !== barge || this.stateValue !== "speaking") return;
    if (barge.checking && !final) return;
    barge.checking = true;
    const speechMs = this.timers.now() - barge.startedAt;
    let text = "";
    try {
      ({ text } = await this.engine.transcribe(
        this.streamId,
        Math.max(0, barge.startSample - this.msToSamples(VOICE_TIMING.bargeInPrerollMs)),
        endSample,
      ));
    } catch (error) {
      this.log("barge_in_stt_error", { error: String(error) });
    }
    barge.checking = false;
    if (this.bargeIn !== barge || this.stateValue !== "speaking") return;
    const spoken = this.gen ? this.spokenText(this.gen) : "";
    const verdict = looksLikeEcho(text, spoken) ? (final ? "ignore" : "undecided") : classifyBargeIn(text, { speechMs, final });
    this.log("barge_in_check", { text, speechMs: Math.round(speechMs), final, verdict });
    if (verdict === "stop") {
      this.confirmBargeIn(barge);
    } else if (verdict === "ignore" || final) {
      this.clearBargeIn();
      this.sink.send({ type: "duck", on: false });
    }
  }

  private confirmBargeIn(barge: BargeInState): void {
    const gen = this.gen;
    this.clearBargeIn();
    if (gen) {
      const spoken = this.spokenText(gen);
      this.interruptedSpeech = spoken ? truncate(spoken, 240) : undefined;
      this.cancelGeneration("barge-in");
    }
    this.log("barge_in", { genId: gen?.id });
    this.beginTurn(barge.startSample, VOICE_TIMING.bargeInPrerollMs, false);
    if (barge.ended) this.beginEndpointing(this.sampleIndex);
  }

  private clearBargeIn(): void {
    const barge = this.bargeIn;
    if (!barge) return;
    for (const timer of barge.timers) this.timers.clearTimeout(timer);
    if (barge.duckTimer) this.timers.clearTimeout(barge.duckTimer);
    this.bargeIn = undefined;
  }

  // ── Sleep and wake ─────────────────────────────────────────────

  private onAsleepVad(speech: boolean, sampleIndex: number): void {
    if (speech) {
      this.sleepSegmentStart = Math.max(0, sampleIndex - this.msToSamples(VOICE_TIMING.prerollMs));
      return;
    }
    const start = this.sleepSegmentStart;
    this.sleepSegmentStart = undefined;
    if (start === undefined) return;
    const boundedStart = Math.max(start, sampleIndex - this.msToSamples(VOICE_TIMING.wakeCheckMaxSeconds * 1000));
    void this.engine.transcribe(this.streamId, boundedStart, sampleIndex).then(({ text }) => {
      if (this.stateValue !== "asleep") return;
      const match = matchWakePhrase(text);
      this.log("wake_check", { text, woke: !!match });
      if (match) this.wake(match.remainder);
    }, (error) => this.log("wake_check_error", { error: String(error) }));
  }

  // ── Generation and speech output ───────────────────────────────

  private startGeneration(
    input: AgentTurnInput,
    metrics: TurnMetrics,
    speechEndAt: number,
    onDelivery?: (delivery: TypedTextDelivery) => void,
  ): void {
    const gen = this.createGeneration(input.kind, metrics, speechEndAt);
    this.gen = gen;
    let deliveryReported = false;
    const reportDelivery = (delivery: TypedTextDelivery) => {
      if (deliveryReported) return;
      deliveryReported = true;
      onDelivery?.(delivery);
    };
    if (input.kind === "user" || input.kind === "continuation" || input.kind === "interrupted") {
      const delay = Math.max(0, VOICE_TIMING.fillerDelayMs - (this.timers.now() - speechEndAt));
      gen.fillerTimer = this.timers.setTimeout(() => {
        gen.fillerTimer = undefined;
        if (this.gen === gen && !gen.cancelled) this.maybeSpeakFiller(gen, "slow reply");
      }, delay);
    }
    try {
      gen.handle = this.agent.startTurn(input, {
        onStarted: () => reportDelivery({ delivered: true }),
        onDelta: (delta) => this.onAgentDelta(gen, delta),
        onMessageEnd: () => this.onAgentMessageEnd(gen),
        onToolStart: ({ toolCallId, name }) => {
          if (this.gen === gen && !gen.cancelled) {
            this.sink.send({ type: "tool", genId: gen.id, toolCallId, name, status: "running" });
            this.maybeSpeakFiller(gen, name);
          }
        },
        onToolEnd: ({ toolCallId, name, success }) => {
          if (this.gen === gen && !gen.cancelled) this.sink.send({ type: "tool", genId: gen.id, toolCallId, name, status: success ? "done" : "failed" });
        },
        onDone: ({ aborted, error }) => {
          // Reaching the end without having started means the message never got to the session.
          reportDelivery({ delivered: false, ...(error ? { error } : {}) });
          this.onAgentDone(gen, aborted, error);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportDelivery({ delivered: false, error: message });
      this.onAgentDone(gen, false, message);
    }
  }

  private createGeneration(kind: GenerationState["kind"], metrics: TurnMetrics, speechEndAt: number): GenerationState {
    return {
      id: ++this.genSeq,
      turnId: metrics.turnId,
      kind,
      text: "",
      pending: "",
      speech: new SpokenTextFilter(),
      messageSpoke: false,
      chunkCount: 0,
      textChunkCount: 0,
      firstSpeechAudioSent: false,
      chunks: new Map(),
      queue: [],
      agentDone: false,
      cancelled: false,
      held: false,
      heldAudio: [],
      audioSecondsSent: 0,
      playedChunkIds: new Set(),
      sleepAfter: false,
      metricsSent: false,
      metrics,
      speechEndAt,
      sentAt: this.timers.now(),
    };
  }

  private onAgentDelta(gen: GenerationState, delta: string): void {
    if (this.gen !== gen || gen.cancelled || !delta) return;
    gen.metrics.llmFirstTextMs ??= Math.round(this.timers.now() - gen.sentAt);
    gen.text += delta;
    this.sink.send({ type: "assistant_delta", genId: gen.id, text: delta });
    const spoken = gen.speech.push(delta);
    if (!spoken) return;
    gen.pending += spoken;
    const { chunks, rest } = takeSpeechChunks(gen.pending, { firstChunk: gen.textChunkCount === 0 });
    gen.pending = rest;
    for (const chunk of chunks) this.enqueueChunk(gen, chunk);
  }

  /** A turn can hold several assistant messages (around tool calls); each has its own spoken part. */
  private onAgentMessageEnd(gen: GenerationState): void {
    if (this.gen !== gen || gen.cancelled) return;
    this.flushPendingSpeech(gen);
    gen.speech.reset();
    gen.messageSpoke = false;
    if (gen.text && !/\s$/.test(gen.text)) gen.text += "\n\n";
  }

  private flushPendingSpeech(gen: GenerationState): void {
    const pending = gen.pending + gen.speech.flush();
    gen.pending = "";
    if (pending.trim()) {
      const { chunks } = takeSpeechChunks(pending, { firstChunk: gen.textChunkCount === 0, flush: true });
      for (const chunk of chunks) this.enqueueChunk(gen, chunk);
    }
    // A reply that is nothing but a list or a table would otherwise land in silence.
    if (!gen.messageSpoke && gen.speech.withheld) this.enqueueChunk(gen, ON_SCREEN_PHRASE);
  }

  private maybeSpeakFiller(gen: GenerationState, toolName: string): void {
    if (gen.held || gen.fillerChunkId !== undefined || gen.chunkCount > 0 || gen.text.trim()) return;
    if (gen.kind !== "user" && gen.kind !== "continuation" && gen.kind !== "interrupted") return;
    if (INSTANT_TOOLS.has(toolName)) return;
    const text = FILLER_PHRASES[this.fillerSeq++ % FILLER_PHRASES.length]!;
    gen.fillerChunkId = gen.chunkCount + 1;
    this.enqueueChunk(gen, text, { filler: true });
  }

  private onAgentDone(gen: GenerationState, aborted: boolean, error?: string): void {
    if (gen.agentDone) return;
    gen.agentDone = true;
    if (this.gen !== gen || gen.cancelled) return;
    if (error) {
      this.log("agent_error", { genId: gen.id, error });
      this.sink.send({ type: "notice", level: "error", message: error });
      if (!gen.text.trim()) this.enqueueChunk(gen, "Sorry, I couldn't reach Copilot just now.");
    }
    this.flushPendingSpeech(gen);
    this.sink.send({ type: "assistant_done", genId: gen.id, text: gen.text, interrupted: aborted });
    this.log("assistant", { genId: gen.id, text: gen.text, aborted });
    this.maybeFinishGeneration(gen, { playbackIdle: false });
  }

  private speakLocal(text: string, options: { sleepAfter: boolean }): void {
    const gen = this.createGeneration("local", { turnId: ++this.turnSeq, reason: "event", smartTurn: [] }, this.timers.now());
    gen.agentDone = true;
    gen.sleepAfter = options.sleepAfter;
    gen.text = text;
    this.gen = gen;
    if (options.sleepAfter) {
      this.setState("asleep");
      this.sink.send({ type: "earcon", kind: "sleep" });
    } else {
      this.setState("thinking");
    }
    this.sink.send({ type: "assistant_delta", genId: gen.id, text });
    this.enqueueChunk(gen, text);
    this.sink.send({ type: "assistant_done", genId: gen.id, text, interrupted: false });
  }

  private enqueueChunk(gen: GenerationState, rawText: string, options: { filler?: boolean } = {}): void {
    const text = toSpeakableText(rawText);
    if (!text) return;
    const chunkId = ++gen.chunkCount;
    if (!options.filler) {
      gen.textChunkCount++;
      gen.messageSpoke = true;
    }
    gen.chunks.set(chunkId, text);
    gen.queue.push({ chunkId, text });
    this.pumpSpeech(gen);
  }

  private bufferedSeconds(gen: GenerationState): number {
    if (gen.firstAudioAt === undefined) return gen.audioSecondsSent;
    return gen.audioSecondsSent - (this.timers.now() - gen.firstAudioAt) / 1000;
  }

  private pumpSpeech(gen: GenerationState): void {
    if (this.gen !== gen || gen.cancelled || gen.synthesis || gen.queue.length === 0) return;
    if (this.bufferedSeconds(gen) > VOICE_TIMING.maxBufferedSpeechSeconds) {
      if (!gen.pacingTimer) {
        gen.pacingTimer = this.timers.setTimeout(() => {
          gen.pacingTimer = undefined;
          this.pumpSpeech(gen);
        }, VOICE_TIMING.pacingRetryMs);
      }
      return;
    }
    const next = gen.queue.shift()!;
    const voice = resolveKokoroVoice(this.settings.voice);
    const startedAt = this.timers.now();
    let first = true;
    const handle = this.engine.synthesize(
      { text: next.text, sid: voice.sid, speed: this.settings.speed, lang: voice.lang },
      (pcm, sampleRate) => {
        if (this.gen !== gen || gen.cancelled) return;
        if (first) {
          first = false;
          this.sink.send({ type: "assistant_chunk", genId: gen.id, chunkId: next.chunkId, text: next.text });
          if (next.chunkId === gen.fillerChunkId) {
            gen.metrics.fillerMs = Math.round(this.timers.now() - gen.speechEndAt);
          } else if (!gen.firstSpeechAudioSent) {
            gen.firstSpeechAudioSent = true;
            gen.metrics.ttsFirstMs = Math.round(this.timers.now() - startedAt);
            gen.metrics.speechEndToFirstAudioMs = Math.round(this.timers.now() - gen.speechEndAt);
          }
        }
        const chunk: VoiceAudioChunk = { genId: gen.id, chunkId: next.chunkId, sampleRate, pcm };
        if (gen.held) {
          gen.heldAudio.push(chunk);
        } else {
          this.emitAudio(gen, chunk);
        }
      },
    );
    gen.synthesis = handle;
    handle.done.then(
      () => undefined,
      (error) => {
        if (!gen.cancelled) this.log("tts_error", { genId: gen.id, error: String(error) });
      },
    ).finally(() => {
      if (gen.synthesis === handle) gen.synthesis = undefined;
      if (this.gen !== gen || gen.cancelled) return;
      this.pumpSpeech(gen);
      this.maybeFinishGeneration(gen, { playbackIdle: false });
    });
  }

  private emitAudio(gen: GenerationState, chunk: VoiceAudioChunk): void {
    if (gen.firstAudioAt === undefined) {
      gen.firstAudioAt = this.timers.now();
      if (gen.sleepAfter) {
        this.log("goodbye_audio", { genId: gen.id });
      } else if (this.stateValue === "thinking") {
        this.setState("speaking");
      }
    }
    gen.audioSecondsSent += chunk.pcm.length / chunk.sampleRate;
    this.sink.sendAudio(chunk);
  }

  private releaseHeld(gen: GenerationState): void {
    gen.held = false;
    this.log("release_hold", { genId: gen.id, chunks: gen.heldAudio.length });
    const held = gen.heldAudio.splice(0);
    if (held.length === 0 && !gen.agentDone) {
      this.setState("thinking");
      return;
    }
    if (held.length > 0) this.setState("thinking");
    for (const chunk of held) this.emitAudio(gen, chunk);
    this.maybeFinishGeneration(gen, { playbackIdle: false });
  }

  private spokenText(gen: GenerationState): string {
    return [...gen.playedChunkIds].sort((a, b) => a - b).map((id) => gen.chunks.get(id)).filter(Boolean).join(" ");
  }

  private maybeFinishGeneration(gen: GenerationState, options: { playbackIdle: boolean }): void {
    if (this.gen !== gen || gen.cancelled || gen.held) return;
    if (!gen.agentDone || gen.synthesis || gen.queue.length > 0) return;
    if (!gen.metricsSent) {
      gen.metricsSent = true;
      if (gen.kind !== "local") {
        this.sink.send({ type: "metrics", metrics: gen.metrics });
        this.log("metrics", { ...gen.metrics });
      }
    }
    const remainingMs = gen.firstAudioAt === undefined
      ? 0
      : Math.max(0, gen.firstAudioAt + gen.audioSecondsSent * 1000 - this.timers.now());
    if (!options.playbackIdle && remainingMs > 0) {
      if (gen.playbackIdleTimer) this.timers.clearTimeout(gen.playbackIdleTimer);
      gen.playbackIdleTimer = this.timers.setTimeout(() => this.finishGeneration(gen), remainingMs + VOICE_TIMING.playbackIdleGraceMs);
      return;
    }
    this.finishGeneration(gen);
  }

  private finishGeneration(gen: GenerationState): void {
    if (this.gen !== gen || gen.cancelled) return;
    if (gen.playbackIdleTimer) this.timers.clearTimeout(gen.playbackIdleTimer);
    this.gen = undefined;
    this.clearBargeIn();
    if (gen.sleepAfter) {
      if (this.stateValue !== "asleep") this.setState("asleep");
      return;
    }
    if (this.stateValue === "speaking" || this.stateValue === "thinking") this.setState("listening");
  }

  private cancelGeneration(reason: string): void {
    const gen = this.gen;
    if (!gen || gen.cancelled) return;
    gen.cancelled = true;
    this.gen = undefined;
    gen.queue.length = 0;
    gen.heldAudio.length = 0;
    gen.synthesis?.cancel();
    if (gen.pacingTimer) this.timers.clearTimeout(gen.pacingTimer);
    if (gen.playbackIdleTimer) this.timers.clearTimeout(gen.playbackIdleTimer);
    if (gen.fillerTimer) this.timers.clearTimeout(gen.fillerTimer);
    if (gen.firstAudioAt !== undefined || gen.audioSecondsSent > 0) {
      this.sink.send({ type: "stop_audio", genId: gen.id, reason });
    } else if (gen.text.trim()) {
      // Nothing of this answer was heard (it was held while the user kept talking).
      this.sink.send({ type: "assistant_discarded", genId: gen.id });
    }
    if (!gen.agentDone && gen.handle) {
      void gen.handle.abort().catch((error) => this.log("abort_error", { error: String(error) }));
    }
    this.log("cancel_generation", { genId: gen.id, reason });
  }

  private flushPendingEvents(): void {
    if (this.stateValue !== "listening" || this.gen || this.turn || this.pendingEvents.length === 0) return;
    const text = this.pendingEvents.splice(0).join("\n");
    this.setState("thinking");
    this.startGeneration({ kind: "event", text }, { turnId: ++this.turnSeq, reason: "event", smartTurn: [] }, this.timers.now());
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const FILLER_PHRASES = ["One sec.", "Let me check.", "Checking now.", "Give me a second.", "On it."];
const INSTANT_TOOLS = new Set(["hands_free"]);

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/** True when a "user" transcript is mostly the assistant's own recent speech leaking into the mic. */
export function looksLikeEcho(transcript: string, spokenText: string): boolean {
  const heard = words(transcript);
  if (heard.length < 3 || !spokenText) return false;
  const spoken = new Set(words(spokenText.slice(-400)));
  const overlap = heard.filter((word) => spoken.has(word)).length;
  return overlap / heard.length >= 0.75;
}
