// What every calendar screen shares: how a kind of item looks, how its time reads, and where it
// opens. Kinds are told apart by their glyph (shape first, colour only on the glyph), so the grid
// stays neutral like the rest of the Bridge.
import { Bot, Flag, RotateCcw } from "lucide-react";
import type { CalendarItem, CalendarItemKind } from "../../shared/calendar";
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

/** The block recipe for an item on the grid: events are content; derived dates step back. */
export function itemSurface(item: CalendarItem): string {
  if (item.kind === "event") return "bg-surface-selected text-text-primary border-l-2 border-text-secondary";
  if (item.kind === "run") return "bg-surface-inset text-text-muted border border-border-subtle";
  return cx("bg-surface-inset text-text-secondary border border-border-subtle", item.done && "line-through text-text-faint");
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
