// Calendar events the Bridge owns: the person's own appointments and the ones agents add for them.
// Dates the rest of the Bridge keeps (deadlines, revisits, runs) are not stored here; calendar-view.ts
// lays them beside these events.

import type { DatabaseSync } from "./db.js";
import { runImmediateTransaction } from "./db-transaction.js";
import type { GlobalBus } from "./global-bus.js";
import { isRecord } from "../shared/is-record.js";
import {
  CALENDAR_MAX_ALL_DAY_SPAN_DAYS,
  CALENDAR_MAX_BATCH,
  CALENDAR_MAX_EXTERNAL_ID,
  CALENDAR_SOURCE_RE,
  CALENDAR_COLORS,
  isCalendarColor,
  type CalendarColor,
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

const EDITABLE_FIELDS = ["title", "allDay", "start", "end", "timezone", "repeat", "location", "notes", "taskId", "externalId", "source"] as const;
const REPEAT_EVERY = new Set(["day", "week", "month", "year"]);
const COLORS_KEY = "calendar:colors";

type EventFields = Omit<CalendarEvent, "id" | "createdBy" | "createdAt" | "updatedAt">;

export type CalendarSaveResult = "created" | "updated" | "unchanged";

export interface SavedCalendarEvent {
  result: CalendarSaveResult;
  event: CalendarEvent;
}

function fail(message: string): never {
  throw new CalendarValidationError(message);
}

function optionalExternalId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail("externalId must be a string or null");
  if (value.length > CALENDAR_MAX_EXTERNAL_ID) fail(`externalId must be at most ${CALENDAR_MAX_EXTERNAL_ID} characters`);
  return value;
}

function optionalSource(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail("source must be a string or null");
  const name = value.trim().toLowerCase();
  if (!CALENDAR_SOURCE_RE.test(name)) fail("source must be a short name such as outlook: up to 32 lowercase letters, digits, dots, dashes or underscores");
  return name;
}

function checkBatchSize(list: unknown, what: string): unknown[] {
  if (!Array.isArray(list)) fail(`${what} must be a list`);
  if (list.length > CALENDAR_MAX_BATCH) fail(`At most ${CALENDAR_MAX_BATCH} ${what} per call`);
  return list;
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
  const externalId = optionalExternalId(input.externalId);
  const source = optionalSource(input.source);
  // The source says where an imported event came from, so only an imported event has one.
  if (source && !externalId) fail("source needs an externalId");
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
    ...(externalId ? { externalId } : {}),
    ...(source ? { source } : {}),
  };
}

