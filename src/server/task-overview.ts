import type { AppContext } from "./app-context.js";
import type { Task } from "./task-store.js";
import type { TaskOverview, TaskOverviewRow, TaskTouchKind } from "../shared/task-overview.js";
import { deriveTaskState, latestTime, TASK_STATE_ORDER, type TaskState } from "../shared/task-state.js";
import { isRecord } from "../shared/is-record.js";
import { maxIsoTime } from "../shared/session-activity.js";
import type { TaskActivity } from "../shared/task-attention.js";

export type TaskOverviewContext = Pick<AppContext, "taskStore" | "taskGroupStore"> &
  Partial<Pick<AppContext, "triggerStore" | "deferredPromptStore" | "sessionMetaStore" | "managementJobStore" | "isStaging">> & {
  sessionManager: Pick<AppContext["sessionManager"], "getSessionRunState" | "getPendingUserInputCount">
    & Partial<Pick<AppContext["sessionManager"], "getSessionContinuationState">>;
};

export interface OverviewSession { sessionId: string; archived: boolean; activity: string; externallyInUse?: boolean }

export function toOverviewSessions(raw: unknown[]): { sessions: OverviewSession[]; invalid: number } {
  let invalid = 0;
  const sessions = raw.flatMap((item): OverviewSession[] => {
    if (!isRecord(item) || typeof item.sessionId !== "string") { invalid++; return []; }
    const text = (key: string) => typeof item[key] === "string" ? item[key] as string : undefined;
    return [{ sessionId: item.sessionId, archived: item.archived === true, externallyInUse: item.externallyInUse === true,
      activity: text("lastActivityAt") ?? maxIsoTime(text("lastVisibleActivityAt"), text("lastAttentionAt")) ?? text("modifiedTime") ?? "" }];
  });
  return { sessions, invalid };
}

