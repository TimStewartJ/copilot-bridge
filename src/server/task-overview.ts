import type { AppContext } from "./app-context.js";
import type { Task } from "./task-store.js";
import type { TaskOverview, TaskOverviewRow, TaskTouchKind } from "../shared/task-overview.js";
import { deriveTaskState, latestTime, TASK_STATE_ORDER, type TaskState } from "../shared/task-state.js";
import { isRecord } from "../shared/is-record.js";
import { maxIsoTime } from "../shared/session-activity.js";

export type TaskOverviewContext = Pick<AppContext, "taskStore" | "taskGroupStore" | "scheduleStore"> &
  Partial<Pick<AppContext, "deferredPromptStore" | "deferLoopStore">> & {
  sessionManager: Pick<AppContext["sessionManager"], "getSessionRunState" | "getPendingUserInputCount">;
};

export interface OverviewSession { sessionId: string; archived: boolean; activity: string }

export function toOverviewSessions(raw: unknown[]): { sessions: OverviewSession[]; invalid: number } {
  let invalid = 0;
  const sessions = raw.flatMap((item): OverviewSession[] => {
    if (!isRecord(item) || typeof item.sessionId !== "string") { invalid++; return []; }
    const text = (key: string) => typeof item[key] === "string" ? item[key] as string : undefined;
    return [{ sessionId: item.sessionId, archived: item.archived === true,
      activity: text("lastActivityAt") ?? maxIsoTime(text("lastVisibleActivityAt"), text("lastAttentionAt")) ?? text("modifiedTime") ?? "" }];
  });
  return { sessions, invalid };
}

/** Derives every active task's state from one read of each source; no per-task queries beyond task hydration. */
export function buildTaskOverview(ctx: TaskOverviewContext, sessions: OverviewSession[] | null, now = Date.now(), tasks?: Task[], invalidSessions = 0): TaskOverview {
  const sourceErrors: string[] = [];
  const active = (tasks ?? ctx.taskStore.listTasks()).filter(task => task.status === "active");
  const groups = new Map(ctx.taskGroupStore.listGroups().map(group => [group.id, group]));
  const momentum = ctx.taskStore.listMomentumSignals();
  const schedulesByTask = new Map<string, number>();
  for (const schedule of ctx.scheduleStore.listSchedules()) {
    if (schedule.enabled) schedulesByTask.set(schedule.taskId, (schedulesByTask.get(schedule.taskId) ?? 0) + 1);
  }
  const prompts = ctx.deferredPromptStore?.listSummariesBySession() ?? new Map();
  const loops = ctx.deferLoopStore?.listSummariesBySession() ?? new Map();
  const sessionById = new Map((sessions ?? []).map(session => [session.sessionId, session]));
  if (!sessions) sourceErrors.push("Conversation status is unavailable, so working, stalled and question signals may be missing.");
  else if (invalidSessions > 0) sourceErrors.push(`${invalidSessions} conversation record${invalidSessions === 1 ? " was" : "s were"} unreadable, so some working and question signals may be missing.`);
  const sessionsComplete = !!sessions && invalidSessions === 0;

  const rows: TaskOverviewRow[] = active.map(task => {
    const linked = task.sessionIds.flatMap(id => {
      const session = sessionById.get(id);
      return session && !session.archived ? [session] : [];
    }).sort((a, b) => (Date.parse(b.activity) || 0) - (Date.parse(a.activity) || 0) || a.sessionId.localeCompare(b.sessionId));
    const runState = (id: string) => ctx.sessionManager.getSessionRunState(id);
    const busyCount = linked.filter(session => runState(session.sessionId) === "busy").length;
    const stalledCount = linked.filter(session => runState(session.sessionId) === "stalled").length;
    const inputCount = linked.reduce((total, session) => total + ctx.sessionManager.getPendingUserInputCount(session.sessionId), 0);
    const automationCount = (schedulesByTask.get(task.id) ?? 0)
      + task.sessionIds.filter(id => prompts.has(id) || loops.has(id)).length;
    const signals = momentum.get(task.id);
    // Only things Tim did to the task count: editing it or writing in one of its conversations. Looking at it does not.
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
      ...(group ? { groupId: group.id, groupName: group.name, groupColor: group.color } : {}),
      ...(task.nextAction ? { nextAction: task.nextAction } : {}), ...(task.waitingOn ? { waitingOn: task.waitingOn } : {}),
      ...(task.nextTouchAt ? { nextTouchAt: task.nextTouchAt } : {}),
      ...derived, ...(lastEngagedAt ? { lastEngagedAt } : {}), ...(lastTouchKind ? { lastTouchKind } : {}),
      busyCount, stalledCount, inputCount, automationCount,
      ...(linked[0] ? { sessionId: linked[0].sessionId } : {}),
    };
  });
  const counts = Object.fromEntries(TASK_STATE_ORDER.map(state => [state, 0])) as Record<TaskState, number>;
  for (const row of rows) counts[row.state]++;
  return { tasks: rows, sessionsComplete, counts, sourceErrors, generatedAt: new Date(now).toISOString() };
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
