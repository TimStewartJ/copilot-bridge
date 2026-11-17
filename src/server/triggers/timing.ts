// When triggers run: parsing timing input, the minimum gaps, and the next occurrence.

import { computeNextRunAt, createCronPreviewIterator, validateSupportedCronExpression } from "../cron-next-run.js";
import type { TriggerLane, TriggerWhen } from "./types.js";

/** Shortest gap between occurrences when a check decides whether each one fires. */
export const TRIGGER_MIN_CHECKED_INTERVAL_SECONDS = 30;
/** Shortest gap when every occurrence fires: each one may run a model. */
export const TRIGGER_MIN_UNCHECKED_INTERVAL_SECONDS = 5 * 60;
export const TRIGGER_MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;
export const TRIGGER_MAX_AT_HORIZON_SECONDS = 365 * 24 * 60 * 60;
/** Recurring chat triggers stop after this unless they set maxRuns or expiresAt. */
export const TRIGGER_DEFAULT_CHAT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
/** A task trigger's at/cron slot missed by more than this (Bridge down) is skipped, not run. */
export const TRIGGER_MISSED_RUN_GRACE_MS = 60 * 60 * 1000;
/** Cron slots, window and probe budget used to find the shortest gap of an expression. */
const CRON_GAP_SAMPLE = 60;
const CRON_GAP_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
const CRON_GAP_PROBES = 20_000;

