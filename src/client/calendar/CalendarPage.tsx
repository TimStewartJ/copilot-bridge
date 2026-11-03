// The Bridge's calendar: the person's own events beside the dates the Bridge already keeps
// (checklist deadlines, task revisits, agent runs). Week and Day lay them on a grid; Agenda lists
// them, and is where a phone starts.
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Palette } from "lucide-react";
import type { Task } from "../api";
import { patchChecklistItem } from "../api";
import type { CalendarItem } from "../../shared/calendar";
import Dialog from "../design/Dialog";
import { Button, ChoiceButton, EmptyHint, IconButton, Notice, Section, SegmentedControl } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { useIsMobile } from "../useIsMobile";
import { useToast } from "../useToast";
import { haptic } from "../lib/haptics";
import { addDaysKey, daysFrom, parseDateKey, toDateKey, weekStartKey } from "./calendar-model";
import { calendarRootKey, fetchCalendarEvent, updateCalendarEvent, useCalendarQuery } from "./calendar-api";
import { EventMark, KIND_LABEL, KindIcon, LAYER_LABEL, formatShortDate, itemContext, itemShown, itemTime, itemTitle, readHiddenSources, readLayers,
  sourceFilterLabel, writeHiddenSources, writeLayers, type CalendarLayer } from "./calendar-ui";
import CalendarWeekGrid, { type EventMove } from "./CalendarWeekGrid";
import CalendarAgenda, { AgendaRow } from "./CalendarAgenda";
import CalendarEventDialog from "./CalendarEventDialog";
import CalendarColorsDialog from "./CalendarColorsDialog";
import { addCalendarDays, daysBetween, DEFAULT_OWN_COLOR, defaultSourceColor, type CalendarColors, type CalendarEvent } from "../../shared/calendar";

type View = "day" | "week" | "agenda";
const AGENDA_DAYS = 14;
const COMING_UP_DAYS = 21;

interface Props {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  tasks?: Task[];
}

function windowFor(view: View, date: string): string[] {
  if (view === "day") return [date];
  if (view === "week") return daysFrom(weekStartKey(date), 7);
  return daysFrom(date, AGENDA_DAYS);
}

