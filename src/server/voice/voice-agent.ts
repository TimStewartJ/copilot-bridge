// The voice assistant's Copilot session: a cheap, fast model with Bridge management tools,
// fed short spoken turns plus a compact live snapshot of Bridge state.
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentModelInfo, AgentSession, AgentSessionConfig, AgentSessionEvent } from "../agent-backend/types.js";
import { createNativeBridgeTools } from "../bridge-native-tools.js";
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import { PREFERRED_VOICE_MODELS } from "./voice-catalog.js";
import type { AgentTurnHandle, AgentTurnInput, AgentTurnListener, VoiceAgentApi } from "./voice-conversation.js";

export const VOICE_AGENT_SESSION_ID_PREFIX = "v01ce000";

export function createVoiceAgentSessionId(): string {
  const uuid = randomUUID();
  return `${VOICE_AGENT_SESSION_ID_PREFIX}${uuid.slice(VOICE_AGENT_SESSION_ID_PREFIX.length)}`;
}

export function isVoiceAgentSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${VOICE_AGENT_SESSION_ID_PREFIX}-`);
}

export function buildVoiceAgentSystemPrompt(options: { timeZone: string; defaultWorkModel?: string }): string {
  return [
    "You are Bridge, the hands-free voice assistant for the user's Copilot Bridge: their personal dashboard of AI chat sessions, tasks, and Focus items.",
    "The user talks to you out loud and hears your replies through text-to-speech. They may be across the room, cooking, or walking around.",
    "",
    "How to talk:",
    "- Reply in one or two short spoken sentences unless the user asks for more. Lead with the answer.",
    "- Never use markdown, bullet lists, headings, code, URLs, file paths, emoji, or ids. Refer to sessions and tasks by their titles, naturally shortened.",
    "- Say numbers, times, and symbols the way a person would say them.",
    "- Be warm, calm, and quick. No filler like \"Great question\".",
    "- Details that are hard to hear (lists, code, long summaries, links) go on screen with show_on_screen; say one sentence pointing to it.",
    "- The input is speech recognition output and may contain mistakes; interpret likely mishearings sensibly and ask a quick clarifying question only when it really matters.",
    "- If an utterance is clearly not meant for you (background talk, someone else in the room), reply with an empty message.",
    "",
    "What you manage:",
    "- Sessions are chats where Copilot agents do real work. \"Unread\" means a session has a reply the user hasn't seen. \"Waiting on you\" means it asked the user a question.",
    "- Use tools to look things up instead of guessing: bridge_overview for what's going on, list_sessions and read_session for replies, task_list and task_get_info for tasks, docs_search for their notes.",
    "- When reading a reply, summarize it conversationally in a sentence or three and offer more. read_session marks it read.",
    "- Real work (coding, debugging, research, writing, deploying) is never done by you. Send it to an existing relevant session with send_to_session, or start one with start_session inside the right task when there is one.",
    `- Worker sessions use the user's default model${options.defaultWorkModel ? ` (${options.defaultWorkModel})` : ""} unless the user asks for another; use list_models to find stronger ones such as Opus or Sol when they ask for more power.`,
    "- Prompts you send to sessions must be complete and self-contained: include the goal, relevant context from this conversation, and constraints, written the way the user would type them.",
    "- After dispatching, confirm in a few words, like \"Sent to the Tellus session.\" You'll get a Bridge update when watched sessions finish or ask something.",
    "- Answer a session's question with answer_session_question once the user tells you the answer.",
    "- Ask before stopping a running session. Don't mark things read that the user hasn't heard about unless they ask.",
    "- If the user asks you to stop listening, take a break, or end voice mode in their own words, call voice_mode.",
    "",
    "Messages from the voice system:",
    "- Lines in square brackets are context from the voice system, not the user: a live Bridge snapshot, a note that the user kept talking or interrupted you, or a Bridge update to announce.",
    "- For Bridge updates, mention only what's useful in one sentence and offer to read more.",
    "",
    `Local time zone: ${options.timeZone}.`,
  ].join("\n");
}

