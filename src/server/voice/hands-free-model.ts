// The hands-free layer's own small model ("Hands-free" in Settings › Models). It sits between the
// user's speech and the chat: it decides what a transcript is for (send it, ignore it, report
// progress, …) and turns the chat's replies and running work into a few spoken sentences. It never
// does the chat's work and never answers from its own knowledge.
//
// Measured on 26 Oct 2026 (394 calls, prompts below): gpt-6.1-terra at low decided correctly on all
// 46 routing cases, median 1.26 s (first token 0.97 s, p90 1.66 s); spoken summaries and progress
// lines took 1.4-1.6 s and were the best of six fast models. A fresh helper session costs ~30 ms,
// so every call gets its own and nothing builds up between calls.
import type { AgentModelInfo, AgentSession, AgentSessionConfig } from "../agent-backend/index.js";
import type { AppSettings } from "../settings-store.js";
import { resolveModelRole } from "../model-roles.js";
import { selectHelperModel } from "../helper-model.js";
import { resolveSupportedReasoningEffort } from "../../shared/reasoning-effort.js";

/** Effort the layer runs at unless its role names one: it has to answer in about a second. */
export const HANDS_FREE_MODEL_EFFORT = "low";

export type HandsFreeAction = "send" | "ignore" | "progress" | "stop" | "repeat" | "full" | "summary" | "leave";

const ACTIONS: ReadonlySet<string> = new Set<HandsFreeAction>(["send", "ignore", "progress", "stop", "repeat", "full", "summary", "leave"]);

export interface HandsFreeRouteContext {
  /** The chat's title, when it has one. */
  chatTitle?: string;
  state: "idle" | "working" | "question";
  workingSeconds?: number;
  /** What was last said aloud, and whether the user cut it off. */
  lastSaid?: string;
  interrupted?: boolean;
  /** The last thing said ended with an offer to read the whole reply. */
  offerPending?: boolean;
  /** Hands-free reconnected shortly after it dropped. */
  resumeNote?: string;
  glossary?: string;
  transcript: string;
}

export interface HandsFreeRouteDecision {
  action: HandsFreeAction;
  /** For send: the transcript with only recognition errors fixed. */
  text: string;
}

export interface HandsFreeActivity {
  elapsedSeconds: number;
  /** One line per step, oldest first. */
  steps: string[];
}

export const HANDS_FREE_SYSTEM_PROMPT = `You are the hands-free voice layer of Copilot Bridge. You sit between the user's speech and a separate chat session that does the real work. You never do that work yourself, never use tools, and never chat. Every message starts with a JOB line: ROUTE, SPEAK, PROGRESS or ANNOUNCE. Handle each message on its own.

JOB: ROUTE
You get a speech transcript plus context: whether the chat is idle, working (and for how long) or waiting on a question shown on screen, what was last said aloud, and a glossary of names the user uses. Pick one action:
- send: a request, question, answer or instruction meant for the assistant. While the chat is working, anything the user adds or changes about the work ("also make it blue", "use the other branch") is still send; it steers the running work.
- ignore: not meant for the assistant: the user talking to someone else in the room or on the phone, TV or radio, fillers ("um", "hmm", "okay"), thanks or acknowledgements with no request, or a fragment that goes nowhere.
- progress: the user asks how the running work is going ("how's it going", "what's it doing", "is it done yet", "still working?"). Only while the chat is working, and only about the work it is running now; asking about some other task, or anything while the chat is idle, is send.
- stop: cancel the running work ("cancel that", "stop working on it", "never mind, don't do that").
- repeat: say the last spoken thing again ("say that again", "what was that?").
- full: read the whole last reply aloud ("read me the whole thing", "read it all"; "yes" or "sure" right after an offer to read the whole thing).
- summary: the user wants only short summaries from now on ("just give me the short version", "summaries are fine").
- leave: end hands-free mode ("I'm done, stop listening", "turn off hands-free").
"stop listening" or "stop hands-free" is leave, not stop.
For send, text is the transcript with only speech-recognition errors fixed: misheard glossary names (match the glossary's spelling), obviously wrong words, punctuation and capitals. Keep the user's words and their order. Never rephrase, summarise, translate, add or drop content. For every other action, text is "".
Reply with exactly one line of JSON and nothing else: {"action":"send","text":"..."}

JOB: SPEAK
You get a finished chat reply in markdown. Write what to say aloud: one to three short spoken sentences giving the gist: the answer, the outcome, or what the user has to decide. Plain speech only: no markdown, lists, code, URLs, file paths, ids, hashes or version strings, and no numbers nobody would say aloud. Do not start with "The reply" or "The assistant"; speak as the assistant ("I fixed...", "Done..."). If the reply is long (more than about four sentences, or it has a table, list or code), offer to read the whole thing. If the reply asks the user something, end with that question; when there is also an offer, make the offer a statement just before the question ("I can read you the whole thing."). Otherwise end with "Want me to read the whole thing?" Output only the words to speak.

JOB: PROGRESS
You get the elapsed time and the running work's activity so far: steps with short arguments and short results, and any partial assistant text. Say in one or two short spoken sentences how it's going: what it is doing now and what it has found or done so far. Speak about the work as "it". Use only what the log shows. Never invent results, guess outcomes or promise how long it will take. If there is little activity yet, say it is still getting started. Plain speech only: no markdown, file paths, ids or tool names; describe actions in everyday words. Output only the words to speak.

JOB: ANNOUNCE
Another chat finished or is waiting on the user. You get its title and the start of its reply. Say in one short spoken sentence which chat it is (its title, naturally shortened) and the gist. Plain speech only. Output only the words to speak.`;

