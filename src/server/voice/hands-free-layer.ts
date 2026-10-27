// The hands-free layer: speaks for one ordinary Bridge chat. The chat stays exactly as it is (it
// gets the user's words as plain messages and writes normal replies); this layer decides what each
// thing the user says is for, sends or steers, follows the chat's runs, and turns replies and
// progress into speech. Its decisions and spoken lines come from a small fast model
// (hands-free-model.ts); short commands and plain short replies need no model at all.
import type { StreamEvent } from "../event-bus.js";
import type {
  AgentSpeech,
  AgentTurnHandle,
  AgentTurnInput,
  AgentTurnListener,
  VoiceAgentApi,
  VoiceAgentOutput,
} from "./voice-conversation.js";
import { countWords, SpokenTextFilter, toSpeakableText } from "./voice-text.js";
import type { HandsFreeActivity, HandsFreeModel, HandsFreeRouteContext } from "./hands-free-model.js";

export type ChatDelivery = "started" | "steered" | "queued" | "command";
export type ReadbackPreference = "full" | "summary";

/** What the layer needs from the chat it speaks for. */
export interface HandsFreeChat {
  isBusy(): boolean;
  /** The chat's current run, or undefined when it has none. */
  getBus(): { subscribe(listener: (event: StreamEvent) => void): () => void; readonly complete: boolean } | undefined;
  /** Sends like the chat composer: starts a run when idle, steers a running one, queues when it can't. */
  deliver(text: string, clientMessageId?: string): Promise<ChatDelivery>;
  abort(): Promise<unknown>;
  title(): Promise<string | undefined>;
  warm(): Promise<unknown>;
}

export interface HandsFreeLayerOptions {
  chat: HandsFreeChat;
  model: Pick<HandsFreeModel, "warm" | "route" | "speak" | "progress" | "announce">;
  /** Bridge-wide status events, to notice runs the chat starts by other means (typed, scheduled). */
  subscribeStatus(listener: (event: { type: string; sessionId?: string }) => void): () => void;
  sessionId: string;
  glossary?: () => string | undefined;
  /** Whether replies in this chat are read in full or summarized; kept across connections. */
  preference: { get(): ReadbackPreference | undefined; set(value: ReadbackPreference): void };
  /** The chat started or stopped working, for the dock. */
  onRunState?(state: { working: boolean; startedAt?: number }): void;
  log?(event: string, details?: Record<string, unknown>): void;
  timers?: LayerTimers;
}

export interface LayerTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: LayerTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** When to say how a long run is going, counted from its start: 20 s, 50 s, then every 90 s. */
export function autoProgressAt(count: number): number {
  return count === 0 ? 20_000 : 50_000 + 90_000 * (count - 1);
}
/** A reply read word for word needs no model: plain sentences and at most this many words. */
export const VERBATIM_MAX_WORDS = 60;

const ACKS_STARTED = ["On it.", "Okay, on it.", "Got it."];
const ACK_STEERED = "Got it, I'll pass that on.";
const ACK_QUEUED = "It's busy, so I'll send that as soon as it's free.";
const OFFER_RE = /\b(?:read (?:you )?(?:the )?whole thing|read (?:it|you) (?:all|in full))\b/i;

interface WatchedRun {
  runId: string;
  startedAt: number;
  steps: string[];
  toolSteps: Map<string, number>;
  /** Steps already covered by the last progress line. */
  reportedSteps: number;
  progressTimer?: unknown;
  progressCount: number;
  /** Questions shown on screen and not yet answered, by request id. */
  questions: Map<string, string>;
  cancelledByVoice: boolean;
  unsubscribe?: () => void;
  ended: boolean;
}

interface ActiveTurn {
  input: AgentTurnInput;
  /** What the user said, with any words carried over from a turn cut short. */
  text?: string;
  listener: AgentTurnListener;
  cancelled: boolean;
  /** The message reached the chat; cancelling the turn no longer takes it back. */
  dispatched: boolean;
  done: boolean;
}

/** Text to read for a reply word for word, when it is short plain prose; else undefined. */
export function verbatimSpeech(markdown: string): string | undefined {
  const filter = new SpokenTextFilter();
  const spoken = (filter.push(markdown) + filter.flush()).trim();
  if (!spoken || filter.withheld) return undefined;
  const text = toSpeakableText(spoken);
  return text && countWords(text) <= VERBATIM_MAX_WORDS ? text : undefined;
}

