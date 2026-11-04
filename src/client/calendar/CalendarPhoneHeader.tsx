import { useLayoutEffect, useRef } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { Button, IconButton, SegmentedControl } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { parseDateKey } from "./calendar-model";

export type CalendarView = "agenda" | "day" | "week";
export type CalendarBack = { label: "Home" | "Task"; onBack: () => void };

export default function CalendarPhoneHeader({ back, view, days, today, onView, onEarlier, onLater, onToday, onFilters, filtersOpen }: {
  back: CalendarBack; view: CalendarView; days: string[]; today: string;
  onView: (view: CalendarView) => void; onEarlier: () => void; onLater: () => void; onToday: () => void;
  onFilters: () => void; filtersOpen: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (document.activeElement !== heading.current) heading.current?.focus({ preventScroll: true });
  }, []);

  const first = parseDateKey(days[0]);
  const last = parseDateKey(days[days.length - 1]);
  const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric",
    weekday: view === "day" ? "short" : undefined,
    year: days.some((day) => day.slice(0, 4) !== today.slice(0, 4)) ? "numeric" : undefined });
  return (
    <header className={cx(DS.surface.pane, "shrink-0 border-b border-surface-edge")}>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center px-2 py-1">
        <Button variant="ghost" size="sm" className="justify-self-start" aria-label={`Back to ${back.label}`} onClick={back.onBack}>
          <ChevronDown size={17} aria-hidden="true" />{back.label}
        </Button>
        <h1 ref={heading} tabIndex={-1} className={cx(DS.text.title, "outline-none")}>Calendar</h1>
        <Button variant="ghost" size="sm" className="justify-self-end" aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={onFilters}>
          <SlidersHorizontal size={15} aria-hidden="true" />Filters
        </Button>
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center justify-between gap-1">
          <h2 aria-live="polite" className={cx(DS.text.sectionTitle, "tabular-nums")}>
            {view === "day" ? format.format(first) : format.formatRange(first, last)}
          </h2>
          <div className="flex shrink-0 items-center">
            <IconButton label="Earlier" onClick={onEarlier}><ChevronLeft size={17} /></IconButton>
            <Button size="sm" variant="ghost" onClick={onToday}>Today</Button>
            <IconButton label="Later" onClick={onLater}><ChevronRight size={17} /></IconButton>
          </div>
        </div>
        <SegmentedControl<CalendarView> ariaLabel="Calendar view" fullWidth value={view} onChange={onView}
          options={[{ value: "agenda", label: "Agenda" }, { value: "day", label: "Day" }, { value: "week", label: "Week" }]} />
      </div>
    </header>
  );
}

/** Seven date targets rather than seven timed columns at phone width. */
export function CalendarWeekDays({ days, today, onDay }: { days: string[]; today: string; onDay: (day: string) => void }) {
  return (
    <div role="group" aria-label="Days of the week" className={cx(DS.surface.group, "mb-3 grid grid-cols-7 divide-x divide-border-subtle")}>
      {days.map((day) => {
        const date = parseDateKey(day);
        const isToday = day === today;
        return (
          <button key={day} type="button" aria-current={isToday ? "date" : undefined} onClick={() => onDay(day)}
            aria-label={`Open ${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`}
            className={cx(DS.focus, "flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 hover:bg-bg-hover/60 first:rounded-l-xl last:rounded-r-xl")}>
            <span className={DS.text.sectionLabel}>{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
            <time dateTime={day} className={cx("flex size-6 items-center justify-center rounded-md text-sm font-semibold tabular-nums",
              isToday ? "bg-text-primary text-bg-primary" : "text-text-primary")}>{date.getDate()}</time>
          </button>
        );
      })}
    </div>
  );
}
