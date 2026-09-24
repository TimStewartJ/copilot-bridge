// Tools Helm uses to orchestrate Bridge: sessions, unread replies, questions waiting on the
// user, dispatching work to stronger models, and housekeeping. The same tools serve typed
// chat and hands-free voice, so both modes behave identically.
import type { AppContext } from "../app-context.js";
import { defineBridgeTool, type BridgeToolInvocation } from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";
import { toolFailure } from "../tool-results.js";
import type { AgentModelInfo } from "../agent-backend/types.js";
import { formatBridgeLink } from "../../shared/bridge-links.js";

export interface HelmSessionSummary {
  sessionId: string;
  title: string;
  runState: string;
  needsUserInput: boolean;
  unread: boolean;
  archived: boolean;
  lastActivityAt?: string;
  linkedTaskIds: string[];
  intentText?: string | null;
  /** "schedule" for sessions a schedule started; absent for the user's own and other agents'. */
  triggeredBy?: string;
  scheduleName?: string;
}

/** Bridge operations shared with the REST API so Helm actions behave exactly like the UI. */
export interface HelmBridgeFacade {
  listSessions(options?: { includeArchived?: boolean }): Promise<HelmSessionSummary[]>;
  markRead(sessionIds: string[]): void;
  setArchived(sessionIds: string[], archived: boolean): void;
  sendMessage(sessionId: string, prompt: string): Promise<"started" | "steered">;
  createSession(options: { taskId?: string; model?: string; reasoningEffort?: string }): Promise<{ sessionId: string }>;
}

/** Hands-free controls for the Helm conversation that is calling a tool, when voice is attached. */
export interface HelmHandsFreeHooks {
  requestHandsFree(action: "sleep" | "end"): void;
}

export interface HelmToolRuntime {
  /** Remembers a session the conversation dispatched work to, so hands-free can announce it. */
  watchSession(helmSessionId: string | undefined, sessionId: string): void;
  getHandsFreeHooks(helmSessionId: string | undefined): HelmHandsFreeHooks | undefined;
}

export const HELM_TOOL_NAMES = [
  "bridge_overview",
  "find",
  "list_sessions",
  "read_session",
  "send_to_session",
  "start_session",
  "stop_session",
  "answer_session_question",
  "mark_sessions_read",
  "archive_sessions",
  "list_models",
  "hands_free",
] as const;

/**
 * Bridge tools Helm may use besides its own: everything for day-to-day management of tasks,
 * schedules, docs and checklist items. Helm never edits code, browses, or deploys, so tools that
 * do real work stay with worker sessions.
 *
 * Every tool's schema rides along on every turn, and Helm is meant to answer quickly (out loud,
 * in hands-free), so the surface stops at orchestration. Left out on purpose:
 * - Docs backup administration and collection schema changes.
 */
const HELM_BRIDGE_TOOL_PREFIXES = ["task_", "tag_", "action_", "schedule_", "docs_"];
const HELM_BRIDGE_TOOL_NAMES = new Set(["session_rename", "publish_visual"]);
const HELM_BRIDGE_TOOL_EXCLUDED_PREFIXES = ["docs_snapshot_"];
const HELM_BRIDGE_TOOL_EXCLUSIONS = new Set([
  "docs_db_create",
  "docs_db_delete",
]);