/** The whole reply as speech: prose and list items read out, code and tables pointed to. */
export function toFullSpeech(markdown: string): string {
  const parts: string[] = [];
  let inFence = false;
  let saidTable = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(`{3,}|~{3,})/.test(line)) {
      if (!inFence) parts.push("There's code on screen.");
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("|")) {
      if (!saidTable) parts.push("There's a table on screen.");
      saidTable = true;
      continue;
    }
    saidTable = false;
    if (!line || /^([-*_])\1{2,}$/.test(line)) continue;
    const text = toSpeakableText(line.replace(/^>\s?/, ""), { codeBlockPhrase: "" });
    if (!text) continue;
    parts.push(/[.!?:;]$/.test(text) ? text : `${text}.`);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** A summary without the model: the first sentences of the spoken part, and where the rest is. */
export function fallbackSummary(markdown: string): string {
  const filter = new SpokenTextFilter();
  const spoken = toSpeakableText(filter.push(markdown) + filter.flush());
  const sentences = spoken.match(/[^.!?]+[.!?]+/g) ?? (spoken ? [spoken] : []);
  const head = sentences.slice(0, 2).map((sentence) => sentence.trim()).join(" ");
  return head ? `${head} The rest is on screen.` : "It finished. The reply is on screen.";
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args.slice(0, 120);
  if (typeof args !== "object") return String(args).slice(0, 120);
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value).replace(/\s+/g, " ").slice(0, 80)}`);
  return entries.join(", ");
}

function summarizeResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  const text = typeof result === "string" ? result
    : typeof result === "object" && typeof (result as { content?: unknown }).content === "string" ? (result as { content: string }).content
    : JSON.stringify(result);
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
}

export class HandsFreeLayer implements VoiceAgentApi {
  private readonly timers: LayerTimers;
  private output?: VoiceAgentOutput;
  private run?: WatchedRun;
  private unsubscribeStatus?: () => void;
  private detached = false;
  private ackSeq = 0;
  private lastSaid?: string;
  private lastReply?: string;
  private offerPending = false;
  /** Words of a turn that was cut short before it reached the chat, kept for the turn that continues it. */
  private carry?: string;
  private readbackSeq = 0;
  /** Bumped when the user asks for the last reply their own way; an automatic readback in progress is then dropped. */
  private readbackRevision = 0;
  private lastReadbackKey?: string;
  private chatTitle?: string;

  constructor(private readonly options: HandsFreeLayerOptions) {
    this.timers = options.timers ?? defaultTimers;
  }

  restoreLastSaid(text: string): void {
    this.lastSaid ??= text;
  }

  bindOutput(output: VoiceAgentOutput): void {
    this.output = output;
  }

  /** Starts following the chat (including a run already under way) and warms the model. */
  warm(): Promise<unknown> {
    this.options.model.warm();
    this.unsubscribeStatus ??= this.options.subscribeStatus((event) => {
      if (event.sessionId !== this.options.sessionId || this.detached) return;
      if (event.type === "session:busy") this.attachCurrentRun();
    });
    this.attachCurrentRun();
    void this.options.chat.title().then((title) => { this.chatTitle = title; }, () => undefined);
    return this.options.chat.warm().catch((error) => this.log("warm_failed", { error: String(error) }));
  }

  /** True while the chat is working or a readback is being written: hands-free stays awake. */
  isBusy(): boolean {
    return !!this.run || this.readbackSeq > 0;
  }

  /** Stops speaking for the chat. Its runs carry on and their replies land in the chat as usual. */
  detach(): void {
    this.detached = true;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    const run = this.run;
    this.run = undefined;
    if (run) this.closeRun(run);
  }

  startTurn(input: AgentTurnInput, listener: AgentTurnListener): AgentTurnHandle {
    const turn: ActiveTurn = { input, listener, cancelled: false, dispatched: false, done: false };
    void this.runTurn(turn).catch((error) => {
      this.log("turn_error", { error: String(error) });
      this.finish(turn, { aborted: false, error: "Something went wrong in hands-free. Try that again." });
    });
    return {
      abort: async () => {
        if (turn.done) return;
        turn.cancelled = true;
        // Cut short before it reached the chat: the user is still talking, so keep the words.
        if (!turn.dispatched && (input.kind === "user" || input.kind === "continuation" || input.kind === "interrupted")) {
          this.carry = turn.text ?? this.withCarry(input);
        }
        this.finish(turn, { aborted: true });
      },
    };
  }

