// A task's dates in one place: its revisit, checklist deadlines, events and next agent runs over the
// coming month, with anything overdue first. Hidden when the task has none.
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { CalendarItem } from "../../shared/calendar";
import { Button, Section } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { addDaysKey, toDateKey } from "./calendar-model";
import { useCalendarQuery } from "./calendar-api";
import { KindIcon, KIND_LABEL, formatShortDate, itemDayKey, itemTime } from "./calendar-ui";

const SHOWN = 5;

export default function TaskDatesSection({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const today = toDateKey(new Date());
  const calendar = useCalendarQuery(today, addDaysKey(today, 30), { taskId });
  const rows = useMemo(() => {
    const data = calendar.data;
    if (!data) return [];
    // One line per schedule: its next run says enough.
    const seenSchedules = new Set<string>();
    const upcoming = data.items.filter((item) => {
      if (item.done) return false;
      if (item.kind !== "run") return true;
      if (seenSchedules.has(item.scheduleId ?? item.id)) return false;
      seenSchedules.add(item.scheduleId ?? item.id);
      return true;
    });
    const overdueIds = new Set(data.overdue.map((item) => item.id));
    return [...data.overdue.map((item) => ({ item, overdue: true })),
      ...upcoming.filter((item) => !overdueIds.has(item.id)).map((item) => ({ item, overdue: false }))];
  }, [calendar.data]);
  if (rows.length === 0) return null;

  const when = (item: CalendarItem) => {
    const day = itemDayKey(item);
    const date = day === today ? "Today" : formatShortDate(day);
    return item.allDay ? date : `${date} ${itemTime(item)}`;
  };
  return (
    <Section surface label="Coming up" count={rows.length > SHOWN ? rows.length : undefined}
      action={<Button size="sm" variant="ghost" className="-mr-2" onClick={() => navigate(`/calendar?date=${today}`)}>Calendar<ArrowRight size={13} /></Button>}>
      <div className={DS.surface.divided}>
        {rows.slice(0, SHOWN).map(({ item, overdue }) => (
          <div key={item.id} className="flex min-w-0 items-center gap-2 py-1.5 text-[13px]" title={item.title}>
            <span className={cx("w-28 shrink-0 truncate text-xs tabular-nums", overdue ? "text-warning" : "text-text-secondary")}>
              {overdue ? `${formatShortDate(itemDayKey(item))} · late` : when(item)}
            </span>
            <KindIcon kind={item.kind} />
            <span className="min-w-0 flex-1 truncate text-text-secondary">
              {item.kind === "revisit" ? KIND_LABEL.revisit : item.title}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}
