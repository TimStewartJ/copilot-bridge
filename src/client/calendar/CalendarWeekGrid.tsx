// The week (or single-day) grid: an all-day row, a row that counts agent runs when their layer is
// hidden, and 24 hours of timed items laid into lanes. Events can be dragged to another time or
// day, and their bottom edge dragged to change when they end. Other dates open where they live.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CalendarItem, CalendarResponse } from "../../shared/calendar";
import { DS, cx } from "../design/tokens";
import { useNow } from "../hooks/useNow";
import { haptic } from "../lib/haptics";
import { addDaysKey, draggedTimes, layoutLanes, minutesIntoDay, parseDateKey, snapMinutes, toDateKey, wallMinutes, type DragChange } from "./calendar-model";
import { KindIcon, itemDayKeys, itemSurface, itemTime, itemTitle, type CalendarLayer } from "./calendar-ui";

const HOUR_PX = 48;
const ALL_DAY_SHOWN = 3;
/** A mouse drag starts once the pointer has moved this far; less is a click. */
const DRAG_THRESHOLD_PX = 4;
/** On a touch screen an event is picked up by holding it, so a swipe still scrolls. */
const TOUCH_HOLD_MS = 350;

export interface EventMove {
  item: CalendarItem;
  /** Timed: ISO instants. All-day: dates, end inclusive. */
  start: string;
  end: string;
}

interface Props {
  days: string[];
  data: CalendarResponse | undefined;
  layers: Record<CalendarLayer, boolean>;
  onOpenItem: (item: CalendarItem) => void;
  onOpenDay: (day: string) => void;
  /** Changes an event's time; resolves once saved. */
  onMoveEvent: (move: EventMove) => Promise<void>;
  /** Times shown for events whose move is still being saved. */
  pending: ReadonlyMap<string, { start: string; end: string }>;
}

interface Drag {
  item: CalendarItem;
  mode: DragChange["mode"];
  /** All-day items move between days only. */
  allDay: boolean;
  originDay: string;
  startX: number;
  startY: number;
  pointerId: number;
  /** Touch drags wait for the hold before they move anything. */
  armed: boolean;
  moved: boolean;
  change: DragChange;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "";
  const h12 = hour % 12 || 12;
  return `${h12} ${hour < 12 ? "AM" : "PM"}`;
}

function nextTimes(item: CalendarItem, change: DragChange): { start: string; end: string } {
  if (item.allDay) return { start: addDaysKey(item.start, change.dayOffset), end: addDaysKey(item.end ?? item.start, change.dayOffset) };
  return draggedTimes(item.start, item.end ?? item.start, change);
}