  /** Another chat finished or is waiting: say so briefly. */
  async announce(title: string, kind: "finished" | "waiting", preview?: string): Promise<void> {
    const spoken = await this.options.model.announce(title, kind, preview)
      ?? (kind === "waiting" ? `${title} is waiting on you with a question.` : `${title} finished.`);
    if (this.detached) return;
    this.say({ key: `announce:${title}:${kind}`, text: spoken, kind: "announce" });
  }

  // ── Turns ──────────────────────────────────────────────────────

  private async runTurn(turn: ActiveTurn): Promise<void> {
    const { input } = turn;
    switch (input.kind) {
      case "greeting":
        return this.speakAndFinish(turn, this.run ? "Listening. It's still working on your last message." : "Listening.");
      case "event":
        return this.speakAndFinish(turn, input.text);
      case "typed":
        return this.send(turn, input.text, { typed: true });
      case "command":
        return this.runCommand(turn, input.command, this.run);
      default:
        return this.route(turn);
    }
  }

  private withCarry(input: AgentTurnInput): string {
    const carried = this.carry;
    this.carry = undefined;
    return input.kind === "continuation" && carried ? `${carried} ${input.text}`.trim() : input.text;
  }

  private async route(turn: ActiveTurn): Promise<void> {
    const text = this.withCarry(turn.input);
    turn.text = text;
    const run = this.run;
    const context: HandsFreeRouteContext = {
      ...(this.chatTitle ? { chatTitle: this.chatTitle } : {}),
      state: run?.questions.size ? "question" : run ? "working" : "idle",
      ...(run ? { workingSeconds: (this.timers.now() - run.startedAt) / 1000 } : {}),
      ...(turn.input.interruptedSpeech ? { lastSaid: turn.input.interruptedSpeech, interrupted: true } : this.lastSaid ? { lastSaid: this.lastSaid } : {}),
      ...(this.offerPending ? { offerPending: true } : {}),
      ...(turn.input.resumeNote ? { resumeNote: turn.input.resumeNote } : {}),
      ...(this.options.glossary?.()?.trim() ? { glossary: this.options.glossary()!.trim() } : {}),
      transcript: text,
    };
    const startedAt = this.timers.now();
    const decision = await this.options.model.route(context);
    if (turn.cancelled || this.detached) return;
    this.log("route", { action: decision?.action ?? "fallback", ms: this.timers.now() - startedAt, text });
    const offerWasPending = this.offerPending;
    this.offerPending = false;
    // Without a decision the words go to the chat, as they did before this layer existed; the
    // commands that must never reach it were caught before routing.
    const action = decision?.action ?? "send";
    switch (action) {
      case "send":
        return this.send(turn, decision?.text || text, { typed: false });
      case "ignore":
        return this.finish(turn, { aborted: false, handled: "not_sent" });
      case "progress":
        return this.runCommand(turn, "progress", run);
      case "stop":
        return this.runCommand(turn, "cancel", run);
      case "repeat":
        return this.runCommand(turn, "repeat", run);
      case "full":
        if (offerWasPending) this.options.preference.set("full");
        return this.runCommand(turn, "full", run);
      case "summary": {
        this.options.preference.set("summary");
        const reply = this.lastReply;
        if (!reply) return this.speakAndFinish(turn, "Okay, I'll keep it short.", "summary");
        this.supersedeReadback();
        const summary = await this.summary(reply);
        if (turn.cancelled || this.detached) return;
        return this.speakAndFinish(turn, summary, "summary");
      }
      case "leave":
        return this.finish(turn, { aborted: false, handled: "end" });
    }
  }