/** Reads a route decision from the model's reply; undefined when it is not one. */
export function parseRouteDecision(content: unknown): HandsFreeRouteDecision | undefined {
  if (typeof content !== "string") return undefined;
  const match = content.match(/\{[^{}]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { action?: unknown; text?: unknown };
    if (typeof parsed.action !== "string" || !ACTIONS.has(parsed.action)) return undefined;
    const action = parsed.action as HandsFreeAction;
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (action === "send" && !text) return undefined;
    return { action, text: action === "send" ? text : "" };
  } catch {
    return undefined;
  }
}

/** Plain spoken text from a SPEAK/PROGRESS/ANNOUNCE reply; undefined when empty. */
export function parseSpoken(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  const text = content.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  return text && text.length <= 800 ? text : undefined;
}

export function formatRouteMessage(context: HandsFreeRouteContext): string {
  const state = context.state === "working"
    ? `working${context.workingSeconds !== undefined ? ` for ${formatSeconds(context.workingSeconds)}` : ""}`
    : context.state === "question" ? "waiting on a question shown on screen" : "idle";
  return [
    "JOB: ROUTE",
    `Chat: ${context.chatTitle ? `"${oneLine(context.chatTitle, 120)}", ` : ""}${state}`,
    context.lastSaid ? `Last said aloud${context.interrupted ? " (the user cut it off)" : ""}: ${oneLine(context.lastSaid, 400)}` : "Last said aloud: nothing yet",
    ...(context.offerPending ? ["That ended with an offer to read the whole reply."] : []),
    ...(context.resumeNote ? [`Note: ${oneLine(context.resumeNote, 300)}`] : []),
    ...(context.glossary ? [`Glossary: ${oneLine(context.glossary, 1_000)}`] : []),
    `Transcript: ${oneLine(context.transcript, 1_500)}`,
  ].join("\n");
}

export function formatProgressMessage(activity: HandsFreeActivity): string {
  const steps = activity.steps.slice(-25);
  return [
    "JOB: PROGRESS",
    `Elapsed: ${formatSeconds(activity.elapsedSeconds)}`,
    "Activity:",
    ...(steps.length ? steps.map((step, index) => `${index + 1}. ${oneLine(step, 300)}`) : ["(nothing yet)"]),
  ].join("\n");
}

function formatSeconds(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  return rounded < 90 ? `${rounded} seconds` : `${Math.round(rounded / 60)} minutes`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface HandsFreeModelDeps {
  listModels(): Promise<AgentModelInfo[]>;
  getSettings(): AppSettings;
  createHelperSession(config: AgentSessionConfig): Promise<{ session: AgentSession; dispose(): Promise<void> }>;
  logger?: Pick<Console, "warn">;
  /** How long each call took: opening its session, and the model's answer. */
  onTiming?(timing: { job: string; model?: string; createMs: number; answerMs: number; ok: boolean }): void;
}

export interface HandsFreeModelChoice {
  model?: string;
  reasoningEffort?: string;
}

function enabled(model: AgentModelInfo): boolean {
  const policy = (model as { policy?: { state?: string } }).policy;
  return !policy || policy.state === "enabled";
}

/**
 * The layer's model: the Hands-free role (a tier or a model of its own) at low effort unless a model
 * of its own names one, else the Small jobs model, else the cheapest model that answers quickly.
 */
export function chooseHandsFreeModel(settings: AppSettings, allModels: readonly AgentModelInfo[]): HandsFreeModelChoice {
  const models = allModels.filter(enabled);
  const role = resolveModelRole(settings, "handsFree", models);
  const helper = resolveModelRole(settings, "helper", models);
  const find = (id: string | undefined) => (id ? models.find((model) => model.id === id) : undefined);
  const chosen = (role.source !== "automatic" ? find(role.model) : undefined)
    ?? (helper.source !== "automatic" ? find(helper.model) : undefined)
    ?? find(selectHelperModel(models, HANDS_FREE_MODEL_EFFORT)?.model);
  if (!chosen) return role.source !== "automatic" && role.model ? { model: role.model } : {};
  const onRole = role.source !== "automatic" && chosen.id === role.model;
  const wanted = (onRole ? role.reasoningEffort : undefined) ?? HANDS_FREE_MODEL_EFFORT;
  const reasoningEffort = resolveSupportedReasoningEffort(wanted, chosen.supportedReasoningEfforts);
  return { model: chosen.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export const HANDS_FREE_TIMEOUTS_MS = { route: 5_000, speak: 9_000, progress: 8_000, announce: 8_000 } as const;

/** One call per job, each on a fresh helper session. Every method resolves undefined on failure. */
export class HandsFreeModel {
  private choice?: Promise<HandsFreeModelChoice>;

  constructor(private readonly deps: HandsFreeModelDeps) {}

  /** Resolves the model once per connection, ahead of the first call. */
  warm(): void {
    this.choice ??= this.resolveChoice();
  }

  route(context: HandsFreeRouteContext): Promise<HandsFreeRouteDecision | undefined> {
    return this.ask(formatRouteMessage(context), HANDS_FREE_TIMEOUTS_MS.route, "route").then(parseRouteDecision);
  }

  speak(reply: string): Promise<string | undefined> {
    return this.ask(`JOB: SPEAK\nReply:\n${reply.slice(0, 12_000)}`, HANDS_FREE_TIMEOUTS_MS.speak, "speak").then(parseSpoken);
  }

  progress(activity: HandsFreeActivity): Promise<string | undefined> {
    return this.ask(formatProgressMessage(activity), HANDS_FREE_TIMEOUTS_MS.progress, "progress").then(parseSpoken);
  }

  announce(title: string, kind: "finished" | "waiting", preview?: string): Promise<string | undefined> {
    const body = [
      "JOB: ANNOUNCE",
      `Chat: ${oneLine(title, 160)}`,
      kind === "waiting" ? "It is waiting on the user with a question." : "It finished.",
      ...(preview ? [`Its reply starts: ${oneLine(preview, 600)}`] : []),
    ].join("\n");
    return this.ask(body, HANDS_FREE_TIMEOUTS_MS.announce, "announce").then(parseSpoken);
  }

  private async resolveChoice(): Promise<HandsFreeModelChoice> {
    try {
      return chooseHandsFreeModel(this.deps.getSettings(), await this.deps.listModels());
    } catch {
      return {};
    }
  }

  private async ask(prompt: string, timeoutMs: number, job: string): Promise<string | undefined> {
    const choice = await (this.choice ??= this.resolveChoice());
    if (!choice.model) {
      this.choice = undefined;
      return undefined;
    }
    let helper: { session: AgentSession; dispose(): Promise<void> } | undefined;
    const startedAt = performance.now();
    let createMs = 0;
    let ok = false;
    try {
      helper = await this.deps.createHelperSession({
        clientName: "Copilot Bridge Hands-free",
        model: choice.model,
        ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
        systemMessage: { mode: "replace", content: HANDS_FREE_SYSTEM_PROMPT },
      });
      createMs = performance.now() - startedAt;
      const response = await helper.session.sendAndWait({ prompt, attachments: [] }, timeoutMs) as { data?: { content?: unknown } } | undefined;
      const content = response?.data?.content;
      ok = typeof content === "string";
      return ok ? content as string : undefined;
    } catch (error) {
      this.deps.logger?.warn(`[hands-free] Model call failed: ${error instanceof Error ? error.message : String(error)}`);
      await helper?.session.abort().catch(() => undefined);
      return undefined;
    } finally {
      this.deps.onTiming?.({ job, model: choice.model, createMs: Math.round(createMs), answerMs: Math.round(performance.now() - startedAt - createMs), ok });
      void helper?.dispose().catch(() => undefined);
    }
  }
}
