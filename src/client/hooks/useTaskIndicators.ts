import { useMemo } from "react";
import { getSessionActivityTime, type Task, type Session } from "../api";

export interface TaskIndicator {
  busy: boolean;
  unread: boolean;
  busyCount: number;
  unreadCount: number;
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
    if (session.archived || session.busy) continue;
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

/**
 * Derives busy/unread indicators per task from linked sessions.
 * Busy sessions are excluded from the unread check — unread only applies
 * once a session goes idle with new content the user hasn't seen.
 * The actively-viewed session is excluded from the unread count to avoid
 * showing an unread dot for content the user is currently looking at.
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
      let busyCount = 0;
      let unreadCount = 0;
      for (const sid of task.sessionIds) {
        const session = sessionMap.get(sid);
        if (!session || session.archived) continue;
        if (session.busy) { busyCount++; continue; }
        if (sid === activeSessionId) continue;
        if (isUnread?.(sid, getSessionActivityTime(session))) unreadCount++;
      }
      const lastActivity = getTaskLastActivity(task, sessionMap);
      result.set(task.id, { busy: busyCount > 0, unread: unreadCount > 0, busyCount, unreadCount, lastActivity });
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
    return session && !session.archived && isUnread(sid, getSessionActivityTime(session));
  }).length;
}