  /** `runAtStart` is the run the user was talking about: the one going when they spoke, or none. */
  private async runCommand(turn: ActiveTurn, command: AgentTurnInput["command"], runAtStart: WatchedRun | undefined): Promise<void> {
    switch (command) {
      case "progress": {
        if (!runAtStart || runAtStart.ended) return this.speakAndFinish(turn, "It's not working on anything right now.", "progress");
        const line = await this.progressLine(runAtStart);
        if (turn.cancelled || this.detached) return;
        runAtStart.reportedSteps = runAtStart.steps.length;
        return this.speakAndFinish(turn, line, "progress");
      }
      case "cancel": {
        if (!runAtStart) return this.speakAndFinish(turn, "There's nothing running to stop.", "cancel");
        // Only the run the user was talking about: a newer one is left alone.
        if (this.run !== runAtStart || runAtStart.ended) return this.speakAndFinish(turn, "It had already finished.", "cancel");
        runAtStart.cancelledByVoice = true;
        turn.dispatched = true;
        await this.options.chat.abort().catch((error) => this.log("abort_failed", { error: String(error) }));
        return this.speakAndFinish(turn, "Stopped.", "cancel");
      }
      case "repeat":
        return this.speakAndFinish(turn, this.lastSaid ?? "I haven't said anything yet.", "repeat", { remember: false });
      case "full":
        if (!this.lastReply) return this.speakAndFinish(turn, "There's no reply to read yet.", "full");
        // Asked for in full: the summary still being written (or waiting) for it is not said too.
        this.supersedeReadback();
        return this.speakAndFinish(turn, toFullSpeech(this.lastReply) || "The reply is all on screen.", "full");
      default:
        return this.finish(turn, { aborted: false });
    }
  }

