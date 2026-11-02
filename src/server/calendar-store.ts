// Calendar events the Bridge owns: the person's own appointments and the ones agents add for them.
// Dates the rest of the Bridge keeps (deadlines, revisits, runs) are not stored here; calendar-view.ts
// lays them beside these events.

import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";
import { isRecord } from "../shared/is-record.js";
import {
  CALENDAR_MAX_ALL_DAY_SPAN_DAYS,
  CALENDAR_MAX_LOCATION,
  CALENDAR_MAX_NOTES,
  CALENDAR_MAX_TIMED_SPAN_MS,
  CALENDAR_MAX_TITLE,
  daysBetween,
  isCalendarDate,
  isCalendarInstant,
  isTimeZone,
  type CalendarEvent,
  type CalendarRepeat,
} from "../shared/calendar.js";
import { wallTimeIn, type WallDate } from "./cron-next-run.js";

export function dateKeyOf(parts: WallDate): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export class CalendarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarValidationError";
  }
}

export class CalendarNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarNotFoundError";
  }
}

const EDITABLE_FIELDS = ["title", "allDay", "start", "end", "timezone", "repeat", "location", "notes", "taskId"] as const;
const REPEAT_EVERY = new Set(["day", "week", "month", "year"]);

type EventFields = Omit<CalendarEvent, "id" | "createdBy" | "createdAt" | "updatedAt">;

