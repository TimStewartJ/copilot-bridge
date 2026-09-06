export interface FocusNotificationPolicy {
  timezone: string;
  quietHours: { start: string; end: string } | null;
  reviewTimes: string[];
  coalesceMinutes: number;
  enableAuthorizedImmediate: boolean;
  allowGrantQuietHoursOverride: boolean;
}

export type FocusNotificationPolicyUpdate = {
  [K in keyof FocusNotificationPolicy]?: FocusNotificationPolicy[K] | null;
};

export const MAX_FOCUS_REVIEW_TIMES = 24;
export const MAX_FOCUS_COALESCE_MINUTES = 60;

export const DEFAULT_FOCUS_NOTIFICATION_POLICY: FocusNotificationPolicy = {
  timezone: "UTC",
  quietHours: { start: "22:00", end: "08:00" },
  reviewTimes: ["09:00", "17:00"],
  coalesceMinutes: 5,
  enableAuthorizedImmediate: false,
  allowGrantQuietHoursOverride: false,
};

export function isFocusClockTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function clockMinute(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

export interface FocusNotificationClock {
  nextReviewAt: number | null;
  quietHours: boolean;
  quietHoursEnd: number | null;
  protection: FocusProtectionWindow | null;
}

/**
 * Search real minutes, rather than adding 24 hours to a local date. A skipped
 * DST review occurs at the first clock minute after the gap; repeated clock
 * times use their earliest future occurrence. Quiet hours are start-inclusive
 * and end-exclusive, including when the interval crosses midnight.
 */
export function getFocusNotificationClock(
  policy: FocusNotificationPolicy,
  now = Date.now(),
  protection?: FocusProtectionWindow | null,
): FocusNotificationClock {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: policy.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const localMinute = (at: number): number => {
    const parts = formatter.formatToParts(at);
    const part = (name: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((entry) => entry.type === name)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute")) / 60_000;
  };
  const minuteOfDay = (minute: number): number => ((minute % 1440) + 1440) % 1440;
  const start = policy.quietHours ? clockMinute(policy.quietHours.start) : 0;
  const end = policy.quietHours ? clockMinute(policy.quietHours.end) : 0;
  const isQuiet = (minute: number): boolean => {
    if (!policy.quietHours) return false;
    const clock = minuteOfDay(minute);
    return start < end ? clock >= start && clock < end : clock >= start || clock < end;
  };
  const reviews = policy.reviewTimes.map(clockMinute).sort((a, b) => a - b);
  let previous = localMinute(now);
  const result: FocusNotificationClock = {
    nextReviewAt: null,
    quietHours: isQuiet(previous),
    quietHoursEnd: null,
    // Protection composes with the standing clock; it never moves a review or
    // quiet-hours boundary, including at sub-minute expiry/cancellation.
    protection: protection && !protection.cancelledAt
      && Date.parse(protection.startsAt) <= now && Date.parse(protection.endsAt) > now
      ? protection : null,
  };
  const firstMinute = Math.floor(now / 60_000) * 60_000 + 60_000;
  // Also bounds unusual IANA date-line changes; unresolved windows fail closed.
  for (let offset = 0; offset < 3 * 1440; offset++) {
    const at = firstMinute + offset * 60_000;
    const current = localMinute(at);
    if (result.nextReviewAt === null) {
      const previousClock = minuteOfDay(previous);
      const nextClock = reviews.find((review) => review > previousClock);
      const nextLocalReview = previous - previousClock
        + (nextClock ?? (1440 + (reviews[0] ?? Number.POSITIVE_INFINITY)));
      if (reviews.includes(minuteOfDay(current)) || (current > previous && nextLocalReview <= current)) {
        result.nextReviewAt = at;
      }
    }
    if (result.quietHours && result.quietHoursEnd === null && !isQuiet(current)) {
      result.quietHoursEnd = at;
    }
    if (result.nextReviewAt !== null && (!result.quietHours || result.quietHoursEnd !== null)) break;
    previous = current;
  }
  return result;
}
import type { FocusProtectionWindow } from "./focus-protection.js";