function formatLocalTime(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
}

export function composeVoicePrompt(input: AgentTurnInput, context: { snapshot?: string; timeZone: string; now?: Date }): string {
  const parts: string[] = [];
  if (context.snapshot) parts.push(`[Bridge now: ${context.snapshot}]`);
  switch (input.kind) {
    case "greeting":
      parts.push(
        `[Voice mode just started. It's ${formatLocalTime(context.timeZone, context.now)}. Greet the user in one short sentence. If something is waiting on them, mention the single most important thing.]`,
      );
      break;
    case "continuation":
      parts.push("[The user kept talking before you answered; this continues their previous message.]", input.text);
      break;
    case "interrupted":
      parts.push(
        input.interruptedSpeech
          ? `[The user interrupted you while you were saying: "${input.interruptedSpeech}"]`
          : "[The user interrupted you.]",
        input.text,
      );
      break;
    case "event":
      parts.push("[Bridge update to mention briefly:]", input.text);
      break;
    default:
      parts.push(input.text);
  }
  return parts.join("\n");
}

export function selectVoiceAgentModel(models: AgentModelInfo[], requested?: string): { model?: string; reasoningEffort?: string } {
  const enabled = models.filter((model) => {
    const policy = (model as { policy?: { state?: string } }).policy;
    return !policy || policy.state === "enabled";
  });
  const chosen = (requested ? enabled.find((model) => model.id === requested) : undefined)
    ?? PREFERRED_VOICE_MODELS.map((id) => enabled.find((model) => model.id === id)).find(Boolean);
  if (!chosen) return requested ? { model: requested } : {};
  const efforts: readonly string[] = chosen.supportedReasoningEfforts ?? [];
  // Spoken replies are short; skipping deliberate reasoning roughly halves time to first words.
  const reasoningEffort = efforts.includes("none") ? "none" : efforts.includes("low") ? "low" : undefined;
  return { model: chosen.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export interface VoiceAgentSessionFactory {
  createVoiceAgentSession(config: AgentSessionConfig): Promise<AgentSession>;
  listModels(): Promise<AgentModelInfo[]>;
}

export interface VoiceAgentTurnTiming {
  kind: AgentTurnInput["kind"];
  queuedMs: number;
  snapshotMs: number;
  sendAcceptedMs?: number;
  firstTextMs?: number;
  toolCalls: string[];
  totalMs: number;
  aborted: boolean;
  error?: string;
}

export interface VoiceAgentOptions {
  factory: VoiceAgentSessionFactory;
  tools: BridgeToolDefinition[];
  stateDir: string;
  requestedModel?: string;
  defaultWorkModel?: string;
  snapshot?: () => Promise<string | undefined>;
  timeZone?: string;
  logger?: Pick<Console, "log" | "warn">;
  onTiming?: (timing: VoiceAgentTurnTiming) => void;
}

interface ActiveTurn {
  input: AgentTurnInput;
  listener: AgentTurnListener;
  done: boolean;
  aborting: boolean;
  settled: Promise<void>;
  settle(): void;
  startedAt: number;
  runAt?: number;
  snapshotMs: number;
  sendAcceptedAt?: number;
  firstTextAt?: number;
  toolCalls: string[];
  toolNames: Map<string, string>;
}

const ABORT_SETTLE_TIMEOUT_MS = 5_000;

export class VoiceAgent implements VoiceAgentApi {
  private session?: AgentSession;
  private sessionPromise?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private active?: ActiveTurn;
  private queue: Promise<void> = Promise.resolve();
  private lastSnapshot?: string;
  private disposed = false;
  readonly timeZone: string;
  modelInfo: { model?: string; reasoningEffort?: string } = {};

  constructor(private readonly options: VoiceAgentOptions) {
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Creates the session ahead of the first turn to cut first-reply latency. */
  warm(): Promise<unknown> {
    return this.ensureSession().catch((error) => {
      this.options.logger?.warn(`[voice-agent] Warmup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private ensureSession(): Promise<AgentSession> {
    if (this.session) return Promise.resolve(this.session);
    if (this.sessionPromise) return this.sessionPromise;
    const run = this.createSession().finally(() => {
      if (this.sessionPromise === run) this.sessionPromise = undefined;
    });
    this.sessionPromise = run;
    return run;
  }

  private async createSession(): Promise<AgentSession> {
    const models = await this.options.factory.listModels().catch(() => [] as AgentModelInfo[]);
    this.modelInfo = selectVoiceAgentModel(models, this.options.requestedModel);
    const sessionId = createVoiceAgentSessionId();
    await mkdir(this.options.stateDir, { recursive: true });
    const tools = createNativeBridgeTools(this.options.tools);
    const config: AgentSessionConfig = {
      sessionId,
      clientName: "Copilot Bridge Voice",
      ...(this.modelInfo.model ? { model: this.modelInfo.model } : {}),
      ...(this.modelInfo.reasoningEffort ? { reasoningEffort: this.modelInfo.reasoningEffort } : {}),
      streaming: true,
      includeSubAgentStreamingEvents: false,
      systemMessage: {
        mode: "replace",
        content: buildVoiceAgentSystemPrompt({ timeZone: this.timeZone, defaultWorkModel: this.options.defaultWorkModel }),
      },
      tools,
      availableTools: tools.map((tool) => tool.name),
      mcpServers: {},
      memory: { enabled: false },
      configDirectory: this.options.stateDir,
      workingDirectory: this.options.stateDir,
      enableConfigDiscovery: false,
      skillDirectories: [],
      instructionDirectories: [],
      infiniteSessions: { enabled: false },
      enableSessionTelemetry: false,
      enableSessionStore: false,
    };
    const session = await this.options.factory.createVoiceAgentSession(config);
    if (this.disposed) {
      await this.disposeSession(session);
      throw new Error("Voice agent was disposed");
    }
    this.session = session;
    this.unsubscribe = session.on((event) => this.onEvent(event));
    this.options.logger?.log(`[voice-agent] Session ${session.sessionId.slice(0, 13)} on ${this.modelInfo.model ?? "default model"}`);
    return session;
  }

  private onEvent(event: AgentSessionEvent): void {
    const turn = this.active;
    if (!turn || turn.done) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "assistant.message_delta":
        if (!data.parentToolCallId && typeof data.deltaContent === "string" && !turn.aborting) {
          turn.firstTextAt ??= performance.now();
          turn.listener.onDelta(data.deltaContent);
        }
        break;
      case "tool.execution_start":
        if (typeof data.toolCallId === "string" && !turn.aborting) {
          const name = String(data.toolName ?? "tool");
          turn.toolNames.set(data.toolCallId, name);
          turn.toolCalls.push(name);
          turn.listener.onToolStart({ toolCallId: data.toolCallId, name });
        }
        break;
      case "tool.execution_complete":
        if (typeof data.toolCallId === "string" && !turn.aborting) {
          const name = turn.toolNames.get(data.toolCallId) ?? String(data.toolName ?? "tool");
          turn.listener.onToolEnd({ toolCallId: data.toolCallId, name, success: data.success !== false });
        }
        break;
      case "session.idle":
        this.finishTurn(turn, { aborted: turn.aborting });
        break;
      case "session.error":
        this.finishTurn(turn, { aborted: turn.aborting, error: typeof data.message === "string" ? data.message : "Copilot session error" });
        break;
      default:
        break;
    }
  }

  private finishTurn(turn: ActiveTurn, result: { aborted: boolean; error?: string }): void {
    if (turn.done) return;
    turn.done = true;
    if (this.active === turn) this.active = undefined;
    turn.settle();
    const now = performance.now();
    const runAt = turn.runAt ?? now;
    this.options.onTiming?.({
      kind: turn.input.kind,
      queuedMs: Math.round(runAt - turn.startedAt),
      snapshotMs: Math.round(turn.snapshotMs),
      ...(turn.sendAcceptedAt !== undefined ? { sendAcceptedMs: Math.round(turn.sendAcceptedAt - runAt) } : {}),
      ...(turn.firstTextAt !== undefined ? { firstTextMs: Math.round(turn.firstTextAt - runAt) } : {}),
      toolCalls: turn.toolCalls,
      totalMs: Math.round(now - turn.startedAt),
      aborted: result.aborted,
      ...(result.error ? { error: result.error } : {}),
    });
    turn.listener.onDone(result);
  }

  startTurn(input: AgentTurnInput, listener: AgentTurnListener): AgentTurnHandle {
    let resolveSettled!: () => void;
    const turn: ActiveTurn = {
      input,
      listener,
      done: false,
      aborting: false,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      settle: () => resolveSettled(),
      startedAt: performance.now(),
      snapshotMs: 0,
      toolCalls: [],
      toolNames: new Map(),
    };
    const previous = this.queue;
    this.queue = previous.then(() => this.runTurn(input, turn)).catch(() => undefined);
    return {
      abort: async () => {
        if (turn.done) return;
        turn.aborting = true;
        if (this.active === turn && this.session) {
          await this.session.abort().catch(() => undefined);
          const timeout = new Promise<void>((resolve) => setTimeout(resolve, ABORT_SETTLE_TIMEOUT_MS).unref());
          await Promise.race([turn.settled, timeout]);
          this.finishTurn(turn, { aborted: true });
        } else {
          this.finishTurn(turn, { aborted: true });
        }
      },
    };
  }

  private async runTurn(input: AgentTurnInput, turn: ActiveTurn): Promise<void> {
    turn.runAt = performance.now();
    if (turn.done || turn.aborting || this.disposed) {
      this.finishTurn(turn, { aborted: true });
      return;
    }
    let snapshot: string | undefined;
    try {
      const current = await this.options.snapshot?.();
      if (current && (current !== this.lastSnapshot || input.kind === "greeting")) {
        snapshot = current;
        this.lastSnapshot = current;
      }
    } catch (error) {
      this.options.logger?.warn(`[voice-agent] Snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    turn.snapshotMs = performance.now() - turn.runAt;
    const prompt = composeVoicePrompt(input, { snapshot, timeZone: this.timeZone });
    for (let attempt = 0; attempt < 2; attempt++) {
      let session: AgentSession;
      try {
        session = await this.ensureSession();
      } catch (error) {
        this.finishTurn(turn, { aborted: false, error: `Couldn't start the voice assistant: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      if (turn.aborting) {
        this.finishTurn(turn, { aborted: true });
        return;
      }
      this.active = turn;
      try {
        await session.send({ prompt });
        turn.sendAcceptedAt ??= performance.now();
        await turn.settled;
        return;
      } catch (error) {
        if (this.active === turn) this.active = undefined;
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.warn(`[voice-agent] Send failed (attempt ${attempt + 1}): ${message}`);
        await this.resetSession();
        if (attempt === 1 || turn.aborting) {
          this.finishTurn(turn, { aborted: turn.aborting, error: `Copilot request failed: ${message}` });
          return;
        }
      }
    }
  }

  private async resetSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (session) await this.disposeSession(session);
  }

  private async disposeSession(session: AgentSession): Promise<void> {
    try {
      await session.disconnect?.();
    } catch {
      // The runtime may already be gone.
    }
    await rm(join(this.options.stateDir, "session-state", session.sessionId), { recursive: true, force: true }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const turn = this.active;
    if (turn && !turn.done) {
      turn.aborting = true;
      await this.session?.abort().catch(() => undefined);
      this.finishTurn(turn, { aborted: true });
    }
    const pending = this.sessionPromise;
    if (pending) await pending.catch(() => undefined);
    await this.resetSession();
  }
}
