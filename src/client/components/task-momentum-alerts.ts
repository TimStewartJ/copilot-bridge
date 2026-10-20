import type { EnrichedPR, Task } from "../api";

export type TaskAlertTone = "accent" | "info" | "success" | "warning" | "danger" | "neutral";

export interface TaskAlertChip {
  kind: "active-pr";
  label: string;
  title?: string;
  tone: TaskAlertTone;
  priority: number;
  recency: number;
}

/**
 * What the task header says needs noticing. Session state (working, stalled, unread) is left to the
 * session rows just below, a reached revisit date to the prompt beneath the header, and a saved wait
 * to the header's activity line.
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

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}
