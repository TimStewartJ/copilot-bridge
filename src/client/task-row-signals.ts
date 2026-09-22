import type { Task } from "./api";
import { getRevisitState } from "./lib/task-revisit";
import type { DsStatusKind } from "./design/tokens";
import type { TaskIndicator } from "./hooks/useTaskIndicators";
import { getTaskLifecycleDisplayState } from "./task-completion-helpers";

export type TaskRowSignalKind =
  | "needs-input"
  | "stalled"
  | "busy"
  | "follow-up-overdue"
  | "follow-up-due"
  | "unread"
  | "completed"
  | "deferred"
  | "archived";

export type TaskRowSignalTone = "accent" | "info" | "warning" | "success" | "danger" | "faint";

export interface TaskRowSignal {
  kind: TaskRowSignalKind;
  label: string;
  shortLabel: string;
  tone: TaskRowSignalTone;
  /** The glyph drawn beside the label; shape carries the state (see StatusIcon). */
  status: DsStatusKind;
  animated?: boolean;
}

/** The one state a compact task tile shows, when it has no room for words. */
export interface TaskStatus {
  kind: DsStatusKind;
  label: string;
}

const SIGNAL_STATUS: Record<TaskRowSignalKind, DsStatusKind> = {
  "needs-input": "needs-input",
  stalled: "warning",
  busy: "working",
  "follow-up-overdue": "open",
  "follow-up-due": "open",
  unread: "unread",
  completed: "done",
  deferred: "paused",
  archived: "closed",
};

function signal(
  kind: TaskRowSignalKind,
  label: string,
  shortLabel: string,
  tone: TaskRowSignalTone,
  animated = false,
): TaskRowSignal {
  return { kind, label, shortLabel, tone, status: SIGNAL_STATUS[kind], animated };
}

/**
 * Returns task-row states in product priority order. Muting suppresses live
 * attention states, while completed and archived lifecycle states stay visible.
 */
export function getTaskRowSignals(
  task: Task,
  indicator?: TaskIndicator,
  now = new Date(),
): TaskRowSignal[] {
  const lifecycleState = getTaskLifecycleDisplayState(task);
  if (lifecycleState === "archived") {
    return [signal("archived", "Archived", "Archived", "faint")];
  }
  if (lifecycleState === "completed") {
    return [signal("completed", "Completed", "Done", "faint")];
  }
  const deferred = task.deferred ? [signal("deferred", "Deferred", "Deferred", "faint")] : [];
  if (task.muted) return deferred;

  const signals: TaskRowSignal[] = [];
  const needsUserInputCount = indicator?.needsUserInputCount ?? 0;
  const busyCount = indicator?.busyCount ?? 0;
  const unreadCount = indicator?.unreadCount ?? 0;

  if (needsUserInputCount > 0) {
    signals.push(signal(
      "needs-input",
      needsUserInputCount === 1 ? "Answer needed" : `${needsUserInputCount} answers needed`,
      needsUserInputCount === 1 ? "Answer" : `${needsUserInputCount} answers`,
      "accent",
    ));
  }
  if (indicator?.stalled) {
    signals.push(signal("stalled", "Stalled", "Stalled", "warning", true));
  } else if (indicator?.busy) {
    signals.push(signal(
      "busy",
      busyCount > 1 ? `${busyCount} sessions working` : "Agent working",
      busyCount > 1 ? `${busyCount} working` : "Agent working",
      "faint",
      true,
    ));
  }

  signals.push(...deferred);
  const followUpState = getRevisitState(task.nextTouchAt, now);
  if (followUpState === "ready") {
    signals.push(signal("follow-up-overdue", "Ready to revisit", "Revisit", "faint"));
  } else if (followUpState === "today") {
    signals.push(signal("follow-up-due", "Revisit today", "Revisit", "faint"));
  }

  if (unreadCount > 0) {
    signals.push(signal(
      "unread",
      unreadCount === 1 ? "Unread conversation" : `${unreadCount} unread conversations`,
      unreadCount === 1 ? "New" : `${unreadCount} new`,
      "faint",
    ));
  }

  return signals;
}

/** The single highest-priority live state of a task, for tiles and rows with no room for words. */
export function getTaskStatus(indicator?: TaskIndicator): TaskStatus | null {
  const needsUserInputCount = indicator?.needsUserInputCount ?? 0;
  if (needsUserInputCount > 0) {
    return { kind: "needs-input", label: needsUserInputCount === 1 ? "Answer needed" : `${needsUserInputCount} answers needed` };
  }
  if (indicator?.stalled) return { kind: "warning", label: "Stalled" };
  if (indicator?.busy) return { kind: "working", label: "Agent working" };
  if ((indicator?.unreadCount ?? 0) > 0 || indicator?.unread) return { kind: "unread", label: "Unread conversations" };
  return null;
}

export function shouldShowTaskRowUnreadDot(
  task: Task,
  indicator: TaskIndicator | undefined,
): boolean {
  return !task.muted && (indicator?.unreadCount ?? 0) > 0;
}