function fail(message: string): never {
  throw new CalendarValidationError(message);
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${field} must be at most ${max} characters`);
  return trimmed || undefined;
}

function parseRepeat(value: unknown): CalendarRepeat | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail("repeat must be an object or null");
  const unknown = Object.keys(value).filter((key) => !["every", "interval", "until"].includes(key));
  if (unknown.length) fail(`Unknown repeat field: ${unknown.join(", ")}`);
  if (typeof value.every !== "string" || !REPEAT_EVERY.has(value.every)) fail('repeat.every must be "day", "week", "month" or "year"');
  const interval = value.interval === undefined ? 1 : value.interval;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 99) fail("repeat.interval must be a whole number from 1 to 99");
  if (value.until !== undefined && value.until !== null && !isCalendarDate(value.until)) fail("repeat.until must be a date (YYYY-MM-DD)");
  return { every: value.every as CalendarRepeat["every"], interval, ...(typeof value.until === "string" ? { until: value.until } : {}) };
}

/** Checks a complete event, normalising timed instants to UTC. */
function validateFields(input: Record<string, unknown>): EventFields {
  const title = optionalText(input.title, "title", CALENDAR_MAX_TITLE);
  if (!title) fail("title must be a non-empty string");
  if (typeof input.allDay !== "boolean") fail("allDay must be true or false");
  if (!isTimeZone(input.timezone)) fail("timezone must be an IANA time zone such as America/New_York");
  let start: string;
  let end: string;
  if (input.allDay) {
    if (!isCalendarDate(input.start)) fail("An all-day event's start must be a date (YYYY-MM-DD)");
    const endDate = input.end === undefined || input.end === null ? input.start : input.end;
    if (!isCalendarDate(endDate)) fail("An all-day event's end must be a date (YYYY-MM-DD)");
    const span = daysBetween(input.start, endDate);
    if (span < 0) fail("end must not be before start");
    if (span >= CALENDAR_MAX_ALL_DAY_SPAN_DAYS) fail(`An all-day event can last at most ${CALENDAR_MAX_ALL_DAY_SPAN_DAYS} days`);
    start = input.start;
    end = endDate;
  } else {
    if (!isCalendarInstant(input.start)) fail("start must be an ISO date-time with a time zone offset, such as 2026-05-01T15:00:00-07:00");
    const startMs = Date.parse(input.start);
    const endMs = input.end === undefined || input.end === null ? startMs + 3_600_000 : (isCalendarInstant(input.end) ? Date.parse(input.end) : NaN);
    if (!Number.isFinite(endMs)) fail("end must be an ISO date-time with a time zone offset");
    if (endMs <= startMs) fail("end must be after start");
    if (endMs - startMs > CALENDAR_MAX_TIMED_SPAN_MS) fail("A timed event can last at most 14 days; use an all-day event");
    start = new Date(startMs).toISOString();
    end = new Date(endMs).toISOString();
  }
  const repeat = parseRepeat(input.repeat);
  if (repeat?.until) {
    const firstDate = input.allDay ? start : dateKeyOf(wallTimeIn(new Date(start), input.timezone as string));
    if (repeat.until < firstDate) fail("repeat.until must not be before the event starts");
  }
  const taskId = input.taskId === undefined || input.taskId === null || input.taskId === "" ? undefined : input.taskId;
  if (taskId !== undefined && typeof taskId !== "string") fail("taskId must be a string or null");
  return {
    title,
    allDay: input.allDay,
    start,
    end,
    timezone: input.timezone as string,
    ...(repeat ? { repeat } : {}),
    ...(optionalText(input.location, "location", CALENDAR_MAX_LOCATION) ? { location: optionalText(input.location, "location", CALENDAR_MAX_LOCATION) } : {}),
    ...(optionalText(input.notes, "notes", CALENDAR_MAX_NOTES) ? { notes: optionalText(input.notes, "notes", CALENDAR_MAX_NOTES) } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

function rejectUnknown(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((key) => !(EDITABLE_FIELDS as readonly string[]).includes(key)).sort();
  if (unknown.length) fail(unknown.length === 1 ? `Unknown field: "${unknown[0]}"` : `Unknown fields: ${unknown.map((key) => `"${key}"`).join(", ")}`);
}

function rowToEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: String(row.id),
    title: String(row.title),
    allDay: Number(row.allDay) === 1,
    start: String(row.start),
    end: String(row.end),
    timezone: String(row.timezone),
    ...(row.repeatEvery ? {
      repeat: {
        every: row.repeatEvery as CalendarRepeat["every"],
        interval: Number(row.repeatInterval) || 1,
        ...(row.repeatUntil ? { until: String(row.repeatUntil) } : {}),
      },
    } : {}),
    ...(row.location ? { location: String(row.location) } : {}),
    ...(row.notes ? { notes: String(row.notes) } : {}),
    ...(row.taskId ? { taskId: String(row.taskId) } : {}),
    createdBy: row.createdBy === "agent" ? "agent" : "user",
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function createCalendarStore(db: DatabaseSync, bus: GlobalBus) {
  function emitChange(): void {
    bus.emit({ type: "calendar:changed" });
  }

  function ensureTask(taskId: string | undefined): void {
    if (!taskId) return;
    if (!db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId)) throw new CalendarNotFoundError(`Task ${taskId} not found`);
  }

  function write(id: string, fields: EventFields, createdBy: CalendarEvent["createdBy"], createdAt: string, now: string, insert: boolean): void {
    const values = [
      fields.title, fields.allDay ? 1 : 0, fields.start, fields.end, fields.timezone,
      fields.repeat?.every ?? null, fields.repeat?.interval ?? null, fields.repeat?.until ?? null,
      fields.location ?? null, fields.notes ?? null, fields.taskId ?? null,
    ];
    if (insert) {
      db.prepare(`INSERT INTO calendar_events (title, allDay, start, "end", timezone, repeatEvery, repeatInterval, repeatUntil,
        location, notes, taskId, id, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values, id, createdBy, createdAt, now);
    } else {
      db.prepare(`UPDATE calendar_events SET title = ?, allDay = ?, start = ?, "end" = ?, timezone = ?, repeatEvery = ?, repeatInterval = ?,
        repeatUntil = ?, location = ?, notes = ?, taskId = ?, updatedAt = ? WHERE id = ?`).run(...values, now, id);
    }
  }

  function getEvent(id: string): CalendarEvent | undefined {
    const row = db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  function listEvents(options: { taskId?: string } = {}): CalendarEvent[] {
    const rows = options.taskId
      ? db.prepare("SELECT * FROM calendar_events WHERE taskId = ? ORDER BY start").all(options.taskId)
      : db.prepare("SELECT * FROM calendar_events ORDER BY start").all();
    return (rows as Array<Record<string, unknown>>).map(rowToEvent);
  }

  function createEvent(body: unknown, createdBy: CalendarEvent["createdBy"] = "user"): CalendarEvent {
    if (!isRecord(body)) fail("Request body must be an object");
    rejectUnknown(body);
    const fields = validateFields(body);
    ensureTask(fields.taskId);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    write(id, fields, createdBy, now, now, true);
    emitChange();
    return getEvent(id)!;
  }

  /** Changes the whole event (every repeat). A field set to null is cleared; the result is checked whole. */
  function updateEvent(id: string, body: unknown): CalendarEvent {
    if (!isRecord(body)) fail("Request body must be an object");
    rejectUnknown(body);
    if (Object.keys(body).length === 0) fail("Provide at least one field to change");
    const existing = getEvent(id);
    if (!existing) throw new CalendarNotFoundError(`Event ${id} not found`);
    const merged: Record<string, unknown> = { ...existing, ...body };
    // Switching between all-day and timed changes what start and end mean, so both must come along.
    if (body.allDay !== undefined && body.allDay !== existing.allDay && (body.start === undefined || body.end === undefined)) {
      fail("Changing allDay needs a new start and end");
    }
    const fields = validateFields(merged);
    ensureTask(fields.taskId);
    write(id, fields, existing.createdBy, existing.createdAt, new Date().toISOString(), false);
    emitChange();
    return getEvent(id)!;
  }

  function deleteEvent(id: string): void {
    const result = db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
    if (Number(result.changes) === 0) throw new CalendarNotFoundError(`Event ${id} not found`);
    emitChange();
  }

  return { getEvent, listEvents, createEvent, updateEvent, deleteEvent };
}

export type CalendarStore = ReturnType<typeof createCalendarStore>;
