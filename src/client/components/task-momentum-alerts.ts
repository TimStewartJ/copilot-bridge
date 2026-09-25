import type { EnrichedPR, Task } from "../api";
import { getRevisitState } from "../lib/task-revisit";

export type TaskAlertTone = "accent" | "info" | "success" | "warning" | "danger" | "neutral";

export interface TaskAlertChip {
  kind:
    | "follow-up-overdue"
    | "follow-up-due"
    | "waiting"
    | "active-pr";
  label: string;
  title?: string;
  tone: TaskAlertTone;
  priority: number;
  recency: number;
}

/**
 * What the task header says needs noticing. Session state (working, stalled, unread) is left to the
 * session rows just below, which already show it.
 */
interface GetTaskAlertChipsOptions {
  task: Task;
  pullRequests?: EnrichedPR[];
  limit?: number;
}

export function getTaskAlertChips({
  task,
  pullRequests = [],
  limit = 3,
}: GetTaskAlertChipsOptions): TaskAlertChip[] {
  const chips: TaskAlertChip[] = [];
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
