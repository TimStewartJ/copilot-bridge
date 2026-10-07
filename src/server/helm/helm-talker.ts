// Helm's quick voice. While the real Helm (tools, slower) works on a hands-free turn, a small
// tool-less model says a lead-in that names what Helm is about to look up or do, so the user hears
// something relevant in about a second and a half instead of a canned "One sec." after three.
// It never answers or claims anything was done; the real reply follows as before.
import type { AgentModelInfo, AgentSession, AgentSessionConfig } from "../agent-backend/index.js";
import { selectHelmModel } from "./helm-session-profile.js";

/** Measured on 28 Sep 2026 replays: gpt-6-luna at low picked right 8 of 8 turns, at about 1.5 s. */
const TALKER_EFFORT = "low";
/**
 * A lead-in later than this is of no use. The real limit is earlier and set by the conversation: the
 * canned lead-in plays 3 s after the user stops talking (4 s while a lead-in is being written), and
 * one to two of those seconds are spent deciding that the user has finished.
 */
const TALKER_TIMEOUT_MS = 3_000;
/**
 * A new helper session takes 2 to 3.5 s over its first request, because the runtime connects its
 * built-in GitHub tools and the model on first use, and 0.8 to 1.5 s over later ones. On the first
 * real call (6 Oct 2026) the first turn's lead-in took over 3 s and "One sec." played instead. So the
 * first request is a throwaway one, sent when hands-free connects.
 */
const WARM_UP_PROMPT = "User: hello";
const WARM_UP_TIMEOUT_MS = 10_000;
const MAX_LEAD_IN_CHARS = 90;

export const HELM_TALKER_SYSTEM_PROMPT = [
  "You speak the first words of Helm's spoken reply while the real Helm, which has tools, works out the answer. Helm manages the user's Copilot Bridge: AI chat sessions, tasks and notes. The user hears you through text-to-speech, often while driving.",
  "When Helm will need to look something up or do something, reply with one short lead-in of four to nine words that names it, for example \"Let me check the car task.\" or \"I'll set that up in the Tether task.\"",
  "Never answer the question, state facts, or say anything was done, found or changed.",
  "Reply with exactly SILENT when Helm can answer without looking anything up (greetings, small talk, a question about what was just said), for a bare acknowledgement like \"okay\" or \"thanks\", and for talk not meant for Helm.",
  "Plain words only: no markdown, quotes, ids, or filler like \"Great question\".",
].join("\n");

export function parseLeadIn(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  const line = content.trim().split("\n")[0]!.replace(/^[A-Z-]+:\s*/, "").replace(/[*_`#"“”]/g, "").trim();
  if (!line || /^silent\b/i.test(line) || line.length > MAX_LEAD_IN_CHARS) return undefined;
  return line;
}

export interface HelmTalkerDeps {
  listModels(): Promise<AgentModelInfo[]>;
  createHelperSession(config: AgentSessionConfig): Promise<{ session: AgentSession; dispose(): Promise<void> }>;
  logger?: Pick<Console, "log" | "warn">;
}

type Helper = { session: AgentSession; dispose(): Promise<void> };

/**
 * One helper session per hands-free connection: a warm session answers in about 0.8–1.5 s, a new
 * one takes 2–3.5 s. Each turn is sent on its own, with only Helm's last reply for context.
 */
export class HelmTalker {
  private helper?: Promise<Helper | undefined>;
  private warming?: Promise<void>;
  private busy = false;

  constructor(private readonly deps: HelmTalkerDeps) {}

  /** Opens the helper session and sends it one throwaway request, so the first real turn finds it warm. */
  warm(): void {
    if (this.helper) return;
    const helper = this.helper = this.open();
    const startedAt = performance.now();
    const warming = this.warming = (async () => {
      const opened = await helper;
      if (!opened) return;
      try {
        await opened.session.sendAndWait({ prompt: WARM_UP_PROMPT, attachments: [] }, WARM_UP_TIMEOUT_MS);
        this.deps.logger?.log(`[helm-talker] Warm in ${Math.round(performance.now() - startedAt)}ms`);
      } catch {
        await opened.session.abort().catch(() => undefined);
      }
    })().finally(() => {
      if (this.warming === warming) this.warming = undefined;
    });
  }

  async leadIn(text: string, lastReply?: string): Promise<string | undefined> {
    if (this.busy || !text.trim()) return undefined;
    this.busy = true;
    // A turn that arrives while the warm-up request is still out waits for it: one session, one request at a time.
    await this.warming;
    const helper = await (this.helper ??= this.open());
    try {
      if (!helper) return undefined;
      const prompt = [lastReply ? `Helm last said: ${lastReply.slice(0, 300)}` : "", `User: ${text}`].filter(Boolean).join("\n");
      const response = await helper.session.sendAndWait({ prompt, attachments: [] }, TALKER_TIMEOUT_MS) as { data?: { content?: unknown } } | undefined;
      return parseLeadIn(response?.data?.content);
    } catch {
      await helper?.session.abort().catch(() => undefined);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    const helper = this.helper;
    this.helper = undefined;
    await (await helper)?.dispose();
  }

  private async open(): Promise<Helper | undefined> {
    try {
      const { model, reasoningEffort } = selectHelmModel(await this.deps.listModels(), undefined, TALKER_EFFORT);
      if (!model) return undefined;
      return await this.deps.createHelperSession({
        clientName: "Copilot Bridge Helm Talker",
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        systemMessage: { mode: "replace", content: HELM_TALKER_SYSTEM_PROMPT },
      });
    } catch (error) {
      this.deps.logger?.warn(`[helm-talker] Unavailable: ${error instanceof Error ? error.message : String(error)}`);
      this.helper = undefined;
      return undefined;
    }
  }
}
