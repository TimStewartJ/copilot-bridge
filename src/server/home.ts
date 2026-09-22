import type { Request, Router } from "express";
import type { AppContext } from "./app-context.js";
import type { Task } from "./task-store.js";
import type { HomeAction, HomeInput, HomeInputSummary, HomePage, HomeReply, HomeSection, HomeSessionRef, HomeSnapshot, HomeTask } from "../shared/home.js";
import type { TransformedEntry } from "./event-transform.js";
import { isRecord } from "../shared/is-record.js";
import { mapWithConcurrency } from "./map-with-concurrency.js";
import { maxIsoTime } from "../shared/session-activity.js";

interface Session {
  sessionId: string; summary?: string; archived?: boolean; triggeredBy?: string;
  lastAttentionAt?: string; lastVisibleActivityAt?: string; lastActivityAt?: string; modifiedTime?: string;
}
const SECTIONS: HomeSection[] = ["overview", "tasks", "inputs", "follow-ups", "actions", "replies"];
const PAGE_SIZE = 20;
const OVERVIEW_SIZE = 3;
type HomeContext = Pick<AppContext, "taskStore" | "taskGroupStore" | "checklistStore" | "readStateStore"> & {
  // SessionManager's public count includes both native asks and elicitations.
  sessionManager: Pick<AppContext["sessionManager"], "getSessionRunState" | "getPendingUserInputCount" | "hydratePendingInteractions" | "readMessagesFromDisk">;
};

