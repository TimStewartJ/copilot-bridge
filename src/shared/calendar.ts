// The Bridge's calendar: events the Bridge owns, and a read-only view that lays them beside the
// dates the rest of the Bridge already keeps (checklist deadlines, task revisits, scheduled agent
// runs and Helm's looks). Shared by the server and the client.

export type CalendarRepeatEvery = "day" | "week" | "month" | "year";

export interface CalendarRepeat {
  every: CalendarRepeatEvery;
  /** Every how many days, weeks, months or years. */
  interval: number;
  /** Last local date (YYYY-MM-DD, in the event's zone) an occurrence may start on. */
  until?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  allDay: boolean;
  /** All-day: the first date (YYYY-MM-DD). Timed: an ISO instant in UTC. */
  start: string;
  /** All-day: the last date, inclusive. Timed: an ISO instant in UTC, after start. */
  end: string;
  /** IANA zone the event was made in; repeats keep its wall-clock time there. */
  timezone: string;
  repeat?: CalendarRepeat;
  location?: string;
  notes?: string;
  taskId?: string;
  /**
   * The event's ID in a calendar it was imported from. Opaque to the Bridge and unique: saving an
   * event with an externalId that already exists updates that event instead of adding another.
   */
  externalId?: string;
  createdBy: "user" | "agent";
  createdAt: string;
  updatedAt: string;
}

export type CalendarItemKind = "event" | "deadline" | "revisit" | "run";

/** One thing on the calendar. Derived items are read-only here and change where they live. */
export interface CalendarItem {
  /** Stable for the occurrence: "event:<id>" or "event:<id>:<n>" for the nth repeat, "deadline:<id>", … */
  id: string;
  kind: CalendarItemKind;
  title: string;
  allDay: boolean;
  /** All-day: YYYY-MM-DD. Otherwise an ISO instant. */
  start: string;
  /** All-day events: last date, inclusive. Timed events: ISO instant. Absent for moments. */
  end?: string;
  taskId?: string;
  taskTitle?: string;
  eventId?: string;
  /** An imported event's ID in its source calendar. */
  externalId?: string;
  checklistItemId?: string;
  scheduleId?: string;
  location?: string;
  repeating?: boolean;
  /** A checklist item already ticked off. */
  done?: boolean;
  /** A revisit on a task that is set aside. */
  deferred?: boolean;
}

export interface CalendarResponse {
  /** First and last local dates of the window, inclusive. */
  from: string;
  to: string;
  timezone: string;
  /** Today's date in `timezone`. */
  today: string;
  items: CalendarItem[];
  /** Agent runs per local date, including those not listed one by one. */
  runCounts: Record<string, number>;
  /** Open deadlines before today and revisits that have arrived, oldest first. */
  overdue: CalendarItem[];
  overdueTotal: number;
  /** Open checklist items without a deadline. */
  undatedChecklistCount: number;
  /** True when the window held more events than one answer carries; the list is then incomplete. */
  eventsTruncated: boolean;
}

export const CALENDAR_MAX_WINDOW_DAYS = 62;
export const CALENDAR_MAX_TITLE = 200;
export const CALENDAR_MAX_LOCATION = 300;
export const CALENDAR_MAX_NOTES = 4000;
export const CALENDAR_MAX_EXTERNAL_ID = 512;
/** Most events one call may save or delete. */
export const CALENDAR_MAX_BATCH = 500;
export const CALENDAR_MAX_TIMED_SPAN_MS = 14 * 86_400_000;
export const CALENDAR_MAX_ALL_DAY_SPAN_DAYS = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** An ISO instant that names its offset, so it means the same moment everywhere. */
export function isCalendarInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT_RE.test(value) || !Number.isFinite(Date.parse(value))) return false;
  // Date.parse rolls impossible dates and times over (Feb 30 becomes Mar 2); refuse them instead.
  const [hour, minute] = value.slice(11, 16).split(":").map(Number);
  return isCalendarDate(value.slice(0, 10)) && hour < 24 && minute < 60;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Whole days from one YYYY-MM-DD to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addCalendarDays(date: string, days: number): string {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return next.toISOString().slice(0, 10);
}
