// Task deletion — the single owner of "delete a task and everything it owns".
//
// Task deletion has to reach past the `tasks` row: entity tags live in a
// separate table with no foreign key, and `schedules.taskId` has no foreign key
// either, so child schedules would otherwise survive their parent and keep
// waking the scheduler forever. `TaskStore` removes all of that in one
// transaction; this helper owns the side effects that cannot be transactional
// (timer unregistration and events). Routing every deletion entry point through
// here keeps that cleanup identical no matter who triggers it.
//
// Linked sessions are NOT owned by the task, so the caller must say what should
// happen to them. Before dispositions existed, deleting a task silently
// detached its sessions: the `task_sessions` rows vanished with the parent row
// and the sessions themselves were left with no task to give them context.

import type { AppContext } from "./app-context.js";

export type SessionDisposition = "archive" | "delete";

export interface TaskDeletionOptions {
  sessionDisposition: SessionDisposition;
  /**
   * Deletes a session and every Bridge-owned row keyed to it. Required for the
   * "delete" disposition. Injected rather than imported because the canonical
   * implementation lives in the API router closure, where the enriched-session
   * cache it invalidates is held.
   */
  deleteSession?: (sessionId: string) => Promise<void>;
  /**
   * Invoked once after a bulk session mutation instead of once per session.
   * A task can link thousands of sessions, so per-session cache invalidation
   * and SSE events would flood both the bus and every connected client.
   */
  onSessionsChanged?: (reason: string) => void;
}

export interface TaskDeletionResult {
  /** Schedules removed alongside the task. Their timers are already unregistered. */
  deletedScheduleIds: string[];
  archivedSessionIds: string[];
  deletedSessionIds: string[];
  /**
   * Sessions another task also links. Deleting a session unlinks it everywhere,
   * so these are left alone and merely lose their link to the deleted task.
   */
  unlinkedSharedSessionIds: string[];
  /** Per-session failures. Non-empty means the task was NOT deleted. */
  sessionErrors: Record<string, string>;
  taskDeleted: boolean;
}

function finishTaskDeletion(
  ctx: AppContext,
  taskId: string,
  deletedScheduleIds: string[],
): void {
  for (const scheduleId of deletedScheduleIds) {
    ctx.scheduler?.unregisterSchedule(scheduleId);
    ctx.globalBus.emit({ type: "schedule:changed", taskId, scheduleId });
  }
  // `feed_cards.taskId` is ON DELETE SET NULL, so cards silently lose their task
  // without any event. Tell clients to refetch or they render a stale task chip.
  ctx.globalBus.emit({ type: "feed:changed" });
}

export async function deleteTaskWithOwnedState(
  ctx: AppContext,
  taskId: string,
  options: TaskDeletionOptions,
): Promise<TaskDeletionResult> {
  const { sessionDisposition, deleteSession, onSessionsChanged } = options;

  if (sessionDisposition === "archive") {
    const { deletedScheduleIds, archivedSessionIds } =
      ctx.taskStore.archiveSessionsAndDeleteTask(taskId);
    if (archivedSessionIds.length > 0) {
      // Archiving normally cancels a session's deferred work through the
      // per-session `session:archived` event that the defer runners subscribe
      // to. The bulk path deliberately does not emit thousands of those, so the
      // cancellation has to happen explicitly or an archived session could
      // still wake up and run a deferred prompt.
      for (const sessionId of archivedSessionIds) {
        ctx.deferredPromptStore?.cancelForSession(sessionId);
        ctx.deferLoopStore?.cancelForSession(sessionId);
      }
      onSessionsChanged?.("task-deletion:sessions-archived");
      ctx.globalBus.emit({ type: "sessions:changed" });
    }
    finishTaskDeletion(ctx, taskId, deletedScheduleIds);
    return {
      deletedScheduleIds,
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

  // Session IDs must be read before the task row goes: `task_sessions` is
  // ON DELETE CASCADE, so the link set is unrecoverable afterwards.
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
    // A backend-only delete failure still removes the local session rows and
    // task links, so any attempt — not just a clean success — can leave other
    // clients holding a stale session list.
    onSessionsChanged?.("task-deletion:sessions-deleted");
    ctx.globalBus.emit({ type: "sessions:changed" });
  }

  // Sessions are disposed before the task so a partial failure leaves the task
  // intact and the operation retryable. Deleting the task first would drop the
  // link rows and strand whatever sessions had not been reached yet.
  if (Object.keys(sessionErrors).length > 0) {
    return {
      deletedScheduleIds: [],
      archivedSessionIds: [],
      deletedSessionIds,
      unlinkedSharedSessionIds,
      sessionErrors,
      taskDeleted: false,
    };
  }

  // A delete can run for minutes, and nothing stops a session being linked to
  // the task while it does. The cascade would drop that new link silently —
  // exactly the orphaning this whole path exists to prevent — so re-check the
  // link set and keep the task if anything unexpected appeared.
  const expectedRemaining = new Set(unlinkedSharedSessionIds);
  const newlyLinked = ctx.taskStore
    .listSessionIdsForTask(taskId)
    .filter((id) => !expectedRemaining.has(id));
  if (newlyLinked.length > 0) {
    return {
      deletedScheduleIds: [],
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

  const { deletedScheduleIds } = ctx.taskStore.deleteTaskCascade(taskId);
  finishTaskDeletion(ctx, taskId, deletedScheduleIds);

  return {
    deletedScheduleIds,
    archivedSessionIds: [],
    deletedSessionIds,
    unlinkedSharedSessionIds,
    sessionErrors,
    taskDeleted: true,
  };
}
