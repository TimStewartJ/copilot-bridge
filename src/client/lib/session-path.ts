import { getSessionActivityTime, type Session, type Task } from "../api";

export interface SessionNavigationTarget {
  sessionId: string;
  taskId?: string | null;
}

export function getSessionPath({ sessionId, taskId }: SessionNavigationTarget): string {
  return taskId
    ? `/tasks/${taskId}/sessions/${sessionId}`
    : `/sessions/${sessionId}`;
}

export interface TaskChatNavigationTarget {
  task: Pick<Task, "id" | "sessionIds">;
  sessions: Session[];
  lastViewedSessionId?: string | null;
}

export function getTaskDraftSessionPath(taskId: string): string {
  return `/tasks/${taskId}/sessions/new`;
}

export function getTaskActiveChatSessionId({
  task,
  sessions,
  lastViewedSessionId,
}: TaskChatNavigationTarget): string | null {
  const linkedSessionIds = new Set(task.sessionIds);
  if (linkedSessionIds.size === 0) return null;

  const activeLinkedSessions = sessions.filter((session) =>
    linkedSessionIds.has(session.sessionId) && !session.archived,
  );
  if (activeLinkedSessions.length === 0) return null;

  if (
    lastViewedSessionId
    && activeLinkedSessions.some((session) => session.sessionId === lastViewedSessionId)
  ) {
    return lastViewedSessionId;
  }

  return [...activeLinkedSessions].sort((left, right) => {
    const activityDiff = (getSessionActivityTime(right) ?? "").localeCompare(
      getSessionActivityTime(left) ?? "",
    );
    if (activityDiff !== 0) return activityDiff;
    return left.sessionId.localeCompare(right.sessionId);
  })[0]?.sessionId ?? null;
}

export function getTaskChatPath(target: TaskChatNavigationTarget): string {
  const sessionId = getTaskActiveChatSessionId(target);
  return sessionId
    ? getSessionPath({ taskId: target.task.id, sessionId })
    : getTaskDraftSessionPath(target.task.id);
}
