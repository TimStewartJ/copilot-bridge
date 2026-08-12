import type { Task } from "./api";
import { getFollowUpState } from "./components/TaskMomentumFields";
import type { TaskIndicator } from "./hooks/useTaskIndicators";
import { getTaskLifecycleDisplayState } from "./task-completion-helpers";

export type TaskRowSignalKind =
  | "needs-input"
  | "stalled"
  | "busy"
  | "follow-up-overdue"
  | "follow-up-due"
  | "needs-decision"
  | "unread"
  | "completed"
  | "archived";

export type TaskRowSignalTone = "info" | "warning" | "success" | "danger" | "faint";

export interface TaskRowSignal {
  kind: TaskRowSignalKind;
  label: string;
  shortLabel: string;
  tone: TaskRowSignalTone;
  animated?: boolean;
}

export interface TaskActivityDot {
  tone: "info" | "warning";
  animated: boolean;
}

function signal(
  kind: TaskRowSignalKind,
  label: string,
  shortLabel: string,
  tone: TaskRowSignalTone,
  animated = false,
): TaskRowSignal {
  return { kind, label, shortLabel, tone, animated };
}

function hasMomentumValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
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
    return [signal("completed", "Completed", "Done", "success")];
  }
  if (task.muted) return [];

  const signals: TaskRowSignal[] = [];
  const needsUserInputCount = indicator?.needsUserInputCount ?? 0;
  const busyCount = indicator?.busyCount ?? 0;
  const unreadCount = indicator?.unreadCount ?? 0;

  if (needsUserInputCount > 0) {
    signals.push(signal(
      "needs-input",
      needsUserInputCount === 1 ? "Answer needed" : `${needsUserInputCount} answers needed`,
      needsUserInputCount === 1 ? "Answer" : `${needsUserInputCount} answers`,
      "warning",
    ));
  }
  if (indicator?.stalled) {
    signals.push(signal("stalled", "Stalled", "Stalled", "warning", true));
  } else if (indicator?.busy) {
    signals.push(signal(
      "busy",
      busyCount > 1 ? `${busyCount} sessions working` : "Working",
      busyCount > 1 ? `${busyCount} working` : "Working",
      "info",
      true,
    ));
  }

  const followUpState = getFollowUpState(task.nextTouchAt, now);
  if (followUpState === "overdue") {
    signals.push(signal("follow-up-overdue", "Follow-up overdue", "Overdue", "danger"));
  } else if (followUpState === "due") {
    signals.push(signal("follow-up-due", "Follow up today", "Follow up", "warning"));
  }

  if (
    !hasMomentumValue(task.nextAction)
    && !hasMomentumValue(task.waitingOn)
    && !hasMomentumValue(task.nextTouchAt)
  ) {
    signals.push(signal("needs-decision", "Needs decision", "Decision", "warning"));
  }

  if (unreadCount > 0) {
    signals.push(signal(
      "unread",
      unreadCount === 1 ? "New result" : `${unreadCount} new results`,
      unreadCount === 1 ? "New" : `${unreadCount} new`,
      "success",
    ));
  }

  return signals;
}

export function getTaskActivityDot(indicator?: TaskIndicator): TaskActivityDot | null {
  if ((indicator?.needsUserInputCount ?? 0) > 0) {
    return { tone: "warning", animated: false };
  }
  if (indicator?.stalled) {
    return { tone: "warning", animated: true };
  }
  if (indicator?.busy) {
    return { tone: "info", animated: true };
  }
  return null;
}

export function shouldShowTaskRowUnreadDot(
  task: Task,
  indicator: TaskIndicator | undefined,
): boolean {
  return !task.muted && (indicator?.unreadCount ?? 0) > 0;
}
