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
import type { LocalVoiceCommand } from "./voice-text.js";
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
  /**
   * Speak a short "One sec." if the agent has said nothing this long after it was asked. The
   * hands-free layer normally acknowledges within about two seconds (26 Oct 2026, in the Bridge),
   * so this covers a slow one.
   */
  fillerDelayMs: 3_000,
  /**
   * While a reply is still being worked out, say so again when this long has passed in silence since
   * the last thing said: first gap, second gap, and so on, the last one repeating. On 6 Oct 2026 a
   * 19-second lookup followed "One sec." with 15 s of silence in a car, and the user hung up one
   * second before the reply.
   */
  progressDelaysMs: [8_000, 12_000, 20_000, 30_000],
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

/**
 * user/continuation/interrupted: something the user said, for the agent to decide about. typed: a
 * message typed while hands-free is on, sent as it is. command: a short command caught locally.
 */
export type AgentTurnKind = "user" | "continuation" | "interrupted" | "event" | "greeting" | "typed" | "command";

export interface AgentTurnInput {
  kind: AgentTurnKind;
  text: string;
  command?: LocalVoiceCommand;
  /** What the assistant had already said when it was interrupted. */
  interruptedSpeech?: string;
  /** Identity of a typed message, so the chat can reconcile its optimistic copy. */
  clientMessageId?: string;
  /** Context for the model about how this hands-free connection started (see setResumeNote). */
  resumeNote?: string;
}

export interface AgentTurnListener {
  /** The message reached the chat; from here on it shows up in the transcript. */
  onStarted?(): void;
  onDelta(text: string): void;
  /** One spoken part ended; the next one starts fresh. */
  onMessageEnd?(): void;
  /**
   * `handled` says what became of what the user said: "sent" to the chat, "not_sent" (heard but not
   * meant for it), "end" (leave hands-free), or a command the agent answered itself.
   */
  onDone(result: { aborted: boolean; error?: string; handled?: string }): void;
}

export interface AgentTurnHandle {
  /** Stops the turn's speech and anything not yet sent. Never stops the chat's own work. */
  abort(): Promise<void>;
}

/** Something the agent wants to say on its own: a reply read back, progress, a notice. */
export interface AgentSpeech {
  /** Speech with the same key replaces what is still waiting to be said. */
  key: string;
  text: string;
  kind: "readback" | "notice" | "progress" | "announce";
  /** Checked again just before speaking; false drops it. */
  valid?(): boolean;
  /** It ended with an offer to read the whole reply. */
  offer?: boolean;
  /** Called once it starts playing. */
  onSpoken?(): void;
}

export interface VoiceAgentOutput {
  say(item: AgentSpeech): void;
  drop(predicate: (item: AgentSpeech) => boolean): void;
}

export interface VoiceAgentApi {
  startTurn(input: AgentTurnInput, listener: AgentTurnListener): AgentTurnHandle;
  /** Gives the agent a way to speak on its own. */
  bindOutput?(output: VoiceAgentOutput): void;
  /** True while the agent has work in hand (the chat is working, a reply is being prepared): no auto-sleep. */
  isBusy?(): boolean;
}

const SPEECH_PRIORITY: Record<AgentSpeech["kind"], number> = { readback: 0, notice: 1, progress: 2, announce: 3 };
/** Cancellations that mean "the user is saying something else", after which unheard agent speech waits its turn. */
const REQUEUE_REASONS: ReadonlySet<string> = new Set(["user kept talking", "typed message"]);