/** The stored columns of an event, in the order write() binds them. */
function columnValues(fields: EventFields): Array<string | number | null> {
  return [
    fields.title, fields.allDay ? 1 : 0, fields.start, fields.end, fields.timezone,
    fields.repeat?.every ?? null, fields.repeat?.interval ?? null, fields.repeat?.until ?? null,
    fields.location ?? null, fields.notes ?? null, fields.taskId ?? null, fields.externalId ?? null, fields.source ?? null,
  ];
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
    ...(row.externalId ? { externalId: String(row.externalId) } : {}),
    ...(row.source ? { source: String(row.source) } : {}),
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
    const values = columnValues(fields);
    if (insert) {
      db.prepare(`INSERT INTO calendar_events (title, allDay, start, "end", timezone, repeatEvery, repeatInterval, repeatUntil,
        location, notes, taskId, externalId, source, id, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values, id, createdBy, createdAt, now);
    } else {
      db.prepare(`UPDATE calendar_events SET title = ?, allDay = ?, start = ?, "end" = ?, timezone = ?, repeatEvery = ?, repeatInterval = ?,
        repeatUntil = ?, location = ?, notes = ?, taskId = ?, externalId = ?, source = ?, updatedAt = ? WHERE id = ?`).run(...values, now, id);
    }
  }

  function getEvent(id: string): CalendarEvent | undefined {
    const row = db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  function getEventByExternalId(externalId: string): CalendarEvent | undefined {
    const row = db.prepare("SELECT * FROM calendar_events WHERE externalId = ?").get(externalId) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  function listEvents(options: { taskId?: string } = {}): CalendarEvent[] {
    const rows = options.taskId
      ? db.prepare("SELECT * FROM calendar_events WHERE taskId = ? ORDER BY start").all(options.taskId)
      : db.prepare("SELECT * FROM calendar_events ORDER BY start").all();
    return (rows as Array<Record<string, unknown>>).map(rowToEvent);
  }

  /**
   * Adds events, all or none. An event whose externalId already exists updates that event in place:
   * the body replaces its fields, except that it keeps its task when the body names none.
   */
  function saveEvents(bodies: unknown, createdBy: CalendarEvent["createdBy"] = "user"): SavedCalendarEvent[] {
    const list = checkBatchSize(bodies, "events");
    const label = (index: number) => list.length > 1 ? `events[${index}]: ` : "";
    const seen = new Set<string>();
    const parsed = list.map((body, index) => {
      try {
        if (!isRecord(body)) fail("Request body must be an object");
        rejectUnknown(body);
        const fields = validateFields(body);
        if (fields.externalId) {
          if (seen.has(fields.externalId)) fail(`externalId ${fields.externalId} appears more than once`);
          seen.add(fields.externalId);
        }
        return { fields, keepTask: body.taskId === undefined };
      } catch (error) {
        if (error instanceof CalendarValidationError) throw new CalendarValidationError(`${label(index)}${error.message}`);
        throw error;
      }
    });
    const saved = runImmediateTransaction(db, () => parsed.map(({ fields, keepTask }, index): SavedCalendarEvent => {
      const existing = fields.externalId ? getEventByExternalId(fields.externalId) : undefined;
      const next: EventFields = existing && keepTask && existing.taskId ? { ...fields, taskId: existing.taskId } : fields;
      try {
        ensureTask(next.taskId);
      } catch (error) {
        if (error instanceof CalendarNotFoundError) throw new CalendarNotFoundError(`${label(index)}${error.message}`);
        throw error;
      }
      const now = new Date().toISOString();
      if (!existing) {
        const id = crypto.randomUUID();
        write(id, next, createdBy, now, now, true);
        return { result: "created", event: getEvent(id)! };
      }
      const before = columnValues(existing);
      if (columnValues(next).every((value, i) => value === before[i])) return { result: "unchanged", event: existing };
      write(existing.id, next, existing.createdBy, existing.createdAt, now, false);
      return { result: "updated", event: getEvent(existing.id)! };
    }));
    if (saved.some((entry) => entry.result !== "unchanged")) emitChange();
    return saved;
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
    if (fields.externalId && getEventByExternalId(fields.externalId)?.id !== id) fail(`Another event already has externalId ${fields.externalId}`);
    write(id, fields, existing.createdBy, existing.createdAt, new Date().toISOString(), false);
    emitChange();
    return getEvent(id)!;
  }

  function deleteEvent(id: string): void {
    const result = db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
    if (Number(result.changes) === 0) throw new CalendarNotFoundError(`Event ${id} not found`);
    emitChange();
  }

  /** Deletes the listed events, all in one go, and says which IDs had no event. */
  function deleteEvents(ids: unknown): { deleted: string[]; notFound: string[] } {
    const list = checkBatchSize(ids, "eventIds");
    if (list.some((id) => typeof id !== "string" || !id)) fail("eventIds must be non-empty strings");
    const unique = [...new Set(list as string[])];
    const deleted: string[] = [];
    const notFound: string[] = [];
    runImmediateTransaction(db, () => {
      const statement = db.prepare("DELETE FROM calendar_events WHERE id = ?");
      for (const id of unique) (Number(statement.run(id).changes) > 0 ? deleted : notFound).push(id);
    });
    if (deleted.length) emitChange();
    return { deleted, notFound };
  }

  /** The colours the person chose; kinds of event they never chose a colour for are absent. */
  function getColors(): { own?: CalendarColor; sources: Record<string, CalendarColor> } {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(COLORS_KEY) as { value?: unknown } | undefined;
    try {
      const stored = JSON.parse(typeof row?.value === "string" ? row.value : "{}") as unknown;
      if (!isRecord(stored)) return { sources: {} };
      const sources = isRecord(stored.sources)
        ? Object.fromEntries(Object.entries(stored.sources).filter((entry): entry is [string, CalendarColor] => isCalendarColor(entry[1])))
        : {};
      return { ...(isCalendarColor(stored.own) ? { own: stored.own } : {}), sources };
    } catch {
      return { sources: {} };
    }
  }

  /** Sets the colour of the person's own events and of any sources named; others keep theirs. */
  function setColors(body: unknown): void {
    if (!isRecord(body)) fail("Request body must be an object");
    const unknown = Object.keys(body).filter((key) => key !== "own" && key !== "sources");
    if (unknown.length) fail(`Unknown field: ${unknown.join(", ")}`);
    const colorError = `a colour must be one of: ${CALENDAR_COLORS.join(", ")}`;
    if (body.own !== undefined && !isCalendarColor(body.own)) fail(`own: ${colorError}`);
    if (body.sources !== undefined && !isRecord(body.sources)) fail("sources must be an object of source names to colours");
    const sources = (body.sources ?? {}) as Record<string, unknown>;
    for (const [source, color] of Object.entries(sources)) {
      if (!CALENDAR_SOURCE_RE.test(source)) fail(`Unknown source name "${source}"`);
      if (!isCalendarColor(color)) fail(`sources.${source}: ${colorError}`);
    }
    const current = getColors();
    const next = {
      ...(body.own ? { own: body.own } : current.own ? { own: current.own } : {}),
      sources: { ...current.sources, ...(sources as Record<string, CalendarColor>) },
    };
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(COLORS_KEY, JSON.stringify(next));
    emitChange();
  }

  return { getEvent, listEvents, saveEvents, updateEvent, deleteEvent, deleteEvents, getColors, setColors };
}

export type CalendarStore = ReturnType<typeof createCalendarStore>;