export function minimumIntervalSeconds(hasCheck: boolean): number {
  return hasCheck ? TRIGGER_MIN_CHECKED_INTERVAL_SECONDS : TRIGGER_MIN_UNCHECKED_INTERVAL_SECONDS;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function getServerTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Timing input: exactly one of delaySeconds, runAt, intervalSeconds or cron. */
export interface TriggerWhenInput {
  delaySeconds?: unknown;
  runAt?: unknown;
  intervalSeconds?: unknown;
  cron?: unknown;
  timezone?: unknown;
}

export function hasTriggerWhenInput(input: TriggerWhenInput): boolean {
  return input.delaySeconds !== undefined || input.runAt !== undefined
    || input.intervalSeconds !== undefined || input.cron !== undefined;
}

/** Shortest gap in seconds between a cron expression's slots over the next eight days. */
export function shortestCronGapSeconds(cron: string, timezone: string, now = new Date()): number | undefined {
  let probes = 0;
  const preview = createCronPreviewIterator(cron, timezone, now.getTime() + 1, now.getTime() + CRON_GAP_WINDOW_MS, () => ++probes <= CRON_GAP_PROBES);
  let previous: number | undefined;
  let shortest = Number.POSITIVE_INFINITY;
  for (let slots = 0; slots < CRON_GAP_SAMPLE; slots += 1) {
    const step = preview.next();
    if (step.done) break;
    const at = Date.parse(step.at);
    if (previous !== undefined) shortest = Math.min(shortest, (at - previous) / 1000);
    previous = at;
  }
  if (previous === undefined) return computeNextRunAt(cron, timezone, now) ? Number.POSITIVE_INFINITY : undefined;
  return Number.isFinite(shortest) ? shortest : Number.POSITIVE_INFINITY;
}

export function parseTriggerWhen(
  input: TriggerWhenInput,
  options: { hasCheck: boolean; now?: Date },
): { when: TriggerWhen } | { error: string } {
  const now = options.now ?? new Date();
  const given = (["delaySeconds", "runAt", "intervalSeconds", "cron"] as const).filter((key) => input[key] !== undefined);
  if (given.length !== 1) return { error: "Give exactly one timing: delaySeconds, runAt, intervalSeconds or cron." };
  if (input.timezone !== undefined && input.cron === undefined) return { error: "timezone applies only to cron." };
  const floor = minimumIntervalSeconds(options.hasCheck);

  if (input.delaySeconds !== undefined || input.runAt !== undefined) {
    if (options.hasCheck) {
      return { error: "A one-time trigger cannot have a check. Use intervalSeconds or cron with the check, and maxRuns: 1 if it should fire once." };
    }
    let at: number;
    if (input.delaySeconds !== undefined) {
      const delay = Number(input.delaySeconds);
      if (typeof input.delaySeconds !== "number" || !Number.isFinite(delay) || delay < 0) {
        return { error: "delaySeconds must be a number of seconds, 0 or more." };
      }
      at = now.getTime() + delay * 1000;
    } else {
      at = Date.parse(String(input.runAt));
      if (!Number.isFinite(at)) return { error: `runAt is not a valid date: ${String(input.runAt)}` };
      if (at <= now.getTime()) return { error: "runAt must be in the future." };
    }
    if (at - now.getTime() > TRIGGER_MAX_AT_HORIZON_SECONDS * 1000) return { error: "A one-time trigger can be at most a year away." };
    return { when: { kind: "at", at: new Date(at).toISOString() } };
  }

  if (input.intervalSeconds !== undefined) {
    const seconds = Number(input.intervalSeconds);
    if (typeof input.intervalSeconds !== "number" || !Number.isInteger(seconds)) {
      return { error: "intervalSeconds must be a whole number of seconds." };
    }
    if (seconds < floor) {
      return {
        error: options.hasCheck
          ? `intervalSeconds must be at least ${floor} with a check.`
          : `intervalSeconds must be at least ${floor} without a check, since every occurrence fires. Add a check to run more often.`,
      };
    }
    if (seconds > TRIGGER_MAX_INTERVAL_SECONDS) return { error: `intervalSeconds can be at most ${TRIGGER_MAX_INTERVAL_SECONDS} (30 days).` };
    return { when: { kind: "every", seconds } };
  }

  const cron = typeof input.cron === "string" ? input.cron.trim() : "";
  if (!cron) return { error: "cron must be a cron expression such as \"0 8 * * 1-5\"." };
  const supported = validateSupportedCronExpression(cron);
  if (!supported.ok) return { error: supported.error };
  const timezone = input.timezone === undefined ? getServerTimezone() : String(input.timezone);
  if (!isValidTimezone(timezone)) return { error: `Unknown timezone: ${timezone}` };
  const gap = shortestCronGapSeconds(cron, timezone, now);
  if (gap === undefined) return { error: "This cron expression never runs." };
  if (gap < floor) {
    return {
      error: options.hasCheck
        ? `This cron runs ${gap} seconds apart; with a check the minimum is ${floor}.`
        : `This cron runs ${gap} seconds apart; without a check the minimum is ${floor}. Add a check to run more often.`,
    };
  }
  return { when: { kind: "cron", cron, timezone } };
}

/** When a new trigger first runs. */
export function firstRunAt(when: TriggerWhen, now = new Date()): string | undefined {
  switch (when.kind) {
    case "at": return when.at;
    case "every": return new Date(now.getTime() + when.seconds * 1000).toISOString();
    case "cron": return computeNextRunAt(when.cron, when.timezone, now);
  }
}

/** The occurrence after one that settled at `settledAt`, or undefined when there is none. */
export function nextRunAfter(when: TriggerWhen, settledAt: Date, scheduledFor?: string): string | undefined {
  switch (when.kind) {
    case "at": return undefined;
    case "every": return new Date(settledAt.getTime() + when.seconds * 1000).toISOString();
    case "cron": {
      // Never before the slot just served, so a quick run cannot hit the same minute again.
      const after = scheduledFor ? Math.max(settledAt.getTime(), Date.parse(scheduledFor)) : settledAt.getTime();
      return computeNextRunAt(when.cron, when.timezone, new Date(after));
    }
  }
}

/** Whether a due task-lane at/cron slot was missed while the Bridge was down. */
export function isMissedOccurrence(when: TriggerWhen, lane: TriggerLane, nextRunAt: string, now = new Date()): boolean {
  if (lane !== "task" || when.kind === "every") return false;
  return now.getTime() - Date.parse(nextRunAt) > TRIGGER_MISSED_RUN_GRACE_MS;
}

/** A short description such as "every 15 min" or "cron 0 8 * * 1-5 (America/Los_Angeles)". */
export function describeTriggerWhen(when: TriggerWhen): string {
  switch (when.kind) {
    case "at": return `at ${when.at}`;
    case "every": {
      const s = when.seconds;
      if (s % 86_400 === 0) return `every ${s / 86_400} d`;
      if (s % 3600 === 0) return `every ${s / 3600} h`;
      if (s % 60 === 0) return `every ${s / 60} min`;
      return `every ${s} s`;
    }
    case "cron": return `cron ${when.cron} (${when.timezone})`;
  }
}
