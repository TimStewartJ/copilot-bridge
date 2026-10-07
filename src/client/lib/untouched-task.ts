import type { Task } from "../api";

/**
 * Whether a task looks unused from what the browser holds: never edited, nothing linked.
 * It only decides whether to try deleting without the confirmation dialog. The server
 * makes the real check, which also covers schedules, checklist items and history.
 */
export function looksUntouched(task: Task): boolean {
  return task.status === "active"
    && task.updatedAt === task.createdAt
    && task.sessionCount === 0
    && task.workItems.length === 0
    && task.pullRequests.length === 0
    && (task.tags?.length ?? 0) === 0;
}