export default function CalendarWeekGrid({ days, data, layers, onOpenItem, onOpenDay, onMoveEvent, pending }: Props) {
  const now = useNow(true, 60_000);
  const today = toDateKey(new Date(now));
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const columns = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<Drag | null>(null);
  const holdTimer = useRef<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const dayUnder = useCallback((clientX: number): string | null => {
    for (const [day, element] of columns.current) {
      const rect = element.getBoundingClientRect();
      if (clientX >= rect.left && clientX < rect.right) return day;
    }
    return null;
  }, []);

  // While a drag is live the item is drawn where it would land.
  const visible = useMemo(() => (data?.items ?? []).filter((item) => layers[item.kind]).map((item) => {
    if (drag?.moved && drag.item.id === item.id) return { ...item, ...nextTimes(item, drag.change) };
    const saving = item.eventId ? pending.get(item.id) : undefined;
    return saving ? { ...item, ...saving } : item;
  }), [data, layers, drag, pending]);
  const byDay = useMemo(() => {
    const allDay = new Map<string, CalendarItem[]>();
    const timed = new Map<string, CalendarItem[]>();
    for (const day of days) { allDay.set(day, []); timed.set(day, []); }
    for (const item of visible) {
      for (const day of itemDayKeys(item, days)) (item.allDay ? allDay : timed).get(day)?.push(item);
    }
    return { allDay, timed };
  }, [visible, days]);

  const key = days.join(",");
  useLayoutEffect(() => {
    if (!scroller.current || scrolledFor.current === key) return;
    scrolledFor.current = key;
    const nowHour = new Date(now).getHours();
    const hour = days.includes(today) && nowHour > 8 ? Math.min(nowHour - 1, 17) : 7;
    scroller.current.scrollTop = Math.max(0, hour * HOUR_PX - HOUR_PX / 3);
  }, [key, days, today, now]);

  const endDrag = useCallback(() => {
    if (holdTimer.current !== null) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
    dragRef.current = null;
    setDrag(null);
  }, []);

  // The listeners live for one drag and read it from the ref, so they are attached once per drag.
  useEffect(() => {
    if (!drag) return;
    const update = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (!current.armed) {
        // A touch that travels before the hold is a scroll, not a drag.
        if (Math.hypot(dx, dy) > 8) endDrag();
        return;
      }
      if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      const day = dayUnder(event.clientX) ?? current.originDay;
      const change: DragChange = {
        mode: current.mode,
        dayOffset: current.mode === "move" ? Math.round((parseDateKey(day).getTime() - parseDateKey(current.originDay).getTime()) / 86_400_000) : 0,
        minuteDelta: current.allDay ? 0 : snapMinutes(dy, HOUR_PX),
      };
      const next = { ...current, moved: true, change };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      endDrag();
      if (!current.moved) {
        if (current.armed || event.type === "pointerup") onOpenItem(current.item);
        return;
      }
      if (current.change.dayOffset === 0 && current.change.minuteDelta === 0) return;
      haptic("light");
      void onMoveEvent({ item: current.item, ...nextTimes(current.item, current.change) });
    };
    const cancel = (event: PointerEvent) => {
      if (dragRef.current && event.pointerId === dragRef.current.pointerId) endDrag();
    };
    // A held touch drag must not scroll the page beneath it.
    const holdScroll = (event: TouchEvent) => { if (dragRef.current?.armed) event.preventDefault(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") endDrag(); };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", holdScroll, { passive: false });
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", holdScroll);
      window.removeEventListener("keydown", escape);
    };
  }, [drag !== null, dayUnder, endDrag, onMoveEvent, onOpenItem]);

  const startDrag = (item: CalendarItem, mode: DragChange["mode"], day: string) => (event: ReactPointerEvent) => {
    if (event.button !== 0 || item.kind !== "event" || !item.eventId) return;
    event.stopPropagation();
    const touch = event.pointerType === "touch";
    const next: Drag = {
      item, mode, allDay: item.allDay, originDay: day, startX: event.clientX, startY: event.clientY,
      pointerId: event.pointerId, armed: !touch, moved: false, change: { mode, dayOffset: 0, minuteDelta: 0 },
    };
    dragRef.current = next;
    setDrag(next);
    if (touch) {
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        if (!dragRef.current) return;
        dragRef.current = { ...dragRef.current, armed: true };
        setDrag(dragRef.current);
        haptic("medium");
      }, TOUCH_HOLD_MS);
    }
  };

  const multiDay = days.length > 1;
  const gridColumns = { gridTemplateColumns: `3.25rem repeat(${days.length}, minmax(0, 1fr))` };
  const dragging = drag?.armed ? drag.item.id : null;
  return (
    <div className={cx(DS.surface.group, "flex min-h-0 flex-1 flex-col overflow-hidden", drag?.moved && (drag.mode === "resize" ? "cursor-ns-resize select-none" : "cursor-grabbing select-none"))}>
      <div className="grid border-b border-border-subtle" style={gridColumns}>
        <div />
        {days.map((day) => {
          const date = parseDateKey(day);
          const isToday = day === today;
          return (
            <button key={day} type="button" onClick={() => onOpenDay(day)}
              className={cx(DS.focus, "flex min-w-0 items-baseline gap-1.5 border-l border-border-subtle px-2 py-2 text-left hover:bg-bg-hover/60")}>
              <span className={cx("text-xs", isToday ? "font-semibold text-text-primary" : "text-text-secondary")}>
                {date.toLocaleDateString(undefined, { weekday: multiDay ? "short" : "long" })}
              </span>
              <span className={cx("text-[15px] tabular-nums", isToday
                ? "-my-0.5 rounded-md bg-text-primary px-1.5 py-0.5 font-semibold text-bg-primary"
                : "font-medium text-text-primary")}>{date.getDate()}</span>
            </button>
          );
        })}
      </div>
      <div className="grid border-b border-border-subtle" style={gridColumns}>
        <div className={cx(DS.text.meta, "px-1.5 py-1.5 text-right")}>all day</div>
        {days.map((day) => {
          const items = byDay.allDay.get(day) ?? [];
          const hidden = multiDay ? items.length - ALL_DAY_SHOWN : 0;
          return (
            <div key={day} className="min-w-0 space-y-0.5 border-l border-border-subtle p-1">
              {items.slice(0, hidden > 0 ? ALL_DAY_SHOWN - 1 : ALL_DAY_SHOWN).map((item) => (
                <button key={item.id} type="button"
                  onPointerDown={item.kind === "event" ? startDrag(item, "move", day) : undefined}
                  onClick={item.kind === "event" ? undefined : () => onOpenItem(item)}
                  onKeyDown={(event) => { if (item.kind === "event" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpenItem(item); } }}
                  title={`${itemTitle(item)}${item.taskTitle ? ` · ${item.taskTitle}` : ""}`}
                  className={cx(DS.focus, itemSurface(item), "flex w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11.5px] leading-4",
                    item.kind === "event" && "cursor-grab touch-manipulation select-none", dragging === item.id && "opacity-80 ring-1 ring-text-secondary")}>
                  <KindIcon kind={item.kind} size={11} />
                  <span className="truncate">{itemTitle(item)}</span>
                </button>
              ))}
              {hidden > 0 && <button type="button" onClick={() => onOpenDay(day)} className={cx(DS.focus, DS.text.meta, "px-1.5 hover:text-text-primary")}>
                +{hidden + 1} more
              </button>}
            </div>
          );
        })}
      </div>
      {!layers.run && data && Object.keys(data.runCounts).length > 0 && (
        <div className="grid border-b border-border-subtle" style={gridColumns}>
          <div className={cx(DS.text.meta, "px-1.5 py-1 text-right")}>agents</div>
          {days.map((day) => (
            <div key={day} className={cx(DS.text.meta, "flex items-center gap-1 border-l border-border-subtle px-2 py-1")}>
              {data.runCounts[day] ? <><KindIcon kind="run" size={11} />{data.runCounts[day]} run{data.runCounts[day] === 1 ? "" : "s"}</> : null}
            </div>
          ))}
        </div>
      )}
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="grid" style={{ ...gridColumns, height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className={cx(DS.text.meta, "absolute right-1.5 -translate-y-1/2")} style={{ top: hour * HOUR_PX }}>{hourLabel(hour)}</div>
            ))}
          </div>
          {days.map((day) => (
            <DayColumn key={day} day={day} items={byDay.timed.get(day) ?? []} isToday={day === today} now={now}
              columnRef={(element) => { if (element) columns.current.set(day, element); else columns.current.delete(day); }}
              dragging={dragging} onOpenItem={onOpenItem} startDrag={startDrag} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({ day, items, isToday, now, columnRef, dragging, onOpenItem, startDrag }: {
  day: string; items: CalendarItem[]; isToday: boolean; now: number; dragging: string | null;
  columnRef: (element: HTMLDivElement | null) => void;
  onOpenItem: (item: CalendarItem) => void;
  startDrag: (item: CalendarItem, mode: DragChange["mode"], day: string) => (event: ReactPointerEvent) => void;
}) {
  const placed = useMemo(() => {
    const spans = items.map((item) => {
      const start = minutesIntoDay(item.start, day);
      const end = item.kind === "event" && item.end ? minutesIntoDay(item.end, day) : start + 30;
      return { id: item.id, start, end };
    });
    const lanes = new Map(layoutLanes(spans, 24).map((lane) => [lane.id, lane]));
    return items.map((item, index) => ({ item, span: spans[index], lane: lanes.get(item.id)! }));
  }, [items, day]);
  const nowLine = isToday ? wallMinutes(now, day) : null;

  return (
    <div ref={columnRef} className="relative border-l border-border-subtle">
      {Array.from({ length: 24 }, (_, hour) => (
        <div key={hour} className="pointer-events-none absolute inset-x-0 border-t border-border-subtle" style={{ top: hour * HOUR_PX }} />
      ))}
      {placed.map(({ item, span, lane }) => {
        const event = item.kind === "event";
        const height = Math.max(event ? 22 : 20, ((span.end - span.start) / 60) * HOUR_PX - 2);
        const width = 100 / lane.lanes;
        // The end can be dragged only where the event ends, not on a day it merely runs through.
        const endsHere = event && !!item.end && itemDayKeys({ ...item, start: item.end, end: item.end }, [day]).length > 0
          && Date.parse(item.end) > Date.parse(item.start);
        return (
          <div key={item.id}
            className={cx(itemSurface(item), "group absolute overflow-hidden rounded-md text-[11.5px] leading-[1.3]",
              event && "touch-manipulation select-none", dragging === item.id && "z-20 opacity-90 ring-1 ring-text-secondary")}
            style={{ top: (span.start / 60) * HOUR_PX + 1, height, left: `calc(${lane.lane * width}% + 2px)`, width: `calc(${width}% - 4px)` }}>
            <button type="button"
              onPointerDown={event ? startDrag(item, "move", day) : undefined}
              onClick={event ? undefined : () => onOpenItem(item)}
              onKeyDown={(keyEvent) => { if (event && (keyEvent.key === "Enter" || keyEvent.key === " ")) { keyEvent.preventDefault(); onOpenItem(item); } }}
              title={`${itemTime(item)} · ${itemTitle(item)}${item.taskTitle && item.kind !== "revisit" ? ` · ${item.taskTitle}` : ""}`}
              className={cx(DS.focus, "block h-full w-full px-1.5 py-0.5 text-left", event && "cursor-grab")}>
              <span className="flex min-w-0 items-center gap-1">
                <KindIcon kind={item.kind} size={11} />
                <span className={cx("truncate", event && "font-medium")}>{itemTitle(item)}</span>
              </span>
              {height >= 34 && <span className="block truncate opacity-75">{itemTime(item)}{item.location ? ` · ${item.location}` : ""}</span>}
            </button>
            {endsHere && (
              <div aria-hidden="true" onPointerDown={startDrag(item, "resize", day)}
                className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize touch-manipulation">
                <div className="mx-auto mt-0.5 h-0.5 w-6 rounded-sm bg-text-secondary opacity-0 transition-opacity group-hover:opacity-60" />
              </div>
            )}
          </div>
        );
      })}
      {nowLine !== null && nowLine >= 0 && nowLine <= 24 * 60 && (
        <div className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-error" style={{ top: (nowLine / 60) * HOUR_PX }} aria-hidden="true" />
      )}
    </div>
  );
}
