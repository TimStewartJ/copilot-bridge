import type { TaskActivity } from "../shared/task-attention.js";

export function createTaskActivity(overrides: Partial<TaskActivity> = {}): TaskActivity {
  return {
    known: true, sessionIndexKnown: true, runCount: 0, runningAgentCount: 0, runningCommandCount: 0, heldCount: 0,
    externalCount: 0, deferredCount: 0, scheduledCount: 0, pendingDeliveryCount: 0, managementJobCount: 0,
    ...overrides,
  };
}
