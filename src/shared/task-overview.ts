import type { TaskNeedsYouReason, TaskState } from "./task-state.js";
import type { TaskActivity } from "./task-attention.js";
import type { MomentumFieldStamp } from "./momentum-age.js";

/** What the user last did to a task; opening it or reading a chat does not count. */
export type TaskTouchKind = "edited" | "message" | "created";

/** One active task with its derived state, for Home and the sidebar. */
export interface TaskOverviewRow {
  id: string;
  title: string;
  kind: "task" | "ongoing";
  groupId?: string;
  groupName?: string;
  groupColor?: string;
  muted: boolean;
  deferred: boolean;
  completedAt?: string;
  nextAction?: string;
  waitingOn?: string;
  nextTouchAt?: string;
  /** When waiting-for last changed, when known. */
  waitingSince?: string;
  /** Who set nextAction and when; null when unrecorded, absent from older servers. */
  nextActionSet?: MomentumFieldStamp | null;
  /** Who set waitingOn and when; null when unrecorded, absent from older servers. */
  waitingOnSet?: MomentumFieldStamp | null;
  state: TaskState;
  reasons: TaskNeedsYouReason[];
  staleWait: boolean;
  idleDays: number | null;
  /** Tim's last touch: editing the task or writing in a linked conversation; else its creation. */
  lastEngagedAt?: string;
  lastTouchKind?: TaskTouchKind;
  busyCount: number;
  stalledCount: number;
  inputCount: number;
  automationCount: number;
  /** Older servers and cached responses omit this; absence does not mean inactivity. */
  activity?: TaskActivity;
  /** Most recently active linked conversation, to resume. */
  sessionId?: string;
  order: number;
}

export interface TaskOverview {
  tasks: TaskOverviewRow[];
  /** False when chat status was partly unreadable; linked tasks are then never called quiet. */
  sessionsComplete: boolean;
  counts: Record<TaskState, number>;
  generatedAt: string;
}
