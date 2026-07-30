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
  previousStatus: Exclude<Task["status"], "done">;
  checklistItems?: readonly Pick<ChecklistItem, "done">[];
  linkedSessions?: readonly Pick<Session, "busy" | "runState">[];
  pullRequests?: readonly Pick<EnrichedPR, "status">[];
}

export interface TaskCompletionFeedback extends TaskCompletionToastData {
  previousStatus: Exclude<Task["status"], "done">;
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
