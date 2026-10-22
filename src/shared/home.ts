import type { PendingUserInputRequestView } from "../server/user-input-types.js";
import type { PendingElicitationRequestView } from "../server/elicitation-types.js";
import type { TaskOverviewRow } from "./task-overview.js";
import type { TaskState } from "./task-state.js";

export type HomeSection = "overview" | "inputs" | "actions" | "replies" | "quiet";
export interface HomePage<T> { items: T[]; total: number | null; offset: number; hasMore: boolean }
export interface HomeSessionRef {
  sessionId: string; title: string; taskId?: string; taskTitle?: string;
  /** The conversation's only tasks are archived: it is listed because something new arrived after they were closed. */
  taskArchived?: boolean;
}
export type HomeInput = HomeSessionRef & (
  | { kind: "user_input"; request: PendingUserInputRequestView }
  | { kind: "elicitation"; request: PendingElicitationRequestView }
);
export interface HomeInputSummary extends HomeSessionRef {
  kind: HomeInput["kind"]; requestId: string; question: string; pendingCount: number; requestedAt?: string;
}
export interface HomeAction { id: string; taskId: string | null; taskTitle?: string; groupColor?: string; text: string; deadline?: string }
/** Open checklist counts across every page, measured against the server's local date. */
export interface HomeActionCounts { open: number; overdue: number; dueToday: number }
export interface HomeReply extends HomeSessionRef {
  sourceEventId?: string; timestamp?: string; excerpt?: string; error?: string;
}
export interface HomeSnapshot {
  section: HomeSection;
  /** Tasks needing Tim for a task-level reason (reached revisit, stalled session). Questions are in `inputs`. */
  attention: TaskOverviewRow[];
  /** Up to five tasks in motion, most recently engaged first. */
  resume: TaskOverviewRow[];
  /** Tasks that have gone quiet, longest untouched first. */
  quiet: HomePage<TaskOverviewRow>;
  taskCounts: Record<TaskState, number>;
  inputs: HomePage<HomeInputSummary>;
  actions: HomePage<HomeAction>;
  replies: HomePage<HomeReply>;
  inputErrors: Array<HomeSessionRef & { error: string }>;
  sourceErrors: string[];
  actionCounts: HomeActionCounts;
  /** The server's local date (YYYY-MM-DD) that the deadline counts were measured against. */
  today: string;
  timezone: string;
}
