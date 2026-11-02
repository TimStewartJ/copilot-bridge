// The calendar as one list: the Bridge's own events (repeats expanded) beside the dates the rest of
// the Bridge keeps. Read-only; each derived item changes where it lives (a checklist item, a task's
// revisit, a schedule). Windows are local dates in the viewer's zone, so "Tuesday" means the
// viewer's Tuesday, and everything is filtered here rather than left to the client.

import {
  addCalendarDays,
  CALENDAR_MAX_WINDOW_DAYS,
  daysBetween,
  isCalendarDate,
  isTimeZone,
  type CalendarEvent,
  type CalendarItem,
  type CalendarResponse,
} from "../shared/calendar.js";
import type { ChecklistItem } from "./checklist-store.js";
import { dateKeyOf } from "./calendar-store.js";
import { cronRunsOnLocalDay, wallTimeIn, wallTimeToInstant, type WallDate } from "./cron-next-run.js";
import type { Schedule } from "./schedule-store.js";

export class CalendarRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarRangeError";
  }
}

export interface CalendarSources {
  listEvents(options: { taskId?: string }): CalendarEvent[];
  listDeadlines(from: string, to: string, taskId?: string): Array<ChecklistItem & { taskTitle?: string }>;
  deadlineSummary(before: string, limit: number, taskId?: string): {
    overdue: Array<ChecklistItem & { taskTitle?: string }>; overdueTotal: number; undated: number;
  };
  listRevisits(): Array<{ id: string; title: string; nextTouchAt: string; deferred: boolean }>;
  listEnabledSchedules(): Schedule[];
  taskTitle(taskId: string): string | undefined;
  /** Helm's look times ("HH:MM", server-local) when its looks are on. */
  helmLookTimes(): string[];
  serverTimezone: string;
}

export interface CalendarQuery {
  from: string;
  to: string;
  timezone: string;
  taskId?: string;
  now?: Date;
}

/** Most occurrences one repeating event may add to a window; a daily year-long event fills about 430. */
const MAX_OCCURRENCES_PER_SERIES = 1000;
const MAX_EVENT_ITEMS = 1500;
/** Runs listed one by one per schedule per day; the rest only count. */
const RUNS_LISTED_PER_DAY = 3;
/** Runs resolved to instants per schedule-local day, enough to place every run of a quarter-hourly schedule exactly. */
const RUNS_RESOLVED_PER_DAY = 96;
const MAX_RUN_LOOKAHEAD_DAYS = 400;
const OVERDUE_LIMIT = 50;

