import type { Task } from "./api";
import { deriveTaskAttention, type TaskActivity } from "../shared/task-attention";
import { getRevisitState } from "./lib/task-revisit";
import type { DsStatusKind } from "./design/tokens";
import type { TaskIndicator } from "./hooks/useTaskIndicators";
import { getTaskLifecycleDisplayState } from "./task-completion-helpers";

export type TaskRowSignalKind =
  | "needs-input" | "stalled" | "follow-up-overdue" | "follow-up-due" | "unread"
  | "needs-look" | "status-unknown";
export type TaskRowSignalTone = "accent" | "warning" | "faint";

export interface TaskRowSignal {
  kind: TaskRowSignalKind;
  label: string;
  shortLabel: string;
  tone: TaskRowSignalTone;
  status: DsStatusKind;
  detail?: string;
}

type SignalTask = Pick<Task, "status" | "completedAt" | "muted" | "deferred" | "nextTouchAt" | "waitingOn">;
export interface TaskRowSignalOptions {
  activity?: TaskActivity;
  inputCount?: number;
}

function signal(kind: TaskRowSignalKind, label: string, shortLabel: string, tone: TaskRowSignalTone, status: DsStatusKind, detail?: string): TaskRowSignal {
  return { kind, label, shortLabel, tone, status, ...(detail ? { detail } : {}) };
}

/** The same answer/read/review meaning in task navigation, lists and the selected task header. */
export function getTaskAttentionSignal(
  task: SignalTask,
  indicator?: TaskIndicator,
  now = new Date(),
  options: TaskRowSignalOptions = {},
): TaskRowSignal | null {
  const lifecycle = getTaskLifecycleDisplayState(task);
  const attention = deriveTaskAttention({
    active: lifecycle === "active",
    muted: task.muted, deferred: task.deferred, waitingOn: task.waitingOn, nextTouchAt: task.nextTouchAt,
    inputCount: Math.max(indicator?.needsUserInputCount ?? 0, options.inputCount ?? 0),
    unreadCount: indicator?.unreadCount ?? 0,
    stalled: indicator?.stalled,
    readStateKnown: indicator?.readStateKnown ?? true,
    sessionStateKnown: indicator?.sessionStateKnown ?? true,
    liveWorkCount: (indicator?.busyCount ?? 0) + (indicator?.deferCount ?? 0)
      + (indicator?.backgroundRunningCount ?? 0) + (indicator?.externalCount ?? 0),
    activity: options.activity,
  }, now.getTime());
  switch (attention) {
    case "needs-input": return signal("needs-input", "Needs you", "Needs you", "accent", "needs-input", "A question or approval is waiting for your input.");
    case "unread": return signal("unread", "New replies", "New", "faint", "unread",
      `${indicator?.unreadCount ?? 0} unread conversation${indicator?.unreadCount === 1 ? "" : "s"}.`);
    case "stalled": return signal("stalled", "Stalled", "Stalled", "warning", "warning", "A linked conversation reports a stalled run.");
    case "revisit": {
      const ready = getRevisitState(task.nextTouchAt, now) === "ready";
      const standing = task.muted ? "Muted" : task.deferred ? "Deferred" : null;
      return signal(ready ? "follow-up-overdue" : "follow-up-due", "Revisit", "Revisit", "faint", standing ? "paused" : "open",
        `${standing ? `${standing} · ` : ""}${ready ? "ready to revisit" : "revisit today"}`);
    }
    case "review": return signal("needs-look", "Needs a look", "Review", "faint", "review", task.waitingOn?.trim()
      ? `Waiting for: ${task.waitingOn.trim()}, with no revisit date. Add one so it comes back.`
      : "Nothing running or planned. Review it or decide its next step.");
    case "unavailable": return signal("status-unknown", "Status unavailable", "Unknown", "faint", "unknown",
      options.activity?.unavailable?.reason ?? (indicator?.readStateKnown === false ? "Read status is unavailable." : "Task activity could not be classified reliably."));
    default: return null;
  }
}

/**
 * The leading glyph: an attention mark first, then the working spinner for a task with a turn running.
 * Unread replies on a working task keep both as one glyph. The spinner never counts as attention.
 */
export function getTaskLeadingGlyph(attention: TaskRowSignal | null, indicator?: TaskIndicator, activity?: TaskActivity): DsStatusKind | null {
  const working = !!indicator?.busy || (activity?.runCount ?? 0) > 0;
  if (attention) return attention.kind === "unread" && working ? "unread-working" : attention.status;
  return working ? "working" : null;
}

/** Progress is available as context, never as a routine leading attention mark. */
export function getTaskActivityDescription(task: SignalTask, indicator?: TaskIndicator, activity?: TaskActivity): string {
  if (indicator?.busy || (activity?.runCount ?? 0) > 0) return "Agent working";
  if ((activity?.runningCommandCount ?? 0) > 0) return "A background command is running";
  if (Math.max(indicator?.backgroundRunningCount ?? 0, activity?.runningAgentCount ?? 0) > 0) return "A background agent is working";
  if ((activity?.heldCount ?? 0) > 0) return "A continuation is pending";
  if ((activity?.managementJobCount ?? 0) > 0) return "A background management job is pending";
  if ((activity?.pendingDeliveryCount ?? 0) > 0) return "A result is queued for delivery";
  if (Math.max(indicator?.deferCount ?? 0, activity?.deferredCount ?? 0) > 0) return "Automatic check scheduled";
  if ((activity?.scheduledCount ?? 0) > 0) return "Automatic work scheduled";
  if (Math.max(indicator?.externalCount ?? 0, activity?.externalCount ?? 0) > 0) return "Open in another client";
  if (task.waitingOn?.trim()) return `Waiting for: ${task.waitingOn.trim()}`;
  if (getRevisitState(task.nextTouchAt) === "upcoming") return "A future revisit is planned";
  const lifecycle = getTaskLifecycleDisplayState(task);
  if (lifecycle === "completed") return "Completed";
  if (lifecycle === "archived") return "Archived";
  if (task.muted) return "Muted";
  if (task.deferred) return "Intentionally set aside";
  if (!activity?.known) return "Task activity unavailable";
  return "No running work or planned continuation";
}

export function shouldShowTaskRowUnreadDot(task: Pick<Task, "muted">, indicator: TaskIndicator | undefined): boolean {
  return !task.muted && (indicator?.readStateKnown ?? true) && (indicator?.unreadCount ?? 0) > 0;
}
