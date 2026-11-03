// The calendar as a list of days: the phone's default, and the desktop's Agenda view.
import type { CalendarColors, CalendarItem } from "../../shared/calendar";
import { EmptyHint } from "../design/primitives";
import { formatClockShort } from "./calendar-model";
import { DS, cx } from "../design/tokens";
import { ItemMark, formatDayHeading, itemContext, itemDayKey, itemDayKeys, itemTime, itemTitle, KindIcon } from "./calendar-ui";

interface Props {
  days: string[];
  items: CalendarItem[];
  today: string;
  runCounts?: Record<string, number>;
  colors: CalendarColors | undefined;
  onOpenItem: (item: CalendarItem) => void;
  empty: string;
}

export function AgendaRow({ item, onOpen, time, colors }: { item: CalendarItem; onOpen: () => void; time?: string; colors: CalendarColors | undefined }) {
  // A timed event shows its start in the time column and its end beneath the title, so neither wraps.
  const until = item.kind === "event" && !item.allDay && item.end && !time ? `Until ${formatClockShort(item.end)}` : undefined;
  const context = [until, itemContext(item)].filter(Boolean).join(" · ") || undefined;
  return (
    <button type="button" onClick={onOpen}
      className={cx(DS.focus, "flex w-full min-w-0 items-start gap-3 rounded-md px-1.5 py-2 text-left hover:bg-bg-hover/60")}>
      <span className={cx(DS.text.meta, "w-[4.5rem] shrink-0 pt-0.5 text-text-secondary")}>{time ?? (until ? formatClockShort(item.start) : itemTime(item))}</span>
      <span className="min-w-0 flex-1">
        <span className={cx("flex min-w-0 items-center gap-1.5 text-[14px] md:text-[13px]",
          item.kind === "event" ? "text-text-primary" : "text-text-secondary", item.done && "line-through text-text-faint")}>
          <ItemMark item={item} colors={colors} />
          <span className="truncate">{itemTitle(item)}</span>
        </span>
        {context && <span className={cx(DS.text.meta, "mt-0.5 block truncate")}>{context}</span>}
      </span>
    </button>
  );
}

export default function CalendarAgenda({ days, items, today, runCounts, colors, onOpenItem, empty }: Props) {
  const groups = days.map((day) => ({ day, items: items.filter((item) => itemDayKeys(item, [day]).length > 0) }))
    .filter((group) => group.items.length > 0 || (runCounts?.[group.day] ?? 0) > 0 || group.day === today);
  if (!groups.some((group) => group.items.length > 0)) return <EmptyHint>{empty}</EmptyHint>;
  return (
    <div className="space-y-4">
      {groups.map(({ day, items: dayItems }) => (
        <section key={day} aria-label={formatDayHeading(day, today)}>
          <h3 className={cx(DS.text.sectionLabel, "mb-1 border-b border-border-subtle pb-1", day === today && "text-text-primary")}>
            {formatDayHeading(day, today)}
          </h3>
          {dayItems.length === 0 && !(runCounts?.[day] ?? 0) && <p className={cx(DS.text.empty, "px-1.5 py-2")}>Nothing planned.</p>}
          <div className={DS.surface.divided}>
            {dayItems.map((item) => <AgendaRow key={`${day}:${item.id}`} item={item} colors={colors} onOpen={() => onOpenItem(item)}
              time={!item.allDay && itemDayKey(item) !== day ? "Continues" : undefined} />)}
          </div>
          {(runCounts?.[day] ?? 0) > 0 && (
            <p className={cx(DS.text.meta, "flex items-center gap-1.5 px-1.5 pt-1")}>
              <KindIcon kind="run" size={11} />{runCounts![day]} agent run{runCounts![day] === 1 ? "" : "s"}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
