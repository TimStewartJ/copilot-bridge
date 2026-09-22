import type { EnrichedPR, Session, Task } from "../api";
import { getSessionActivityTime, getSessionRunState } from "../api";
import { getRevisitState } from "../lib/task-revisit";

export type TaskAlertTone = "accent" | "info" | "success" | "warning" | "danger" | "neutral";

export interface TaskAlertChip {
  kind:
    | "follow-up-overdue"
    | "follow-up-due"
    | "waiting"
    | "session-stalled"
    | "session-busy"
    | "session-unread"
    | "active-pr";
  label: string;
  title?: string;
  tone: TaskAlertTone;
  priority: number;
  recency: number;
}

interface GetTaskAlertChipsOptions {
  task: Task;
  sessions: Session[];
  activeSessionId?: string | null;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  pullRequests?: EnrichedPR[];
  limit?: number;
}

export function getTaskAlertChips({
  task,
  sessions,
  activeSessionId = null,
  isUnread,
  pullRequests = [],
  limit = 3,
}: GetTaskAlertChipsOptions): TaskAlertChip[] {
  const chips: TaskAlertChip[] = [];
  const activeSessions = sessions.filter((session) => !session.archived);
  const followUpState = getRevisitState(task.nextTouchAt);

  if (followUpState === "ready") {
    chips.push({
      kind: "follow-up-overdue",
      label: "Ready to revisit",
      title: task.nextTouchAt ? formatFollowUpTitle(task.nextTouchAt) : "Ready to revisit this task",
      tone: "neutral",
      priority: 10,
      recency: toTimestamp(task.nextTouchAt),
    });
  } else if (followUpState === "today") {
    chips.push({
      kind: "follow-up-due",
      label: "Revisit today",
      title: task.nextTouchAt ? formatFollowUpTitle(task.nextTouchAt) : "This task should be revisited now",
      tone: "neutral",
      priority: 11,
      recency: toTimestamp(task.nextTouchAt),
    });
  }

  if (task.waitingOn?.trim()) {
    chips.push({
      kind: "waiting",
      label: "Waiting for",
      title: task.waitingOn.trim(),
      tone: "neutral",
      priority: 20,
      recency: toTimestamp(task.updatedAt),
    });
  }

  const stalledSessions = activeSessions
    .filter((session) => getSessionRunState(session) === "stalled")
    .sort(compareSessionRecency);
  if (stalledSessions.length > 0) {
    chips.push({
      kind: "session-stalled",
      label: stalledSessions.length === 1 ? "Session stalled" : `${stalledSessions.length} sessions stalled`,
      title: describeSessions(stalledSessions, "stalled"),
      tone: "warning",
      priority: 30,
      recency: getSessionRecency(stalledSessions[0]),
    });
  } else {
    const busySessions = activeSessions
      .filter((session) => getSessionRunState(session) === "busy")
      .sort(compareSessionRecency);
    if (busySessions.length > 0) {
      chips.push({
        kind: "session-busy",
        label: busySessions.length === 1 ? "Chat in flight" : `${busySessions.length} chats in flight`,
        title: describeSessions(busySessions, "busy"),
        tone: "info",
        priority: 31,
        recency: getSessionRecency(busySessions[0]),
      });
    }
  }

  const unreadSessions = activeSessions
    .filter((session) => session.sessionId !== activeSessionId)
    .filter((session) => isUnread?.(session.sessionId, getSessionActivityTime(session)))
    .sort(compareSessionRecency);
  if (unreadSessions.length > 0) {
    chips.push({
      kind: "session-unread",
      label: unreadSessions.length === 1 ? "Unread activity" : `${unreadSessions.length} unread chats`,
      title: describeSessions(unreadSessions, "unread"),
      tone: "success",
      priority: 40,
      recency: getSessionRecency(unreadSessions[0]),
    });
  }

  const activePrCount = pullRequests.filter((pr) => pr.status === "active").length;
  if (activePrCount > 0) {
    chips.push({
      kind: "active-pr",
      label: activePrCount === 1 ? "1 active PR" : `${activePrCount} active PRs`,
      title: `${activePrCount} linked pull request${activePrCount === 1 ? " is" : "s are"} still active`,
      tone: "info",
      priority: 50,
      recency: toTimestamp(task.updatedAt),
    });
  }

  return chips
    .sort((left, right) => left.priority - right.priority || right.recency - left.recency)
    .slice(0, limit);
}

function compareSessionRecency(left: Session, right: Session): number {
  return getSessionRecency(right) - getSessionRecency(left);
}

function getSessionRecency(session: Session): number {
  return toTimestamp(getSessionActivityTime(session));
}

function describeSessions(sessions: Session[], state: "busy" | "stalled" | "unread"): string | undefined {
  const [first] = sessions;
  if (!first) return undefined;
  const label = first.summary || first.intentText || first.sessionId.slice(0, 8);
  const prefix = state === "unread" ? "Latest unread" : state === "stalled" ? "Latest stalled" : "Latest busy";
  return sessions.length === 1
    ? `${prefix}: ${label}`
    : `${prefix}: ${label} (+${sessions.length - 1} more)`;
}

function formatFollowUpTitle(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Revisit date unavailable";
  return `Revisit ${parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}
