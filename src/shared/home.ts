import type { PendingUserInputRequestView } from "../server/user-input-types.js";
import type { PendingElicitationRequestView } from "../server/elicitation-types.js";

export type HomeSection = "overview" | "tasks" | "inputs" | "follow-ups" | "actions" | "replies";
export interface HomePage<T> { items: T[]; total: number | null; offset: number; hasMore: boolean }
export interface HomeTask {
  id: string; title: string; kind: "task" | "ongoing"; deferred: boolean; groupName?: string; groupColor?: string;
  nextAction?: string; waitingOn?: string; nextTouchAt?: string; doneWhen?: string;
  sessionId?: string; sessionTitle?: string; runningCount: number; stalledCount?: number; inputCount?: number;
}
export interface HomeSessionRef {
  sessionId: string; title: string; taskId?: string; taskTitle?: string;
}
export type HomeInput = HomeSessionRef & (
  | { kind: "user_input"; request: PendingUserInputRequestView }
  | { kind: "elicitation"; request: PendingElicitationRequestView }
);
export interface HomeInputSummary extends HomeSessionRef {
  kind: HomeInput["kind"]; requestId: string; question: string; pendingCount: number; requestedAt?: string;
}
export interface HomeFollowUp { taskId: string; title: string; at: string; deferred: boolean; nextAction?: string; waitingOn?: string }
export interface HomeAction { id: string; taskId: string | null; taskTitle?: string; text: string; deadline?: string }
export interface HomeReply extends HomeSessionRef {
  sourceEventId?: string; timestamp?: string; excerpt?: string; error?: string;
}
export interface HomeSnapshot {
  section: HomeSection;
  tasks: HomePage<HomeTask>;
  deferredTaskTotal: number;
  inputs: HomePage<HomeInputSummary>;
  followUps: HomePage<HomeFollowUp>;
  actions: HomePage<HomeAction>;
  replies: HomePage<HomeReply>;
  inputErrors: Array<HomeSessionRef & { error: string }>;
  sourceErrors: string[];
  openActionTotal: number;
  timezone: string;
}
