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

/** Count non-archived tasks whose linked sessions currently show unread activity. */
export function countTaskTabUnread(
  tasks: Task[],
  taskIndicators: Map<string, TaskIndicator>,
): number {
  let unread = 0;
  for (const task of tasks) {
    if (task.status === "archived") continue;
    if (taskIndicators.get(task.id)?.unread) unread++;
  }
  return unread;
}

/** Count unread orphan chats using the same nav-tab semantics as the task rail. */
export function countChatTabUnread(
  orphanSessions: Session[],
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean,
): number {
  let unread = 0;
  for (const session of orphanSessions) {
    if (session.archived || isSessionActive(session)) continue;
    if (isUnread?.(session.sessionId, getSessionActivityTime(session))) unread++;
  }
  return unread;
}

/** Max of task.updatedAt and the latest session activity across all linked sessions (including archived). */
export function getTaskLastActivity(
  task: Task,
  sessionMap: Map<string, Session>,
): string {
  let latest = task.updatedAt;
  for (const sid of task.sessionIds) {
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
): TaskIndicator {
  let busyCount = 0;
  let stalledCount = 0;
  let unreadCount = 0;
  let needsUserInputCount = 0;

  for (const sid of task.sessionIds) {
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

  const lastActivity = getTaskLastActivity(task, sessionMap);
  return {
    busy: busyCount > 0,
    stalled: stalledCount > 0,
    unread: unreadCount > 0 || needsUserInputCount > 0,
    busyCount,
    unreadCount,
    needsUserInputCount,
    lastActivity,
  };
}

/**
 * Derives active/unread indicators per task from linked sessions. Read-state
 * unread still excludes active sessions, but pending user input keeps a task
 * visibly unread until the prompt is answered.
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

  const indicators = useMemo(() => {
    const result = new Map<string, TaskIndicator>();
    for (const task of tasks) {
      result.set(task.id, getTaskIndicator(task, sessionMap, isUnread, activeSessionId));
    }
    return result;
  }, [tasks, sessionMap, isUnread, activeSessionId]);

  return indicators;
}

/** Count unread sessions for a specific task (excludes archived sessions and the active session). */
export function countTaskUnread(
  task: Task,
  sessionMap: Map<string, Session>,
  isUnread: (sessionId: string, modifiedTime?: string) => boolean,
  activeSessionId?: string | null,
): number {
  return task.sessionIds.filter((sid) => {
    if (sid === activeSessionId) return false;
    const session = sessionMap.get(sid);
    return !!session && !session.archived && !isSessionActive(session) && isUnread(sid, getSessionActivityTime(session));
  }).length;
}
