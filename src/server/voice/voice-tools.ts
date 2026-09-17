// Tools the voice assistant uses to manage Bridge: sessions, unread replies, questions
// waiting on the user, dispatching work to stronger models, and on-screen cards.
import type { AppContext } from "../app-context.js";
import { defineBridgeTool } from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import { toolFailure } from "../tool-results.js";
import type { AgentModelInfo } from "../agent-backend/types.js";

export interface VoiceSessionSummary {
  sessionId: string;
  title: string;
  runState: string;
  needsUserInput: boolean;
  unread: boolean;
  archived: boolean;
  lastActivityAt?: string;
  linkedTaskIds: string[];
  intentText?: string | null;
}

/** Bridge operations shared with the REST API so voice actions behave exactly like the UI. */
export interface VoiceBridgeFacade {
  listSessions(): Promise<VoiceSessionSummary[]>;
  markRead(sessionIds: string[]): void;
  sendMessage(sessionId: string, prompt: string): Promise<"started" | "steered">;
  createSession(options: { taskId?: string; model?: string; reasoningEffort?: string }): Promise<{ sessionId: string }>;
}

export interface VoiceCardLink {
  label: string;
  path: string;
}

export interface VoiceToolHooks {
  watchSession(sessionId: string): void;
  showCard(card: { title: string; body: string; links: VoiceCardLink[] }): void;
  requestVoiceMode(action: "sleep" | "end"): void;
}

/** Existing Bridge tools the voice assistant may also use. */
export const REUSED_BRIDGE_TOOL_NAMES = [
  "task_list",
  "task_get_info",
  "task_create",
  "task_update_momentum",
  "action_add",
  "action_list",
  "action_update",
  "decision_list",
  "alert_list",
  "docs_search",
  "docs_read",
  "focus_protection_current",
];

const MAX_REPLY_CHARS = 3_000;

