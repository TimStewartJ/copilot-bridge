// Whose move a task is, read from its live fields rather than from Helm's own thread line. Helm
// once called a task "agent-run; stay out" while its next step was Tim's and its deadline had
// passed, and both the brief and the chat followed that line. These checks read only data (fields,
// dates, the calendar and the structured part of Helm's line, never its wording), and Helm's view
// can add a task to what needs Tim but never take one off.
import { createHash } from "node:crypto";
import type { CalendarEvent } from "../../shared/calendar.js";
import type { HelmThreadOwner } from "../../shared/helm-thinker.js";
import type { TaskState } from "../../shared/task-state.js";
import type { TaskOverviewRow } from "../../shared/task-overview.js";

/** A stretch of several days on the calendar (a trip, a retreat): work due by then must happen before it. */
export interface AttentionAbsence {
  title: string;
  /** Local dates, YYYY-MM-DD, both inclusive. */
  start: string;
  end: string;
}

export interface AttentionTask {
  state?: TaskState;
  reasons?: readonly string[];
  deferred?: boolean;
  muted?: boolean;
  nextAction?: string;
  waitingOn?: string;
  nextTouchAt?: string;
  /** When waiting-for was last set: a date in it after this is a due date, one before it a record. */
  waitingSince?: string;
  /** The structured part of Helm's thread line for the task. */
  helm?: { owner?: HelmThreadOwner | null; holdUntil?: string | null };
  /** A conversation of the task is working right now. */
  agentWorking?: boolean;
  /** Open checklist items. */
  checklist?: ReadonlyArray<{ text: string; deadline?: string }>;
  /** Only future dates are read from notes; the past ones there are history. */
  notes?: string;
}

export interface TaskAttention {
  /** Nothing but Tim moves the task next: its fields say so, or Helm says it is his. */
  onTim: boolean;
  /** Its fields alone say so: no agent is working on it and it waits on no one else. Helm can't overrule this. */
  fromFields: boolean;
  /** Why it needs Tim now: dates passed, due within days, or before a stretch away. Empty when nothing presses. */
  reasons: string[];
  /** The earliest date behind the reasons, for ordering. */
  soonest?: string;
}

/** What the checks need beyond a Bridge's task rows. */
export interface AttentionInputs {
  timeZone: string;
  absences: AttentionAbsence[];
  /** Notes and open checklist items of a task on this Bridge. Peers have neither; their due checklist items stand in. */
  local?: (taskId: string) => { notes?: string; checklist?: Array<{ text: string; deadline?: string }> } | undefined;
  /** The structured part of Helm's thread line for a task on this Bridge. */
  helm?: (taskId: string) => AttentionTask["helm"];
}

export interface AttentionContext {
  now: Date;
  timeZone: string;
  absences?: readonly AttentionAbsence[];
}

const DAY_MS = 86_400_000;
/** A date this many days ahead or fewer is due soon. */
export const SOON_DAYS = 3;
/** A stretch away that starts within this many days makes what is due before or during it press now. */
export const ABSENCE_LOOKAHEAD_DAYS = 14;
/** Passed dates older than this are history, not a missed deadline. */
const PASSED_LOOKBACK_DAYS = 30;
/** Calendar events at least this long count as a stretch away. */
const ABSENCE_MIN_MS = 48 * 3_600_000;
const MAX_REASONS = 3;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// Whole month names or their abbreviations only, so "Decide" or "Mark" is never a month.
const MONTH_NAME = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?";

/** The local calendar date of an instant, YYYY-MM-DD. */
export function localDateKey(at: Date | number | string, timeZone: string): string {
  const date = at instanceof Date ? at : new Date(at);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function keyToDay(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!) / DAY_MS;
}

function dayToKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function validKey(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return undefined;
  return dayToKey(date.getTime() / DAY_MS);
}

/** A date without a year is the one nearest to today. */
function nearest(month: number, day: number, today: string): string | undefined {
  const year = Number(today.slice(0, 4));
  const todayDay = keyToDay(today);
  let best: string | undefined;
  for (const candidate of [year - 1, year, year + 1]) {
    const key = validKey(candidate, month, day);
    if (key && (!best || Math.abs(keyToDay(key) - todayDay) < Math.abs(keyToDay(best) - todayDay))) best = key;
  }
  return best;
}

function fullYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return raw.length === 2 ? 2000 + value : value;
}

/** Calendar dates written in text: 2026-11-20, 11/20, 11/20/26, Nov 20, November 20, 2026, 20 Nov. */
export function extractDates(text: string | undefined, today: string): string[] {
  return [...new Set(findDates(text, today).map((found) => found.key))].sort();
}

