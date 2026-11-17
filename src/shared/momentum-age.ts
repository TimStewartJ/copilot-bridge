// When a task's next step or waiting-for was last set, and by whom, for Helm to judge staleness.
export interface MomentumFieldStamp {
  at: string;
  source: "agent" | "user" | "system";
  sessionId?: string;
  scheduleId?: string;
  scheduleName?: string;
}

/** A next step on the user older than this is shown as unverified until checked live. */
export const NEXT_STEP_UNVERIFIED_AFTER_DAYS = 3;

/** How Helm should treat a next step marked unverified, shown wherever the mark appears. */
export const NEXT_STEP_UNVERIFIED_NOTE = `nextActionUnverified means the next step was set over ${NEXT_STEP_UNVERIFIED_AFTER_DAYS} days ago or at an unknown time, so it may already be done or replaced. Check it live (the conversation that set it, the task's history, its linked pull requests or work items) before presenting it as the user's; if you cannot, say it is unverified. It still counts as on the user.`;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** "5d ago", "3h ago" or "just now"; whole units, rounded down. */
export function momentumAgeText(at: string, now: number): string | undefined {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return undefined;
  const elapsed = Math.max(0, now - time);
  if (elapsed >= DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  if (elapsed >= HOUR_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  return "just now";
}

export function momentumSetByText(stamp: MomentumFieldStamp, options: { sessions?: boolean } = {}): string {
  const sessions = options.sessions ?? true;
  if (stamp.source === "user") return "the user";
  if (stamp.source === "system") return "Bridge";
  const session = sessions && stamp.sessionId ? `session ${stamp.sessionId}` : undefined;
  if (stamp.scheduleName) return `schedule "${stamp.scheduleName}"${session ? ` (${session})` : ""}`;
  return session ?? "an agent";
}

/** "set 5d ago by session X"; null means no audit record (set before the audit, or pruned). */
export function describeMomentumStamp(stamp: MomentumFieldStamp | null, now: number, options: { sessions?: boolean; setter?: boolean } = {}): string {
  const age = stamp ? momentumAgeText(stamp.at, now) : undefined;
  if (!stamp || !age) return "set at an unknown time";
  return options.setter === false ? `set ${age}` : `set ${age} by ${momentumSetByText(stamp, options)}`;
}

/** Older than the limit or of unknown age; undefined (an older Bridge sent none) is not. */
export function nextStepUnverified(stamp: MomentumFieldStamp | null | undefined, now: number): boolean {
  if (stamp === undefined) return false;
  const time = stamp ? Date.parse(stamp.at) : NaN;
  if (!Number.isFinite(time)) return true;
  return now - time > NEXT_STEP_UNVERIFIED_AFTER_DAYS * DAY_MS;
}

export interface MomentumAgeSource {
  nextAction?: string;
  waitingOn?: string;
  nextActionSet?: MomentumFieldStamp | null;
  waitingOnSet?: MomentumFieldStamp | null;
}

export interface MomentumAgeFields {
  nextActionSet?: string;
  waitingOnSet?: string;
  /** Only for a task on the user: its next step is old or of unknown age. */
  nextActionUnverified?: true;
}

/** Age text for each field the task has; `onYou` adds the unverified mark on an old next step. */
export function momentumAgeFields(task: MomentumAgeSource, now: number, options: { onYou?: boolean } = {}): MomentumAgeFields {
  const hasStep = !!task.nextAction?.trim() && task.nextActionSet !== undefined;
  const hasWait = !!task.waitingOn?.trim() && task.waitingOnSet !== undefined;
  return {
    ...(hasStep ? { nextActionSet: describeMomentumStamp(task.nextActionSet!, now) } : {}),
    ...(hasWait ? { waitingOnSet: describeMomentumStamp(task.waitingOnSet!, now) } : {}),
    ...(hasStep && options.onYou && nextStepUnverified(task.nextActionSet, now) ? { nextActionUnverified: true as const } : {}),
  };
}
