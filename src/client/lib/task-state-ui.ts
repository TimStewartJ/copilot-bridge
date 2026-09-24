import type { TaskOverviewRow } from "../../shared/task-overview";
import type { TaskPatch } from "../api";

export type StateTone = "warning" | "info" | "neutral";

const DAY_MS = 86_400_000;

/** Days as a person says them: "3 days", "5 weeks", "4 months". */
export function formatSpan(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

/** How long ago Tim last engaged, worded honestly when it is only an estimate. */
export function describeIdle(row: Pick<TaskOverviewRow, "idleDays">): string {
  if (row.idleDays === null) return "No recent activity from you";
  if (row.idleDays < 1) return "today";
  if (row.idleDays === 1) return "yesterday";
  return `${formatSpan(row.idleDays)} ago`;
}

const TOUCH_VERB: Record<NonNullable<TaskOverviewRow["lastTouchKind"]>, string> = {
  edited: "You edited it", message: "You wrote in its conversation", created: "Created",
};

/** What Tim last did and when, e.g. "You wrote in its conversation 3 weeks ago". */
export function describeTouch(row: Pick<TaskOverviewRow, "idleDays" | "lastTouchKind">): string {
  if (row.idleDays === null || !row.lastTouchKind) return "No recent activity from you";
  return `${TOUCH_VERB[row.lastTouchKind]} ${describeIdle(row)}`;
}

export function formatShortDate(value: string, now = new Date()): string {
  const date = new Date(value);
  const days = Math.round((date.getTime() - now.getTime()) / DAY_MS);
  if (days >= 0 && days < 7) return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** The single most useful status for a task row, or none when nothing needs saying. */
export function stateBadge(row: TaskOverviewRow, now = new Date()): { label: string; tone: StateTone } | null {
  if (row.inputCount > 0) return { label: "Answer needed", tone: "warning" };
  if (row.stalledCount > 0) return { label: "Stalled", tone: "warning" };
  if (row.reasons.includes("revisit") && row.nextTouchAt) return { label: `Revisit · ${formatShortDate(row.nextTouchAt, now)}`, tone: "warning" };
  if (row.busyCount > 0) return { label: "Agent working", tone: "info" };
  if (row.state === "set_aside") return { label: row.muted ? "Muted" : "Deferred", tone: "neutral" };
  if (row.nextTouchAt && Date.parse(row.nextTouchAt) > now.getTime()) return { label: `Revisit ${formatShortDate(row.nextTouchAt, now)}`, tone: "neutral" };
  if (row.state === "gone_quiet") return { label: "Quiet", tone: "neutral" };
  if (row.waitingOn) return { label: "Waiting", tone: "neutral" };
  if (row.automationCount > 0) return { label: "Automated", tone: "neutral" };
  return null;
}

/** One line of context: the recorded next step or wait, never checklist items. */
export function contextLine(row: TaskOverviewRow): { text: string; empty: boolean } {
  if (row.staleWait && row.waitingOn) return { text: `Still waiting for ${lowerFirst(row.waitingOn)}?`, empty: false };
  if (row.nextAction) return { text: `${row.deferred ? "When resumed" : "Next"}: ${row.nextAction}`, empty: false };
  if (row.waitingOn) return { text: `Waiting for: ${row.waitingOn}`, empty: false };
  return { text: "No next step", empty: true };
}

function lowerFirst(value: string): string {
  const text = value.trim().replace(/[.?!]+$/, "");
  return text && /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

export type TaskOutcome = "finished" | "archive" | "keep" | "mute" | "set_aside";

export const KEEP_DAYS = 21;

/** The change an outcome makes, and the change that undoes it from the task's prior values. */
export function outcomePatches(row: TaskOverviewRow, outcome: TaskOutcome, now = Date.now()): { apply: TaskPatch; undo: TaskPatch } {
  const prior: TaskPatch = {
    status: "active", deferred: row.deferred,
    nextAction: row.nextAction ?? null, waitingOn: row.waitingOn ?? null, nextTouchAt: row.nextTouchAt ?? null,
  };
  switch (outcome) {
    case "finished": return { apply: { completionAction: "complete-and-archive" }, undo: prior };
    case "archive": return { apply: { status: "archived" }, undo: prior };
    case "keep": return { apply: { nextTouchAt: new Date(now + KEEP_DAYS * DAY_MS).toISOString() }, undo: { nextTouchAt: row.nextTouchAt ?? null } };
    case "mute": return { apply: { muted: true }, undo: { muted: false } };
    case "set_aside": return { apply: { deferred: true }, undo: { deferred: row.deferred } };
  }
}

/** Set aside until an optional revisit date; undo restores both the deferral and the prior date. */
export function setAsidePatches(row: TaskOverviewRow, revisitAt?: string): { apply: TaskPatch; undo: TaskPatch } {
  return {
    apply: { deferred: true, ...(revisitAt ? { nextTouchAt: revisitAt } : {}) },
    undo: { deferred: row.deferred, ...(revisitAt ? { nextTouchAt: row.nextTouchAt ?? null } : {}) },
  };
}

export const OUTCOME_DONE: Record<TaskOutcome, string> = {
  finished: "Marked complete",
  archive: "Archived",
  keep: `Kept; back in ${KEEP_DAYS / 7} weeks if still quiet`,
  mute: "Muted",
  set_aside: "Set aside",
};

/** Set-aside tasks that still need Tim (a question, a stall or a reached revisit), by id with the reason to show. */
export function setAsideAttention(rows: readonly TaskOverviewRow[] | undefined, setAsideIds: ReadonlySet<string>, now = new Date()): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.state !== "needs_you" || !setAsideIds.has(row.id)) continue;
    result.set(row.id, stateBadge(row, now)?.label ?? "Needs you");
  }
  return result;
}

/** "1 needs you" / "2 need you", for a collapsed section header. */
export function needsYouCount(count: number): string {
  return `${count} need${count === 1 ? "s" : ""} you`;
}
