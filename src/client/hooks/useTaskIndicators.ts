import { useMemo } from "react";
import { getSessionActivityTime, getSessionRunState, isSessionActive, type Task, type Session } from "../api";

export interface TaskIndicator {
  busy: boolean;
  stalled: boolean;
  unread: boolean;
  busyCount: number;
  unreadCount: number;
  needsUserInputCount?: number;
  lastActivity: string;
}

export interface TabAttentionSummary {
  count: number;
  needsUserInputCount: number;
}

/**
 * Summarize unmuted tasks that have unread activity or need an answer. Archived tasks count too:
 * archiving marks a task's conversations read, so anything unread there arrived afterwards.
 */
export function summarizeTaskTabAttention(
  tasks: Task[],
  taskIndicators: Map<string, TaskIndicator>,
): TabAttentionSummary {
  let count = 0;
  let needsUserInputCount = 0;
  for (const task of tasks) {
    if (task.muted) continue;
    const indicator = taskIndicators.get(task.id);
    if (!indicator) continue;
    const needsUserInput = (indicator.needsUserInputCount ?? 0) > 0;
    if (indicator.unreadCount <= 0 && !needsUserInput) continue;
    count++;
    if (needsUserInput) needsUserInputCount++;
  }
  return { count, needsUserInputCount };
}

/** How many of these tasks hold unread conversations, for the header of a collapsed section. Muted tasks stay silent. */
export function countUnreadTasks(tasks: readonly Task[], taskIndicators: Map<string, TaskIndicator>): number {
  return tasks.filter((task) => !task.muted && (taskIndicators.get(task.id)?.unreadCount ?? 0) > 0).length;
}

/** "2 unread", for a collapsed section header. */
export function unreadTasksLabel(count: number): string {
  return `${count} unread`;
}

/** Summarize orphan chats that have unread activity or need an answer. */
export function summarizeChatTabAttention(
  orphanSessions: Session[],
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean,
  activeSessionId?: string | null,
): TabAttentionSummary {
  let count = 0;
  let needsUserInputCount = 0;
  for (const session of orphanSessions) {
    if (session.archived) continue;
    const needsUserInput = sessionNeedsUserInput(session);
    const unread = !isSessionActive(session)
      && session.sessionId !== activeSessionId
      && Boolean(isUnread?.(session.sessionId, getSessionActivityTime(session)));
    if (!unread && !needsUserInput) continue;
    count++;
    if (needsUserInput) needsUserInputCount++;
  }
  return { count, needsUserInputCount };
}

export function describeTabAttention(
  summary: TabAttentionSummary,
  singular: string,
  plural: string,
): string | null {
  if (summary.count <= 0) return null;
  const entity = summary.count === 1 ? singular : plural;
  const attentionVerb = summary.count === 1 ? "needs" : "need";
  const attention = `${summary.count} ${entity} ${attentionVerb} attention`;
  if (summary.needsUserInputCount <= 0) return attention;
  const answerVerb = summary.needsUserInputCount === 1 ? "needs" : "need";
  return `${attention}; ${summary.needsUserInputCount} ${answerVerb} an answer`;
}

/**
 * Latest activity of loaded archived sessions, per linked task. Tasks list only their active
 * sessions, so archived ones are matched through their own links.
 */
export function getArchivedActivityByTask(sessions: Iterable<Session>): Map<string, string> {
  const latestByTask = new Map<string, string>();
  for (const session of sessions) {
    if (!session.archived || !session.linkedTaskIds?.length) continue;
    const t = getSessionActivityTime(session);
    if (!t) continue;
    for (const taskId of session.linkedTaskIds) {
      const current = latestByTask.get(taskId);
      if (!current || t > current) latestByTask.set(taskId, t);
    }
  }
  return latestByTask;
}

/** Max of task.updatedAt and the latest session activity across its loaded linked sessions (including archived). */
export function getTaskLastActivity(
  task: Task,
  sessionMap: Map<string, Session>,
  archivedActivityByTask?: Map<string, string>,
): string {
  const archivedActivity = archivedActivityByTask?.get(task.id);
  let latest = archivedActivity && archivedActivity > task.updatedAt ? archivedActivity : task.updatedAt;
  for (const sid of task.activeSessionIds) {
    const session = sessionMap.get(sid);
    if (!session) continue;
    const t = getSessionActivityTime(session);
    if (t && t > latest) latest = t;
  }
  return latest;
}

export function sessionNeedsUserInput(session: Pick<Session, "needsUserInput" | "pendingUserInputCount">): boolean {
  return session.needsUserInput === true || (session.pendingUserInputCount ?? 0) > 0;
}

export function getTaskIndicator(
  task: Task,
  sessionMap: Map<string, Session>,
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean,
  activeSessionId?: string | null,
  archivedActivityByTask?: Map<string, string>,
): TaskIndicator {
  let busyCount = 0;
  let stalledCount = 0;
  let unreadCount = 0;
  let needsUserInputCount = 0;

  for (const sid of task.activeSessionIds) {
    const session = sessionMap.get(sid);
    if (!session || session.archived) continue;

    if (sessionNeedsUserInput(session)) needsUserInputCount++;

    if (isSessionActive(session)) {
      busyCount++;
      if (getSessionRunState(session) === "stalled") stalledCount++;
      continue;
    }
    if (sid === activeSessionId) continue;
    if (isUnread?.(sid, getSessionActivityTime(session))) unreadCount++;
  }

  const lastActivity = getTaskLastActivity(task, sessionMap, archivedActivityByTask);
  const hasUnreadActivity = unreadCount > 0 || needsUserInputCount > 0;
  return {
    busy: busyCount > 0,
    stalled: stalledCount > 0,
    unread: !task.muted && hasUnreadActivity,
    busyCount,
    unreadCount,
    needsUserInputCount,
    lastActivity,
  };
}

/**
 * Derives active/unread indicators per task from linked sessions. Muted tasks
 * keep their counts, but do not raise task-level unread indicators.
 */
export default function useTaskIndicators(
  tasks: Task[],
  sessions: Session[],
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean,
  activeSessionId?: string | null,
): Map<string, TaskIndicator> {
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

  const archivedActivityByTask = useMemo(() => getArchivedActivityByTask(sessions), [sessions]);

  const indicators = useMemo(() => {
    const result = new Map<string, TaskIndicator>();
    for (const task of tasks) {
      result.set(task.id, getTaskIndicator(task, sessionMap, isUnread, activeSessionId, archivedActivityByTask));
    }
    return result;
  }, [tasks, sessionMap, isUnread, activeSessionId, archivedActivityByTask]);

  return indicators;
}

/** Count unread sessions for a specific task (excludes archived sessions and the active session). */
export function countTaskUnread(
  task: Task,
  sessionMap: Map<string, Session>,
  isUnread: (sessionId: string, modifiedTime?: string) => boolean,
  activeSessionId?: string | null,
): number {
  return task.activeSessionIds.filter((sid) => {
    if (sid === activeSessionId) return false;
    const session = sessionMap.get(sid);
    return !!session && !session.archived && !isSessionActive(session) && isUnread(sid, getSessionActivityTime(session));
  }).length;
}
