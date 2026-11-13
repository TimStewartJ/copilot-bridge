// Suggested chats on a task: serving them, closing them, and the panel's refresh, which asks Helm's
// model for this one task's next chats in a throwaway helper session. Helm's looks write them for
// many tasks at once through helm_publish (helm/thinker/publish.ts); both go through
// validateTaskStarters and replace the task's open set.
import type { AppContext } from "./app-context.js";
import type { AgentModelInfo } from "./agent-backend/types.js";
import { chooseHelmModel, usableModels } from "./helm/helm-model.js";
import {
  TASK_STARTER_LABEL_MAX,
  TASK_STARTER_PROMPT_MAX,
  TASK_STARTERS_MAX,
  validateTaskStarters,
  type TaskStarterRefreshTrigger,
  type TaskStartersResponse,
} from "../shared/task-starters.js";

const REFRESH_TIMEOUT_MS = 3 * 60_000;
const REFRESH_EFFORT = "medium";
const MAX_HISTORY = 8;
const MAX_CHECKLIST = 15;
const MAX_CHATS = 8;
/** How long a task's chats must stay quiet after a reply before its suggestions refresh by themselves. */
export const AUTO_REFRESH_QUIET_MS = 3 * 60_000;
/** An automatic refresh waits this long after the task's last refresh of any kind. */
export const AUTO_REFRESH_COOLDOWN_MS = 30 * 60_000;
/** Automatic refreshes per local day, across all tasks. */
export const AUTO_REFRESH_DAILY_CAP = 40;
/** Quiet periods to wait for another of the task's chats to finish before giving up. */
const AUTO_REFRESH_MAX_WAITS = 10;

export class TaskStartersError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type StartersContext = Pick<AppContext, "taskStore" | "settingsStore" | "sessionTitles"> & {
  sessionManager: Pick<AppContext["sessionManager"], "listModels" | "createHelperSession" | "isSessionBusy">;
  globalBus?: AppContext["globalBus"];
  bridgeSessionStateStore?: Pick<AppContext["bridgeSessionStateStore"], "getState">;
  taskStartersStore?: AppContext["taskStartersStore"];
  checklistStore?: AppContext["checklistStore"];
  taskHistoryStore?: AppContext["taskHistoryStore"];
};

const SYSTEM_PROMPT = [
  "You suggest the next chats Tim could start on one of his tasks in Copilot Bridge, his agent workspace.",
  "Each suggestion becomes a button on the task. Tapping it opens a new chat on the task with your prompt in the composer, so he can read and send it.",
  "Reply with JSON only, no prose and no code fence: {\"chats\": [{\"label\": string, \"prompt\": string, \"playbook\"?: string}]}.",
  `- At most ${TASK_STARTERS_MAX} chats, the most useful first. Fewer is fine, and an empty list is right when nothing useful is obvious.`,
  `- label: a short imperative an at-a-glance button can hold, at most ${TASK_STARTER_LABEL_MAX} characters, e.g. "Draft the PR description".`,
  `- prompt: a complete, self-contained request written as Tim would type it, at most ${TASK_STARTER_PROMPT_MAX} characters. The chat sees the task's notes and instructions, so refer to them instead of copying them.`,
  "- Base every chat on what the task shows: its next step, open checklist items, what it is waiting for, recent history and chats. Do not invent facts, people or deadlines.",
  "- Do not suggest a chat that only repeats one already running or one that just finished, or one like those Tim dismissed.",
  "- latestReplyStart, when present, is the start of the reply a chat on this task just gave: suggest what comes after it, not what it already did.",
  "- playbook: optional; one of bug-fix, feature, investigate, research, decide, write, plan-project, refactor, pr-to-merge-ready, buy-or-book, schedule-it, watch, sweep, or \"none\" for a small direct request. Leave it out when unsure.",
].join("\n");

