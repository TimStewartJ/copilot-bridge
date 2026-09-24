// Drives a Helm conversation from hands-free voice. Voice turns run through the same
// session manager, event bus and transcript as typed chat, so entering or leaving
// hands-free never forks the context: it is one Bridge session either way.
import type { StreamEvent } from "../event-bus.js";
import type { StartWorkOptions } from "../session-runner.js";
import type { AgentTurnHandle, AgentTurnInput, AgentTurnListener, VoiceAgentApi } from "../voice/voice-conversation.js";
import { composeHandsFreePrompt } from "./helm-prompt.js";

export interface HelmVoiceSessionManager {
  startWork(sessionId: string, prompt: string, attachments?: undefined, options?: StartWorkOptions): void;
  abortSession(sessionId: string): Promise<boolean>;
  isSessionBusy(sessionId: string): boolean;
  warmSession(sessionId: string): Promise<void>;
}

export interface HelmVoiceEventBus {
  subscribe(listener: (event: StreamEvent) => void): () => void;
}

export interface HelmVoiceAgentTiming {
  kind: AgentTurnInput["kind"];
  queuedMs: number;
  snapshotMs: number;
  busyWaitMs: number;
  firstTextMs?: number;
  toolCalls: string[];
  totalMs: number;
  aborted: boolean;
  error?: string;
}

export interface HelmVoiceAgentOptions {
  sessionId: string;
  sessionManager: HelmVoiceSessionManager;
  getBus(sessionId: string): HelmVoiceEventBus;
  snapshot?: () => Promise<string | undefined>;
  /** The user's names list from Helm settings. Read per turn; sent when it is new to this conversation. */
  glossary?: () => string | undefined;
  /** Reasoning effort for turns answered out loud. Read per turn so a settings change applies at once. */
  resolveReasoningEffort?: () => string | undefined;
  timeZone?: string;
  onTiming?: (timing: HelmVoiceAgentTiming) => void;
  logger?: Pick<Console, "log" | "warn">;
  /** How long a new turn waits for the session to go idle before stopping whatever is running. */
  busyWaitMs?: number;
  pollMs?: number;
}

interface ActiveTurn {
  input: AgentTurnInput;
  listener: AgentTurnListener;
  done: boolean;
  aborting: boolean;
  started: boolean;
  settled: Promise<void>;
  settle(): void;
  unsubscribe?: () => void;
  startedAt: number;
  runAt?: number;
  snapshotMs: number;
  busyWaitMs: number;
  firstTextAt?: number;
  streamedSinceBoundary: number;
  toolCalls: string[];
  toolNames: Map<string, string>;
}