export function isHelmBridgeToolName(name: string): boolean {
  if (HELM_BRIDGE_TOOL_EXCLUSIONS.has(name)) return false;
  if (HELM_BRIDGE_TOOL_EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  return HELM_BRIDGE_TOOL_NAMES.has(name) || HELM_BRIDGE_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const MAX_REPLY_CHARS = 3_000;
const MAX_HISTORY_MESSAGES = 12;

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
  | { ok: true; session: HelmSessionSummary }
  | { ok: false; error: string; candidates?: HelmSessionSummary[] };

/** Resolves a session by id, short ref, `bridge://session/…` link, or spoken title. */
export function resolveSession(sessions: HelmSessionSummary[], reference: unknown): SessionResolution {
  const raw = typeof reference === "string" ? reference.trim() : "";
  const ref = raw.replace(/^bridge:\/\/sessions?\//i, "");
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

function describeSessionTarget(session: HelmSessionSummary) {
  return {
    session: session.title,
    ref: sessionRef(session.sessionId),
    link: formatBridgeLink({ kind: "session", sessionId: session.sessionId }),
  };
}

function describeSession(ctx: AppContext, session: HelmSessionSummary, now = Date.now()) {
  const task = session.linkedTaskIds[0] ? ctx.taskStore.getTask(session.linkedTaskIds[0]) : undefined;
  return {
    ref: sessionRef(session.sessionId),
    title: session.title,
    link: formatBridgeLink({ kind: "session", sessionId: session.sessionId }),
    status: session.needsUserInput ? "waiting on you" : session.runState === "idle" ? "idle" : session.runState,
    unread: session.unread,
    ...(session.archived ? { archived: true } : {}),
    ...(task ? { task: task.title, taskLink: formatBridgeLink({ kind: "task", taskId: task.id }) } : {}),
    ...(session.intentText && session.runState !== "idle" ? { doing: session.intentText } : {}),
    ...(session.triggeredBy === "schedule"
      ? { startedBy: session.scheduleName ? `schedule "${session.scheduleName}"` : "a schedule" }
      : {}),
    ...(formatAgo(session.lastActivityAt, now) ? { lastActivity: formatAgo(session.lastActivityAt, now) } : {}),
  };
}

type TranscriptEntry = {
  type?: string;
  role?: string;
  content?: string;
  timestamp?: string;
  toolCall?: { name?: string; startedAt?: string; completedAt?: string };
};

/**
 * What a running session is doing, from its transcript since the last prompt: how long it has been at
 * it, its last few tool steps (the one still running marked), and the heading of its latest thinking.
 * A busy session that has not written any text yet otherwise reads as "no reply" (24 Sep 2026).
 */
export function describeProgress(entries: readonly TranscriptEntry[], now = Date.now()) {
  let start = entries.length;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "message" && entry.role === "user") { start = index; break; }
  }
  const since = entries.slice(start + 1);
  const tools = since.filter((entry) => entry.type === "tool" && entry.toolCall?.name);
  const thinking = [...since].reverse().find((entry) => entry.type === "reasoning" && entry.content?.trim());
  const heading = thinking?.content?.match(/\*\*([^*\n]{3,120})\*\*/)?.[1]?.trim();
  const promptAt = entries[start]?.timestamp;
  const workingFor = promptAt ? formatAgo(promptAt, now)?.replace(/ ago$/, "") : undefined;
  return {
    ...(workingFor ? { workingFor } : {}),
    stepsSoFar: tools.length,
    recentSteps: tools.slice(-4).map((entry) => `${entry.toolCall!.name}${entry.toolCall!.completedAt ? "" : " (running)"}`),
    ...(heading ? { thinkingAbout: heading } : {}),
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

export interface BridgeSessionCounts {
  waiting: number;
  running: number;
  unread: number;
}

function partitionSessions(sessions: HelmSessionSummary[]) {
  const active = sessions.filter((session) => !session.archived);
  return {
    waiting: active.filter((session) => session.needsUserInput),
    running: active.filter((session) => session.runState !== "idle" && !session.needsUserInput),
    unread: active.filter((session) => session.unread && session.runState === "idle" && !session.needsUserInput),
  };
}

export function countBridgeSessions(sessions: HelmSessionSummary[]): BridgeSessionCounts {
  const { waiting, running, unread } = partitionSessions(sessions);
  return { waiting: waiting.length, running: running.length, unread: unread.length };
}

/** One compact line of live Bridge state that rides along with a turn. */
export function buildBridgeSnapshotLine(sessions: HelmSessionSummary[], now = Date.now()): string {
  const { waiting, running, unread } = partitionSessions(sessions);
  const describe = (list: HelmSessionSummary[], withAgo: boolean) => list.slice(0, 3)
    .map((session) => `"${session.title}"${withAgo && formatAgo(session.lastActivityAt, now) ? ` (${formatAgo(session.lastActivityAt, now)})` : ""}`)
    .join(", ");
  return [
    waiting.length ? `${waiting.length} waiting on you: ${describe(waiting, false)}` : "nothing waiting on you",
    running.length ? `${running.length} running: ${describe(running, false)}` : "nothing running",
    unread.length ? `${unread.length} unread: ${describe(unread, true)}` : "no unread replies",
  ].join("; ");
}

export function createHelmToolDefinitions(
  ctx: AppContext,
  facade: HelmBridgeFacade,
  runtime: HelmToolRuntime,
): BridgeToolDefinition[] {
  const withSession = async (reference: unknown, options?: { includeArchived?: boolean }) => {
    const sessions = await facade.listSessions(options);
    return resolveSession(sessions, reference);
  };
  const resolutionFailure = (resolution: Extract<SessionResolution, { ok: false }>) => toolFailure(resolution.error, {
    ...(resolution.candidates
      ? { detail: `Candidates: ${resolution.candidates.map((session) => `"${session.title}" (${sessionRef(session.sessionId)})`).join(", ")}` }
      : {}),
  });

  const tools: BridgeToolDefinition[] = [
    defineBridgeTool("bridge_overview", {
      description: "Snapshot of the user's Bridge right now: unread replies, sessions still running, sessions waiting on the user, and active tasks (most recently active first) with their last activity and next actions. counts.activeTasks is the total when more exist than are listed. Use for 'what's new', 'what's going on', 'anything need me?', 'what changed recently?'.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const now = Date.now();
        const sessions = await facade.listSessions();
        const { waiting, running, unread } = partitionSessions(sessions);
        // The same "last activity" the task rail shows: the newest of the task's own changes and
        // its sessions' activity. Without it, a recency question costs one task_get_info per task.
        const sessionActivity = new Map<string, number>();
        for (const session of sessions) {
          const time = Date.parse(session.lastActivityAt ?? "");
          if (!Number.isFinite(time)) continue;
          for (const taskId of session.linkedTaskIds) {
            if (time > (sessionActivity.get(taskId) ?? 0)) sessionActivity.set(taskId, time);
          }
        }
        const activeTasks = ctx.taskStore.listTasks()
          .filter((task) => task.status === "active" && !task.muted)
          .map((task) => ({ task, lastActivityAt: Math.max(Date.parse(task.updatedAt) || 0, sessionActivity.get(task.id) ?? 0) }))
          .sort((a, b) => b.task.priority - a.task.priority || b.lastActivityAt - a.lastActivityAt);
        const tasks = activeTasks.slice(0, 8).map(({ task, lastActivityAt }) => {
          const lastActivity = lastActivityAt > 0 ? formatAgo(new Date(lastActivityAt).toISOString(), now) : undefined;
          return {
            taskId: task.id,
            title: task.title,
            link: formatBridgeLink({ kind: "task", taskId: task.id }),
            ...(lastActivity ? { lastActivity } : {}),
            ...(task.nextAction ? { nextAction: task.nextAction } : {}),
            ...(task.waitingOn ? { waitingOn: task.waitingOn } : {}),
          };
        });
        return {
          now: new Date(now).toISOString(),
          waitingOnYou: waiting.slice(0, 8).map((session) => ({
            ...describeSession(ctx, session, now),
            questions: pendingQuestions(ctx, session.sessionId).userInputs.map((request) => request.question).slice(0, 2),
          })),
          running: running.slice(0, 8).map((session) => describeSession(ctx, session, now)),
          unreadReplies: unread.slice(0, 10).map((session) => describeSession(ctx, session, now)),
          counts: { waitingOnYou: waiting.length, running: running.length, unread: unread.length, activeTasks: activeTasks.length },
          activeTasks: tasks,
        };
      },
    }),
    defineBridgeTool("find", {
      description: "Find tasks, sessions and notes by what they are about, not only by title: searches task titles and notes, session titles and chat messages, and the knowledge base. Use it whenever the user names a task or session loosely or by topic (\"the Apple integration task\", \"the standalone app\"), before picking one from task_list or list_sessions. Returns the best matches with the text that matched; if several could fit, ask which one.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The user's words for it, e.g. \"standalone copilot app apple integration\"." },
          kind: { type: "string", enum: ["all", "task", "chat", "doc"], description: "Only tasks, sessions (chat) or notes (doc). Defaults to all." },
        },
        required: ["query"],
      },
      handler: async (args: any) => {
        const query = String(args.query ?? "").trim().slice(0, 500);
        if (!query) return toolFailure("query is required");
        if (!ctx.searchIndex) return toolFailure("Search is not available on this Bridge right now. Use task_list or list_sessions.");
        const kind = ["all", "task", "chat", "doc"].includes(args.kind) ? args.kind : "all";
        const request = { q: query, scope: "global" as const, kind, limit: 5, offset: 0, refreshOnly: true };
        let result = await ctx.searchIndex.search(request);
        let matchedAnyWord = false;
        const found = (value: typeof result) => value.tasks.total + value.chats.total + value.docs.total;
        if (found(result) === 0 && query.split(/\s+/).length > 1) {
          result = await ctx.searchIndex.search({ ...request, anyWord: true });
          matchedAnyWord = true;
        }
        return {
          ...(matchedAnyWord ? { matchedAnyWord: true } : {}),
          tasks: result.tasks.items.map((task) => ({
            taskId: task.taskId,
            title: task.title,
            link: formatBridgeLink({ kind: "task", taskId: task.taskId }),
            matched: task.snippet,
            ...(task.archived ? { archived: true } : {}),
          })),
          sessions: result.chats.items.map((chat) => ({
            ref: sessionRef(chat.sessionId),
            title: chat.title,
            link: formatBridgeLink({ kind: "session", sessionId: chat.sessionId }),
            ...(chat.taskTitle ? { task: chat.taskTitle } : {}),
            ...(chat.matches[0] ? { matched: chat.matches[0].snippet } : {}),
            matchCount: chat.matchCount,
            ...(chat.archived ? { archived: true } : {}),
          })),
          notes: result.docs.items.map((doc) => ({
            path: doc.path,
            title: doc.title,
            link: formatBridgeLink({ kind: "doc", path: doc.path }),
            matched: doc.snippet,
          })),
          ...(result.coverage.state !== "ready" ? { coverage: "Some sessions are still being indexed; results may be incomplete." } : {}),
        };
      },
    }),
    defineBridgeTool("list_sessions", {
      description: "List Bridge chat sessions. Filter by unread, running, waiting (needs the user), recent, archived, or a title query or task id.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["unread", "running", "waiting", "recent", "archived", "all"], description: "Which sessions to include. Defaults to recent." },
          query: { type: "string", description: "Words from the session title." },
          taskId: { type: "string", description: "Only sessions linked to this task." },
          limit: { type: "number", description: "Maximum sessions to return (default 10, max 25)." },
        },
      },
      handler: async (args: any) => {
        const now = Date.now();
        const filter = args.filter ?? "recent";
        const archivedOnly = filter === "archived";
        let sessions = await facade.listSessions(archivedOnly ? { includeArchived: true } : undefined);
        sessions = sessions.filter((session) => (archivedOnly ? session.archived : !session.archived));
        switch (filter) {
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
      description: "Read a session's latest reply (and what it is doing if still running, plus any question it's asking the user). Marks it read by default. Set history to also get the last few exchanges. Summarize; don't repeat it verbatim unless asked.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session ref, id, link, or title words." },
          markRead: { type: "boolean", description: "Mark the session read after reading. Defaults to true." },
          history: { type: "number", description: `Also return up to this many recent messages (max ${MAX_HISTORY_MESSAGES}).` },
        },
        required: ["session"],
      },
      handler: async (args: any) => {
        const resolution = await withSession(args.session);
        if (!resolution.ok) return resolutionFailure(resolution);
        const { session } = resolution;
        // Thinking entries roughly double the non-message entries of an agentic run.
        const { messages } = await ctx.sessionManager.readMessagesFromDisk(session.sessionId, { limit: 80 });
        const textMessages = messages.filter((entry: any) => entry?.type === "message" && typeof entry.content === "string" && entry.content.trim()) as Array<{ role: string; content: string; timestamp?: string }>;
        const latestReply = [...textMessages].reverse().find((entry) => entry.role === "assistant");
        const latestPrompt = [...textMessages].reverse().find((entry) => entry.role === "user");
        const bus = ctx.eventBusRegistry.getBus(session.sessionId);
        const live = session.runState !== "idle" ? bus?.getLastAssistantSegment() : undefined;
        const questions = pendingQuestions(ctx, session.sessionId);
        const historyCount = Math.min(MAX_HISTORY_MESSAGES, Math.max(0, Math.floor(Number(args.history) || 0)));
        if (args.markRead !== false && session.unread) facade.markRead([session.sessionId]);
        return {
          ...describeSession(ctx, session),
          ...(latestPrompt ? { lastPrompt: truncate(latestPrompt.content, 500) } : {}),
          ...(latestReply ? { latestReply: truncate(latestReply.content, MAX_REPLY_CHARS), repliedAt: latestReply.timestamp } : { latestReply: null }),
          ...(live?.content ? { liveProgress: truncate(live.content, 800) } : {}),
          ...(session.runState !== "idle" ? { progress: describeProgress(messages as TranscriptEntry[]) } : {}),
          ...(historyCount > 0
            ? { recentMessages: textMessages.slice(-historyCount).map((entry) => ({ role: entry.role, content: truncate(entry.content, 1_200) })) }
            : {}),
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
          session: { type: "string", description: "Session ref, id, link, or title words." },
          message: { type: "string", description: "The message to send, written as the user would type it." },
        },
        required: ["session", "message"],
      },
      handler: async (args: any, invocation: BridgeToolInvocation) => {
        const resolution = await withSession(args.session, { includeArchived: true });
        if (!resolution.ok) return resolutionFailure(resolution);
        const message = String(args.message ?? "").trim();
        if (!message) return toolFailure("message is required");
        try {
          const mode = await facade.sendMessage(resolution.session.sessionId, message);
          runtime.watchSession(invocation.sessionId, resolution.session.sessionId);
          return { success: true, ...describeSessionTarget(resolution.session), delivery: mode };
        } catch (error) {
          return toolFailure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    defineBridgeTool("start_session", {
      description: "Start a new Bridge session that does real work (coding, research, fixes, writing) with a capable model, optionally inside a task. Returns immediately while it works. Write a complete, self-contained prompt with all needed context.",
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
      handler: async (args: any, invocation: BridgeToolInvocation) => {
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
          runtime.watchSession(invocation.sessionId, sessionId);
          return {
            success: true,
            ref: sessionRef(sessionId),
            link: formatBridgeLink({ kind: "session", sessionId }),
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
          session: { type: "string", description: "Session ref, id, link, or title words." },
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
          ? { success: true, ...describeSessionTarget(resolution.session) }
          : toolFailure(`${resolution.session.title} isn't running.`);
      },
    }),
    defineBridgeTool("answer_session_question", {
      description: "Answer a question a session is waiting on (ask_user). Pick the matching choice when choices exist.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session ref, id, link, or title words." },
          answer: { type: "string", description: "The user's answer." },
        },
        required: ["session", "answer"],
      },
      handler: async (args: any, invocation: BridgeToolInvocation) => {
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
          runtime.watchSession(invocation.sessionId, resolution.session.sessionId);
          return { success: true, ...describeSessionTarget(resolution.session), question: request.question, answer: choice ?? answer };
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
          sessions: { type: "array", items: { type: "string" }, description: "Session refs, ids, links, or titles." },
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
    defineBridgeTool("archive_sessions", {
      description: "Archive finished sessions to tidy the lists, or restore archived ones. Never archive a session that is running or waiting on the user.",
      parameters: {
        type: "object",
        properties: {
          sessions: { type: "array", items: { type: "string" }, description: "Session refs, ids, links, or titles." },
          archived: { type: "boolean", description: "True to archive (default), false to restore." },
        },
        required: ["sessions"],
      },
      handler: async (args: any) => {
        const archived = args.archived !== false;
        const sessions = await facade.listSessions({ includeArchived: true });
        const targets: HelmSessionSummary[] = [];
        for (const reference of Array.isArray(args.sessions) ? args.sessions.slice(0, 25) : []) {
          const resolution = resolveSession(sessions, reference);
          if (!resolution.ok) return resolutionFailure(resolution);
          if (archived && (resolution.session.runState !== "idle" || resolution.session.needsUserInput)) {
            return toolFailure(`${resolution.session.title} is still ${resolution.session.needsUserInput ? "waiting on the user" : "running"}.`);
          }
          targets.push(resolution.session);
        }
        if (targets.length === 0) return toolFailure("No sessions to update.");
        facade.setArchived(targets.map((session) => session.sessionId), archived);
        return { success: true, archived, sessions: targets.map((session) => session.title) };
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
    defineBridgeTool("hands_free", {
      description: "Control hands-free voice when the user asks out loud: sleep (stop listening until 'hey Bridge') or end (leave hands-free and return to chat). Only works while hands-free is active.",
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["sleep", "end"] } },
        required: ["action"],
      },
      handler: async (args: any, invocation: BridgeToolInvocation) => {
        if (args.action !== "sleep" && args.action !== "end") return toolFailure("action must be sleep or end");
        const hooks = runtime.getHandsFreeHooks(invocation.sessionId);
        if (!hooks) return toolFailure("Hands-free isn't active. The user can start it with the Hands-free button in Helm.");
        hooks.requestHandsFree(args.action);
        return { success: true };
      },
    }),
  ];

  const ownNames = new Set(tools.map((tool) => tool.name));
  const reused = ctx.bridgeToolsMcpServer
    ?.getToolDefinitions("all")
    .filter((definition) => isHelmBridgeToolName(definition.name) && !ownNames.has(definition.name))
    .map((definition): BridgeToolDefinition => ({
      ...definition,
      handler: async (args, extra) => boundToolResult(await definition.handler(args, extra)) as Awaited<ReturnType<BridgeToolDefinition["handler"]>>,
    }))
    ?? [];
  return [...tools, ...reused];
}

/** Caps long notes and lists in reused tool results so Helm turns stay fast and cheap. */
export function boundToolResult(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 4_000 ? `${value.slice(0, 4_000)}… (truncated)` : value;
  if (Array.isArray(value)) {
    const bounded = value.slice(0, 60).map((entry) => boundToolResult(entry, depth + 1));
    return value.length > 60 ? [...bounded, `… ${value.length - 60} more`] : bounded;
  }
  if (value && typeof value === "object" && depth < 8) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, boundToolResult(entry, depth + 1)]));
  }
  return value;
}