export function parseHomeQuery(query: Request["query"]): { section: HomeSection; offset: number } {
  const section = query.section ?? "overview";
  if (typeof section !== "string" || !SECTIONS.some(value => value === section)) throw new Error("Unknown Home section");
  const offset = query.offset ?? "0";
  if (typeof offset !== "string" || !/^\d+$/.test(offset) || Number(offset) > 100000) throw new Error("Invalid Home page offset");
  return { section: section as HomeSection, offset: Number(offset) };
}
function clip(value: string | undefined, length = 300): string | undefined {
  return value && value.length > length ? `${value.slice(0, length)}…` : value;
}
function activity(session: Session): string {
  return session.lastActivityAt ?? maxIsoTime(session.lastVisibleActivityAt, session.lastAttentionAt) ?? session.modifiedTime ?? "";
}
export function latestHomeReply(messages: readonly TransformedEntry[]): Pick<HomeReply, "sourceEventId" | "excerpt" | "timestamp"> | undefined {
  const reversed = [...messages].reverse();
  const lastUser = reversed.findIndex(item => item.type === "message" && item.role === "user");
  const reply = (lastUser < 0 ? reversed : reversed.slice(0, lastUser)).find(item => item.type === "message" && item.role === "assistant"
    && !!item.sourceEventId && !!item.content?.trim());
  return reply ? { sourceEventId: reply.sourceEventId, excerpt: clip(reply.content?.trim(), 350), timestamp: reply.timestamp } : undefined;
}
export function createHomeReader(ctx: HomeContext, getSessions: () => Promise<unknown[]>) {
  const replyCache = new Map<string, { fingerprint: string; expires: number; value: Promise<HomeReply> }>();
  async function snapshot(section: HomeSection = "overview", offset = 0): Promise<HomeSnapshot> {
    const allTasks = ctx.taskStore.listTasks();
    const taskById = new Map(allTasks.map(task => [task.id, task]));
    const taskRank = new Map(allTasks.map((task, index) => [task.id, index]));
    const tasks = allTasks.filter(task => task.status === "active" && !task.muted);
    const groupById = new Map(ctx.taskGroupStore.listGroups().map(group => [group.id, group]));
    const sourceErrors: string[] = [];
    let rawSessions: unknown[] = [];
    try { rawSessions = await getSessions(); }
    catch (error) {
      console.error("[home] Session index unavailable:", error);
      sourceErrors.push("Session information is unavailable. Saved task/checklist data remains available; question and reply totals are unknown.");
    }
    let invalidSessions = 0;
    const sessions = rawSessions.flatMap((raw): Session[] => {
      if (!isRecord(raw) || typeof raw.sessionId !== "string") { invalidSessions++; return []; }
      return [{ sessionId: raw.sessionId, summary: typeof raw.summary === "string" ? raw.summary : undefined,
        archived: raw.archived === true, triggeredBy: typeof raw.triggeredBy === "string" ? raw.triggeredBy : undefined,
        lastAttentionAt: typeof raw.lastAttentionAt === "string" ? raw.lastAttentionAt : undefined,
        lastVisibleActivityAt: typeof raw.lastVisibleActivityAt === "string" ? raw.lastVisibleActivityAt : undefined,
        lastActivityAt: typeof raw.lastActivityAt === "string" ? raw.lastActivityAt : undefined,
        modifiedTime: typeof raw.modifiedTime === "string" ? raw.modifiedTime : undefined }];
    }).filter(session => !session.archived);
    if (invalidSessions) {
      console.error("[home] Session index contained invalid records:", invalidSessions);
      sourceErrors.push(`${invalidSessions} session record(s) could not be read. Question and reply totals may be incomplete.`);
    }
    const linkedTasks = new Map<string, Task[]>();
    for (const task of allTasks) for (const id of task.sessionIds) linkedTasks.set(id, [...linkedTasks.get(id) ?? [], task]);
    const visible = sessions.filter(session => {
      const linked = linkedTasks.get(session.sessionId) ?? [];
      return linked.length === 0 || linked.some(task => task.status === "active" && !task.muted);
    });
    const refs = new Map(visible.map(session => {
      const task = (linkedTasks.get(session.sessionId) ?? []).filter(task => task.status === "active" && !task.muted)
        .sort((a, b) => taskRank.get(a.id)! - taskRank.get(b.id)!)[0];
      const ref: HomeSessionRef = { sessionId: session.sessionId, title: clip(session.summary, 160) || "Conversation",
        ...(task ? { taskId: task.id, taskTitle: task.title } : {}) };
      return [session.sessionId, ref];
    }));
    const sessionById = new Map(visible.map(session => [session.sessionId, session]));
    function page<T>(items: T[], target: HomeSection): HomePage<T> {
      const start = target === section ? offset : 0;
      const limit = target === section ? PAGE_SIZE : OVERVIEW_SIZE;
      return { items: items.slice(start, start + limit), total: items.length, offset: start, hasMore: items.length > start + limit };
    }
    const taskRows: HomeTask[] = tasks.map(task => {
      const linked = task.sessionIds.flatMap(id => { const session = sessionById.get(id); return session ? [session] : []; })
        .sort((a, b) => Date.parse(activity(b)) - Date.parse(activity(a)) || a.sessionId.localeCompare(b.sessionId));
      const group = task.groupId ? groupById.get(task.groupId) : undefined;
      return { id: task.id, title: task.title, kind: task.kind, deferred: task.deferred, nextAction: clip(task.nextAction), waitingOn: clip(task.waitingOn),
        nextTouchAt: task.nextTouchAt, doneWhen: clip(task.doneWhen), groupName: group?.name, groupColor: group?.color,
        sessionId: linked[0]?.sessionId, sessionTitle: clip(linked[0]?.summary, 160),
        runningCount: linked.filter(session => ctx.sessionManager.getSessionRunState(session.sessionId) === "busy").length,
        stalledCount: linked.filter(session => ctx.sessionManager.getSessionRunState(session.sessionId) === "stalled").length,
        inputCount: linked.reduce((total, session) => total + ctx.sessionManager.getPendingUserInputCount(session.sessionId), 0) };
    });
    const inputRows: HomeInputSummary[] = [], inputErrors: HomeSnapshot["inputErrors"] = [];
    const pending = visible.filter(session => ctx.sessionManager.getPendingUserInputCount(session.sessionId) > 0)
      .sort((a,b) => Date.parse(activity(b)) - Date.parse(activity(a)) || a.sessionId.localeCompare(b.sessionId));
    const inputPage = page(pending, "inputs");
    let ended = 0;
    await mapWithConcurrency(inputPage.items, 4, async session => {
      const ref = refs.get(session.sessionId)!;
      try {
        const native = await ctx.sessionManager.hydratePendingInteractions(session.sessionId);
        const requests: HomeInputSummary[] = [
          ...native.pendingUserInputs.map(request => ({ ...ref, kind: "user_input" as const, requestId: request.requestId, question: clip(request.question, 350)!, requestedAt: request.requestedAt, pendingCount: 0 })),
          ...native.pendingElicitations.map(request => ({ ...ref, kind: "elicitation" as const, requestId: request.requestId, question: clip(request.message, 350)!, requestedAt: request.requestedAt, pendingCount: 0 })),
        ].sort((a,b) => (a.requestedAt ?? "").localeCompare(b.requestedAt ?? "") || a.requestId.localeCompare(b.requestId));
        if (requests[0]) inputRows.push({ ...requests[0], pendingCount: requests.length });
        else ended++;
      } catch (error) {
        console.error("[home] Native request read failed:", session.sessionId, error);
        inputErrors.push({ ...ref, error: error instanceof Error ? error.message : String(error) });
      }
    });
    inputRows.sort((a, b) => (a.requestedAt ?? "").localeCompare(b.requestedAt ?? "") || a.sessionId.localeCompare(b.sessionId));
    const now = new Date();
    const followUps = tasks.filter(task => task.nextTouchAt && Date.parse(task.nextTouchAt) <= now.getTime())
      .sort((a, b) => a.nextTouchAt!.localeCompare(b.nextTouchAt!) || a.id.localeCompare(b.id))
      .map(task => ({ taskId: task.id, title: task.title, at: task.nextTouchAt!, deferred: task.deferred, nextAction: clip(task.nextAction), waitingOn: clip(task.waitingOn) }));
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const allActions = ctx.checklistStore.listAllOpenChecklistItems();
    const actionRows: HomeAction[] = allActions.filter(item => section === "actions" || (item.deadline && item.deadline <= date))
      .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.order - b.order || a.id.localeCompare(b.id))
      .map(item => ({ id: item.id, taskId: item.taskId, taskTitle: item.taskId ? taskById.get(item.taskId)?.title : undefined, text: section === "actions" ? item.text : clip(item.text, 500)!, deadline: item.deadline }));
    const readState = ctx.readStateStore.getReadState();
    const seenTasks = new Set<string>();
    const returnSessions = visible.filter(session => ctx.sessionManager.getSessionRunState(session.sessionId) === "idle"
      && !!activity(session) && (!readState[session.sessionId] || Date.parse(activity(session)) > Date.parse(readState[session.sessionId])))
      .sort((a, b) => Date.parse(activity(b)) - Date.parse(activity(a)) || a.sessionId.localeCompare(b.sessionId))
      .filter(session => {
        if (section === "replies") return true;
        const group = refs.get(session.sessionId)?.taskId ?? session.sessionId;
        if (seenTasks.has(group)) return false;
        seenTasks.add(group); return true;
      });
    const replyPage = page(returnSessions, "replies");
    const replies = await mapWithConcurrency(section === "overview" || section === "replies" ? replyPage.items : [], 2, async session => {
      const ref = refs.get(session.sessionId)!;
      const fingerprint = `${activity(session)}/${session.lastVisibleActivityAt ?? ""}`;
      let cached = replyCache.get(session.sessionId);
      if (!cached || cached.fingerprint !== fingerprint || cached.expires <= Date.now()) {
        const value = (async (): Promise<HomeReply> => {
          try {
            const history = await ctx.sessionManager.readMessagesFromDisk(session.sessionId, { limit: 40 });
            const reply = latestHomeReply(history.messages);
            return { ...ref, ...reply, ...(!reply ? { error: "No returned reply is available in the recent conversation window. Open the conversation to inspect its activity." } : {}) };
          } catch (error) {
            console.error("[home] Reply read failed:", session.sessionId, error);
            return { ...ref, error: error instanceof Error ? error.message : String(error) };
          }
        })();
        cached = { fingerprint, expires: Date.now() + 30000, value };
        replyCache.set(session.sessionId, cached);
        if (replyCache.size > 100) replyCache.delete(replyCache.keys().next().value!);
      }
      replyCache.delete(session.sessionId); replyCache.set(session.sessionId, cached);
      return { ...await cached.value, ...ref };
    });
    return { section, tasks: page(section === "tasks" ? taskRows : taskRows.filter(task => !task.deferred), "tasks"),
      deferredTaskTotal: tasks.filter(task => task.deferred).length,
      inputs: { ...inputPage, items: inputRows, total: sourceErrors.length ? null : pending.length - ended },
      followUps: page(followUps, "follow-ups"), openActionTotal: allActions.length,
      actions: page(actionRows, "actions"), replies: { ...replyPage, items: replies, total: sourceErrors.length ? null : replyPage.total }, inputErrors, sourceErrors,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  return { snapshot };
}

export function registerHomeRoutes(router: Router, ctx: HomeContext, getSessions: () => Promise<unknown[]>): void {
  const reader = createHomeReader(ctx, getSessions);
  router.get("/home", async (req, res) => {
    let query: ReturnType<typeof parseHomeQuery>;
    try { query = parseHomeQuery(req.query); }
    catch (error) { res.status(400).json({ error: String(error) }); return; }
    try { res.json(await reader.snapshot(query.section, query.offset)); }
    catch (error) {
      console.error("[home] Snapshot unavailable:", error);
      res.status(503).json({ error: "Home could not read its native task/session sources. No empty or all-clear state is implied." });
    }
  });
  router.get("/home/inputs/:sessionId/:kind/:requestId", async (req, res) => {
    const { sessionId, kind, requestId } = req.params;
    if ((kind !== "user_input" && kind !== "elicitation") || sessionId.length > 200 || requestId.length > 500) {
      res.status(400).json({ error: "Invalid native request identity" }); return;
    }
    try {
      const native = await ctx.sessionManager.hydratePendingInteractions(sessionId);
      const input: HomeInput | undefined = kind === "user_input"
        ? native.pendingUserInputs.filter(request => request.requestId === requestId).map((request): HomeInput => ({ kind: "user_input", sessionId, title: "Conversation", request }))[0]
        : native.pendingElicitations.filter(request => request.requestId === requestId).map((request): HomeInput => ({ kind: "elicitation", sessionId, title: "Conversation", request }))[0];
      if (!input) { res.status(404).json({ error: "This native question is no longer active. Open its conversation to inspect the outcome." }); return; }
      res.json(input);
    } catch (error) {
      console.error("[home] Native question unavailable:", sessionId, error);
      res.status(503).json({ error: "The question source could not be verified." });
    }
  });
}
