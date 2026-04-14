import { useMemo } from "react";
import { getSessionActivityTime, type Task, type Session } from "../api";

export interface TaskIndicator {
  busy: boolean;
  unread: boolean;
  busyCount: number;
  unreadCount: number;
  lastActivity: string;
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
 */
export default function useTaskIndicators(
  tasks: Task[],
  sessions: Session[],
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean,
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
        if (isUnread?.(sid, getSessionActivityTime(session))) unreadCount++;
      }
      const lastActivity = getTaskLastActivity(task, sessionMap);
      result.set(task.id, { busy: busyCount > 0, unread: unreadCount > 0, busyCount, unreadCount, lastActivity });
    }
    return result;
  }, [tasks, sessionMap, isUnread]);

  return indicators;
}

/** Count unread sessions for a specific task (excludes archived sessions). */
export function countTaskUnread(
  task: Task,
  sessionMap: Map<string, Session>,
  isUnread: (sessionId: string, modifiedTime?: string) => boolean,
): number {
  return task.sessionIds.filter((sid) => {
    const session = sessionMap.get(sid);
    return session && !session.archived && isUnread(sid, getSessionActivityTime(session));
  }).length;
}
