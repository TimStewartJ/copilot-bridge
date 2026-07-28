// Task deletion — the single owner of "delete a task and everything it owns".
//
// Task deletion has to reach past the `tasks` row: entity tags live in a
// separate table with no foreign key, and `schedules.taskId` has no foreign key
// either, so child schedules would otherwise survive their parent and keep
// waking the scheduler forever. `TaskStore.deleteTaskCascade` removes all of
// that in one transaction; this helper owns the side effects that cannot be
// transactional (timer unregistration and events). Routing every deletion entry
// point through here keeps that cleanup identical no matter who triggers it.

import type { AppContext } from "./app-context.js";

export interface TaskDeletionResult {
  /** Schedules removed alongside the task. Their timers are already unregistered. */
  deletedScheduleIds: string[];
}

export function deleteTaskWithOwnedState(ctx: AppContext, taskId: string): TaskDeletionResult {
  const { deletedScheduleIds } = ctx.taskStore.deleteTaskCascade(taskId);

  for (const scheduleId of deletedScheduleIds) {
    ctx.scheduler?.unregisterSchedule(scheduleId);
    ctx.globalBus.emit({ type: "schedule:changed", taskId, scheduleId });
  }

  return { deletedScheduleIds };
}
