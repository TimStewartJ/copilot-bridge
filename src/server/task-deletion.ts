// Single path for task deletion: triggers and tags have no FK; callers choose what chats get.

import type { AppContext } from "./app-context.js";
import type { Task } from "./task-store.js";

export type SessionDisposition = "archive" | "delete";

/** Deleted without asking; updatedAt covers own fields, other stores are checked here. */
export function isTaskUntouched(ctx: AppContext, task: Task): boolean {
  return task.status === "active"
    && task.updatedAt === task.createdAt
    && task.sessionIds.length === 0
    && task.workItems.length === 0
    && task.pullRequests.length === 0
    && (ctx.triggerStore?.list({ taskId: task.id, includeInactive: true }).length ?? 0) === 0
    && ctx.checklistStore.listChecklistItems(task.id).length === 0
    && (ctx.taskHistoryStore?.countEntries(task.id) ?? 0) === 0
    && (ctx.tagStore?.getEntityTags("task", task.id).length ?? 0) === 0;
}

export interface TaskDeletionOptions {
  sessionDisposition: SessionDisposition;
  /** Injected: the real one lives in the API router, which owns the cache it invalidates. */
  deleteSession?: (sessionId: string) => Promise<void>;
  /** Called once per bulk change: a task can link thousands of chats. */
  onSessionsChanged?: (reason: string) => void;
}

export interface TaskDeletionResult {
  /** Triggers removed alongside the task. */
  deletedTriggerIds: string[];
  archivedSessionIds: string[];
  deletedSessionIds: string[];
  /** Sessions another task also links; they are kept and only lose this task's link. */
  unlinkedSharedSessionIds: string[];
  /** Per-session failures. Non-empty means the task was NOT deleted. */
  sessionErrors: Record<string, string>;
  taskDeleted: boolean;
}

function finishTaskDeletion(
  ctx: AppContext,
  taskId: string,
  deletedTriggerIds: string[],
): void {
  for (const triggerId of deletedTriggerIds) {
    ctx.globalBus.emit({ type: "trigger:changed", taskId, triggerId });
  }
}

export async function deleteTaskWithOwnedState(
  ctx: AppContext,
  taskId: string,
  options: TaskDeletionOptions,
): Promise<TaskDeletionResult> {
  const { sessionDisposition, deleteSession, onSessionsChanged } = options;

  if (sessionDisposition === "archive") {
    const { deletedTriggerIds, archivedSessionIds } =
      ctx.taskStore.archiveSessionsAndDeleteTask(taskId);
    if (archivedSessionIds.length > 0) {
      // No per-chat session:archived here, so cancel triggers and queued prompts explicitly.
      for (const sessionId of archivedSessionIds) {
        ctx.deferredPromptStore?.cancelForSession(sessionId);
        ctx.deferredPromptStore?.cancelManagementJobDeliveriesForSession(sessionId);
        ctx.triggerStore?.cancelForSession(sessionId);
      }
      onSessionsChanged?.("task-deletion:sessions-archived");
      ctx.globalBus.emit({ type: "sessions:changed" });
    }
    // Kept chats lose the task their system prompt names.
    for (const sessionId of archivedSessionIds) ctx.sessionManager.invalidateSessionConfig(sessionId, "task deleted");
    finishTaskDeletion(ctx, taskId, deletedTriggerIds);
    return {
      deletedTriggerIds,
      archivedSessionIds,
      deletedSessionIds: [],
      unlinkedSharedSessionIds: [],
      sessionErrors: {},
      taskDeleted: true,
    };
  }

  if (!deleteSession) {
    throw new Error('deleteSession is required for the "delete" session disposition');
  }

  // Read links before the task row goes: `task_sessions` cascades on delete.
  const linkedSessionIds = ctx.taskStore.listSessionIdsForTask(taskId);
  const exclusiveSessionIds = new Set(ctx.taskStore.listExclusiveSessionIdsForTask(taskId));
  const unlinkedSharedSessionIds = linkedSessionIds.filter((id) => !exclusiveSessionIds.has(id));

  const deletedSessionIds: string[] = [];
  const sessionErrors: Record<string, string> = {};
  for (const sessionId of linkedSessionIds) {
    if (!exclusiveSessionIds.has(sessionId)) continue;
    try {
      await deleteSession(sessionId);
      deletedSessionIds.push(sessionId);
    } catch (error) {
      sessionErrors[sessionId] = error instanceof Error ? error.message : String(error);
    }
  }

  if (deletedSessionIds.length > 0 || Object.keys(sessionErrors).length > 0) {
    // Even a failed attempt can remove local rows, so other clients must refresh.
    onSessionsChanged?.("task-deletion:sessions-deleted");
    ctx.globalBus.emit({ type: "sessions:changed" });
  }

  // Chats go first: a partial failure keeps the task and its links, so a retry can finish.
  if (Object.keys(sessionErrors).length > 0) {
    return {
      deletedTriggerIds: [],
      archivedSessionIds: [],
      deletedSessionIds,
      unlinkedSharedSessionIds,
      sessionErrors,
      taskDeleted: false,
    };
  }

  // A chat linked mid-delete would lose its link to the cascade; keep the task if one appeared.
  const expectedRemaining = new Set(unlinkedSharedSessionIds);
  const newlyLinked = ctx.taskStore
    .listSessionIdsForTask(taskId)
    .filter((id) => !expectedRemaining.has(id));
  if (newlyLinked.length > 0) {
    return {
      deletedTriggerIds: [],
      archivedSessionIds: [],
      deletedSessionIds,
      unlinkedSharedSessionIds,
      sessionErrors: Object.fromEntries(newlyLinked.map((id) => [
        id,
        "Session was linked to the task while it was being deleted",
      ])),
      taskDeleted: false,
    };
  }

  const { deletedTriggerIds } = ctx.taskStore.deleteTaskCascade(taskId);
  for (const sessionId of unlinkedSharedSessionIds) ctx.sessionManager.invalidateSessionConfig(sessionId, "task deleted");
  finishTaskDeletion(ctx, taskId, deletedTriggerIds);

  return {
    deletedTriggerIds,
    archivedSessionIds: [],
    deletedSessionIds,
    unlinkedSharedSessionIds,
    sessionErrors,
    taskDeleted: true,
  };
}