export type VoiceServerEvent =
  | { type: "state"; state: VoiceState }
  | { type: "vad"; speech: boolean }
  | { type: "duck"; on: boolean }
  | { type: "earcon"; kind: "commit" | "wake" | "sleep" | "error" }
  | { type: "smart_turn"; probability: number }
  | { type: "user"; turnId: number; text: string; handled?: string }
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
  /** What the user said, for turns they authored. */
  userText?: string;
  /** Speech the agent asked for on its own; put back in the queue if it is dropped unheard. */
  agentSpeech?: AgentSpeech;
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
  /** The "still working" lines said during a long silent wait; they are not part of the reply. */
  progressChunkIds: Set<number>;
  firstSpeechAudioSent: boolean;
  chunks: Map<number, string>;
  queue: Array<{ chunkId: number; text: string }>;
  synthesis?: SpeechSynthesisHandle;
  agentDone: boolean;
  cancelled: boolean;
  held: boolean;
  heldAudio: VoiceAudioChunk[];
  /** Everything emitted for this reply, so a client that reconnects mid-reply can hear what it missed. */
  sentAudio: VoiceAudioChunk[];
  audioSecondsSent: number;
  firstAudioAt?: number;
  /** When everything sent so far will have finished playing, allowing for silent gaps between parts. */
  playbackEndsAt?: number;
  playedChunkIds: Set<number>;
  sleepAfter: boolean;
  metricsSent: boolean;
  metrics: TurnMetrics;
  speechEndAt: number;
  sentAt: number;
  playbackIdleTimer?: unknown;
  pacingTimer?: unknown;
  fillerTimer?: unknown;
  progressTimer?: unknown;
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

export class VoiceConversation implements VoiceAgentOutput {
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
  private resumeNote?: string;
  private lastReplyState?: { genId: number; text: string; finished: boolean };
  private fillerSeq = 0;
  private progressSeq = 0;
  private lastSpeechAt: number;
  private autoSleepTimer?: unknown;
  private pendingSpeech: AgentSpeech[] = [];
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
    this.agent.bindOutput?.(this);
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

  /**
   * Hands-free restarted soon after the last connection ended (a dropped call, most likely): the
   * next thing the user says reaches the model with this note, so it can offer to repeat itself.
   */
  setResumeNote(note: string): void {
    this.resumeNote = note;
  }