function titleFor(view: View, days: string[], today: string): string {
  const first = parseDateKey(days[0]);
  if (view === "day") return days[0] === today ? "Today" : first.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  if (view === "week") return `Week of ${first.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  return days[0] === today ? "Next two weeks" : `From ${formatShortDate(days[0])}`;
}

export default function CalendarPage({ onSelectTask, tasks = [] }: Props) {
  const phone = useIsMobile();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const today = toDateKey(new Date());
  const view: View = params.get("view") === "day" || params.get("view") === "week" || params.get("view") === "agenda"
    ? params.get("view") as View : phone ? "agenda" : "week";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date")! : today;
  const days = useMemo(() => windowFor(view, date), [view, date]);
  const calendar = useCalendarQuery(days[0], days[days.length - 1]);
  const comingFrom = addDaysKey(days[days.length - 1], 1);
  const comingUp = useCalendarQuery(comingFrom, addDaysKey(comingFrom, COMING_UP_DAYS - 1), { enabled: !phone && view !== "agenda" });
  const [layers, setLayers] = useState(readLayers);
  const [hiddenSources, setHiddenSources] = useState(readHiddenSources);
  const [editing, setEditing] = useState<string | null>(null);
  const [opened, setOpened] = useState<CalendarItem | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, { start: string; end: string }>>(new Map());
  const { showToast, dismissToast } = useToast();
  const data = calendar.data;

  const go = (next: { view?: View; date?: string }) => {
    const nextParams = new URLSearchParams(params);
    if (next.view) nextParams.set("view", next.view);
    if (next.date) nextParams.set("date", next.date);
    setParams(nextParams, { replace: true });
  };
  const step = view === "day" ? 1 : view === "week" ? 7 : AGENDA_DAYS;
  const toggleLayer = (layer: CalendarLayer) => setLayers((current) => {
    const next = { ...current, [layer]: !current[layer] };
    writeLayers(next);
    return next;
  });
  const toggleSource = (source: string) => setHiddenSources((current) => {
    const next = current.includes(source) ? current.filter((entry) => entry !== source) : [...current, source];
    writeHiddenSources(next);
    return next;
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: calendarRootKey });
  const openItem = useCallback((item: CalendarItem) => {
    if (item.kind === "event" && item.eventId) setEditing(item.eventId);
    else setOpened(item);
  }, []);

  // A drag changes the event itself: its first occurrence shifts by what this one moved, so every
  // repeat moves alike. The new place shows until the calendar has reloaded.
  const moveEvent = useCallback(async ({ item, start, end }: EventMove) => {
    if (!item.eventId) return;
    const hold = (next: { start: string; end: string } | null) => setPending((current) => {
      const map = new Map(current);
      if (next) map.set(item.id, next); else map.delete(item.id);
      return map;
    });
    hold({ start, end });
    let before: CalendarEvent | null = null;
    try {
      before = await fetchCalendarEvent(item.eventId);
      const shifted = item.allDay
        ? { start: addCalendarDays(before.start, daysBetween(item.start, start)), end: addCalendarDays(before.end, daysBetween(item.end ?? item.start, end)) }
        : { start: new Date(Date.parse(before.start) + Date.parse(start) - Date.parse(item.start)).toISOString(),
          end: new Date(Date.parse(before.end) + Date.parse(end) - Date.parse(item.end ?? item.start)).toISOString() };
      await updateCalendarEvent(item.eventId, shifted);
      await queryClient.invalidateQueries({ queryKey: calendarRootKey });
      const original = { start: before.start, end: before.end };
      const verb = start === item.start ? "Changed" : "Moved";
      const toastId = showToast({
        tone: "success", haptic: false,
        title: before.repeat ? `${verb} every repeat of ${before.title}` : `${verb} ${before.title}`,
        action: { label: "Undo", icon: "undo", onAction: async () => {
          await updateCalendarEvent(item.eventId!, original);
          await queryClient.invalidateQueries({ queryKey: calendarRootKey });
          dismissToast(toastId);
        } },
      });
    } catch (cause) {
      showToast({ tone: "error", title: "The event wasn't moved", description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      hold(null);
    }
  }, [queryClient, showToast, dismissToast]);

  const listed = (data?.items ?? []).filter((item) => itemShown(item, layers, hiddenSources));
  const importedSources = data?.importedSources ?? [];
  const colors: CalendarColors = data?.colors ?? { own: DEFAULT_OWN_COLOR, sources: {} };
  const [coloring, setColoring] = useState(false);
  const overdue = data?.overdue ?? [];
  const side = !phone && view !== "agenda";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cx("flex min-h-0 flex-1 flex-col gap-3", phone ? "overflow-y-auto px-4 py-4" : "px-6 py-5")}>
        <header className="flex flex-wrap items-center gap-2">
          <h1 className={cx(DS.text.pageTitle, "mr-2")}>{titleFor(view, days, today)}</h1>
          <div className="flex items-center gap-1">
            <IconButton label="Earlier" onClick={() => go({ date: addDaysKey(date, -step) })}><ChevronLeft size={16} /></IconButton>
            <Button size="sm" variant="secondary" onClick={() => go({ date: today })}>Today</Button>
            <IconButton label="Later" onClick={() => go({ date: addDaysKey(date, step) })}><ChevronRight size={16} /></IconButton>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <SegmentedControl<View> ariaLabel="Calendar view" size="sm" value={view} onChange={(next) => go({ view: next })}
              options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "agenda", label: "Agenda" }]} />
          </div>
        </header>

        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div role="group" aria-label="Show on the calendar" className={DS.choice.group}>
            {(Object.keys(LAYER_LABEL) as CalendarLayer[]).map((layer) => (
              <ChoiceButton key={layer} selected={layers[layer]} onClick={() => toggleLayer(layer)}
                title={layer === "event" && importedSources.length > 0 ? "Events added in the Bridge" : undefined}>
                <span className="inline-flex items-center gap-1.5">
                  {layer === "event" ? <EventMark color={colors.own} /> : <KindIcon kind={layer} />}{LAYER_LABEL[layer]}
                </span>
              </ChoiceButton>
            ))}
            {importedSources.length > 0 && <span aria-hidden="true" className="mx-1 my-2 w-px self-stretch bg-border" />}
            {importedSources.map((source) => (
              <ChoiceButton key={source} selected={!hiddenSources.includes(source)} onClick={() => toggleSource(source)}>
                <span className="inline-flex items-center gap-1.5"><EventMark color={colors.sources[source] ?? defaultSourceColor(source)} />{sourceFilterLabel(source)}</span>
              </ChoiceButton>
            ))}
            {data && <Button size="sm" variant="ghost" className="self-center" onClick={() => setColoring(true)}><Palette size={14} />Colors</Button>}
          </div>
        </div>
        <p className={DS.text.meta}>Events don't send alerts yet.</p>

        {calendar.error && <Notice tone="danger" title="The calendar couldn't load">{calendar.error.message}</Notice>}
        {data?.eventsTruncated && <Notice tone="warning" title="Some events aren't shown">This range holds more events than one view can list.</Notice>}

        <div className={cx("flex min-h-0 flex-1 gap-5", phone && "flex-col")}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {view === "agenda" ? (
              <div className={cx(!phone && "min-h-0 overflow-y-auto pr-1")}>
                {phone && overdue.length > 0 && <OverdueList items={overdue} total={data?.overdueTotal ?? 0} colors={colors} onOpen={openItem} />}
                {data ? <CalendarAgenda days={days} items={listed} today={today} colors={colors} runCounts={layers.run ? undefined : data.runCounts}
                  onOpenItem={openItem} empty="Nothing in these two weeks." /> : <EmptyHint>Loading…</EmptyHint>}
              </div>
            ) : (
              <CalendarWeekGrid days={days} data={data} layers={layers} hiddenSources={hiddenSources} onOpenItem={openItem} onOpenDay={(day) => go({ view: "day", date: day })}
                onMoveEvent={moveEvent} pending={pending} />
            )}
          </div>
          {side && (
            <aside className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto lg:flex">
              <OverdueList items={overdue} total={data?.overdueTotal ?? 0} colors={colors} onOpen={openItem} />
              <Section label="Coming up" level="page">
                {comingUp.data ? (() => {
                  const upcoming = comingUp.data.items.filter((item) => item.kind !== "run" && itemShown(item, layers, hiddenSources) && !item.done);
                  return upcoming.length === 0 ? <EmptyHint>Nothing in the following three weeks.</EmptyHint> : (
                    <div className={DS.surface.divided}>
                      {upcoming.slice(0, 12).map((item) => <AgendaRow key={item.id} item={item} colors={comingUp.data!.colors} onOpen={() => openItem(item)}
                        time={formatShortDate(item.allDay ? item.start : toDateKey(new Date(item.start)))} />)}
                    </div>
                  );
                })() : <EmptyHint>Loading…</EmptyHint>}
              </Section>
              {(data?.undatedChecklistCount ?? 0) > 0 && <p className={DS.text.meta}>{data!.undatedChecklistCount} open checklist items have no date.</p>}
            </aside>
          )}
        </div>
      </div>

      {editing && <CalendarEventDialog eventId={editing} tasks={tasks} onClose={() => setEditing(null)} onSaved={refresh} />}
      {coloring && data && <CalendarColorsDialog colors={data.colors} onClose={() => setColoring(false)} />}
      {opened && <ItemDialog item={opened} onClose={() => setOpened(null)} onSelectTask={onSelectTask} onChanged={refresh} />}
    </div>
  );
}

function OverdueList({ items, total, colors, onOpen }: { items: CalendarItem[]; total: number; colors: CalendarColors; onOpen: (item: CalendarItem) => void }) {
  if (items.length === 0) return null;
  return (
    <Section label="Overdue" count={total} level="page" className="mb-3">
      <div className={DS.surface.divided}>
        {items.slice(0, 8).map((item) => <AgendaRow key={item.id} item={item} colors={colors} onOpen={() => onOpen(item)}
          time={formatShortDate(item.allDay ? item.start : toDateKey(new Date(item.start)))} />)}
      </div>
      {total > 8 && <p className={cx(DS.text.meta, "px-1.5 pt-1")}>{total - 8} more</p>}
    </Section>
  );
}

/** A date that lives somewhere else in the Bridge: say what it is and open where it is kept. */
function ItemDialog({ item, onClose, onSelectTask, onChanged }: {
  item: CalendarItem; onClose: () => void; onChanged: () => void;
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const context = itemContext(item);
  const when = item.allDay ? parseDateKey(item.start).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    : `${new Date(item.start).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · ${itemTime(item)}`;
  async function markDone() {
    if (!item.checklistItemId) return;
    setPending(true); setError("");
    try {
      await patchChecklistItem(item.checklistItemId, { done: !item.done });
      haptic(item.done ? "selection" : "light");
      onChanged();
      onClose();
    } catch (cause) {
      haptic("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog title={itemTitle(item)} pending={pending} onClose={onClose}>
      <div className="space-y-3">
        <p className="flex items-center gap-1.5 text-[13px] text-text-secondary"><KindIcon kind={item.kind} />{KIND_LABEL[item.kind]} · {when}</p>
        {context && <p className={DS.text.prose}>{item.kind === "revisit" ? null : context}</p>}
        {item.kind === "run" && <p className={DS.text.prose}>A scheduled agent run. It doesn't take your time.</p>}
        {error && <Notice tone="danger" title="Not saved">{error}</Notice>}
        <div className="flex flex-wrap justify-end gap-2">
          {item.kind === "deadline" && <Button disabled={pending} onClick={() => void markDone()}>{item.done ? "Not done" : "Mark done"}</Button>}
          {item.taskId && <Button variant="primary" disabled={pending} onClick={() => { onClose(); onSelectTask(item.taskId!, item.checklistItemId ? { checklistItemId: item.checklistItemId } : undefined); }}>
            Open task
          </Button>}
        </div>
      </div>
    </Dialog>
  );
}