function findDates(text: string | undefined, today: string): Array<{ key: string; index: number }> {
  if (!text) return [];
  const found: Array<{ key: string; index: number }> = [];
  let index = 0;
  const add = (key: string | undefined) => { if (key) found.push({ key, index }); };
  const each = (pattern: RegExp, read: (match: RegExpMatchArray) => string | undefined) => {
    for (const match of text.matchAll(pattern)) { index = match.index ?? 0; add(read(match)); }
  };
  each(/\b(20\d{2})-(\d{2})-(\d{2})\b/g, (match) => validKey(Number(match[1]), Number(match[2]), Number(match[3])));
  // Not part of a longer number, a path or an amount ("41/64", "$1/2", "a/b/c").
  each(/(?<![\w/.$-])(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\/(\d{4}|\d{2}))?(?![\w/%])/g, (match) => {
    const year = fullYear(match[3]);
    return year ? validKey(year, Number(match[1]), Number(match[2])) : nearest(Number(match[1]), Number(match[2]), today);
  });
  const month = (name: string) => MONTHS.indexOf(name.toLowerCase().slice(0, 3)) + 1;
  each(new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!:)(?:,?\\s+(20\\d{2}))?`, "gi"), (match) => {
    const year = fullYear(match[3]);
    return year ? validKey(year, month(match[1]!), Number(match[2])) : nearest(month(match[1]!), Number(match[2]), today);
  });
  each(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_NAME}(?:\\s+(20\\d{2}))?\\b`, "gi"), (match) => {
    const year = fullYear(match[3]);
    return year ? validKey(year, month(match[2]!), Number(match[1])) : nearest(month(match[2]!), Number(match[1]), today);
  });
  return found;
}

