import { getSessionActivityTime, isSessionActive, type Session, type Task } from "../api";
import { isSessionLinkedToTask } from "./task-session-links";

type UnreadTask = Pick<Task, "id" | "title" | "status" | "muted" | "activeSessionIds">;

export interface UnreadSession<T extends UnreadTask = UnreadTask> {
  session: Session;
  /** The task the chat opens under. A quick chat has none. */
  task?: T;
}

/**
 * Chats holding results the reader has not seen, newest first: the set Home lists as new replies.
 * A chat that is still working is not unread yet, the chat open behind the caller is being read,
 * and a chat whose tasks are all muted stays quiet. A chat with no active task left is listed under
 * its archived task: archiving marks a task's chats read, so this one arrived afterwards. Naming a
 * task lists that task's unread chats even when it is muted, as its own session list does.
 */
export function listUnreadSessions<T extends UnreadTask>({ sessions, tasks, isUnread, activeSessionId, taskId }: {
  sessions: readonly Session[];
  tasks: readonly T[];
  isUnread: (sessionId: string, activityTime?: string) => boolean;
  activeSessionId?: string | null;
  taskId?: string;
}): UnreadSession<T>[] {
  const scopedTask = taskId === undefined ? undefined : tasks.find((task) => task.id === taskId);
  if (taskId !== undefined && !scopedTask) return [];

  const unread: Array<UnreadSession<T> & { time: number }> = [];
  for (const session of sessions) {
    if (session.archived || isSessionActive(session) || session.sessionId === activeSessionId) continue;
    const activityTime = getSessionActivityTime(session);
    if (!isUnread(session.sessionId, activityTime)) continue;

    let task = scopedTask;
    if (scopedTask) {
      if (!isSessionLinkedToTask(scopedTask, session)) continue;
    } else {
      const linked = tasks.filter((candidate) => isSessionLinkedToTask(candidate, session));
      task = linked.find((candidate) => candidate.status === "active" && !candidate.muted)
        ?? (linked.some((candidate) => candidate.status === "active") ? undefined : linked.find((candidate) => !candidate.muted));
      // A link to a task this list does not know is still a link, so it is not a quick chat.
      if (!task && (linked.length > 0 || (session.linkedTaskIds?.length ?? 0) > 0)) continue;
    }
    const time = Date.parse(activityTime ?? "");
    unread.push({ session, task, time: Number.isFinite(time) ? time : 0 });
  }

  return unread
    .sort((left, right) => right.time - left.time || left.session.sessionId.localeCompare(right.session.sessionId))
    .map(({ session, task }) => (task ? { session, task } : { session }));
}
