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
  phone?: boolean;
}

export function AgendaRow({ item, onOpen, time, colors, phone }: {
  item: CalendarItem; onOpen: () => void; time?: string; colors: CalendarColors | undefined; phone?: boolean;
}) {
  // A timed event shows its start in the time column and its end beneath the title, so neither wraps.
  const until = item.kind === "event" && !item.allDay && item.end && !time ? `Until ${formatClockShort(item.end)}` : undefined;
  const context = [until, itemContext(item)].filter(Boolean).join(" · ") || undefined;
  return (
    <button type="button" onClick={onOpen}
      className={cx(DS.focus, phone && DS.row.touch, "flex w-full min-w-0 items-start gap-3 rounded-md px-1.5 py-2 text-left hover:bg-bg-hover/60")}>
      <span className={cx(DS.text.meta, "w-[4.5rem] shrink-0 pt-0.5 text-text-secondary")}>{time ?? (until ? formatClockShort(item.start) : itemTime(item))}</span>
      <span className="min-w-0 flex-1">
        <span className={cx("flex min-w-0 items-center gap-1.5 text-[14px] md:text-[13px]",
          item.kind === "event" ? "text-text-primary" : "text-text-secondary", item.done && "line-through text-text-faint")}>
          <ItemMark item={item} colors={colors} />
          <span className={phone ? "line-clamp-2 break-words" : "truncate"}>{itemTitle(item)}</span>
        </span>
        {context && <span className={cx(DS.text.meta, "mt-0.5 block truncate")}>{context}</span>}
      </span>
    </button>
  );
}

export default function CalendarAgenda({ days, items, today, runCounts, colors, onOpenItem, empty, phone }: Props) {
  const groups = days.map((day) => ({ day, items: items.filter((item) => itemDayKeys(item, [day]).length > 0) }))
    .filter((group) => group.items.length > 0 || (runCounts?.[group.day] ?? 0) > 0 || group.day === today);
  if (!groups.some((group) => group.items.length > 0 || (runCounts?.[group.day] ?? 0) > 0)) return <EmptyHint>{empty}</EmptyHint>;
  return (
    <div className={phone ? cx(DS.surface.group, "overflow-hidden") : "space-y-4"}>
      {groups.map(({ day, items: dayItems }) => (
        <section key={day} aria-label={formatDayHeading(day, today)}>
          <h3 className={phone ? cx(DS.collection.header, DS.text.sectionTitle, "px-3")
            : cx(DS.text.sectionLabel, "mb-1 border-b border-border-subtle pb-1", day === today && "text-text-primary")}>
            {formatDayHeading(day, today)}
          </h3>
          {dayItems.length === 0 && !(runCounts?.[day] ?? 0) && <p className={cx(DS.text.empty, phone ? "px-3 py-2" : "px-1.5 py-2")}>Nothing planned.</p>}
          <div className={cx(DS.surface.divided, phone && "px-1.5")}>
            {dayItems.map((item) => <AgendaRow key={`${day}:${item.id}`} item={item} colors={colors} phone={phone} onOpen={() => onOpenItem(item)}
              time={!item.allDay && itemDayKey(item) !== day ? "Continues" : undefined} />)}
          </div>
          {(runCounts?.[day] ?? 0) > 0 && (
            <p className={cx(DS.text.meta, "flex items-center gap-1.5", phone ? "px-3 py-2" : "px-1.5 pt-1")}>
              <KindIcon kind="run" size={11} />{runCounts![day]} agent run{runCounts![day] === 1 ? "" : "s"}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
