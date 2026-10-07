export type RevisitState = "ready" | "today" | "upcoming" | null;

export function getRevisitState(value?: string, now = new Date()): RevisitState {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() > now.getTime()) return "upcoming";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return parsed.getTime() < start.getTime() ? "ready" : "today";
}

/** The revisit date has arrived: the task is asking to be looked at again. */
export function isRevisitDue(value?: string, now: Date | number = Date.now()): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= (typeof now === "number" ? now : now.getTime());
}

/** The morning a number of calendar days ahead, so a postponed task is waiting at the start of that day. */
export function revisitInDays(days: number, now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

/** A revisit moment as a person reads it: "Thu, Oct 8, 9:00 AM". */
export function formatRevisitMoment(value: string, now = new Date()): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    ...(parsed.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export function formatRevisit(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const date = parsed.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
  const state = getRevisitState(value);
  return state === "ready" ? `${date} · ready to revisit` : state === "today" ? `${date} · revisit today` : date;
}

export function toDateTimeInputValue(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function toDateTimeStorageValue(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Enter a valid revisit date and time.");
  return parsed.toISOString();
}
