import type { ChecklistItem, EnrichedPR, Session, Task, TaskCompletionAction } from "./api";

type CompletionTask = Pick<Task, "status" | "doneWhen" | "completedAt">;
type ChecklistLike = Pick<ChecklistItem, "done">;
type SessionLike = Pick<Session, "busy" | "runState">;
type PullRequestLike = Pick<EnrichedPR, "status">;

export interface TaskCompletionCounts {
  totalChecklistItems: number;
  completedChecklistItems: number;
  openChecklistItems: number;
  linkedSessions: number;
  busySessions: number;
  linkedPullRequests: number;
  activePullRequests: number;
  unknownPullRequests: number;
}

export type TaskCompletionCtaState = "default" | "ready" | "completed" | "archived";

export interface TaskCompletionState {
  counts: TaskCompletionCounts;
  blockers: string[];
  isStrongCloseCandidate: boolean;
  isReadyToComplete: boolean;
  ctaState: TaskCompletionCtaState;
  ctaLabel: string;
  ctaDescription: string;
  ctaNextStatus: Task["status"] | null;
  ctaCompletionAction: TaskCompletionAction | null;
}

export function shouldShowTaskArchiveToggle(
  task: Pick<Task, "status" | "completedAt">,
  completionState: Pick<TaskCompletionState, "ctaState">,
): boolean {
  return !(task.status === "archived" && completionState.ctaState === "completed");
}