/** "Thu Nov 12" for a YYYY-MM-DD key. */
export function formatDay(key: string): string {
  return new Date(keyToDay(key) * DAY_MS).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

/** Calendar events of several days that are not over and start within a month, soonest first. */
export function upcomingAbsences(events: readonly CalendarEvent[], context: { now: Date; timeZone: string }): AttentionAbsence[] {
  const today = localDateKey(context.now, context.timeZone);
  const absences: AttentionAbsence[] = [];
  for (const event of events) {
    if (event.repeat) continue;
    let start: string;
    let end: string;
    if (event.allDay) {
      start = event.start;
      end = event.end;
      if (keyToDay(end) - keyToDay(start) < 1) continue;
    } else {
      const from = Date.parse(event.start);
      const to = Date.parse(event.end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < ABSENCE_MIN_MS) continue;
      start = localDateKey(from, context.timeZone);
      end = localDateKey(to, context.timeZone);
    }
    if (end < today || keyToDay(start) - keyToDay(today) > 30) continue;
    absences.push({ title: event.title, start, end });
  }
  return absences.sort((a, b) => a.start.localeCompare(b.start));
}

/** A fingerprint of the fields a thread line was written from; when they change, the line is out of date. */
export function taskBasis(task: { nextAction?: string | null; waitingOn?: string | null; nextTouchAt?: string | null }): string {
  const parts = [task.nextAction, task.waitingOn, task.nextTouchAt].map((value) => value?.replace(/\s+/g, " ").trim() ?? "");
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

interface DatedReason { day: string; text: string }

export function taskAttention(task: AttentionTask, context: AttentionContext): TaskAttention {
  const today = localDateKey(context.now, context.timeZone);
  const todayDay = keyToDay(today);
  const waiting = task.waitingOn?.trim() ?? "";
  // A wait ends on a date it was due by: one after the wait was set ("by 11/12"), not one it
  // records ("emailed 11/10"). Without the time it was set, its dates are not read as due.
  const setOn = task.waitingSince && Number.isFinite(Date.parse(task.waitingSince)) ? localDateKey(task.waitingSince, context.timeZone) : undefined;
  const waitDates = setOn ? extractDates(waiting, today).filter((day) => day > setOn) : [];
  const waitOver = waitDates.length > 0 && waitDates.every((day) => day < today && keyToDay(today) - keyToDay(day) <= PASSED_LOOKBACK_DAYS);

  const fromFields = task.state === "needs_you"
    || (!task.deferred && !task.muted && !!task.nextAction?.trim() && !task.agentWorking && (!waiting || waitOver));
  const helmSaysTim = task.helm?.owner === "tim" && !task.deferred && !task.muted;
  const onTim = fromFields || helmSaysTim;
  if (!onTim) return { onTim: false, fromFields: false, reasons: [] };

  const dated: DatedReason[] = [];
  const undated: string[] = [];
  if (task.reasons?.includes("question")) undated.push("an agent is waiting on your answer");
  if (task.reasons?.includes("stalled")) undated.push("one of its conversations stalled");
  if (task.reasons?.includes("revisit") && task.nextTouchAt) {
    const day = localDateKey(task.nextTouchAt, context.timeZone);
    dated.push({ day, text: `its revisit date (${formatDay(day)}) has passed` });
  }
  if (waitOver) {
    const day = waitDates[waitDates.length - 1]!;
    dated.push({ day, text: `what it was waiting for was due ${formatDay(day)}, which has passed` });
  }
  const hold = task.helm?.holdUntil;
  if (helmSaysTim && hold && /^\d{4}-\d{2}-\d{2}$/.test(hold) && hold <= today) {
    dated.push({ day: hold, text: hold === today ? "Helm's pause on it ends today" : `Helm's pause on it ended ${formatDay(hold)}` });
  }

  // Past dates count only where they read as a due date: the next step and a checklist deadline. In
  // checklist text and notes they are mostly history ("moved on Nov 12", "status as of today").
  const sources: Array<{ text: string | undefined; label: string; pastCounts: boolean; minOffset: number; deadline?: string }> = [
    { text: task.nextAction, label: "the next step", pastCounts: true, minOffset: 0 },
    ...(waitOver ? [] : [{ text: waiting, label: "what it waits for", pastCounts: false, minOffset: 0 }]),
    ...(task.checklist ?? []).map((item) => ({ text: item.text, label: `checklist “${clip(item.text, 60)}”`, pastCounts: false, minOffset: 0, ...(item.deadline ? { deadline: item.deadline } : {}) })),
    { text: task.notes, label: "its notes", pastCounts: false, minOffset: 1 },
  ];
  const absences = (context.absences ?? []).filter((absence) => absence.end >= today && keyToDay(absence.start) - todayDay <= ABSENCE_LOOKAHEAD_DAYS);
  for (const source of sources) {
    const deadline = source.deadline && /^\d{4}-\d{2}-\d{2}$/.test(source.deadline) ? source.deadline : undefined;
    const days = new Set(extractDates(source.text, today));
    if (deadline) days.add(deadline);
    for (const day of [...days].sort()) {
      const offset = keyToDay(day) - todayDay;
      if (offset < 0) {
        if ((source.pastCounts || day === deadline) && offset >= -PASSED_LOOKBACK_DAYS) dated.push({ day, text: `${formatDay(day)} in ${source.label} has passed` });
        continue;
      }
      if (offset < source.minOffset) continue;
      if (offset <= SOON_DAYS) {
        dated.push({ day, text: offset === 0 ? `${source.label} names today` : `${formatDay(day)} in ${source.label} is ${offset === 1 ? "tomorrow" : `in ${offset} days`}` });
        continue;
      }
      const absence = absences.find((candidate) => day <= candidate.end);
      if (!absence) continue;
      dated.push({
        day,
        text: day < absence.start
          ? `${formatDay(day)} in ${source.label} comes before ${absence.title} (from ${formatDay(absence.start)})`
          : `${formatDay(day)} in ${source.label} falls during ${absence.title} (${formatDay(absence.start)}–${formatDay(absence.end)})`,
      });
    }
  }
  dated.sort((a, b) => a.day.localeCompare(b.day));
  // One reason per date: the first found, which is the most direct (revisit, wait, next step, checklist, notes).
  const byDay = dated.filter((reason, index) => dated.findIndex((other) => other.day === reason.day) === index);
  const reasons = [...new Set([...undated, ...byDay.map((reason) => reason.text)])].slice(0, MAX_REASONS);
  return { onTim: true, fromFields, reasons, ...(dated[0] ? { soonest: dated[0].day } : {}) };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Tasks that need Tim first (earliest date first), then the rest that wait on him. */
export function byAttention<T extends { attention: TaskAttention }>(a: T, b: T): number {
  const pressing = Number(b.attention.reasons.length > 0) - Number(a.attention.reasons.length > 0);
  if (pressing) return pressing;
  return (a.attention.soonest ?? "9999").localeCompare(b.attention.soonest ?? "9999");
}

/** A task row's attention; checklist stands in for open items when the Bridge cannot list them (a peer). */
export function attentionOfRow(
  row: Pick<TaskOverviewRow, "id" | "state" | "reasons" | "deferred" | "muted" | "nextAction" | "waitingOn" | "nextTouchAt" | "waitingSince" | "busyCount">,
  inputs: AttentionInputs,
  now: Date,
  checklist: ReadonlyArray<{ text: string; deadline?: string }> = [],
): TaskAttention {
  const local = inputs.local?.(row.id);
  const helm = inputs.helm?.(row.id);
  return taskAttention({
    state: row.state, reasons: row.reasons, deferred: row.deferred, muted: row.muted,
    ...(row.nextAction ? { nextAction: row.nextAction } : {}), ...(row.waitingOn ? { waitingOn: row.waitingOn } : {}),
    ...(row.nextTouchAt ? { nextTouchAt: row.nextTouchAt } : {}), ...(row.waitingSince ? { waitingSince: row.waitingSince } : {}),
    ...(helm ? { helm } : {}), agentWorking: row.busyCount > 0,
    checklist: local?.checklist ?? checklist,
    ...(local?.notes ? { notes: local.notes } : {}),
  }, { now, timeZone: inputs.timeZone, absences: inputs.absences });
}
