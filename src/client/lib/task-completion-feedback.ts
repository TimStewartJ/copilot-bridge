import type { ChecklistItem, EnrichedPR, Session, Task } from "../api";
import type { ToastInput } from "../useToast";
import { describeTaskCompletionSummary, getTaskCompletionCounts } from "../task-completion-helpers";

export interface TaskCompletionToastData {
  taskId: string;
  taskTitle: string;
  summary: string;
  doneWhenCopy?: string;
}

export interface CreateTaskCompletionFeedbackArgs {
  task: Pick<Task, "id" | "title" | "doneWhen" | "pullRequests">;
  previousStatus: Task["status"];
  checklistItems?: readonly Pick<ChecklistItem, "done">[];
  linkedSessions?: readonly Pick<Session, "runState">[];
  pullRequests?: readonly Pick<EnrichedPR, "status">[];
}

export interface TaskCompletionFeedback extends TaskCompletionToastData {
  previousStatus: Task["status"];
}

export function createTaskCompletionFeedback({
  task,
  previousStatus,
  checklistItems = [],
  linkedSessions = [],
  pullRequests,
}: CreateTaskCompletionFeedbackArgs): TaskCompletionFeedback {
  const counts = getTaskCompletionCounts({
    checklistItems,
    linkedSessions,
    pullRequests: pullRequests && pullRequests.length > 0
      ? pullRequests
      : task.pullRequests.map(() => ({ status: null })),
  });

  return {
    taskId: task.id,
    taskTitle: task.title,
    previousStatus,
    summary: describeTaskCompletionSummary({ doneWhen: undefined }, counts),
    doneWhenCopy: task.doneWhen ? `Done when: ${task.doneWhen}` : undefined,
  };
}

/** Maps completion feedback onto the shared toast model. */
export function createTaskCompletionToast(
  feedback: TaskCompletionFeedback,
  onUndo: () => void | Promise<void>,
): ToastInput {
  return {
    id: `task-completion-${feedback.taskId}`,
    tone: "success",
    title: `${feedback.taskTitle} completed`,
    description: feedback.summary,
    footnote: feedback.doneWhenCopy,
    action: { label: "Reopen task", pendingLabel: "Reopening…", onAction: onUndo },
  };
}

const CLAIM_MS = 60_000;
const claimedCompletions = new Map<string, number>();

/**
 * Marks completions whose confirmation and undo another surface already shows, such as Home's
 * quiet-task outcomes, so the global "Reopen task" toast does not offer a second, lossier undo.
 */
export function claimTaskCompletionFeedback(taskIds: readonly string[], now = Date.now()): void {
  for (const id of taskIds) claimedCompletions.set(id, now + CLAIM_MS);
}

/** True once per claim: the detector consumes it so a later, unrelated completion still gets its toast. */
export function consumeTaskCompletionClaim(taskId: string, now = Date.now()): boolean {
  const expires = claimedCompletions.get(taskId);
  if (expires === undefined) return false;
  claimedCompletions.delete(taskId);
  return expires >= now;
}