interface TaskCompletionStateOptions {
  checklistLoaded?: boolean;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isBusySession(session: SessionLike): boolean {
  return session.busy || session.runState === "busy" || session.runState === "stalled";
}

export function getTaskCompletionCounts({
  checklistItems,
  linkedSessions,
  pullRequests,
}: {
  checklistItems: readonly ChecklistLike[];
  linkedSessions: readonly SessionLike[];
  pullRequests: readonly PullRequestLike[];
}): TaskCompletionCounts {
  const completedChecklistItems = checklistItems.filter((item) => item.done).length;
  const activePullRequests = pullRequests.filter((pr) => pr.status === "active").length;
  const unknownPullRequests = pullRequests.filter((pr) => pr.status == null).length;
  const busySessions = linkedSessions.filter(isBusySession).length;

  return {
    totalChecklistItems: checklistItems.length,
    completedChecklistItems,
    openChecklistItems: checklistItems.length - completedChecklistItems,
    linkedSessions: linkedSessions.length,
    busySessions,
    linkedPullRequests: pullRequests.length,
    activePullRequests,
    unknownPullRequests,
  };
}

export function getTaskCompletionBlockers(counts: TaskCompletionCounts): string[] {
  const blockers: string[] = [];
  if (counts.openChecklistItems > 0) blockers.push(pluralize(counts.openChecklistItems, "open checklist item"));
  if (counts.busySessions > 0) blockers.push(pluralize(counts.busySessions, "busy session"));
  if (counts.activePullRequests > 0) blockers.push(pluralize(counts.activePullRequests, "active PR"));
  if (counts.unknownPullRequests > 0) blockers.push(pluralize(counts.unknownPullRequests, "PR with unknown status"));
  return blockers;
}

export function isTaskCompleted(task: Pick<Task, "status" | "completedAt">): boolean {
  return task.status === "done" || Boolean(task.completedAt);
}

// ── Lifecycle display helpers ─────────────────────────────────────────────────

/** Three mutually-exclusive user-facing states derived from status + completedAt. */
export type TaskLifecycleDisplayState = "completed" | "archived" | "active";

/**
 * Derives the user-facing lifecycle state:
 * - "completed" when completedAt exists OR status is the legacy "done"
 * - "archived"  when status is "archived" without completedAt
 * - "active"    otherwise
 */
export function getTaskLifecycleDisplayState(
  task: Pick<Task, "status" | "completedAt">,
): TaskLifecycleDisplayState {
  if (isTaskCompleted(task)) return "completed";
  if (task.status === "archived") return "archived";
  return "active";
}

/** Human-readable label for the task lifecycle state. */
export function getTaskStatusLabel(task: Pick<Task, "status" | "completedAt">): string {
  const state = getTaskLifecycleDisplayState(task);
  if (state === "completed") return "Completed";
  if (state === "archived") return "Archived";
  return "Active";
}

/** Tailwind colour classes for a small status badge (rounded pill). */
export function getTaskLifecycleBadgeClass(task: Pick<Task, "status" | "completedAt">): string {
  const state = getTaskLifecycleDisplayState(task);
  const colours =
    state === "completed"
      ? "bg-success/15 text-success"
      : state === "archived"
        ? "bg-text-muted/15 text-text-muted"
        : "bg-info-surface text-info";
  return `rounded-full px-1.5 py-0.5 text-[10px] ${colours}`;
}

/** Tailwind text-colour class for a small inline status label. */
export function getTaskStatusTextClass(task: Pick<Task, "status" | "completedAt">): string {
  const state = getTaskLifecycleDisplayState(task);
  if (state === "completed") return "text-success";
  if (state === "archived") return "text-text-faint";
  return "text-info";
}

export function getTaskCompletionAction(task: Pick<Task, "status" | "completedAt">): {
  ctaLabel: string;
  ctaNextStatus: Task["status"] | null;
  ctaCompletionAction: TaskCompletionAction | null;
} {
  if (isTaskCompleted(task)) {
    return {
      ctaLabel: "Reopen task",
      ctaNextStatus: "active",
      ctaCompletionAction: null,
    };
  }

  if (task.status === "archived") {
    return {
      ctaLabel: "Archived",
      ctaNextStatus: null,
      ctaCompletionAction: null,
    };
  }

  return {
    ctaLabel: "Complete task",
    ctaNextStatus: null,
    ctaCompletionAction: "complete-and-archive",
  };
}

export function getTaskCompletionState(
  task: CompletionTask,
  counts: TaskCompletionCounts,
  options?: TaskCompletionStateOptions,
): TaskCompletionState {
  const blockers = getTaskCompletionBlockers(counts);
  const completed = isTaskCompleted(task);
  if (options?.checklistLoaded === false && !completed && task.status !== "archived") {
    blockers.unshift("Checklist items haven't loaded yet");
  }
  const isReadyToComplete = !completed && task.status !== "archived" && blockers.length === 0;
  const isStrongCloseCandidate = task.status === "active" && isReadyToComplete;

  const ctaState: TaskCompletionCtaState = completed
    ? "completed"
    : task.status === "archived"
      ? "archived"
      : isReadyToComplete
        ? "ready"
        : "default";
  const { ctaLabel, ctaNextStatus, ctaCompletionAction } = getTaskCompletionAction(task);
  const actionableNextStatus = ctaState === "default" ? null : ctaNextStatus;
  const actionableCompletionAction = ctaState === "default" ? null : ctaCompletionAction;

  const ctaDescription = ctaState === "completed"
    ? task.doneWhen ? `Done when: ${task.doneWhen}` : "Task already completed"
    : ctaState === "archived"
      ? "Archived tasks cannot be completed"
      : ctaState === "ready"
        ? task.doneWhen || "No open checklist items, busy sessions, or unresolved PRs"
        : blockers.join(" • ");

  return {
    counts,
    blockers,
    isStrongCloseCandidate,
    isReadyToComplete,
    ctaState,
    ctaLabel,
    ctaDescription,
    ctaNextStatus: actionableNextStatus,
    ctaCompletionAction: actionableCompletionAction,
  };
}

export function shouldSurfaceReadyToCompleteCue({
  previousOpenChecklistItems,
  nextOpenChecklistItems,
  isReadyToComplete,
}: {
  previousOpenChecklistItems: number | null;
  nextOpenChecklistItems: number;
  isReadyToComplete: boolean;
}): boolean {
  return previousOpenChecklistItems === 1 && nextOpenChecklistItems === 0 && isReadyToComplete;
}

export function getTaskCompletionSummaryParts(
  task: Pick<Task, "doneWhen">,
  counts: TaskCompletionCounts,
): string[] {
  const parts = [
    counts.totalChecklistItems > 0
      ? `${counts.completedChecklistItems} of ${counts.totalChecklistItems} checklist item${counts.totalChecklistItems === 1 ? "" : "s"} complete`
      : "No checklist items",
    pluralize(counts.linkedSessions, "linked session"),
    pluralize(counts.linkedPullRequests, "linked PR"),
  ];
  if (task.doneWhen) parts.push(`Done when: ${task.doneWhen}`);
  return parts;
}

export function describeTaskCompletionSummary(
  task: Pick<Task, "doneWhen">,
  counts: TaskCompletionCounts,
): string {
  return getTaskCompletionSummaryParts(task, counts).join(" • ");
}
