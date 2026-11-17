import type { Task } from "../api";

/** Client-side guess to skip the delete confirmation; the server makes the real check. */
export function looksUntouched(task: Task): boolean {
  return task.status === "active"
    && task.updatedAt === task.createdAt
    && task.sessionCount === 0
    && task.workItems.length === 0
    && task.pullRequests.length === 0
    && (task.tags?.length ?? 0) === 0;
}
