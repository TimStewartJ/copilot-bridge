/** How a task stands right now, derived from existing task, session and schedule facts. Never stored. */
export type TaskState = "needs_you" | "in_motion" | "waiting" | "up_next" | "no_next_step" | "gone_quiet" | "set_aside";
export type TaskNeedsYouReason = "question" | "stalled" | "revisit";

export const IN_MOTION_DAYS = 7;
export const STALE_WAIT_DAYS = 21;
export const QUIET_DAYS = 30;
const DAY_MS = 86_400_000;

export interface TaskStateInput {
  muted: boolean;
  deferred: boolean;
  nextAction?: string;
  waitingOn?: string;
  nextTouchAt?: string;
  /** When Tim last opened the task, edited it or wrote in one of its conversations. */
  lastEngagedAt?: string;
  /** When the current waiting-for text was last set, when known. */
  waitingSince?: string;
  busyCount: number;
  stalledCount: number;
  inputCount: number;
  /** Enabled schedules plus active session defers: automation still working on the task. */
  automationCount: number;
  /** Linked conversation status could not be read, so the task may be working or waiting on Tim. */
  sessionSignalsUnknown?: boolean;
}

export interface DerivedTaskState {
  state: TaskState;
  reasons: TaskNeedsYouReason[];
  /** Waiting for something without Tim opening the task in a while. */
  staleWait: boolean;
  /** Whole days since the last engagement, or null when unknown. */
  idleDays: number | null;
}

function time(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function deriveTaskState(input: TaskStateInput, now: number = Date.now()): DerivedTaskState {
  const engaged = time(input.lastEngagedAt);
  const idleDays = engaged === undefined ? null : Math.max(0, Math.floor((now - engaged) / DAY_MS));
  const revisit = time(input.nextTouchAt);
  const futureRevisit = revisit !== undefined && revisit > now;
  const hasWait = !!input.waitingOn?.trim();
  const waitStarted = time(input.waitingSince) ?? engaged;
  // A planned revisit already answers "still waiting?", so it suppresses the prompt.
  const staleWait = hasWait && !futureRevisit && idleDays !== null && idleDays >= STALE_WAIT_DAYS
    && waitStarted !== undefined && now - waitStarted >= STALE_WAIT_DAYS * DAY_MS;
  const result = (state: TaskState, reasons: TaskNeedsYouReason[] = []): DerivedTaskState => ({ state, reasons, idleDays, staleWait });

  if (input.muted) return result("set_aside");
  const reasons: TaskNeedsYouReason[] = [];
  if (input.inputCount > 0) reasons.push("question");
  if (input.stalledCount > 0) reasons.push("stalled");
  if (revisit !== undefined && revisit <= now) reasons.push("revisit");
  if (reasons.length) return result("needs_you", reasons);
  if (input.deferred) return result("set_aside");
  if (input.busyCount > 0 || (idleDays !== null && idleDays < IN_MOTION_DAYS)) return result("in_motion");
  // Never offer to close a task whose conversations might be working or asking something.
  if ((idleDays === null || idleDays >= QUIET_DAYS) && !futureRevisit && input.automationCount === 0 && !input.sessionSignalsUnknown) return result("gone_quiet");
  // Waiting on someone else, or on a revisit date Tim chose.
  if (hasWait || futureRevisit) return result("waiting");
  if (input.nextAction?.trim()) return result("up_next");
  return result("no_next_step");
}

export const TASK_STATE_ORDER: TaskState[] = ["needs_you", "in_motion", "waiting", "up_next", "no_next_step", "gone_quiet", "set_aside"];

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  needs_you: "Needs you",
  in_motion: "In motion",
  waiting: "Waiting",
  up_next: "Up next",
  no_next_step: "No next step",
  gone_quiet: "Gone quiet",
  set_aside: "Set aside",
};

/** The latest of several optional ISO timestamps. */
export function latestTime(...values: Array<string | undefined | null>): string | undefined {
  let best: number | undefined;
  for (const value of values) {
    const parsed = time(value ?? undefined);
    if (parsed !== undefined && (best === undefined || parsed > best)) best = parsed;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}
