import type { Session, Task } from "../api";

type TaskLinks = Pick<Task, "id" | "activeSessionIds">;

/**
 * Whether a session is linked to a task. Tasks list only their active sessions, so an archived
 * session is matched through the links the server reports on the session itself.
 */
export function isSessionLinkedToTask(
  task: TaskLinks,
  session: Pick<Session, "sessionId" | "linkedTaskIds">,
): boolean {
  return task.activeSessionIds.includes(session.sessionId) || (session.linkedTaskIds?.includes(task.id) ?? false);
}

export function findTaskForSession<T extends TaskLinks>(
  tasks: readonly T[],
  sessionId: string,
  session?: Pick<Session, "linkedTaskIds"> | null,
): T | undefined {
  const byActiveLink = tasks.find((task) => task.activeSessionIds.includes(sessionId));
  if (byActiveLink) return byActiveLink;
  const linkedTaskIds = session?.linkedTaskIds;
  return linkedTaskIds?.length ? tasks.find((task) => linkedTaskIds.includes(task.id)) : undefined;
}

/** Optimistic link of a new session; the next task fetch brings the real counts and revision. */
export function addActiveSessionToTask<T extends Task>(task: T, sessionId: string): T {
  if (task.activeSessionIds.includes(sessionId)) return task;
  return {
    ...task,
    activeSessionIds: [...task.activeSessionIds, sessionId],
    sessionCount: task.sessionCount + 1,
  };
}

export function removeActiveSessionFromTask<T extends Task>(task: T, sessionId: string): T {
  if (!task.activeSessionIds.includes(sessionId)) return task;
  return {
    ...task,
    activeSessionIds: task.activeSessionIds.filter((candidate) => candidate !== sessionId),
    sessionCount: Math.max(0, task.sessionCount - 1),
  };
}
