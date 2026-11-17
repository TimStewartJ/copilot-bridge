// Read-only merged calendar; windows are local dates in the viewer's zone, filtered here.

import {
  addCalendarDays,
  CALENDAR_MAX_WINDOW_DAYS,
  compareSources,
  daysBetween,
  defaultSourceColor,
  DEFAULT_OWN_COLOR,
  isCalendarDate,
  isTimeZone,
  sourceOf,
  type CalendarColor,
  type CalendarEvent,
  type CalendarItem,
  type CalendarResponse,
} from "../shared/calendar.js";
import type { ChecklistItem } from "./checklist-store.js";
import { dateKeyOf } from "./calendar-store.js";
import { cronRunsOnLocalDay, wallTimeIn, wallTimeToInstant, type WallDate } from "./cron-next-run.js";
import type { Trigger } from "./triggers/types.js";

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
  /** Active triggers; the calendar shows the one-time and cron ones. */
  listActiveTriggers(): Trigger[];
  taskTitle(taskId: string): string | undefined;
  /** Helm's look times ("HH:MM", server-local) when its looks are on. */
  helmLookTimes(): string[];
  /** Event colours the person chose; anything absent takes its default. */
  chosenColors?(): { own?: CalendarColor; sources: Record<string, CalendarColor> };
  serverTimezone: string;
}

export interface CalendarQuery {
  from: string;
  to: string;
  timezone: string;
  taskId?: string;
  now?: Date;
}

/** Most occurrences one repeating event may add to a window; a daily year-long one fills ~430. */
const MAX_OCCURRENCES_PER_SERIES = 1000;
const MAX_EVENT_ITEMS = 1500;
/** Runs listed one by one per schedule per day; the rest only count. */
const RUNS_LISTED_PER_DAY = 3;
/** Runs resolved per schedule-local day: enough for a quarter-hourly schedule. */
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

/** The nth repeat date, counted from the first so months never drift; null if none (Feb 30). */
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
    ...(event.source ? { source: event.source } : {}),
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

interface RunPlan { id: string; title: string; taskId?: string; triggerId?: string; cron?: string; runAt?: string; timezone?: string; remaining?: number; expiresAtMs?: number }

/** Forecast runs from now; a run limit also counts runs from now that fall before the window. */
function forecastRuns(plans: RunPlan[], window: Window, viewerZone: string, nowMs: number): { items: CalendarItem[]; counts: Record<string, number> } {
  const items: CalendarItem[] = [];
  const counts: Record<string, number> = {};
  const fromMs = Math.max(nowMs, window.startMs);
  for (const plan of plans) {
    const base = { kind: "run" as const, title: plan.title, allDay: false, ...(plan.taskId ? { taskId: plan.taskId } : {}), ...(plan.triggerId ? { triggerId: plan.triggerId } : {}) };
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
    // A run limit is spent from now on, so a limited schedule is walked from today.
    const firstDay = localDateOf(limited ? nowMs : Math.max(nowMs, window.startMs - 86_400_000), zone);
    const lastDay = addCalendarDays(localDateOf(window.endMs, zone), 1);
    const days = Math.min(MAX_RUN_LOOKAHEAD_DAYS, daysBetween(firstDay, lastDay));
    const before = plan.expiresAtMs === undefined ? undefined : plan.expiresAtMs;
    // Viewer and schedule days can differ, so the listing limit is kept per viewer day.
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
      // A busy day (more runs than resolved): list the first, count the day under its date.
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
  const importedSources = new Set<string>();
  for (const event of sources.listEvents(taskId ? { taskId } : {})) {
    if (event.externalId) importedSources.add(sourceOf(event));
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

  const plans: RunPlan[] = sources.listActiveTriggers()
    .filter((trigger) => trigger.when.kind !== "every" && (!taskId || trigger.taskId === taskId))
    .map((trigger) => ({
      id: trigger.id,
      title: trigger.name ?? (trigger.action.kind === "new_task" ? trigger.action.title : "Trigger"),
      ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
      triggerId: trigger.id,
      ...(trigger.when.kind === "at" ? { runAt: trigger.when.at } : trigger.when.kind === "cron" ? { cron: trigger.when.cron, timezone: trigger.when.timezone } : {}),
      ...(trigger.maxRuns ? { remaining: Math.max(0, trigger.maxRuns - trigger.runCount) } : {}),
      ...(trigger.expiresAt && Number.isFinite(Date.parse(trigger.expiresAt)) ? { expiresAtMs: Date.parse(trigger.expiresAt) } : {}),
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
  const sortedSources = [...importedSources].sort(compareSources);
  const chosen = sources.chosenColors?.() ?? { sources: {} };
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
    importedSources: sortedSources,
    colors: {
      own: chosen.own ?? DEFAULT_OWN_COLOR,
      sources: Object.fromEntries(sortedSources.map((source) => [source, chosen.sources[source] ?? defaultSourceColor(source)])),
    },
  };
}