function clip(text: string | undefined, max: number): string | undefined {
  if (!text?.trim()) return undefined;
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** What the refresh model is shown: one task, bounded. */
export function buildTaskStartersPacket(ctx: StartersContext, taskId: string, latestReply?: string): string {
  const task = ctx.taskStore.getTask(taskId);
  if (!task) throw new TaskStartersError("Task not found", 404);
  const checklist = (ctx.checklistStore?.listChecklistItems(task.id) ?? []).filter((item) => !item.done).slice(0, MAX_CHECKLIST)
    .map((item) => ({ text: clip(item.text, 300), ...(item.deadline ? { deadline: item.deadline } : {}) }));
  const history = (ctx.taskHistoryStore?.listEntries(task.id, { limit: MAX_HISTORY }) ?? [])
    .map((entry) => ({ at: entry.at.slice(0, 10), text: clip(entry.text, 500) }));
  const chats = task.sessionIds.slice(-MAX_CHATS).reverse()
    .map((sessionId) => ctx.sessionTitles.getTitle(sessionId))
    .filter((title): title is string => !!title);
  const current = ctx.taskStartersStore?.list(task.id).map((starter) => starter.label) ?? [];
  const dismissed = ctx.taskStartersStore?.listDismissedLabels(task.id) ?? [];
  return JSON.stringify({
    today: new Date().toISOString().slice(0, 10),
    task: {
      title: task.title,
      kind: task.kind,
      status: task.status,
      ...(task.doneWhen ? { doneWhen: clip(task.doneWhen, 500) } : {}),
      ...(task.nextAction ? { nextStep: clip(task.nextAction, 300) } : {}),
      ...(task.waitingOn ? { waitingFor: clip(task.waitingOn, 200) } : {}),
      ...(task.instructions ? { instructions: clip(task.instructions, 2000) } : {}),
      notes: clip(task.notes, 6000) ?? "",
    },
    openChecklist: checklist,
    recentHistory: history,
    recentChats: chats,
    ...(latestReply ? { latestReplyStart: clip(latestReply, 1500) } : {}),
    currentSuggestions: current,
    dismissedByTim: dismissed,
  }, null, 1);
}

/** The JSON object in a model's reply, tolerating a code fence or a stray sentence around it. */
export function parseStartersReply(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new TaskStartersError("Helm's reply had no suggestions in it. Try again.", 502);
  try {
    return (JSON.parse(content.slice(start, end + 1)) as { chats?: unknown }).chats;
  } catch {
    throw new TaskStartersError("Helm's reply could not be read. Try again.", 502);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TaskStartersError("Helm didn't answer in time. Try again.", 504)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class TaskStartersService {
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  /** Bumped when a refresh is given up, so its late answer is not written. */
  private readonly generations = new Map<string, number>();

  /** Tasks waiting for their chats to stay quiet, with the reply that started the wait. */
  private readonly quietTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; sessionIds: Set<string>; reply: string }>();
  private readonly unsubscribe?: () => void;
  private readonly now: () => number;

  constructor(private readonly ctx: StartersContext, options: { autoRefresh?: boolean; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    if (options.autoRefresh && ctx.globalBus) {
      this.unsubscribe = ctx.globalBus.subscribe((event) => {
        if (!event.sessionId) return;
        if (event.type === "session:idle" && event.assistantPreview) this.noteReply(event.sessionId, event.assistantPreview);
      });
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    for (const wait of this.quietTimers.values()) clearTimeout(wait.timer);
    this.quietTimers.clear();
  }

  /** A chat replied: once the task's chats stay quiet, its suggestions are refreshed. */
  private noteReply(sessionId: string, reply: string): void {
    for (const link of this.ctx.taskStore.listTaskLinksBySession([sessionId]).get(sessionId) ?? []) {
      const previous = this.quietTimers.get(link.id);
      if (previous) clearTimeout(previous.timer);
      const sessionIds = previous?.sessionIds ?? new Set<string>();
      sessionIds.add(sessionId);
      this.waitForQuiet(link.id, sessionIds, reply, 0);
    }
  }

  private waitForQuiet(taskId: string, sessionIds: Set<string>, reply: string, attempt: number): void {
    const timer = setTimeout(() => {
      this.quietTimers.delete(taskId);
      // Checked now rather than at the reply: a scheduled run is marked after it starts delivering.
      const fromUser = [...sessionIds].filter((id) => this.ctx.bridgeSessionStateStore?.getState(id)?.triggeredBy !== "schedule");
      if (fromUser.length === 0) return;
      if (this.taskHasBusyChat(taskId)) {
        if (attempt < AUTO_REFRESH_MAX_WAITS) this.waitForQuiet(taskId, new Set(fromUser), reply, attempt + 1);
        return;
      }
      this.autoRefresh(taskId, reply);
    }, AUTO_REFRESH_QUIET_MS);
    timer.unref?.();
    this.quietTimers.set(taskId, { timer, sessionIds, reply });
  }

  private taskHasBusyChat(taskId: string): boolean {
    const task = this.ctx.taskStore.getTask(taskId);
    return !!task?.sessionIds.some((id) => this.ctx.sessionManager.isSessionBusy(id)
      && this.ctx.bridgeSessionStateStore?.getState(id)?.triggeredBy !== "schedule");
  }

  /** Refreshes a task whose chats went quiet, unless it refreshed recently or today's cap is spent. */
  autoRefresh(taskId: string, latestReply?: string): boolean {
    const store = this.ctx.taskStartersStore;
    if (!store || this.refreshing.has(taskId)) return false;
    const task = this.ctx.taskStore.getTask(taskId);
    if (!task || task.status !== "active" || task.muted || task.deferred) return false;
    const last = store.lastRefreshAt(taskId);
    if (last && this.now() - Date.parse(last) < AUTO_REFRESH_COOLDOWN_MS) return false;
    const dayStart = new Date(this.now());
    dayStart.setHours(0, 0, 0, 0);
    if (store.countRefreshesSince("auto", dayStart.toISOString()) >= AUTO_REFRESH_DAILY_CAP) return false;
    void this.refresh(taskId, { trigger: "auto", latestReply });
    return true;
  }

  get(taskId: string): TaskStartersResponse {
    if (!this.ctx.taskStore.getTask(taskId)) throw new TaskStartersError("Task not found", 404);
    const error = this.errors.get(taskId);
    return {
      starters: this.store().list(taskId),
      refreshing: this.refreshing.has(taskId),
      ...(error ? { error } : {}),
    };
  }

  close(taskId: string, starterId: string, how: "used" | "dismissed"): void {
    if (!this.store().close(taskId, starterId, how)) throw new TaskStartersError("That suggestion is gone", 404);
  }

  /** Starts a refresh of one task; a second call while one runs joins it. Resolves when it is done. */
  refresh(taskId: string, options: { trigger?: TaskStarterRefreshTrigger; latestReply?: string } = {}): Promise<void> {
    if (!this.ctx.taskStore.getTask(taskId)) throw new TaskStartersError("Task not found", 404);
    const running = this.refreshing.get(taskId);
    if (running) return running;
    this.errors.delete(taskId);
    const generation = (this.generations.get(taskId) ?? 0) + 1;
    this.generations.set(taskId, generation);
    const trigger = options.trigger ?? "manual";
    const logId = this.ctx.taskStartersStore?.startRefresh(taskId, trigger);
    const work = withTimeout(this.runRefresh(taskId, generation, trigger, options.latestReply), REFRESH_TIMEOUT_MS + 30_000)
      .then((count) => { if (logId !== undefined) this.ctx.taskStartersStore?.finishRefresh(logId, count === null ? "skipped" : "ok", count); })
      .catch((error: unknown) => {
        if (logId !== undefined) this.ctx.taskStartersStore?.finishRefresh(logId, error instanceof Error ? error.message : String(error), null);
        if (this.generations.get(taskId) === generation) this.generations.set(taskId, generation + 1);
        this.errors.set(taskId, error instanceof TaskStartersError ? error.message : "Helm couldn't suggest chats. Try again.");
        if (!(error instanceof TaskStartersError)) console.warn(`[task-starters] Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => { this.refreshing.delete(taskId); });
    this.refreshing.set(taskId, work);
    return work;
  }

  private store() {
    const store = this.ctx.taskStartersStore;
    if (!store) throw new TaskStartersError("Suggested chats are not available", 503);
    return store;
  }

  /** The number of suggestions written, or null when the answer arrived too late to use. */
  private async runRefresh(taskId: string, generation: number, trigger: TaskStarterRefreshTrigger, latestReply?: string): Promise<number | null> {
    const packet = buildTaskStartersPacket(this.ctx, taskId, latestReply);
    const models = await this.ctx.sessionManager.listModels().catch(() => [] as AgentModelInfo[]);
    const choice = chooseHelmModel(this.ctx.settingsStore.getSettings(), usableModels(models), { fallbackEffort: REFRESH_EFFORT });
    const helper = await this.ctx.sessionManager.createHelperSession({
      clientName: "Copilot Bridge suggested chats",
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
      systemMessage: { mode: "replace", content: SYSTEM_PROMPT },
    });
    try {
      const response = await helper.session.sendAndWait({ prompt: packet, attachments: [] }, REFRESH_TIMEOUT_MS) as { data?: { content?: unknown } } | undefined;
      const content = response?.data?.content;
      if (typeof content !== "string") throw new TaskStartersError("Helm didn't answer in time. Try again.", 504);
      const result = validateTaskStarters(parseStartersReply(content));
      if (!result.ok) throw new TaskStartersError("Helm's suggestions didn't fit on the panel. Try again.", 502);
      if (this.generations.get(taskId) !== generation || !this.ctx.taskStore.getTask(taskId)) return null;
      this.store().replace(taskId, result.starters, trigger === "auto" ? "auto" : "refresh");
      this.ctx.globalBus?.emit({ type: "task:changed", taskId, reason: "starters" });
      return result.starters.length;
    } catch (error) {
      await helper.session.abort().catch(() => undefined);
      throw error;
    } finally {
      void helper.dispose().catch(() => undefined);
    }
  }
}
