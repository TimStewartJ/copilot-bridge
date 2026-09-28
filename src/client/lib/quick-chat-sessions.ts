import type { Session, Task } from "../api";

export function getQuickChatSessions(
  sessions: readonly Session[],
  tasks: readonly Pick<Task, "activeSessionIds">[],
): Session[] {
  const taskLinkedSessionIds = new Set<string>();
  for (const task of tasks) {
    for (const sessionId of task.activeSessionIds) {
      taskLinkedSessionIds.add(sessionId);
    }
  }

  return sessions.filter((session) =>
    (session.linkedTaskIds?.length ?? 0) === 0
    && !taskLinkedSessionIds.has(session.sessionId));
}