export function formatAgo(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function sessionRef(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

const REFERENCE_STOPWORDS = new Set([
  "the", "a", "an", "my", "that", "this", "those", "these", "one", "session", "sessions", "chat", "chats",
  "thread", "about", "on", "for", "with", "in", "of", "to", "and", "or", "please", "it",
]);

function referenceTokens(text: string): string[] {
  const tokens = normalizeTitle(text).split(" ").filter((token) => token.length > 1);
  const meaningful = tokens.filter((token) => !REFERENCE_STOPWORDS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
}

export type SessionResolution =
  | { ok: true; session: VoiceSessionSummary }
  | { ok: false; error: string; candidates?: VoiceSessionSummary[] };

/** Resolves a session by id, short ref, or spoken title. */
export function resolveSession(sessions: VoiceSessionSummary[], reference: unknown): SessionResolution {
  const ref = typeof reference === "string" ? reference.trim() : "";
  if (!ref) return { ok: false, error: "A session reference is required." };
  const byId = sessions.find((session) => session.sessionId === ref)
    ?? (ref.length >= 4 ? sessions.filter((session) => session.sessionId.startsWith(ref.toLowerCase())) : [])[0];
  if (byId) return { ok: true, session: byId };

  const query = normalizeTitle(ref);
  const exact = sessions.filter((session) => normalizeTitle(session.title) === query);
  if (exact.length === 1) return { ok: true, session: exact[0]! };
  const tokens = referenceTokens(ref);
  const scored = sessions
    .map((session) => {
      const title = normalizeTitle(session.title);
      const score = tokens.filter((token) => title.includes(token)).length / Math.max(1, tokens.length);
      return { session, score };
    })
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score || (b.session.lastActivityAt ?? "").localeCompare(a.session.lastActivityAt ?? ""));
  if (scored.length === 0) return { ok: false, error: `No session matches "${ref}".` };
  if (scored.length === 1 || scored[0]!.score > scored[1]!.score) return { ok: true, session: scored[0]!.session };
  return {
    ok: false,
    error: `Several sessions match "${ref}". Ask which one.`,
    candidates: scored.slice(0, 5).map((entry) => entry.session),
  };
}

function describeSession(ctx: AppContext, session: VoiceSessionSummary, now = Date.now()) {
  const task = session.linkedTaskIds[0] ? ctx.taskStore.getTask(session.linkedTaskIds[0]) : undefined;
  return {
    ref: sessionRef(session.sessionId),
    title: session.title,
    status: session.needsUserInput ? "waiting on you" : session.runState === "idle" ? "idle" : session.runState,
    unread: session.unread,
    ...(task ? { task: task.title } : {}),
    ...(session.intentText && session.runState !== "idle" ? { doing: session.intentText } : {}),
    ...(formatAgo(session.lastActivityAt, now) ? { lastActivity: formatAgo(session.lastActivityAt, now) } : {}),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

function modelTier(model: AgentModelInfo): "fast and cheap" | "balanced" | "most capable" {
  const prices = (model as { billing?: { tokenPrices?: { outputPrice?: number } } }).billing?.tokenPrices;
  const output = prices?.outputPrice;
  if (typeof output !== "number") return "balanced";
  if (output <= 500) return "fast and cheap";
  if (output >= 2_000) return "most capable";
  return "balanced";
}

function pendingQuestions(ctx: AppContext, sessionId: string) {
  const index = ctx.eventBusRegistry.getBus(sessionId)?.getPendingInteractionIndex();
  return {
    userInputs: index?.pendingUserInputs ?? [],
    elicitations: index?.pendingElicitations ?? [],
  };
}

export function createVoiceToolDefinitions(
  ctx: AppContext,
  facade: VoiceBridgeFacade,
  hooks: VoiceToolHooks,
): BridgeToolDefinition[] {
  const withSession = async (reference: unknown) => {
    const sessions = await facade.listSessions();
    return resolveSession(sessions, reference);
  };
  const resolutionFailure = (resolution: Extract<SessionResolution, { ok: false }>) => toolFailure(resolution.error, {
    ...(resolution.candidates
      ? { detail: `Candidates: ${resolution.candidates.map((session) => `"${session.title}" (${sessionRef(session.sessionId)})`).join(", ")}` }
      : {}),
  });

  const tools: BridgeToolDefinition[] = [
    defineBridgeTool("bridge_overview", {
      description: "Snapshot of the user's Bridge right now: unread replies, sessions still running, sessions waiting on the user, and active tasks with next actions. Use for 'what's new', 'what's going on', 'anything need me?'.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const now = Date.now();
        const sessions = (await facade.listSessions()).filter((session) => !session.archived);
        const waiting = sessions.filter((session) => session.needsUserInput);
        const running = sessions.filter((session) => session.runState !== "idle" && !session.needsUserInput);
        const unread = sessions.filter((session) => session.unread && session.runState === "idle" && !session.needsUserInput);
        const tasks = ctx.taskStore.listTasks()
          .filter((task) => task.status === "active" && !task.muted)
          .sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 8)
          .map((task) => ({
            taskId: task.id,
            title: task.title,
            ...(task.nextAction ? { nextAction: task.nextAction } : {}),
            ...(task.waitingOn ? { waitingOn: task.waitingOn } : {}),
          }));
        return {
          now: new Date(now).toISOString(),
          waitingOnYou: waiting.slice(0, 8).map((session) => ({
            ...describeSession(ctx, session, now),
            questions: pendingQuestions(ctx, session.sessionId).userInputs.map((request) => request.question).slice(0, 2),
          })),
          running: running.slice(0, 8).map((session) => describeSession(ctx, session, now)),
          unreadReplies: unread.slice(0, 10).map((session) => describeSession(ctx, session, now)),
          counts: { waitingOnYou: waiting.length, running: running.length, unread: unread.length },
          activeTasks: tasks,
        };
      },
    }),
    defineBridgeTool("list_sessions", {
      description: "List Bridge chat sessions. Filter by unread, running, waiting (needs the user), recent, or a spoken title query or task id.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["unread", "running", "waiting", "recent", "all"], description: "Which sessions to include. Defaults to recent." },
          query: { type: "string", description: "Words from the session title." },
          taskId: { type: "string", description: "Only sessions linked to this task." },
          limit: { type: "number", description: "Maximum sessions to return (default 10, max 25)." },
        },
      },
      handler: async (args: any) => {
        const now = Date.now();
        let sessions = (await facade.listSessions()).filter((session) => !session.archived);
        switch (args.filter ?? "recent") {
          case "unread":
            sessions = sessions.filter((session) => session.unread);
            break;
          case "running":
            sessions = sessions.filter((session) => session.runState !== "idle");
            break;
          case "waiting":
            sessions = sessions.filter((session) => session.needsUserInput);
            break;
          default:
            break;
        }
        if (typeof args.taskId === "string" && args.taskId.trim()) {
          sessions = sessions.filter((session) => session.linkedTaskIds.includes(args.taskId.trim()));
        }
        if (typeof args.query === "string" && args.query.trim()) {
          const tokens = referenceTokens(args.query);
          sessions = sessions.filter((session) => {
            const title = normalizeTitle(session.title);
            return tokens.some((token) => title.includes(token));
          });
        }
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        return { total: sessions.length, sessions: sessions.slice(0, limit).map((session) => describeSession(ctx, session, now)) };
      },
    }),
    defineBridgeTool("read_session", {
      description: "Read a session's latest reply (and what it is doing if still running, plus any question it's asking the user). Marks it read by default. Summarize conversationally; don't read it verbatim unless asked.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session ref, id, or title words." },
          markRead: { type: "boolean", description: "Mark the session read after reading. Defaults to true." },
        },
        required: ["session"],
      },
      handler: async (args: any) => {
        const resolution = await withSession(args.session);
        if (!resolution.ok) return resolutionFailure(resolution);
        const { session } = resolution;
        const { messages } = await ctx.sessionManager.readMessagesFromDisk(session.sessionId, { limit: 30 });
        const textMessages = messages.filter((entry: any) => entry?.type === "message" && typeof entry.content === "string" && entry.content.trim());
        const latestReply = [...textMessages].reverse().find((entry: any) => entry.role === "assistant") as { content: string; timestamp?: string } | undefined;
        const latestPrompt = [...textMessages].reverse().find((entry: any) => entry.role === "user") as { content: string } | undefined;
        const bus = ctx.eventBusRegistry.getBus(session.sessionId);
        const live = session.runState !== "idle" ? bus?.getLastAssistantSegment() : undefined;
        const questions = pendingQuestions(ctx, session.sessionId);
        if (args.markRead !== false && session.unread) facade.markRead([session.sessionId]);
        return {
          ...describeSession(ctx, session),
          ...(latestPrompt ? { lastPrompt: truncate(latestPrompt.content, 500) } : {}),
          ...(latestReply ? { latestReply: truncate(latestReply.content, MAX_REPLY_CHARS), repliedAt: latestReply.timestamp } : { latestReply: null }),
          ...(live?.content ? { liveProgress: truncate(live.content, 800) } : {}),
          ...(questions.userInputs.length
            ? { waitingForAnswer: questions.userInputs.map((request) => ({ question: request.question, choices: request.choices ?? [], allowFreeform: request.allowFreeform })) }
            : {}),
          ...(questions.elicitations.length
            ? { waitingForForm: questions.elicitations.map((request) => request.message) }
            : {}),
        };
      },
    }),
    defineBridgeTool("send_to_session", {
      description: "Send the user's message or instructions to an existing session. If it's running, the message steers it immediately. Write a complete, self-contained message.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session ref, id, or title words." },
          message: { type: "string", description: "The message to send, written as the user would type it." },
        },
        required: ["session", "message"],
      },
      handler: async (args: any) => {
        const resolution = await withSession(args.session);
        if (!resolution.ok) return resolutionFailure(resolution);
        const message = String(args.message ?? "").trim();
        if (!message) return toolFailure("message is required");
        try {
          const mode = await facade.sendMessage(resolution.session.sessionId, message);
          hooks.watchSession(resolution.session.sessionId);
          return { success: true, session: resolution.session.title, ref: sessionRef(resolution.session.sessionId), delivery: mode };
        } catch (error) {
          return toolFailure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    defineBridgeTool("start_session", {
      description: "Start a new Bridge session that does real work (coding, research, fixes, writing) with a capable model, optionally inside a task. Returns immediately while it works; you'll hear when it finishes. Write a complete, self-contained prompt with all needed context.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Full instructions for the worker session." },
          taskId: { type: "string", description: "Task id to run the session in (use task_list to find it)." },
          model: { type: "string", description: "Model id. Omit to use the user's default model; use list_models to find stronger ones." },
          reasoningEffort: { type: "string", description: "Optional reasoning effort such as low, medium, high." },
        },
        required: ["prompt"],
      },
      handler: async (args: any) => {
        const prompt = String(args.prompt ?? "").trim();
        if (!prompt) return toolFailure("prompt is required");
        const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : undefined;
        if (taskId && !ctx.taskStore.getTask(taskId)) return toolFailure(`Task ${taskId} was not found. Use task_list to find the right task id.`);
        try {
          const { sessionId } = await facade.createSession({
            ...(taskId ? { taskId } : {}),
            ...(typeof args.model === "string" && args.model.trim() ? { model: args.model.trim() } : {}),
            ...(typeof args.reasoningEffort === "string" && args.reasoningEffort.trim() ? { reasoningEffort: args.reasoningEffort.trim() } : {}),
          });
          await facade.sendMessage(sessionId, prompt);
          hooks.watchSession(sessionId);
          return {
            success: true,
            ref: sessionRef(sessionId),
            ...(taskId ? { task: ctx.taskStore.getTask(taskId)?.title } : {}),
            model: args.model ?? ctx.settingsStore.getSettings().model ?? "default",
          };
        } catch (error) {
          return toolFailure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    defineBridgeTool("stop_session", {
      description: "Stop a running session's current turn. Only call after the user confirms.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session ref, id, or title words." },
          confirmed: { type: "boolean", description: "Must be true: the user explicitly confirmed stopping it." },
        },
        required: ["session", "confirmed"],
      },
      handler: async (args: any) => {
        if (args.confirmed !== true) return toolFailure("Ask the user to confirm before stopping a session.");
        const resolution = await withSession(args.session);
        if (!resolution.ok) return resolutionFailure(resolution);
        const aborted = await ctx.sessionManager.abortSession(resolution.session.sessionId);
        return aborted
          ? { success: true, session: resolution.session.title }
          : toolFailure(`${resolution.session.title} isn't running.`);
      },
    }),
    defineBridgeTool("answer_session_question", {
      description: "Answer a question a session is waiting on (ask_user). Pick the matching choice when choices exist.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session ref, id, or title words." },
          answer: { type: "string", description: "The user's answer." },
        },
        required: ["session", "answer"],
      },
      handler: async (args: any) => {
        const resolution = await withSession(args.session);
        if (!resolution.ok) return resolutionFailure(resolution);
        const request = pendingQuestions(ctx, resolution.session.sessionId).userInputs[0];
        if (!request) return toolFailure(`${resolution.session.title} isn't waiting on a question. Forms must be answered in the Bridge UI.`);
        const answer = String(args.answer ?? "").trim();
        if (!answer) return toolFailure("answer is required");
        const choice = request.choices?.find((candidate) => normalizeTitle(candidate) === normalizeTitle(answer))
          ?? request.choices?.find((candidate) => normalizeTitle(candidate).includes(normalizeTitle(answer)) || normalizeTitle(answer).includes(normalizeTitle(candidate)));
        if (!choice && !request.allowFreeform) {
          return toolFailure(`That answer must be one of: ${(request.choices ?? []).join(", ")}`);
        }
        try {
          await ctx.sessionManager.submitUserInputResponse(resolution.session.sessionId, request.requestId, {
            answer: choice ?? answer,
            wasFreeform: !choice,
          });
          hooks.watchSession(resolution.session.sessionId);
          return { success: true, session: resolution.session.title, question: request.question, answer: choice ?? answer };
        } catch (error) {
          return toolFailure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    defineBridgeTool("mark_sessions_read", {
      description: "Mark sessions read after the user has heard about them or asks to clear them.",
      parameters: {
        type: "object",
        properties: {
          sessions: { type: "array", items: { type: "string" }, description: "Session refs, ids, or titles." },
          allUnread: { type: "boolean", description: "Mark every unread session read." },
        },
      },
      handler: async (args: any) => {
        const sessions = await facade.listSessions();
        const ids = new Set<string>();
        if (args.allUnread === true) {
          for (const session of sessions) if (session.unread) ids.add(session.sessionId);
        }
        for (const reference of Array.isArray(args.sessions) ? args.sessions : []) {
          const resolution = resolveSession(sessions, reference);
          if (!resolution.ok) return resolutionFailure(resolution);
          ids.add(resolution.session.sessionId);
        }
        if (ids.size === 0) return toolFailure("Nothing to mark read.");
        facade.markRead([...ids]);
        return { success: true, marked: ids.size };
      },
    }),
    defineBridgeTool("list_models", {
      description: "List models available for new sessions with a rough capability tier. Use to pick a stronger model for demanding work.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const models = await ctx.sessionManager.listModels();
        const defaultModel = ctx.settingsStore.getSettings().model;
        return {
          defaultModel,
          models: models
            .filter((model) => !(model as { policy?: { state?: string } }).policy || (model as { policy?: { state?: string } }).policy?.state === "enabled")
            .map((model) => ({
              id: model.id,
              name: model.name,
              tier: modelTier(model),
              ...(model.supportedReasoningEfforts?.length ? { reasoningEfforts: model.supportedReasoningEfforts } : {}),
            })),
        };
      },
    }),
    defineBridgeTool("show_on_screen", {
      description: "Show a card on the user's voice screen for details that are awkward to speak: lists, code, links, longer summaries. Say one short sentence pointing to it.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string", description: "Markdown body." },
          sessions: { type: "array", items: { type: "string" }, description: "Session refs to link." },
          taskIds: { type: "array", items: { type: "string" }, description: "Task ids to link." },
        },
        required: ["title", "body"],
      },
      handler: async (args: any) => {
        const links: VoiceCardLink[] = [];
        if (Array.isArray(args.sessions) && args.sessions.length) {
          const sessions = await facade.listSessions();
          for (const reference of args.sessions.slice(0, 6)) {
            const resolution = resolveSession(sessions, reference);
            if (resolution.ok) links.push({ label: resolution.session.title, path: `/sessions/${resolution.session.sessionId}` });
          }
        }
        for (const taskId of Array.isArray(args.taskIds) ? args.taskIds.slice(0, 6) : []) {
          const task = typeof taskId === "string" ? ctx.taskStore.getTask(taskId) : undefined;
          if (task) links.push({ label: task.title, path: `/tasks/${task.id}` });
        }
        hooks.showCard({ title: String(args.title).slice(0, 120), body: String(args.body).slice(0, 8_000), links });
        return { success: true };
      },
    }),
    defineBridgeTool("voice_mode", {
      description: "Control voice mode when the user asks: sleep (stop listening until 'hey Bridge') or end (exit voice mode).",
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["sleep", "end"] } },
        required: ["action"],
      },
      handler: async (args: any) => {
        if (args.action !== "sleep" && args.action !== "end") return toolFailure("action must be sleep or end");
        hooks.requestVoiceMode(args.action);
        return { success: true };
      },
    }),
  ];

  const reused = ctx.bridgeToolsMcpServer
    ?.getToolDefinitions("all")
    .filter((definition) => REUSED_BRIDGE_TOOL_NAMES.includes(definition.name) && definition.scope !== "session")
    .map((definition): BridgeToolDefinition => ({
      ...definition,
      handler: async (args, extra) => boundToolResult(await definition.handler(args, extra)) as Awaited<ReturnType<BridgeToolDefinition["handler"]>>,
    }))
    ?? [];
  return [...tools, ...reused];
}

/** Caps long notes and lists in reused tool results so voice turns stay fast and cheap. */
export function boundToolResult(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 1_500 ? `${value.slice(0, 1_500)}… (truncated)` : value;
  if (Array.isArray(value)) {
    const bounded = value.slice(0, 40).map((entry) => boundToolResult(entry, depth + 1));
    return value.length > 40 ? [...bounded, `… ${value.length - 40} more`] : bounded;
  }
  if (value && typeof value === "object" && depth < 8) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, boundToolResult(entry, depth + 1)]));
  }
  return value;
}
