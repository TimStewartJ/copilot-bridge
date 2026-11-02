// Pure helpers for the calendar screens: which days a view shows, how overlapping blocks share a
// day column, and the arithmetic behind Home's day line. Everything is local time.
import { toDateKey } from "../../shared/typed-date";

export { toDateKey };

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysKey(key: string, days: number): string {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/** Monday of the week holding `key`. */
export function weekStartKey(key: string): string {
  const date = parseDateKey(key);
  return addDaysKey(key, -((date.getDay() + 6) % 7));
}

export function daysFrom(startKey: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDaysKey(startKey, index));
}

/** When the local day after `key` starts; a day is 23 or 25 hours when the clock changes. */
export function dayEndMs(key: string): number {
  return parseDateKey(addDaysKey(key, 1)).getTime();
}

/** The clock time of `instant` on `dayKey` in minutes after midnight, clipped to the day; the grid is laid out by clock time. */
export function wallMinutes(instant: number, dayKey: string): number {
  if (instant <= parseDateKey(dayKey).getTime()) return 0;
  if (instant >= dayEndMs(dayKey)) return 24 * 60;
  const date = new Date(instant);
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function minutesIntoDay(iso: string, dayKey: string): number {
  return wallMinutes(Date.parse(iso), dayKey);
}

export interface TimedSpan { id: string; start: number; end: number }
export interface PlacedSpan { id: string; lane: number; lanes: number }

/**
 * Lays timed blocks of one day into side-by-side lanes. Blocks that overlap, directly or through a
 * chain, form a cluster sharing one lane count; each takes the first lane free at its start. Ties
 * break by longer first, then id, so the layout never depends on the order the server sent.
 */
export function layoutLanes(spans: readonly TimedSpan[], minMinutes = 20): PlacedSpan[] {
  const sorted = [...spans]
    .map((span) => ({ ...span, end: Math.max(span.end, span.start + minMinutes) }))
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.id.localeCompare(b.id));
  const placed: PlacedSpan[] = [];
  let cluster: Array<{ id: string; lane: number }> = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const item of cluster) placed.push({ id: item.id, lane: item.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };
  for (const span of sorted) {
    if (span.start >= clusterEnd) { flush(); clusterEnd = -Infinity; }
    let lane = laneEnds.findIndex((end) => end <= span.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(span.end); } else laneEnds[lane] = span.end;
    cluster.push({ id: span.id, lane });
    clusterEnd = Math.max(clusterEnd, span.end);
  }
  flush();
  return placed;
}

/** Waking hours the day line counts as possible free time. */
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 21;

/**
 * Free minutes left in a day: waking hours from now (or the day's start) to the day's end, less the
 * union of busy blocks. Only events count as busy; deadlines, revisits and agent runs never do.
 */
export function freeMinutes(busy: ReadonlyArray<{ start: number; end: number }>, nowMinutes: number): number {
  const from = Math.max(DAY_START_HOUR * 60, nowMinutes);
  const to = DAY_END_HOUR * 60;
  if (from >= to) return 0;
  const clipped = busy
    .map((span) => ({ start: Math.max(from, span.start), end: Math.min(to, span.end) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  let taken = 0;
  let cursor = from;
  for (const span of clipped) {
    const start = Math.max(cursor, span.start);
    if (span.end > start) { taken += span.end - start; cursor = span.end; }
  }
  return to - from - taken;
}

/** "4 h free", "45 min free", "3 h 30 min free". */
export function formatFree(minutes: number): string {
  if (minutes <= 0) return "No free time left";
  const rounded = minutes >= 120 ? Math.round(minutes / 30) * 30 : Math.max(15, Math.round(minutes / 15) * 15);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${rounded} min free`;
  return m ? `${h} h ${m} min free` : `${h} h free`;
}

/** "9am", "3:30pm". */
export function formatClockShort(iso: string): string {
  const date = new Date(iso);
  const hour = date.getHours();
  const minute = date.getMinutes();
  const h12 = hour % 12 || 12;
  const suffix = hour < 12 ? "am" : "pm";
  return minute ? `${h12}:${String(minute).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

/** Snap for dragging on the grid, in minutes. */
export const DRAG_SNAP_MINUTES = 15;

export interface DragChange {
  mode: "move" | "resize";
  /** Days the pointer crossed; a move keeps the clock time on the new day. */
  dayOffset: number;
  /** Minutes the pointer moved, already snapped. */
  minuteDelta: number;
}

/**
 * Where a timed event lands after a drag. A move keeps its length; a resize moves only the end and
 * never makes it shorter than one snap. Days are local calendar days, so 9am stays 9am across a
 * change of the clock.
 */
export function draggedTimes(start: string, end: string, change: DragChange): { start: string; end: string } {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (change.mode === "resize") {
    const nextEnd = Math.max(endDate.getTime() + change.minuteDelta * 60_000, startDate.getTime() + DRAG_SNAP_MINUTES * 60_000);
    return { start, end: new Date(nextEnd).toISOString() };
  }
  const length = endDate.getTime() - startDate.getTime();
  const moved = new Date(startDate);
  moved.setDate(moved.getDate() + change.dayOffset);
  const nextStart = moved.getTime() + change.minuteDelta * 60_000;
  return { start: new Date(nextStart).toISOString(), end: new Date(nextStart + length).toISOString() };
}

/** Pointer travel in pixels as snapped minutes. */
export function snapMinutes(pixels: number, hourPx: number): number {
  return Math.round((pixels / hourPx) * 60 / DRAG_SNAP_MINUTES) * DRAG_SNAP_MINUTES;
}