  /** The newest reply and whether it played to the end, for the note the next connection gets. */
  lastReply(): { text: string; finished: boolean } | undefined {
    const reply = this.lastReplyState;
    return reply && reply.text.trim() ? { text: reply.text, finished: reply.finished } : undefined;
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
   * A message typed while hands-free is active (Tether sends these). It always goes to the chat
   * as it is (never treated as filler or a command); the reply is read back like any other.
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
      { kind: "typed", text: trimmed, ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}) },
      metrics,
      this.timers.now(),
      options.onDelivery,
    );
  }

  /** Queues something the agent wants to say; it is spoken once the user isn't talking. */
  say(item: AgentSpeech): void {
    if (this.disposed) return;
    this.pendingSpeech = this.pendingSpeech.filter((pending) => pending.key !== item.key);
    this.pendingSpeech.push(item);
    // Too much waiting: the least important (oldest first) goes, so announcements never push out a reply.
    while (this.pendingSpeech.length > 8) {
      const worst = this.pendingSpeech.reduce((least, candidate) => (SPEECH_PRIORITY[candidate.kind] > SPEECH_PRIORITY[least.kind] ? candidate : least));
      this.pendingSpeech = this.pendingSpeech.filter((pending) => pending !== worst);
    }
    this.flushAgentSpeech();
  }

  drop(predicate: (item: AgentSpeech) => boolean): void {
    this.pendingSpeech = this.pendingSpeech.filter((item) => !predicate(item));
    const gen = this.gen;
    // Not started playing yet (or held while the user talks): it can still be taken back.
    if (gen?.agentSpeech && predicate(gen.agentSpeech) && gen.firstAudioAt === undefined) {
      gen.agentSpeech = undefined;
      this.cancelGeneration("no longer relevant");
      if (this.stateValue === "thinking") this.setState("listening");
    }
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
      this.flushAgentSpeech();
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
    if (state === "listening") this.flushAgentSpeech();
  }

  private msToSamples(ms: number): number {
    return Math.round((ms / 1000) * VOICE_SAMPLE_RATE);
  }

  private scheduleAutoSleep(): void {
    if (this.autoSleepTimer) this.timers.clearTimeout(this.autoSleepTimer);
    this.autoSleepTimer = this.timers.setTimeout(() => {
      this.autoSleepTimer = undefined;
      // While the chat is working, its reply is still to come: stay awake for it.
      if (this.stateValue === "listening" && this.timers.now() - this.lastSpeechAt >= VOICE_TIMING.autoSleepMs - 50
        && !this.agent.isBusy?.() && this.pendingSpeech.length === 0) {
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

    let command = detectLocalCommand(text);
    // "Cancel that" with nothing running is just "be quiet".
    if (command === "cancel" && !this.agent.isBusy?.()) command = "stop";
    if (command === "end" || command === "sleep" || command === "stop") {
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
      // Stops speech only; the chat's work carries on.
      this.cancelGeneration("stop command");
      this.setState("listening");
      return;
    }
    if (command) {
      this.sink.send({ type: "user", turnId: metrics.turnId, text, handled: command });
      this.log("local_command", { command, text });
      if (heldGen) this.cancelGeneration("user kept talking");
      this.interruptedSpeech = undefined;
      this.setState("thinking");
      this.startGeneration({ kind: "command", command, text }, metrics, speechEndAt);
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
    if (this.resumeNote && (input.kind === "user" || input.kind === "continuation" || input.kind === "interrupted")) {
      input = { ...input, resumeNote: this.resumeNote };
      this.resumeNote = undefined;
    }
    const gen = this.createGeneration(input.kind, metrics, speechEndAt);
    if (input.kind !== "event" && input.kind !== "greeting") gen.userText = input.text;
    this.gen = gen;
    let deliveryReported = false;
    const reportDelivery = (delivery: TypedTextDelivery) => {
      if (deliveryReported) return;
      deliveryReported = true;
      onDelivery?.(delivery);
    };
    if (input.kind === "user" || input.kind === "continuation" || input.kind === "interrupted" || input.kind === "command") {
      // The agent normally answers within a second or two; this covers a slow one. Counted from now,
      // not from the end of speech: transcribing a long request can take a second by itself.
      const delay = VOICE_TIMING.fillerDelayMs;
      gen.fillerTimer = this.timers.setTimeout(() => {
        gen.fillerTimer = undefined;
        if (this.gen === gen && !gen.cancelled) this.maybeSpeakFiller(gen);
      }, delay);
    }
    try {
      gen.handle = this.agent.startTurn(input, {
        onStarted: () => reportDelivery({ delivered: true }),
        onDelta: (delta) => this.onAgentDelta(gen, delta),
        onMessageEnd: () => this.onAgentMessageEnd(gen),
        onDone: ({ aborted, error, handled }) => {
          // Reaching the end without having started means the message never got to the session.
          reportDelivery({ delivered: false, ...(error ? { error } : {}) });
          this.onAgentHandled(gen, handled);
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
      progressChunkIds: new Set(),
      firstSpeechAudioSent: false,
      chunks: new Map(),
      queue: [],
      agentDone: false,
      cancelled: false,
      held: false,
      heldAudio: [],
      sentAudio: [],
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

  /** What became of what the user said: shown on screen; leaving ends hands-free. */
  private onAgentHandled(gen: GenerationState, handled: string | undefined): void {
    if (!handled || gen.userText === undefined) return;
    if (handled === "end") {
      this.cancelGeneration("end hands-free");
      this.sink.send({ type: "end_voice_mode" });
      return;
    }
    if (handled === "not_sent") this.sink.send({ type: "user", turnId: gen.turnId, text: gen.userText, handled });
  }

  private maybeSpeakFiller(gen: GenerationState): void {
    if (gen.held || gen.fillerChunkId !== undefined || gen.chunkCount > 0 || gen.text.trim()) return;
    if (gen.kind !== "user" && gen.kind !== "continuation" && gen.kind !== "interrupted" && gen.kind !== "command") return;
    const text = FILLER_PHRASES[this.fillerSeq++ % FILLER_PHRASES.length]!;
    gen.fillerChunkId = gen.chunkCount + 1;
    this.enqueueChunk(gen, text, { filler: true });
  }

  private remainingPlaybackMs(gen: GenerationState): number {
    return gen.playbackEndsAt === undefined ? 0 : Math.max(0, gen.playbackEndsAt - this.timers.now());
  }

  /**
   * Starts the wait for the next "still working" line, counted from the end of what is playing now.
   * Called each time something has been said, so only silence lets the wait run out.
   */
  private scheduleProgress(gen: GenerationState): void {
    if (gen.progressTimer) this.timers.clearTimeout(gen.progressTimer);
    gen.progressTimer = undefined;
    if (this.gen !== gen || gen.cancelled || gen.agentDone) return;
    if (gen.kind !== "user" && gen.kind !== "continuation" && gen.kind !== "interrupted") return;
    const delays = VOICE_TIMING.progressDelaysMs;
    const delay = delays[Math.min(gen.progressChunkIds.size, delays.length - 1)]!;
    gen.progressTimer = this.timers.setTimeout(() => {
      gen.progressTimer = undefined;
      this.speakProgress(gen);
    }, this.remainingPlaybackMs(gen) + delay);
  }

  private speakProgress(gen: GenerationState): void {
    if (this.gen !== gen || gen.cancelled || gen.agentDone) return;
    // The user is talking: a held reply is released or replaced, and both start the wait again.
    if (gen.held) return;
    if (this.bargeIn || gen.synthesis || gen.queue.length > 0 || this.remainingPlaybackMs(gen) > 0) {
      this.scheduleProgress(gen);
      return;
    }
    const text = PROGRESS_PHRASES[this.progressSeq++ % PROGRESS_PHRASES.length]!;
    gen.progressChunkIds.add(gen.chunkCount + 1);
    this.log("progress", { genId: gen.id, text, ms: Math.round(this.timers.now() - gen.speechEndAt) });
    this.enqueueChunk(gen, text, { filler: true });
  }

  private onAgentDone(gen: GenerationState, aborted: boolean, error?: string): void {
    if (gen.agentDone) return;
    gen.agentDone = true;
    if (gen.progressTimer) this.timers.clearTimeout(gen.progressTimer);
    gen.progressTimer = undefined;
    if (this.gen !== gen || gen.cancelled) return;
    if (error) {
      this.log("agent_error", { genId: gen.id, error });
      this.sink.send({ type: "notice", level: "error", message: error });
      if (!gen.text.trim()) this.enqueueChunk(gen, "Sorry, that didn't go through.");
    }
    this.flushPendingSpeech(gen);
    if (gen.kind !== "local") this.lastReplyState = { genId: gen.id, text: gen.text, finished: false };
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
          } else if (!gen.firstSpeechAudioSent && !gen.progressChunkIds.has(next.chunkId)) {
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
      this.scheduleProgress(gen);
      this.maybeFinishGeneration(gen, { playbackIdle: false });
    });
  }

  private emitAudio(gen: GenerationState, chunk: VoiceAudioChunk): void {
    if (gen.firstAudioAt === undefined) {
      gen.firstAudioAt = this.timers.now();
      gen.agentSpeech?.onSpoken?.();
      if (gen.sleepAfter) {
        this.log("goodbye_audio", { genId: gen.id });
      } else if (this.stateValue === "thinking") {
        this.setState("speaking");
      }
    }
    const now = this.timers.now();
    gen.audioSecondsSent += chunk.pcm.length / chunk.sampleRate;
    gen.playbackEndsAt = Math.max(gen.playbackEndsAt ?? now, now) + (chunk.pcm.length / chunk.sampleRate) * 1000;
    gen.sentAudio.push(chunk);
    this.sink.sendAudio(chunk);
  }

  /**
   * A client that reconnected mid-reply missed the audio sent while it was away (and may have dropped
   * what it had queued but not started). Sends every chunk of the current reply it has not started
   * playing again, in order, and restarts the playback clock. Returns how many audio pieces were sent.
   */
  resendUnplayedAudio(): number {
    const gen = this.gen;
    if (!gen || gen.cancelled || gen.held) return 0;
    const missing = gen.sentAudio.filter((chunk) => !gen.playedChunkIds.has(chunk.chunkId));
    if (missing.length === 0) return 0;
    gen.firstAudioAt = this.timers.now();
    gen.audioSecondsSent = 0;
    for (const chunk of missing) {
      gen.audioSecondsSent += chunk.pcm.length / chunk.sampleRate;
      this.sink.sendAudio(chunk);
    }
    gen.playbackEndsAt = gen.firstAudioAt + gen.audioSecondsSent * 1000;
    this.log("resend_audio", { genId: gen.id, chunks: missing.length });
    this.maybeFinishGeneration(gen, { playbackIdle: false });
    return missing.length;
  }

  private releaseHeld(gen: GenerationState): void {
    // The agent's own speech may have stopped being worth saying while the user talked.
    if (gen.agentSpeech?.valid && !gen.agentSpeech.valid()) {
      gen.agentSpeech = undefined;
      this.cancelGeneration("no longer relevant");
      this.setState("listening");
      return;
    }
    gen.held = false;
    this.log("release_hold", { genId: gen.id, chunks: gen.heldAudio.length });
    const held = gen.heldAudio.splice(0);
    if (held.length === 0 && !gen.agentDone) {
      this.setState("thinking");
      this.scheduleProgress(gen);
      return;
    }
    if (held.length > 0) this.setState("thinking");
    for (const chunk of held) this.emitAudio(gen, chunk);
    this.scheduleProgress(gen);
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
    // Counted from the end of the last part, not from the first: a reply that follows its lead-in
    // after a long lookup is still playing when its synthesis ends.
    const remainingMs = this.remainingPlaybackMs(gen);
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
    if (this.lastReplyState?.genId === gen.id) this.lastReplyState.finished = true;
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
    // The agent's own speech that nobody heard because the user started talking first waits for the
    // next gap. Asked to be quiet, it is dropped.
    if (REQUEUE_REASONS.has(reason) && gen.agentSpeech && gen.firstAudioAt === undefined
      && !this.pendingSpeech.some((item) => item.key === gen.agentSpeech!.key)) {
      this.pendingSpeech.unshift(gen.agentSpeech);
    }
    gen.queue.length = 0;
    gen.heldAudio.length = 0;
    gen.synthesis?.cancel();
    if (gen.pacingTimer) this.timers.clearTimeout(gen.pacingTimer);
    if (gen.playbackIdleTimer) this.timers.clearTimeout(gen.playbackIdleTimer);
    if (gen.fillerTimer) this.timers.clearTimeout(gen.fillerTimer);
    if (gen.progressTimer) this.timers.clearTimeout(gen.progressTimer);
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

  private flushAgentSpeech(): void {
    if (this.stateValue !== "listening" || this.gen || this.turn) return;
    let next: AgentSpeech | undefined;
    while (!next && this.pendingSpeech.length > 0) {
      const ordered = [...this.pendingSpeech].sort((a, b) => SPEECH_PRIORITY[a.kind] - SPEECH_PRIORITY[b.kind]);
      const candidate = ordered[0]!;
      this.pendingSpeech = this.pendingSpeech.filter((item) => item !== candidate);
      if (!candidate.valid || candidate.valid()) next = candidate;
    }
    if (!next) return;
    this.speakAgentSpeech(next);
  }

  /** Speaks something the agent asked for on its own. Like a reply, it waits for and yields to the user. */
  private speakAgentSpeech(item: AgentSpeech): void {
    const gen = this.createGeneration("event", { turnId: ++this.turnSeq, reason: "event", smartTurn: [] }, this.timers.now());
    gen.agentSpeech = item;
    this.gen = gen;
    this.setState("thinking");
    this.log("agent_speech", { genId: gen.id, kind: item.kind, key: item.key });
    this.onAgentDelta(gen, item.text);
    this.onAgentMessageEnd(gen);
    this.onAgentDone(gen, false);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const FILLER_PHRASES = ["One sec.", "Just a sec.", "Give me a second."];
/** Said during a long wait. They claim nothing about the answer and differ from the lead-ins. */
const PROGRESS_PHRASES = ["Still working on it.", "Still on it, one moment.", "This is taking a little longer.", "Still here, still working."];

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * True when a "user" transcript is mostly the assistant's own recent speech leaking into the mic.
 * Short ones count too: on a phone speaker the Bridge heard its own "One sec." and "Let me check." (as
 * "Let me change.") and cancelled its answer three times (23 Sep 2026). A short transcript is echo when
 * it appears word for word in what was just said, or shares two of its three words with it.
 */
export function looksLikeEcho(transcript: string, spokenText: string): boolean {
  const heard = words(transcript);
  if (heard.length === 0 || !spokenText) return false;
  const recent = words(spokenText.slice(-400));
  const spoken = new Set(recent);
  const overlap = heard.filter((word) => spoken.has(word)).length;
  if (heard.length <= 3) {
    const phrase = ` ${heard.join(" ")} `;
    return ` ${recent.join(" ")} `.includes(phrase) || (heard.length === 3 && overlap >= 2);
  }
  return overlap / heard.length >= 0.75;
}