function dateParts(key: string): WallDate {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

function localMidnight(key: string, timezone: string): number {
  return wallTimeToInstant({ ...dateParts(key), hour: 0, minute: 0 }, timezone).getTime();
}

function localDateOf(instant: number, timezone: string): string {
  return dateKeyOf(wallTimeIn(new Date(instant), timezone));
}

/** The nth start date of a repeat, counted from the first so months never drift; null when it does not exist (Feb 30). */
function nthDate(anchor: string, every: NonNullable<CalendarEvent["repeat"]>["every"], step: number, n: number): string | null {
  if (every === "day" || every === "week") return addCalendarDays(anchor, n * step * (every === "week" ? 7 : 1));
  const { year, month, day } = dateParts(anchor);
  const months = (every === "year" ? 12 : 1) * step * n;
  const total = (year * 12 + (month - 1)) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const candidate = new Date(Date.UTC(y, m - 1, day));
  if (candidate.getUTCMonth() !== m - 1) return null;
  return candidate.toISOString().slice(0, 10);
}

/** A first n so occurrences before it cannot reach the window, even when they last several days. */
function firstUsefulN(anchor: string, every: NonNullable<CalendarEvent["repeat"]>["every"], step: number, from: string, spanDays: number): number {
  const lead = daysBetween(anchor, from) - spanDays - 1;
  if (lead <= 0) return 0;
  if (every === "day") return Math.floor(lead / step);
  if (every === "week") return Math.floor(lead / (7 * step));
  const monthsPer = (every === "year" ? 12 : 1) * step;
  return Math.max(0, Math.floor(lead / 31 / monthsPer) - 1);
}

interface Window { from: string; to: string; startMs: number; endMs: number }

function expandEvent(event: CalendarEvent, window: Window, taskTitle: (id: string) => string | undefined): { items: CalendarItem[]; capped: boolean } {
  const base = {
    kind: "event" as const,
    title: event.title,
    allDay: event.allDay,
    eventId: event.id,
    ...(event.externalId ? { externalId: event.externalId } : {}),
    ...(event.taskId ? { taskId: event.taskId, taskTitle: taskTitle(event.taskId) } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.repeat ? { repeating: true } : {}),
  };
  const anchorDate = event.allDay ? event.start : localDateOf(Date.parse(event.start), event.timezone);
  const anchorWall = event.allDay ? null : wallTimeIn(new Date(event.start), event.timezone);
  // Seconds survive repeats; the wall clock carries hours and minutes.
  const anchorSubMinuteMs = event.allDay ? 0 : Date.parse(event.start) % 60_000;
  // A timed event's repeats fall on dates of its own zone, which may differ from the viewer's.
  const bounds = event.allDay
    ? { from: window.from, to: window.to }
    : { from: localDateOf(window.startMs, event.timezone), to: localDateOf(window.endMs, event.timezone) };
  const durationMs = Date.parse(event.end) - Date.parse(event.start);
  const spanDays = event.allDay ? daysBetween(event.start, event.end) : Math.ceil(durationMs / 86_400_000);

  const occurrence = (n: number, date: string): CalendarItem | null => {
    const id = event.repeat ? `event:${event.id}:${n}` : `event:${event.id}`;
    if (event.allDay) {
      const end = addCalendarDays(date, spanDays);
      if (date > window.to || end < window.from) return null;
      return { ...base, id, start: date, end };
    }
    const startMs = n === 0 ? Date.parse(event.start) : wallTimeToInstant({ ...dateParts(date), hour: anchorWall!.hour, minute: anchorWall!.minute }, event.timezone).getTime() + anchorSubMinuteMs;
    const endMs = startMs + durationMs;
    if (startMs >= window.endMs || endMs <= window.startMs) return null;
    return { ...base, id, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
  };

  if (!event.repeat) {
    const item = occurrence(0, anchorDate);
    return { items: item ? [item] : [], capped: false };
  }
  const { every, interval, until } = event.repeat;
  const items: CalendarItem[] = [];
  for (let n = firstUsefulN(anchorDate, every, interval, bounds.from, spanDays), steps = 0; ; n += 1, steps += 1) {
    if (steps >= MAX_OCCURRENCES_PER_SERIES) return { items, capped: true };
    const date = nthDate(anchorDate, every, interval, n);
    if (date === null) continue;
    if (until && date > until) break;
    if (date > bounds.to) break;
    const item = occurrence(n, date);
    if (item) items.push(item);
  }
  return { items, capped: false };
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

interface RunPlan { id: string; title: string; taskId?: string; scheduleId?: string; cron?: string; runAt?: string; timezone?: string; remaining?: number; expiresAtMs?: number }

/**
 * Upcoming runs: forecasts from now, never history. A schedule with a run limit stops once the
 * runs from now on (including those before the window) have used it up.
 */
function forecastRuns(plans: RunPlan[], window: Window, viewerZone: string, nowMs: number): { items: CalendarItem[]; counts: Record<string, number> } {
  const items: CalendarItem[] = [];
  const counts: Record<string, number> = {};
  const fromMs = Math.max(nowMs, window.startMs);
  for (const plan of plans) {
    const base = { kind: "run" as const, title: plan.title, allDay: false, ...(plan.taskId ? { taskId: plan.taskId } : {}), ...(plan.scheduleId ? { scheduleId: plan.scheduleId } : {}) };
    const beforeExpiry = (at: number) => plan.expiresAtMs === undefined || at < plan.expiresAtMs;
    if (plan.runAt) {
      const at = Date.parse(plan.runAt);
      if (at >= fromMs && at < window.endMs && beforeExpiry(at) && (plan.remaining === undefined || plan.remaining > 0)) {
        const day = localDateOf(at, viewerZone);
        counts[day] = (counts[day] ?? 0) + 1;
        items.push({ ...base, id: `run:${plan.id}:${new Date(at).toISOString()}`, start: new Date(at).toISOString() });
      }
      continue;
    }
    if (!plan.cron) continue;
    const zone = plan.timezone ?? viewerZone;
    let remaining = plan.remaining ?? Infinity;
    const limited = Number.isFinite(remaining);
    // A run limit is spent from now on, so a limited schedule is walked from today; others start at the window.
    const firstDay = localDateOf(limited ? nowMs : Math.max(nowMs, window.startMs - 86_400_000), zone);
    const lastDay = addCalendarDays(localDateOf(window.endMs, zone), 1);
    const days = Math.min(MAX_RUN_LOOKAHEAD_DAYS, daysBetween(firstDay, lastDay));
    const before = plan.expiresAtMs === undefined ? undefined : plan.expiresAtMs;
    // Viewer days and schedule days can differ, so the listing limit is kept per viewer day across the walk.
    const listedPerDay = new Map<string, number>();
    for (let offset = 0; offset <= days && remaining > 0; offset += 1) {
      const day = addCalendarDays(firstDay, offset);
      const runs = cronRunsOnLocalDay(plan.cron, zone, dateParts(day), RUNS_RESOLVED_PER_DAY, { afterMs: nowMs - 1, ...(before !== undefined ? { beforeMs: before } : {}) });
      if (!runs || runs.count === 0) continue;
      const dayCount = Math.min(remaining, runs.count);
      remaining -= dayCount;
      const resolved = runs.times.slice(0, dayCount).map(Date.parse);
      if (resolved.length === dayCount) {
        // Every run of the day is known: count and list each in the viewer's day.
        for (const at of resolved) {
          if (at < window.startMs || at >= window.endMs) continue;
          const viewerDay = localDateOf(at, viewerZone);
          counts[viewerDay] = (counts[viewerDay] ?? 0) + 1;
          const listed = listedPerDay.get(viewerDay) ?? 0;
          if (listed < RUNS_LISTED_PER_DAY) {
            listedPerDay.set(viewerDay, listed + 1);
            items.push({ ...base, id: `run:${plan.id}:${new Date(at).toISOString()}`, start: new Date(at).toISOString() });
          }
        }
        continue;
      }
      // A very busy day (more runs than are resolved): list the first, count the day under its first run's date.
      const inWindow = resolved.filter((at) => at >= window.startMs && at < window.endMs);
      if (inWindow.length === 0) continue;
      const viewerDay = localDateOf(inWindow[0], viewerZone);
      counts[viewerDay] = (counts[viewerDay] ?? 0) + dayCount - (resolved.length - inWindow.length);
      for (const at of inWindow.slice(0, RUNS_LISTED_PER_DAY)) items.push({ ...base, id: `run:${plan.id}:${new Date(at).toISOString()}`, start: new Date(at).toISOString() });
    }
  }
  return { items, counts };
}

export function buildCalendar(sources: CalendarSources, query: CalendarQuery): CalendarResponse {
  const { from, to, timezone, taskId } = query;
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new CalendarRangeError("from and to must be dates (YYYY-MM-DD)");
  if (to < from) throw new CalendarRangeError("to must not be before from");
  if (daysBetween(from, to) >= CALENDAR_MAX_WINDOW_DAYS) throw new CalendarRangeError(`A calendar window can span at most ${CALENDAR_MAX_WINDOW_DAYS} days`);
  if (!isTimeZone(timezone)) throw new CalendarRangeError("timezone must be an IANA time zone");
  const nowMs = (query.now ?? new Date()).getTime();
  const window: Window = { from, to, startMs: localMidnight(from, timezone), endMs: localMidnight(addCalendarDays(to, 1), timezone) };
  const today = localDateOf(nowMs, timezone);
  const titleOf = (id: string) => sources.taskTitle(id);

  let events: CalendarItem[] = [];
  let seriesCapped = false;
  for (const event of sources.listEvents(taskId ? { taskId } : {})) {
    const expanded = expandEvent(event, window, titleOf);
    events.push(...expanded.items);
    seriesCapped ||= expanded.capped;
  }
  const eventsTruncated = seriesCapped || events.length > MAX_EVENT_ITEMS;
  if (eventsTruncated) events = events.sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX_EVENT_ITEMS);

  const deadlineItem = (item: ChecklistItem & { taskTitle?: string }): CalendarItem => ({
    id: `deadline:${item.id}`,
    kind: "deadline",
    title: item.text,
    allDay: true,
    start: item.deadline!,
    checklistItemId: item.id,
    ...(item.taskId ? { taskId: item.taskId } : {}),
    ...(item.taskTitle ? { taskTitle: item.taskTitle } : {}),
    ...(item.done ? { done: true } : {}),
  });
  const deadlines = sources.listDeadlines(from, to, taskId).map(deadlineItem);

  const revisitItem = (task: { id: string; title: string; nextTouchAt: string; deferred: boolean }): CalendarItem => ({
    id: `revisit:${task.id}`,
    kind: "revisit",
    title: task.title,
    allDay: false,
    start: new Date(Date.parse(task.nextTouchAt)).toISOString(),
    taskId: task.id,
    taskTitle: task.title,
    ...(task.deferred ? { deferred: true } : {}),
  });
  const allRevisits = sources.listRevisits().filter((task) => !taskId || task.id === taskId);
  const revisits = allRevisits
    .filter((task) => { const at = Date.parse(task.nextTouchAt); return at >= window.startMs && at < window.endMs; })
    .map(revisitItem);

  const plans: RunPlan[] = sources.listEnabledSchedules()
    .filter((schedule) => !taskId || schedule.taskId === taskId)
    .map((schedule) => ({
      id: schedule.id,
      title: schedule.name,
      taskId: schedule.taskId,
      scheduleId: schedule.id,
      ...(schedule.type === "once" ? { runAt: schedule.runAt } : { cron: schedule.cron, timezone: schedule.timezone }),
      ...(schedule.maxRuns ? { remaining: Math.max(0, schedule.maxRuns - schedule.runCount) } : {}),
      ...(schedule.expiresAt && Number.isFinite(Date.parse(schedule.expiresAt)) ? { expiresAtMs: Date.parse(schedule.expiresAt) } : {}),
    }));
  if (!taskId) {
    for (const time of sources.helmLookTimes()) {
      const clock = parseClock(time);
      if (clock) plans.push({ id: `helm-${time}`, title: "Helm's look", cron: `${clock.minute} ${clock.hour} * * *`, timezone: sources.serverTimezone });
    }
  }
  const runs = forecastRuns(plans, window, timezone, nowMs);

  const summary = sources.deadlineSummary(today, OVERDUE_LIMIT, taskId);
  const dueRevisits = allRevisits.filter((task) => Date.parse(task.nextTouchAt) <= nowMs);
  const overdue = [...summary.overdue.map(deadlineItem), ...dueRevisits.map(revisitItem)]
    .sort((a, b) => (a.allDay ? localMidnight(a.start, timezone) : Date.parse(a.start)) - (b.allDay ? localMidnight(b.start, timezone) : Date.parse(b.start)))
    .slice(0, OVERDUE_LIMIT);

  // A date and an instant compare by the moment the viewer's day starts, all-day first.
  const at = (item: CalendarItem) => item.allDay ? localMidnight(item.start, timezone) - 1 : Date.parse(item.start);
  const items = [...events, ...deadlines, ...revisits, ...runs.items]
    .sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
  return {
    from,
    to,
    timezone,
    today,
    items,
    runCounts: runs.counts,
    overdue,
    overdueTotal: summary.overdueTotal + dueRevisits.length,
    undatedChecklistCount: summary.undated,
    eventsTruncated,
  };
}
