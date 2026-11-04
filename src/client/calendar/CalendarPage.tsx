// The Bridge's calendar: the person's own events beside the dates the Bridge already keeps
// (checklist deadlines, task revisits, agent runs). Phones start with Agenda and show a week
// as days to open; Day and the desktop week keep their timed grid.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Palette } from "lucide-react";
import type { Task } from "../api";
import { patchChecklistItem } from "../api";
import type { CalendarItem } from "../../shared/calendar";
import Dialog from "../design/Dialog";
import Sheet from "../design/Sheet";
import { Button, ChoiceButton, DisclosureRow, EmptyHint, IconButton, Notice, Section, SegmentedControl, StatusIcon } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { useOverlayParam } from "../hooks/useOverlayParam";
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
import CalendarPhoneHeader, { CalendarWeekDays, type CalendarBack, type CalendarView as View } from "./CalendarPhoneHeader";
import { addCalendarDays, daysBetween, DEFAULT_OWN_COLOR, defaultSourceColor, isCalendarDate, type CalendarColors, type CalendarEvent } from "../../shared/calendar";

const AGENDA_DAYS = 14;
const COMING_UP_DAYS = 21;

interface Props {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  tasks?: Task[];
  mobileBack?: CalendarBack;
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

export default function CalendarPage({ onSelectTask, tasks = [], mobileBack }: Props) {
  const phone = !!mobileBack;
  const queryClient = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { value: overlay, open, close } = useOverlayParam("calendarOverlay");
  const today = toDateKey(new Date());
  const requestedView = params.get("view");
  const view: View = requestedView === "day" || requestedView === "week" || requestedView === "agenda"
    ? requestedView : phone ? "agenda" : "week";
  const requestedDate = params.get("date");
  const date = isCalendarDate(requestedDate) ? requestedDate : today;
  const days = useMemo(() => windowFor(view, date), [view, date]);
  const calendar = useCalendarQuery(days[0], days[days.length - 1]);
  const comingFrom = addDaysKey(days[days.length - 1], 1);
  const comingUp = useCalendarQuery(comingFrom, addDaysKey(comingFrom, COMING_UP_DAYS - 1), { enabled: !phone && view !== "agenda" });
  const [layers, setLayers] = useState(readLayers);
  const [hiddenSources, setHiddenSources] = useState(readHiddenSources);
  const editing = overlay?.startsWith("event:") ? overlay.slice("event:".length) : null;
  const itemId = overlay?.startsWith("item:") ? overlay.slice("item:".length) : null;
  const taskAfterClose = useRef<Parameters<Props["onSelectTask"]> | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, { start: string; end: string }>>(new Map());
  const { showToast, dismissToast } = useToast();
  const data = calendar.data;

  const go = (next: { view?: View; date?: string }) => {
    const nextParams = new URLSearchParams(params);
    if (next.view) nextParams.set("view", next.view);
    if (next.date) nextParams.set("date", next.date);
    setParams(nextParams, { replace: true, state: location.state });
  };
  const openDay = (day: string) => go({ view: "day", date: day });
  const step = view === "day" ? 1 : view === "week" ? 7 : AGENDA_DAYS;
  const earlier = () => go({ date: addDaysKey(date, -step) });
  const later = () => go({ date: addDaysKey(date, step) });
  const goToday = () => go({ date: today });
  const changeView = (view: View) => go({ view });
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
    open(item.kind === "event" && item.eventId ? `event:${item.eventId}` : `item:${item.id}`);
  }, [open]);

  // Pop the item's history entry before opening its task; two simultaneous navigations race.
  useEffect(() => {
    if (overlay !== null || !taskAfterClose.current) return;
    const task = taskAfterClose.current;
    taskAfterClose.current = null;
    onSelectTask(...task);
  }, [overlay, onSelectTask]);

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
  const overdue = data?.overdue ?? [];
  const side = !phone && view !== "agenda";
  const opened = itemId ? data?.items.find((item) => item.id === itemId) ?? overdue.find((item) => item.id === itemId)
    ?? comingUp.data?.items.find((item) => item.id === itemId) : undefined;
  const filters = <>
    <div role="group" aria-label="Show on the calendar" className={DS.choice.group}>
      {(Object.keys(LAYER_LABEL) as CalendarLayer[]).map((layer) => (
        <ChoiceButton key={layer} selected={layers[layer]} onClick={() => toggleLayer(layer)}
          title={layer === "event" && importedSources.length > 0 ? "Events added in the Bridge" : undefined}>
          <span className="inline-flex items-center gap-1.5">
            {layer === "event" ? <EventMark color={colors.own} /> : <KindIcon kind={layer} />}{LAYER_LABEL[layer]}
          </span>
        </ChoiceButton>
      ))}
      {importedSources.length > 0 && !phone && <span aria-hidden="true" className="mx-1 my-2 w-px self-stretch bg-border" />}
      {importedSources.map((source) => (
        <ChoiceButton key={source} selected={!hiddenSources.includes(source)} onClick={() => toggleSource(source)}>
          <span className="inline-flex items-center gap-1.5"><EventMark color={colors.sources[source] ?? defaultSourceColor(source)} />{sourceFilterLabel(source)}</span>
        </ChoiceButton>
      ))}
      {data && <Button size="sm" variant="ghost" className="self-center" aria-haspopup="dialog" onClick={() => open("colors", { replace: overlay === "filters" })}>
        <Palette size={14} aria-hidden="true" />Colors
      </Button>}
    </div>
    <p className={DS.text.meta}>Events don't send alerts yet.</p>
  </>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cx("flex min-h-0 flex-1 flex-col", !phone && "gap-3 px-6 py-5")}>
        {mobileBack ? (
          <CalendarPhoneHeader back={mobileBack} view={view} days={days} today={today} onView={changeView}
            onEarlier={earlier} onLater={later} onToday={goToday} onFilters={() => open("filters")} filtersOpen={overlay === "filters"} />
        ) : <>
          <header className="flex flex-wrap items-center gap-2">
            <h1 className={cx(DS.text.pageTitle, "mr-2")}>{titleFor(view, days, today)}</h1>
            <div className="flex items-center gap-1">
              <IconButton label="Earlier" onClick={earlier}><ChevronLeft size={16} /></IconButton>
              <Button size="sm" variant="secondary" onClick={goToday}>Today</Button>
              <IconButton label="Later" onClick={later}><ChevronRight size={16} /></IconButton>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <SegmentedControl<View> ariaLabel="Calendar view" size="sm" value={view} onChange={changeView}
                options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "agenda", label: "Agenda" }]} />
            </div>
          </header>
          {filters}
        </>}

        {calendar.error && <Notice className={phone ? "mx-3 mt-2" : undefined} tone="danger" title="The calendar couldn't load">{calendar.error.message}</Notice>}
        {data?.eventsTruncated && <Notice className={phone ? "mx-3 mt-2" : undefined} tone="warning" title="Some events aren't shown">This range holds more events than one view can list.</Notice>}

        <div className="flex min-h-0 flex-1 gap-5">
          <div className={cx("flex min-h-0 min-w-0 flex-1 flex-col", phone && view === "day" && "p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]")}>
            {view === "agenda" || (phone && view === "week") ? (
              <div key={phone ? `${view}:${days[0]}` : undefined} className={cx("min-h-0 overflow-y-auto", phone ? "flex-1 overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "pr-1")}>
                {phone && view === "agenda" && <OverdueList disclosure items={overdue} total={data?.overdueTotal ?? 0} colors={colors} onOpen={openItem} />}
                {phone && view === "week" && <CalendarWeekDays days={days} today={today} onDay={openDay} />}
                {data && !(phone && calendar.isPlaceholderData) ? <CalendarAgenda days={days} items={listed} today={today} colors={colors} runCounts={layers.run ? undefined : data.runCounts}
                  onOpenItem={openItem} phone={phone} empty={view === "week" ? "Nothing this week." : "Nothing in these two weeks."} /> : !calendar.error && <EmptyHint>Loading…</EmptyHint>}
              </div>
            ) : (
              <CalendarWeekGrid days={days} data={data} layers={layers} hiddenSources={hiddenSources} onOpenItem={openItem} onOpenDay={openDay}
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

      {overlay === "filters" && <Sheet title="Filters" closeLabel="Close filters" onClose={close}>
        <div className="space-y-3 py-2">{filters}</div>
      </Sheet>}
      {overlay === "colors" && data && <CalendarColorsDialog colors={data.colors} onClose={close} />}
      {editing && <CalendarEventDialog key={editing} eventId={editing} tasks={tasks} onClose={close} onSaved={refresh} />}
      {opened && <ItemDialog item={opened} onClose={close} onSelectTask={(...task) => { taskAfterClose.current = task; close(); }} onChanged={refresh} />}
      {((itemId && !opened) || (overlay === "colors" && !data)) && <Dialog title={itemId ? "Calendar item" : "Event colors"} pending={false} onClose={close}>
        <EmptyHint>{calendar.isLoading || (side && comingUp.isLoading) ? "Loading…" : "Unavailable in this range."}</EmptyHint>
      </Dialog>}
    </div>
  );
}

function OverdueList({ items, total, colors, onOpen, disclosure }: {
  items: CalendarItem[]; total: number; colors: CalendarColors; onOpen: (item: CalendarItem) => void; disclosure?: boolean;
}) {
  if (items.length === 0) return null;
  const shown = disclosure ? items : items.slice(0, 8);
  const rows = <>
    <div className={DS.surface.divided}>
      {shown.map((item) => <AgendaRow key={item.id} item={item} colors={colors} phone={disclosure} onOpen={() => onOpen(item)}
        time={formatShortDate(item.allDay ? item.start : toDateKey(new Date(item.start)))} />)}
    </div>
    {total > shown.length && <p className={cx(DS.text.meta, "px-1.5 pt-1")}>{total - shown.length} more</p>}
  </>;
  return disclosure
    ? <DisclosureRow label="Overdue" meta={total} icon={<StatusIcon kind="danger" decorative />} className={cx(DS.surface.group, "mb-3 px-3 [&>button]:min-h-10")}>{rows}</DisclosureRow>
    : <Section label="Overdue" count={total} level="page" className="mb-3">{rows}</Section>;
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
          {item.taskId && <Button variant="primary" disabled={pending} onClick={() => onSelectTask(item.taskId!, item.checklistItemId ? { checklistItemId: item.checklistItemId } : undefined)}>
            Open task
          </Button>}
        </div>
      </div>
    </Dialog>
  );
}