const DEFAULT_BUSY_WAIT_MS = 4_000;
const DEFAULT_POLL_MS = 50;
const ABORT_SETTLE_TIMEOUT_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export class HelmVoiceAgent implements VoiceAgentApi {
  private active?: ActiveTurn;
  private queue: Promise<void> = Promise.resolve();
  private lastSnapshot?: string;
  private lastGlossary?: string;
  private detached = false;
  readonly sessionId: string;
  readonly timeZone: string;

  constructor(private readonly options: HelmVoiceAgentOptions) {
    this.sessionId = options.sessionId;
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Resumes the session ahead of the first turn to cut first-reply latency. */
  warm(): Promise<unknown> {
    return this.options.sessionManager.warmSession(this.sessionId).catch((error) => {
      this.options.logger?.warn(`[helm-voice] Warmup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  startTurn(input: AgentTurnInput, listener: AgentTurnListener): AgentTurnHandle {
    let resolveSettled!: () => void;
    const turn: ActiveTurn = {
      input,
      listener,
      done: false,
      aborting: false,
      started: false,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      settle: () => resolveSettled(),
      startedAt: performance.now(),
      snapshotMs: 0,
      busyWaitMs: 0,
      streamedSinceBoundary: 0,
      toolCalls: [],
      toolNames: new Map(),
    };
    const previous = this.queue;
    this.queue = previous.then(() => this.runTurn(turn)).catch(() => undefined);
    return { abort: () => this.abortTurn(turn) };
  }

  /**
   * Stops relaying to voice without touching the session. A reply that is still being
   * written keeps streaming into the chat, which is what leaving hands-free should do.
   */
  detach(): void {
    this.detached = true;
    const turn = this.active;
    if (turn && !turn.done) this.finishTurn(turn, { aborted: true });
  }

  private async abortTurn(turn: ActiveTurn): Promise<void> {
    if (turn.done) return;
    turn.aborting = true;
    if (this.detached || !turn.started || this.active !== turn) {
      this.finishTurn(turn, { aborted: true });
      return;
    }
    await this.options.sessionManager.abortSession(this.sessionId).catch(() => false);
    await Promise.race([turn.settled, delay(ABORT_SETTLE_TIMEOUT_MS)]);
    this.finishTurn(turn, { aborted: true });
  }

  private finishTurn(turn: ActiveTurn, result: { aborted: boolean; error?: string }): void {
    if (turn.done) return;
    turn.done = true;
    turn.unsubscribe?.();
    turn.unsubscribe = undefined;
    if (this.active === turn) this.active = undefined;
    turn.settle();
    const now = performance.now();
    const runAt = turn.runAt ?? now;
    this.options.onTiming?.({
      kind: turn.input.kind,
      queuedMs: Math.round(runAt - turn.startedAt),
      snapshotMs: Math.round(turn.snapshotMs),
      busyWaitMs: Math.round(turn.busyWaitMs),
      ...(turn.firstTextAt !== undefined ? { firstTextMs: Math.round(turn.firstTextAt - runAt) } : {}),
      toolCalls: turn.toolCalls,
      totalMs: Math.round(now - turn.startedAt),
      aborted: result.aborted,
      ...(result.error ? { error: result.error } : {}),
    });
    turn.listener.onDone(result);
  }

  private async readSnapshot(turn: ActiveTurn): Promise<string | undefined> {
    const startedAt = performance.now();
    try {
      const current = await this.options.snapshot?.();
      if (current && (current !== this.lastSnapshot || turn.input.kind === "greeting")) {
        this.lastSnapshot = current;
        return current;
      }
    } catch (error) {
      this.options.logger?.warn(`[helm-voice] Snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      turn.snapshotMs = performance.now() - startedAt;
    }
    return undefined;
  }

  /**
   * A voice turn is the newest thing the user said, so it wins: wait briefly for the session
   * to settle (a just-interrupted reply, a warmup), then stop whatever is still running.
   */
  private async waitUntilIdle(turn: ActiveTurn): Promise<boolean> {
    const { sessionManager } = this.options;
    const startedAt = performance.now();
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    const waitFor = async (budgetMs: number) => {
      const deadline = performance.now() + budgetMs;
      while (sessionManager.isSessionBusy(this.sessionId) && performance.now() < deadline && !turn.aborting && !this.detached) {
        await delay(pollMs);
      }
    };
    try {
      await waitFor(this.options.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS);
      if (turn.aborting || this.detached) return false;
      if (sessionManager.isSessionBusy(this.sessionId)) {
        await sessionManager.abortSession(this.sessionId).catch(() => false);
        await waitFor(ABORT_SETTLE_TIMEOUT_MS);
      }
      return !sessionManager.isSessionBusy(this.sessionId);
    } finally {
      turn.busyWaitMs = performance.now() - startedAt;
    }
  }

  private async runTurn(turn: ActiveTurn): Promise<void> {
    turn.runAt = performance.now();
    if (turn.done || turn.aborting || this.detached) {
      this.finishTurn(turn, { aborted: true });
      return;
    }
    const snapshot = await this.readSnapshot(turn);
    const glossary = this.options.glossary?.()?.trim() || undefined;
    const newGlossary = glossary && glossary !== this.lastGlossary ? glossary : undefined;
    if (glossary) this.lastGlossary = glossary;
    const composed = composeHandsFreePrompt(turn.input, { snapshot, timeZone: this.timeZone, ...(newGlossary ? { glossary: newGlossary } : {}) });
    const idle = await this.waitUntilIdle(turn);
    if (turn.done) return;
    if (turn.aborting || this.detached) {
      this.finishTurn(turn, { aborted: true });
      return;
    }
    if (!idle) {
      this.finishTurn(turn, { aborted: false, error: "Helm is still busy with another message. Try again in a moment." });
      return;
    }

    this.active = turn;
    try {
      const reasoningEffort = this.options.resolveReasoningEffort?.();
      this.options.sessionManager.startWork(this.sessionId, composed.prompt, undefined, {
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(composed.hidden ? { promptSource: "system" as const } : {}),
        ...(composed.displayPrompt ? { displayPrompt: composed.displayPrompt } : {}),
        ...(turn.input.clientMessageId ? { clientMessageId: turn.input.clientMessageId } : {}),
      });
      // Subscribing in the same tick as startWork cannot miss an event: the run emits nothing
      // until it has awaited the backend. A finished bus refuses subscribers, so this has to
      // come after startWork has reset it for the new run.
      turn.unsubscribe = this.options.getBus(this.sessionId).subscribe((event) => this.onEvent(turn, event));
      turn.started = true;
      turn.listener.onStarted?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(`[helm-voice] Could not start turn: ${message}`);
      this.finishTurn(turn, { aborted: false, error: `Couldn't reach Copilot: ${message}` });
      return;
    }
    await turn.settled;
  }

  private onEvent(turn: ActiveTurn, event: StreamEvent): void {
    if (turn.done) return;
    switch (event.type) {
      case "delta":
        if (typeof event.content === "string" && event.content && !turn.aborting) {
          turn.firstTextAt ??= performance.now();
          turn.streamedSinceBoundary += event.content.length;
          turn.listener.onDelta(event.content);
        }
        break;
      case "assistant_partial":
        if (!turn.aborting) {
          // Models that don't stream deliver the whole message here.
          if (turn.streamedSinceBoundary === 0 && typeof event.content === "string" && event.content && event.bridgeNative !== true) {
            turn.firstTextAt ??= performance.now();
            turn.listener.onDelta(event.content);
          }
          turn.listener.onMessageEnd?.();
        }
        turn.streamedSinceBoundary = 0;
        break;
      case "tool_start": {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (toolCallId && !turn.aborting && !event.parentToolCallId) {
          const name = String(event.name ?? "tool");
          turn.toolNames.set(toolCallId, name);
          turn.toolCalls.push(name);
          turn.listener.onToolStart({ toolCallId, name });
        }
        break;
      }
      case "tool_done": {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (toolCallId && turn.toolNames.has(toolCallId) && !turn.aborting) {
          turn.listener.onToolEnd({ toolCallId, name: turn.toolNames.get(toolCallId)!, success: event.success !== false });
        }
        break;
      }
      case "done":
        this.finishTurn(turn, { aborted: turn.aborting });
        break;
      case "aborted":
      case "shutdown":
      case "resync_required":
        this.finishTurn(turn, { aborted: true });
        break;
      case "error":
        this.finishTurn(turn, { aborted: turn.aborting, error: typeof event.message === "string" && event.message ? event.message : "Copilot session error" });
        break;
      default:
        break;
    }
  }
}
