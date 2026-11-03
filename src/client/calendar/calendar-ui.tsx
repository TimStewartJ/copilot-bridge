// What every calendar screen shares: how a kind of item looks, how its time reads, and where it
// opens. Kinds are told apart by their glyph (shape first, colour only on the glyph), so the grid
// stays neutral like the rest of the Bridge. Events carry the identity colour the person gave their
// kind (their own, or an import source) on a bar at the block's edge, never as a fill; imported
// events also step back in weight, so they read right even when two kinds share a colour.
import { Bot, Flag, RotateCcw } from "lucide-react";
import { DEFAULT_OWN_COLOR, defaultSourceColor, sourceOf, UNNAMED_SOURCE, type CalendarColor, type CalendarColors, type CalendarItem, type CalendarItemKind } from "../../shared/calendar";
import { IDENTITY_FILL } from "../design/identity";
import { cx } from "../design/tokens";
import { dayEndMs, formatClockShort, parseDateKey } from "./calendar-model";

export type CalendarLayer = CalendarItemKind;

export const LAYER_LABEL: Record<CalendarLayer, string> = {
  event: "Events",
  deadline: "Deadlines",
  revisit: "Revisits",
  run: "Agent runs",
};

export const KIND_LABEL: Record<CalendarLayer, string> = {
  event: "Event",
  deadline: "Due",
  revisit: "Revisit",
  run: "Agent run",
};

export function KindIcon({ kind, size = 12, className }: { kind: CalendarItemKind; size?: number; className?: string }) {
  if (kind === "deadline") return <Flag size={size} aria-hidden="true" className={cx("shrink-0 text-warning", className)} />;
  if (kind === "revisit") return <RotateCcw size={size} aria-hidden="true" className={cx("shrink-0 text-info", className)} />;
  if (kind === "run") return <Bot size={size} aria-hidden="true" className={cx("shrink-0 text-agent", className)} />;
  return null;
}

/** An event copied in from another calendar: read-only here, since the next import replaces it. */
export function isImported(item: CalendarItem): boolean {
  return item.kind === "event" && !!item.externalId;
}

const SOURCE_NAMES: Record<string, string> = { outlook: "Outlook", google: "Google Calendar", icloud: "iCloud" };

/** "Outlook" for "outlook"; undefined when an imported event names no source. */
export function sourceName(source: string | undefined): string | undefined {
  if (!source) return undefined;
  return SOURCE_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** The filter label for one source of imported events. */
export function sourceFilterLabel(source: string): string {
  return source === UNNAMED_SOURCE ? "Imported" : `From ${sourceName(source)}`;
}

/** The block recipe for an item on the grid: own events are content; imported events and derived dates step back. */
export function itemSurface(item: CalendarItem): string {
  if (isImported(item)) return "bg-surface-selected/60 text-text-secondary";
  if (item.kind === "event") return "bg-surface-selected text-text-primary";
  if (item.kind === "run") return "bg-surface-inset text-text-muted border border-border-subtle";
  return cx("bg-surface-inset text-text-secondary border border-border-subtle", item.done && "line-through text-text-faint");
}

/** The colour the person gave this event's kind: their own events, or its import source. */
export function eventColor(item: CalendarItem, colors: CalendarColors | undefined): CalendarColor {
  if (!isImported(item)) return colors?.own ?? DEFAULT_OWN_COLOR;
  return colors?.sources[sourceOf(item)] ?? defaultSourceColor(sourceOf(item));
}

/** The colour bar down an event block's leading edge. The block must be positioned and clip its corners. */
export function EventBar({ item, colors }: { item: CalendarItem; colors: CalendarColors | undefined }) {
  if (item.kind !== "event") return null;
  return <span aria-hidden="true" className={cx("pointer-events-none absolute inset-y-0 left-0 w-[3px]", IDENTITY_FILL[eventColor(item, colors)])} />;
}

/** The bar alone: the key on a filter chip and the mark before an event in a list. */
export function EventMark({ color, className }: { color: CalendarColor; className?: string }) {
  return <span aria-hidden="true" className={cx("inline-block h-3 w-[3px] shrink-0 rounded-sm", IDENTITY_FILL[color], className)} />;
}

/** The leading mark of an item in a list: the event's colour bar, or the kind's glyph. */
export function ItemMark({ item, colors, size = 12 }: { item: CalendarItem; colors: CalendarColors | undefined; size?: number }) {
  if (item.kind === "event") return <EventMark color={eventColor(item, colors)} />;
  return <KindIcon kind={item.kind} size={size} />;
}

/** "9am", "9am – 10:30am", "All day". */
export function itemTime(item: CalendarItem): string {
  if (item.allDay) return "All day";
  if (item.kind !== "event" || !item.end) return formatClockShort(item.start);
  return `${formatClockShort(item.start)} – ${formatClockShort(item.end)}`;
}

export function itemDayKey(item: CalendarItem): string {
  if (item.allDay) return item.start;
  const date = new Date(item.start);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The local days an item covers: several for a multi-day event, one otherwise. */
export function itemDayKeys(item: CalendarItem, visible: readonly string[]): string[] {
  if (item.kind !== "event" || !item.end) return [itemDayKey(item)].filter((key) => visible.includes(key));
  if (item.allDay) return visible.filter((key) => key >= item.start && key <= item.end!);
  const start = Date.parse(item.start);
  const end = Date.parse(item.end);
  return visible.filter((key) => {
    return start < dayEndMs(key) && end > parseDateKey(key).getTime();
  });
}

export function formatDayHeading(key: string, today: string): string {
  const date = parseDateKey(key);
  const label = date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  if (key === today) return `Today · ${label}`;
  return label;
}

export function formatShortDate(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A line under an item's title: its task, or where it is. */
export function itemContext(item: CalendarItem): string | undefined {
  return [item.location, item.kind !== "revisit" ? item.taskTitle : undefined, item.deferred ? "set aside" : undefined]
    .filter(Boolean).join(" · ") || undefined;
}

export function itemTitle(item: CalendarItem): string {
  return item.kind === "revisit" ? `Revisit · ${item.title}` : item.title;
}

const LAYERS_KEY = "bridge.calendar.layers";
export const DEFAULT_LAYERS: Record<CalendarLayer, boolean> = { event: true, deadline: true, revisit: true, run: false };

export function readLayers(): Record<CalendarLayer, boolean> {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "null") as Partial<Record<CalendarLayer, boolean>> | null;
    return { ...DEFAULT_LAYERS, ...(stored ?? {}) };
  } catch {
    return DEFAULT_LAYERS;
  }
}

export function writeLayers(layers: Record<CalendarLayer, boolean>): void {
  try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layers)); } catch { /* private mode */ }
}

const HIDDEN_SOURCES_KEY = "bridge.calendar.hiddenSources";

/** Sources of imported events the person has hidden. */
export function readHiddenSources(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_SOURCES_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function writeHiddenSources(sources: readonly string[]): void {
  try { localStorage.setItem(HIDDEN_SOURCES_KEY, JSON.stringify(sources)); } catch { /* private mode */ }
}

/** The Events layer covers the person's own events; each import source has its own switch. */
export function itemShown(item: CalendarItem, layers: Record<CalendarLayer, boolean>, hiddenSources: readonly string[]): boolean {
  if (isImported(item)) return !hiddenSources.includes(sourceOf(item));
  return layers[item.kind];
}
