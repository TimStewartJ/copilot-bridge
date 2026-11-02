// The week on Home: seven days from today with what is on them, and one line of arithmetic about
// today (what is on now or next, free time, what is due or overdue). Tapping a day opens it.
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { CalendarItem } from "../../shared/calendar";
import { DS, cx } from "../design/tokens";
import { useNow } from "../hooks/useNow";
import { daysFrom, formatClockShort, formatFree, freeMinutes, minutesIntoDay, parseDateKey, toDateKey, wallMinutes } from "./calendar-model";
import { useCalendarQuery } from "./calendar-api";
import { KindIcon, itemDayKeys, readLayers } from "./calendar-ui";

const LINES = 3;

function shortLabel(item: CalendarItem): string {
  return item.allDay ? item.title : `${formatClockShort(item.start)} ${item.title}`;
}

export default function HomeWeekStrip({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const now = useNow(true, 60_000);
  const today = toDateKey(new Date(now));
  const days = useMemo(() => daysFrom(today, 7), [today]);
  const calendar = useCalendarQuery(days[0], days[6]);
  const layers = readLayers();
  const data = calendar.data;

  const byDay = useMemo(() => {
    const map = new Map(days.map((day) => [day, [] as CalendarItem[]]));
    for (const item of data?.items ?? []) {
      if (item.kind === "run" || !layers[item.kind] || item.done) continue;
      for (const day of itemDayKeys(item, days)) map.get(day)!.push(item);
    }
    for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
    return map;
  }, [data, days, layers]);

  const line = useMemo(() => {
    if (!data) return [];
    const todays = byDay.get(today) ?? [];
    const nowMinutes = wallMinutes(now, today);
    // Busy time comes from every event, whatever the calendar shows.
    const allEvents = data.items.filter((item) => item.kind === "event" && itemDayKeys(item, [today]).length > 0);
    const timedEvents = allEvents.filter((item) => !item.allDay && item.end);
    const parts: Array<{ text: string; tone?: "warning" }> = [];
    const current = timedEvents.find((item) => Date.parse(item.start) <= now && Date.parse(item.end!) > now);
    const next = timedEvents.find((item) => Date.parse(item.start) > now);
    if (current) parts.push({ text: `${current.title} until ${formatClockShort(current.end!)}` });
    else if (next) parts.push({ text: `Next: ${formatClockShort(next.start)} ${next.title}` });
    if (!data.eventsTruncated && !allEvents.some((item) => item.allDay)) {
      const busy = timedEvents.map((item) => ({ start: minutesIntoDay(item.start, today), end: minutesIntoDay(item.end!, today) }));
      parts.push({ text: formatFree(freeMinutes(busy, nowMinutes)) });
    }
    const due = todays.filter((item) => item.kind === "deadline").length;
    if (due) parts.push({ text: `${due} due` });
    const revisits = todays.filter((item) => item.kind === "revisit" && Date.parse(item.start) > now).length;
    if (revisits) parts.push({ text: `${revisits} revisit${revisits === 1 ? "" : "s"}` });
    if (data.overdueTotal) parts.push({ text: `${data.overdueTotal} overdue`, tone: "warning" });
    return parts;
  }, [data, byDay, today, now]);

  const open = (day: string) => navigate(`/calendar?view=day&date=${day}`);
  return (
    <section aria-label="This week" className="space-y-2">
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((day) => {
          const date = parseDateKey(day);
          const items = byDay.get(day) ?? [];
          const isToday = day === today;
          return (
            <button key={day} type="button" onClick={() => open(day)}
              aria-label={`${date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}, ${items.length} item${items.length === 1 ? "" : "s"}`}
              className={cx(DS.focus, "flex min-w-0 flex-col rounded-lg border px-1.5 py-1.5 text-left transition-colors hover:bg-bg-hover/60",
                isToday ? "border-text-secondary bg-surface-group" : "border-border-subtle bg-surface-group",
                compact ? "min-h-[3.75rem] items-center" : "min-h-[6.25rem]")}>
              <span className={cx("flex items-baseline gap-1 text-[11px]", isToday ? "font-semibold text-text-primary" : "text-text-secondary")}>
                {date.toLocaleDateString(undefined, { weekday: compact ? "narrow" : "short" })}
                <span className="tabular-nums">{date.getDate()}</span>
              </span>
              {compact ? (
                <span className="mt-1.5 flex flex-wrap justify-center gap-0.5" aria-hidden="true">
                  {items.slice(0, 3).map((item) => item.kind === "event"
                    ? <span key={item.id} className="h-2.5 w-1 rounded-sm bg-text-secondary" />
                    : <KindIcon key={item.id} kind={item.kind} size={10} />)}
                  {items.length > 3 && <span className="text-[10px] leading-none text-text-faint">+{items.length - 3}</span>}
                </span>
              ) : (
                <span className="mt-1 w-full min-w-0 space-y-0.5">
                  {items.slice(0, items.length > LINES ? LINES - 1 : LINES).map((item) => (
                    <span key={item.id} className={cx("flex min-w-0 items-center gap-1 text-[11px] leading-4",
                      item.kind === "event" ? "text-text-primary" : "text-text-secondary")}>
                      {item.kind === "event" ? <span className="h-3 w-0.5 shrink-0 rounded-sm bg-text-secondary" /> : <KindIcon kind={item.kind} size={10} />}
                      <span className="truncate">{shortLabel(item)}</span>
                    </span>
                  ))}
                  {items.length > LINES && <span className="block text-[10.5px] text-text-faint">+{items.length - LINES + 1} more</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className="font-semibold text-text-primary">Today</span>
        {calendar.error ? <span className="text-text-secondary">The calendar couldn't load.</span>
          : !data ? <span className="text-text-faint">Loading…</span>
          : line.length === 0 ? <span className="text-text-secondary">Nothing planned</span>
          : line.map((part, index) => <span key={index} className="flex items-center gap-2">
            {index > 0 && <span className="text-text-faint" aria-hidden="true">·</span>}
            <span className={part.tone === "warning" ? "text-warning" : "text-text-secondary"}>{part.text}</span>
          </span>)}
        <button type="button" onClick={() => navigate(`/calendar?date=${today}`)}
          className={cx(DS.focus, "ml-auto inline-flex items-center gap-1 text-[13px] text-text-secondary hover:text-text-primary")}>
          Calendar<ArrowRight size={13} />
        </button>
      </div>
    </section>
  );
}