  private async send(turn: ActiveTurn, text: string, options: { typed: boolean }): Promise<void> {
    const run = this.run;
    if (run?.questions.size && !options.typed) {
      return this.speakAndFinish(turn, "There's a question waiting on screen. Answer it there first.", "not_sent");
    }
    turn.dispatched = true;
    let delivery: ChatDelivery;
    try {
      delivery = await this.options.chat.deliver(text, options.typed ? turn.input.clientMessageId : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("send_failed", { error: message });
      return this.finish(turn, { aborted: false, error: `Couldn't send that: ${message}` });
    }
    turn.listener.onStarted?.();
    this.log("sent", { delivery, typed: options.typed });
    // A newly started run is picked up from its busy event; this covers a run that was already going.
    this.attachCurrentRun();
    if (options.typed || turn.cancelled || this.detached) return this.finish(turn, { aborted: false, handled: "sent" });
    const ack = delivery === "steered" ? ACK_STEERED
      : delivery === "queued" ? ACK_QUEUED
        : ACKS_STARTED[this.ackSeq++ % ACKS_STARTED.length]!;
    return this.speakAndFinish(turn, ack, "sent", { remember: false });
  }

  private speakAndFinish(turn: ActiveTurn, text: string, handled?: string, options: { remember?: boolean } = {}): void {
    if (turn.cancelled || turn.done) return;
    if (text) {
      if (options.remember !== false) this.lastSaid = text;
      turn.listener.onDelta(text);
      turn.listener.onMessageEnd?.();
    }
    this.finish(turn, { aborted: false, ...(handled ? { handled } : {}) });
  }

  private finish(turn: ActiveTurn, result: { aborted: boolean; error?: string; handled?: string }): void {
    if (turn.done) return;
    turn.done = true;
    turn.listener.onDone(result);
  }

  // ── Following the chat's runs ──────────────────────────────────

  /** Subscribes to the chat's current run once; a run already followed is left as it is. */
  private attachCurrentRun(): void {
    if (this.detached || !this.options.chat.isBusy()) return;
    const bus = this.options.chat.getBus();
    if (!bus || bus.complete) return;
    let watched: WatchedRun | undefined;
    let duplicate = false;
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === "snapshot") {
        const runId = typeof event.runId === "string" ? event.runId : "";
        if (this.run && !this.run.ended && this.run.runId === runId) {
          duplicate = true;
          return;
        }
        watched = this.startRun(runId, event);
        return;
      }
      if (watched && !duplicate) this.onRunEvent(watched, event);
    });
    if (duplicate || !watched) {
      unsubscribe();
      return;
    }
    if (watched.ended) unsubscribe();
    else watched.unsubscribe = unsubscribe;
  }

  private startRun(runId: string, snapshot: StreamEvent): WatchedRun {
    const previous = this.run;
    if (previous && !previous.ended) this.closeRun(previous);
    const run: WatchedRun = {
      runId,
      startedAt: this.timers.now(),
      steps: [],
      toolSteps: new Map(),
      reportedSteps: 0,
      progressCount: 0,
      questions: new Map(),
      cancelledByVoice: false,
      ended: false,
    };
    const tools = Array.isArray(snapshot.liveTools) ? snapshot.liveTools as Array<Record<string, unknown>> : [];
    for (const tool of tools) {
      if (tool.parentToolCallId) continue;
      this.addToolStep(run, String(tool.toolCallId ?? ""), String(tool.name ?? "tool"), tool.args);
      if (tool.completedAt) this.completeToolStep(run, String(tool.toolCallId ?? ""), tool.success !== false, tool.result);
    }
    const startedAt = typeof snapshot.runStartedAt === "string" ? Date.parse(snapshot.runStartedAt) : NaN;
    if (Number.isFinite(startedAt)) run.startedAt = Math.min(run.startedAt, startedAt);
    this.run = run;
    // A question asked before hands-free started is only in the snapshot.
    for (const request of Array.isArray(snapshot.pendingUserInputs) ? snapshot.pendingUserInputs as Array<Record<string, unknown>> : []) {
      this.noteQuestion(run, request.requestId, request.question);
    }
    for (const request of Array.isArray(snapshot.pendingElicitations) ? snapshot.pendingElicitations as Array<Record<string, unknown>> : []) {
      this.noteQuestion(run, request.requestId, request.message);
    }
    this.scheduleProgress(run);
    this.options.onRunState?.({ working: true, startedAt: run.startedAt });
    this.log("run_start", { runId });
    return run;
  }

  private addToolStep(run: WatchedRun, toolCallId: string, name: string, args: unknown): void {
    const summary = summarizeArgs(args);
    run.steps.push(`${name}${summary ? ` (${summary})` : ""}`);
    if (toolCallId) run.toolSteps.set(toolCallId, run.steps.length - 1);
  }

  private completeToolStep(run: WatchedRun, toolCallId: string, success: boolean, result: unknown): void {
    const index = run.toolSteps.get(toolCallId);
    if (index === undefined) return;
    const summary = summarizeResult(result);
    run.steps[index] += success ? (summary ? ` -> ${summary}` : " -> done") : ` -> failed${summary ? `: ${summary}` : ""}`;
  }

  private onRunEvent(run: WatchedRun, event: StreamEvent): void {
    if (run.ended) return;
    switch (event.type) {
      case "tool_start":
        if (!event.parentToolCallId) this.addToolStep(run, String(event.toolCallId ?? ""), String(event.name ?? "tool"), event.args);
        break;
      case "tool_done":
        this.completeToolStep(run, String(event.toolCallId ?? ""), event.success !== false, event.result);
        break;
      case "intent":
        if (typeof event.content === "string" && event.content.trim()) run.steps.push(`Working on: ${event.content.trim()}`);
        break;
      case "assistant_partial":
        if (typeof event.content === "string" && event.content.trim() && event.bridgeNative !== true) {
          run.steps.push(`Wrote: ${event.content.replace(/\s+/g, " ").trim().slice(0, 300)}`);
        }
        break;
      case "user_input_requested":
      case "elicitation_requested":
        this.noteQuestion(run, event.requestId, event.type === "user_input_requested" ? event.question : event.message);
        break;
      case "user_input_answered":
      case "user_input_canceled":
      case "elicitation_resolved":
      case "elicitation_canceled":
        run.questions.delete(String(event.requestId ?? ""));
        if (run.questions.size === 0) this.output?.drop((item) => item.key === `question:${run.runId}`);
        break;
      case "done":
        this.endRun(run, { kind: "done", content: typeof event.content === "string" ? event.content : "" });
        break;
      case "error": {
        const message = typeof event.message === "string" ? event.message : "";
        // The runtime's word for a turn that wrote nothing (it happens after steering, and the work
        // carries on in a new turn); like an empty reply, it is not something to announce.
        if (message.startsWith("No response was returned")) this.endRun(run, { kind: "done", content: "" });
        else this.endRun(run, { kind: "error", message });
        break;
      }
      case "aborted":
      case "shutdown":
      case "resync_required":
        this.endRun(run, { kind: "stopped" });
        break;
      default:
        break;
    }
  }

  private noteQuestion(run: WatchedRun, requestId: unknown, asked: unknown): void {
    const question = typeof asked === "string" && asked.trim() ? asked.trim() : undefined;
    run.questions.set(String(requestId ?? ""), question ?? "a question");
    const text = `There's a question for you on screen${question ? `: ${toSpeakableText(question).slice(0, 200)}` : "."}`;
    this.say({ key: `question:${run.runId}`, text, kind: "notice" });
  }

  private closeRun(run: WatchedRun): void {
    run.ended = true;
    run.unsubscribe?.();
    run.unsubscribe = undefined;
    if (run.progressTimer !== undefined) this.timers.clearTimeout(run.progressTimer);
    run.progressTimer = undefined;
    this.output?.drop((item) => item.key === `progress:${run.runId}` || item.key === `question:${run.runId}`);
  }

  private endRun(run: WatchedRun, outcome: { kind: "done"; content: string } | { kind: "error"; message: string } | { kind: "stopped" }): void {
    if (run.ended) return;
    this.closeRun(run);
    if (this.run === run) {
      this.run = undefined;
      this.options.onRunState?.({ working: false });
    }
    this.log("run_end", { runId: run.runId, outcome: outcome.kind });
    if (this.detached || run.cancelledByVoice) return;
    if (outcome.kind === "error") {
      this.say({ key: `end:${run.runId}`, text: `It ran into an error${outcome.message ? `: ${toSpeakableText(outcome.message).slice(0, 160)}` : "."}`, kind: "readback" });
      return;
    }
    if (outcome.kind === "stopped") {
      this.say({ key: `end:${run.runId}`, text: "It stopped before finishing.", kind: "readback" });
      return;
    }
    const content = outcome.content.trim();
    if (!content || content === "(no response)") return;
    void this.readBack(run, content);
  }

  private supersedeReadback(): void {
    this.readbackRevision++;
    const key = this.lastReadbackKey;
    if (key) this.output?.drop((item) => item.key === key);
  }

  private async readBack(run: WatchedRun, content: string): Promise<void> {
    this.lastReply = content;
    this.lastReadbackKey = `end:${run.runId}`;
    const revision = ++this.readbackRevision;
    this.readbackSeq++;
    try {
      let text = verbatimSpeech(content);
      let offer = false;
      if (!text) {
        if (this.options.preference.get() === "full") {
          text = toFullSpeech(content);
        } else {
          text = await this.summary(content);
          offer = OFFER_RE.test(text);
        }
      }
      if (this.detached || !text) return;
      // A newer reply, or the user asking for this one in full, supersedes it before it is said.
      if (this.lastReply !== content || this.readbackRevision !== revision) return;
      this.say({ key: `end:${run.runId}`, text, kind: "readback", ...(offer ? { offer: true } : {}) });
    } finally {
      this.readbackSeq--;
    }
  }

  private async summary(content: string): Promise<string> {
    return await this.options.model.speak(content) ?? fallbackSummary(content);
  }

  private scheduleProgress(run: WatchedRun): void {
    if (run.ended) return;
    const elapsed = this.timers.now() - run.startedAt;
    run.progressTimer = this.timers.setTimeout(() => void this.autoProgress(run), Math.max(1_000, autoProgressAt(run.progressCount) - elapsed));
  }

  private async autoProgress(run: WatchedRun): Promise<void> {
    run.progressTimer = undefined;
    if (run.ended || this.detached || this.run !== run) return;
    run.progressCount++;
    if (run.questions.size === 0) {
      // Nothing new since the last line: no model call, just say it is still at it.
      const fresh = run.steps.length > run.reportedSteps || run.steps.length === 0;
      const line = fresh ? await this.progressLine(run) : "Still working on it.";
      if (!run.ended && this.run === run && !this.detached) {
        run.reportedSteps = run.steps.length;
        this.say({ key: `progress:${run.runId}`, text: line, kind: "progress", valid: () => !run.ended && this.run === run });
      }
    }
    this.scheduleProgress(run);
  }

  private async progressLine(run: WatchedRun): Promise<string> {
    const activity: HandsFreeActivity = { elapsedSeconds: (this.timers.now() - run.startedAt) / 1000, steps: [...run.steps] };
    if (activity.steps.length === 0) return "It's still getting started.";
    return await this.options.model.progress(activity) ?? "Still working on it.";
  }

  private say(item: AgentSpeech): void {
    if (this.detached || !this.output) return;
    const valid = item.valid;
    this.output.say({
      ...item,
      onSpoken: () => {
        this.lastSaid = item.text;
        if (item.offer) this.offerPending = true;
        item.onSpoken?.();
      },
      ...(valid ? { valid } : {}),
    });
  }

  private log(event: string, details?: Record<string, unknown>): void {
    this.options.log?.(event, details);
  }
}
