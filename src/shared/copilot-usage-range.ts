/**
 * Time-window selection shared by the Copilot usage API and the usage panel.
 *
 * Windows are always anchored to "now" and only bounded at the start, so a
 * clock skew between the scan timestamps and the request can never hide the
 * most recent usage. Day boundaries use the server's local calendar day, which
 * is the same calendar the cached daily buckets are keyed by.
 */
export type CopilotUsageRangeKey = "7d" | "28d" | "mtd" | "ytd" | "all";

export const COPILOT_USAGE_RANGE_KEYS = ["7d", "28d", "mtd", "ytd", "all"] as const satisfies readonly CopilotUsageRangeKey[];

export const DEFAULT_COPILOT_USAGE_RANGE: CopilotUsageRangeKey = "all";

export const COPILOT_USAGE_RANGE_LABELS: Record<CopilotUsageRangeKey, string> = {
  "7d": "7 days",
  "28d": "28 days",
  mtd: "MTD",
  ytd: "YTD",
  all: "All time",
};

export const COPILOT_USAGE_RANGE_DESCRIPTIONS: Record<CopilotUsageRangeKey, string> = {
  "7d": "Past 7 days",
  "28d": "Past 28 days",
  mtd: "Month to date",
  ytd: "Year to date",
  all: "All local history",
};

export interface CopilotUsageRange {
  key: CopilotUsageRangeKey;
  label: string;
  /** Inclusive start instant, or null for the unbounded all-time window. */
  startAt: string | null;
  /** Inclusive start day key (YYYY-MM-DD, local calendar), or null for all time. */
  startDate: string | null;
}

export function isCopilotUsageRangeKey(value: unknown): value is CopilotUsageRangeKey {
  return typeof value === "string"
    && (COPILOT_USAGE_RANGE_KEYS as readonly string[]).includes(value);
}

export function normalizeCopilotUsageRangeKey(value: unknown): CopilotUsageRangeKey {
  return isCopilotUsageRangeKey(value) ? value : DEFAULT_COPILOT_USAGE_RANGE;
}

/** Local calendar day key (YYYY-MM-DD) for a Date or ISO timestamp. */
export function copilotUsageDayKey(value: Date | string | number): string | null {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Resolve a range key into the inclusive start of its window. `7d` and `28d`
 * count the current local day plus the preceding 6 / 27 days.
 */
export function resolveCopilotUsageRange(
  key: CopilotUsageRangeKey,
  nowMs: number = Date.now(),
): CopilotUsageRange {
  const label = COPILOT_USAGE_RANGE_LABELS[key];
  const start = resolveRangeStartDate(key, nowMs);
  if (!start) {
    return { key, label, startAt: null, startDate: null };
  }
  return {
    key,
    label,
    startAt: start.toISOString(),
    startDate: copilotUsageDayKey(start),
  };
}

function resolveRangeStartDate(key: CopilotUsageRangeKey, nowMs: number): Date | null {
  const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) return null;
  switch (key) {
    case "7d":
      return startOfLocalDayOffset(now, 6);
    case "28d":
      return startOfLocalDayOffset(now, 27);
    case "mtd":
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    case "ytd":
      return new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    case "all":
    default:
      return null;
  }
}

function startOfLocalDayOffset(now: Date, daysBack: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, 0, 0, 0, 0);
}