/** Derives every active task's state from one read of each source; no per-task queries. */
export function buildTaskOverview(ctx: TaskOverviewContext, sessions: OverviewSession[] | null, now = Date.now(), tasks?: Task[], invalidSessions = 0): TaskOverview {
  const active = (tasks ?? ctx.taskStore.listTasks()).filter(task => task.status === "active");
  const groups = new Map(ctx.taskGroupStore.listGroups().map(group => [group.id, group]));
  const momentum = ctx.taskStore.listMomentumSignals();
  // Task triggers that will run again; a paused one still counts as automation the task has.
  const taskTriggersByTask = new Map<string, number>();
  const continuingTaskTriggers = new Map<string, number>();
  for (const trigger of ctx.triggerStore?.list() ?? []) {
    if (!trigger.taskId) continue;
    taskTriggersByTask.set(trigger.taskId, (taskTriggersByTask.get(trigger.taskId) ?? 0) + 1);
    if (trigger.status === "active" || trigger.status === "running") {
      continuingTaskTriggers.set(trigger.taskId, (continuingTaskTriggers.get(trigger.taskId) ?? 0) + 1);
    }
  }
  const chatTriggers = ctx.triggerStore?.listSummariesBySession() ?? new Map();
  const pendingDeliveries = ctx.deferredPromptStore?.listPendingDeliveryCountsBySession() ?? new Map<string, number>();
  const archivedIds = new Set(ctx.sessionMetaStore?.listArchivedSessionIds() ?? []);
  const jobsBySession = new Map<string, number>();
  const managementJobs = [...(ctx.managementJobStore?.listActive() ?? []), ...(ctx.managementJobStore?.listDeploysAwaitingActivation() ?? [])];
  const seenJobs = new Set<string>();
  for (const job of managementJobs) {
    if (!job.originSessionId || seenJobs.has(job.id)) continue;
    seenJobs.add(job.id);
    jobsBySession.set(job.originSessionId, (jobsBySession.get(job.originSessionId) ?? 0) + 1);
  }
  const sessionById = new Map((sessions ?? []).map(session => [session.sessionId, session]));
  const sessionsComplete = !!sessions && invalidSessions === 0;

  const rows: TaskOverviewRow[] = active.map(task => {
    const linked = task.sessionIds.flatMap(id => {
      const session = sessionById.get(id);
      return session && !session.archived ? [session] : [];
    }).sort((a, b) => (Date.parse(b.activity) || 0) - (Date.parse(a.activity) || 0) || a.sessionId.localeCompare(b.sessionId));
    const runState = (id: string) => ctx.sessionManager.getSessionRunState(id);
    const busyCount = linked.filter(session => runState(session.sessionId) === "busy").length;
    const stalledCount = linked.filter(session => runState(session.sessionId) === "stalled").length;
    const inputCount = task.sessionIds.filter(id => !archivedIds.has(id))
      .reduce((total, id) => total + ctx.sessionManager.getPendingUserInputCount(id), 0);
    const automationCount = (taskTriggersByTask.get(task.id) ?? 0)
      + task.sessionIds.filter(id => chatTriggers.has(id)).length;
    const activity: TaskActivity = {
      known: true,
      sessionIndexKnown: true,
      runCount: 0, runningAgentCount: 0, runningCommandCount: 0, heldCount: 0, externalCount: 0,
      chatTriggerCount: 0, taskTriggerCount: continuingTaskTriggers.get(task.id) ?? 0,
      pendingDeliveryCount: 0, managementJobCount: 0,
    };
    const unavailable = (scope: "source" | "task", reason: string, expectedInPreview = false) => {
      activity.known = false;
      if (!activity.unavailable || activity.unavailable.scope === "source" && scope === "task"
        || activity.unavailable.expectedInPreview && !expectedInPreview) {
        activity.unavailable = { scope, reason, ...(expectedInPreview ? { expectedInPreview: true } : {}) };
      }
    };
    if (task.sessionIds.length > 0 && !(ctx.deferredPromptStore && ctx.triggerStore && ctx.managementJobStore)) {
      unavailable("source", "Continuation status is unavailable.");
    }
    for (const id of task.sessionIds) {
      const session = sessionById.get(id);
      // Linked chats are listed unless archived, so one missing from a full list was deleted.
      const deleted = !session && !archivedIds.has(id) && !!sessions && !ctx.isStaging && !!ctx.sessionMetaStore && invalidSessions === 0;
      if (!session && !archivedIds.has(id) && !deleted) {
        activity.sessionIndexKnown = false;
        if (!sessions) unavailable("source", "Conversation status is unavailable, so working, stalled and question signals may be missing.");
        else if (ctx.isStaging) unavailable("source", "Production conversations are not copied into this isolated preview.", true);
        else if (!ctx.sessionMetaStore) unavailable("source", "Conversation archive status is unavailable.");
        else unavailable("task", "A linked conversation could not be read.");
      }
      const runtime = ctx.sessionManager.getSessionContinuationState?.(id);
      if (!runtime) unavailable("source", "Runtime continuation status is unavailable.");
      if (runState(id) !== "idle") activity.runCount++;
      if (runtime) {
        activity.runningAgentCount += runtime.runningAgentCount;
        activity.runningCommandCount += runtime.runningCommandCount;
        activity.heldCount += Number(runtime.held);
      }
      activity.externalCount += Number(session?.externallyInUse === true);
      activity.chatTriggerCount += chatTriggers.get(id)?.count ?? 0;
      activity.pendingDeliveryCount += pendingDeliveries.get(id) ?? 0;
      activity.managementJobCount += jobsBySession.get(id) ?? 0;
    }
    const signals = momentum.get(task.id);
    // Only the user's edits and messages count as touches; viewing the task does not.
    const touches: Array<[TaskTouchKind, string | undefined]> = [
      ["edited", signals?.userEditedAt], ["message", signals?.lastMessageAt], ["created", task.createdAt],
    ];
    const lastEngagedAt = latestTime(...touches.map(([, at]) => at));
    const lastTouchKind = lastEngagedAt ? touches.find(([, at]) => at && Date.parse(at) === Date.parse(lastEngagedAt))?.[0] : undefined;
    const derived = deriveTaskState({
      muted: task.muted, deferred: task.deferred, nextAction: task.nextAction, waitingOn: task.waitingOn,
      nextTouchAt: task.nextTouchAt, lastEngagedAt, waitingSince: signals?.waitingChangedAt,
      busyCount, stalledCount, inputCount, automationCount,
      sessionSignalsUnknown: !sessionsComplete && task.sessionIds.length > 0,
    }, now);
    const group = task.groupId ? groups.get(task.groupId) : undefined;
    return {
      id: task.id, title: task.title, kind: task.kind, muted: task.muted, deferred: task.deferred, order: task.order,
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      ...(group ? { groupId: group.id, groupName: group.name, groupColor: group.color } : {}),
      ...(task.nextAction ? { nextAction: task.nextAction } : {}), ...(task.waitingOn ? { waitingOn: task.waitingOn } : {}),
      ...(task.nextTouchAt ? { nextTouchAt: task.nextTouchAt } : {}),
      ...(task.waitingOn && signals?.waitingChangedAt ? { waitingSince: signals.waitingChangedAt } : {}),
      ...derived, ...(lastEngagedAt ? { lastEngagedAt } : {}), ...(lastTouchKind ? { lastTouchKind } : {}),
      busyCount, stalledCount, inputCount, automationCount, activity,
      ...(linked[0] ? { sessionId: linked[0].sessionId } : {}),
    };
  });
  const counts = Object.fromEntries(TASK_STATE_ORDER.map(state => [state, 0])) as Record<TaskState, number>;
  for (const row of rows) counts[row.state]++;
  return { tasks: rows, sessionsComplete, counts, generatedAt: new Date(now).toISOString() };
}

const engagedTime = (row: TaskOverviewRow) => (row.lastEngagedAt ? Date.parse(row.lastEngagedAt) : 0);

/** Most recently engaged first; working agents float up within the same moment. */
export function byRecentEngagement(a: TaskOverviewRow, b: TaskOverviewRow): number {
  return engagedTime(b) - engagedTime(a) || b.busyCount - a.busyCount || a.order - b.order;
}

/** Longest untouched first, so the stalest task is reviewed first. */
export function byLongestIdle(a: TaskOverviewRow, b: TaskOverviewRow): number {
  return engagedTime(a) - engagedTime(b) || a.order - b.order;
}
