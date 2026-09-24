import type { TaskNeedsYouReason, TaskState } from "./task-state.js";

/** What Tim last did to a task. Reading a conversation deliberately does not count. */
export type TaskTouchKind = "opened" | "edited" | "message" | "created";

/** One active task with its derived state, for Home, All tasks and the sidebar. */
export interface TaskOverviewRow {
  id: string;
  title: string;
  kind: "task" | "ongoing";
  groupId?: string;
  groupName?: string;
  groupColor?: string;
  muted: boolean;
  deferred: boolean;
  nextAction?: string;
  waitingOn?: string;
  nextTouchAt?: string;
  state: TaskState;
  reasons: TaskNeedsYouReason[];
  staleWait: boolean;
  idleDays: number | null;
  /** Tim's last touch: opening the task, editing it, or writing in a linked conversation; else its creation. */
  lastEngagedAt?: string;
  lastTouchKind?: TaskTouchKind;
  busyCount: number;
  stalledCount: number;
  inputCount: number;
  automationCount: number;
  /** Most recently active linked conversation, to resume. */
  sessionId?: string;
  order: number;
}

export interface TaskOverview {
  tasks: TaskOverviewRow[];
  /** False when conversation status was unavailable or partly unreadable; linked tasks are then never called quiet. */
  sessionsComplete: boolean;
  counts: Record<TaskState, number>;
  sourceErrors: string[];
  generatedAt: string;
}
