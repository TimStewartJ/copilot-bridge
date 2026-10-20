/** Counts-only evidence of work that can advance a task without another user message. */
export interface TaskActivity {
  /** All sources needed to infer absence were available; positive counts can still prove continuation. */
  known: boolean;
  /** Missing conversation records can hide an input request, even when future work is known. */
  sessionIndexKnown: boolean;
  unavailable?: { scope: "source" | "task"; reason: string; expectedInPreview?: boolean };
  runCount: number;
  runningAgentCount: number;
  runningCommandCount: number;
  heldCount: number;
  externalCount: number;
  deferredCount: number;
  scheduledCount: number;
  pendingDeliveryCount: number;
  managementJobCount: number;
}

export type TaskAttentionKind = "needs-input" | "unread" | "revisit" | "review" | "unavailable" | "stalled";

export interface TaskAttentionInput {
  active: boolean;
  muted: boolean;
  deferred: boolean;
  waitingOn?: string;
  nextTouchAt?: string;
  inputCount: number;
  unreadCount: number;
  stalled?: boolean;
  readStateKnown: boolean;
  sessionStateKnown: boolean;
  liveWorkCount: number;
  activity?: TaskActivity;
}

/** Attention is independent of read markers: reading a result does not remove an idle task's review cue. */
export function deriveTaskAttention(input: TaskAttentionInput, now = Date.now()): TaskAttentionKind | null {
  const revisit = input.nextTouchAt ? Date.parse(input.nextTouchAt) : null;
  const revisitDue = revisit !== null && Number.isFinite(revisit) && revisit <= now;
  if (input.muted) return input.active && revisitDue ? "revisit" : null;
  if (input.inputCount > 0) return "needs-input";
  if (input.readStateKnown && input.unreadCount > 0) return "unread";
  if (!input.active) return null;
  if (revisitDue) return "revisit";
  if (input.stalled) return "stalled";
  if (input.deferred) return null;
  if (revisit !== null && !Number.isFinite(revisit)) return "unavailable";
  // A saved wait alone stays marked: nothing will bring the task back unless a date or a check is set.
  if (input.liveWorkCount > 0 || revisit !== null) return null;
  const activity = input.activity;
  if (!activity) return "unavailable";
  const counts = [activity.runCount, activity.runningAgentCount, activity.runningCommandCount,
    activity.heldCount, activity.externalCount, activity.deferredCount, activity.scheduledCount,
    activity.pendingDeliveryCount, activity.managementJobCount];
  if (counts.some(count => !Number.isFinite(count) || count < 0)) return "unavailable";
  if (activity.runCount + activity.runningAgentCount + activity.runningCommandCount
    + activity.heldCount + activity.externalCount + activity.deferredCount + activity.scheduledCount
    + activity.pendingDeliveryCount + activity.managementJobCount > 0) return null;
  if (!input.readStateKnown || !input.sessionStateKnown || activity.sessionIndexKnown === false) return "unavailable";
  if (!activity.known) return "unavailable";
  return "review";
}
