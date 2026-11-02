// Changing one of the Bridge's own events; agents add them. A repeating event is edited as a whole
// series: the form shows the series' first occurrence, whichever repeat was clicked.
import { useEffect, useId, useState } from "react";
import type { Task } from "../api";
import type { CalendarEvent, CalendarRepeatEvery } from "../../shared/calendar";
import Dialog from "../design/Dialog";
import { Button, FormRow, Notice, Select, Switch, TextArea, TextInput } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { haptic } from "../lib/haptics";
import { addDaysKey, parseDateKey, toDateKey } from "./calendar-model";
import { deleteCalendarEvent, fetchCalendarEvent, updateCalendarEvent, viewerTimeZone, type CalendarEventInput } from "./calendar-api";

interface Props {
  eventId: string;
  tasks: Task[];
  onClose: () => void;
  onSaved: () => void;
}

interface Form {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  repeat: "" | CalendarRepeatEvery;
  interval: string;
  until: string;
  location: string;
  notes: string;
  taskId: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

function fromEvent(event: CalendarEvent): Form {
  const base = { title: event.title, allDay: event.allDay, repeat: event.repeat?.every ?? "", interval: String(event.repeat?.interval ?? 1),
    until: event.repeat?.until ?? "", location: event.location ?? "", notes: event.notes ?? "", taskId: event.taskId ?? "" } as const;
  if (event.allDay) return { ...base, startDate: event.start, endDate: event.end, startTime: "09:00", endTime: "10:00" };
  const start = new Date(event.start);
  const end = new Date(event.end);
  return { ...base, startDate: toDateKey(start), startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
    endDate: toDateKey(end), endTime: `${pad(end.getHours())}:${pad(end.getMinutes())}` };
}

function instant(date: string, time: string): string {
  const day = parseDateKey(date);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).toISOString();
}

export default function CalendarEventDialog({ eventId, tasks, onClose, onSaved }: Props) {
  const id = useId();
  const [existing, setExisting] = useState<CalendarEvent | null>(null);
  const [initial, setInitial] = useState<Form | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let live = true;
    fetchCalendarEvent(eventId)
      .then((event) => { if (live) { setExisting(event); setForm(fromEvent(event)); setInitial(fromEvent(event)); } })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [eventId]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => current && { ...current, [key]: value });

  async function run(action: () => Promise<unknown>) {
    setPending(true); setError("");
    try {
      await action();
      haptic("success");
      onSaved();
      onClose();
    } catch (cause) {
      haptic("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  function save() {
    if (!form || !existing || !initial) return;
    const full = toInput(form);
    // Send only what changed, so an untouched start or end keeps its exact instant.
    const changes: CalendarEventInput = {};
    if ((["allDay", "startDate", "startTime", "endDate", "endTime"] as const).some((key) => form[key] !== initial[key])) {
      Object.assign(changes, { allDay: full.allDay, start: full.start, end: full.end });
    }
    if (form.title.trim() !== initial.title) changes.title = full.title;
    if (form.repeat !== initial.repeat || form.interval !== initial.interval || form.until !== initial.until) changes.repeat = full.repeat;
    if (form.location.trim() !== initial.location) changes.location = full.location;
    if (form.notes.trim() !== initial.notes) changes.notes = full.notes;
    if (form.taskId !== initial.taskId) changes.taskId = full.taskId;
    if (Object.keys(changes).length === 0) { onClose(); return; }
    void run(() => updateCalendarEvent(existing.id, changes));
  }

  function toInput(form: Form): CalendarEventInput {
    return {
      title: form.title.trim(),
      allDay: form.allDay,
      start: form.allDay ? form.startDate : instant(form.startDate, form.startTime),
      end: form.allDay ? (form.endDate < form.startDate ? form.startDate : form.endDate) : instant(form.endDate, form.endTime),
      timezone: existing?.timezone ?? viewerTimeZone(),
      repeat: form.repeat ? { every: form.repeat, interval: Math.max(1, Math.min(99, Number(form.interval) || 1)), ...(form.until ? { until: form.until } : {}) } : null,
      location: form.location.trim() || null,
      notes: form.notes.trim() || null,
      taskId: form.taskId || null,
    };
  }

  const activeTasks = tasks.filter((task) => task.status === "active" || task.id === form?.taskId);
  return (
    <Dialog title="Edit event" pending={pending} onClose={onClose}>
      {!form ? <p className={DS.text.empty}>{error || "Loading…"}</p> : (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <FormRow label="Title" htmlFor={`${id}-title`}>
            <TextInput id={`${id}-title`} value={form.title} disabled={pending} required maxLength={200}
              onChange={(event) => set("title", event.target.value)} />
          </FormRow>
          <FormRow label="All day" htmlFor={`${id}-allday`}>
            <Switch id={`${id}-allday`} checked={form.allDay} disabled={pending} onChange={(event) => set("allDay", event.target.checked)} />
          </FormRow>
          <FormRow label="Starts" htmlFor={`${id}-start`}>
            <div className="flex gap-2">
              <TextInput id={`${id}-start`} type="date" value={form.startDate} disabled={pending} required
                onChange={(event) => {
                  const next = event.target.value;
                  // Moving the start moves the end with it, keeping the length.
                  setForm((current) => current && { ...current, startDate: next,
                    endDate: next && current.startDate ? addDaysKey(current.endDate, Math.round((parseDateKey(next).getTime() - parseDateKey(current.startDate).getTime()) / 86_400_000)) : current.endDate });
                }} />
              {!form.allDay && <TextInput type="time" aria-label="Start time" value={form.startTime} disabled={pending} required className="w-32"
                onChange={(event) => set("startTime", event.target.value)} />}
            </div>
          </FormRow>
          <FormRow label="Ends" htmlFor={`${id}-end`}>
            <div className="flex gap-2">
              <TextInput id={`${id}-end`} type="date" value={form.endDate} min={form.startDate} disabled={pending} required
                onChange={(event) => set("endDate", event.target.value)} />
              {!form.allDay && <TextInput type="time" aria-label="End time" value={form.endTime} disabled={pending} required className="w-32"
                onChange={(event) => set("endTime", event.target.value)} />}
            </div>
          </FormRow>
          <FormRow label="Repeat" htmlFor={`${id}-repeat`}>
            <div className="flex flex-wrap items-center gap-2">
              <Select id={`${id}-repeat`} value={form.repeat} disabled={pending} className="w-40"
                onChange={(event) => set("repeat", event.target.value as Form["repeat"])}>
                <option value="">Never</option>
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </Select>
              {form.repeat && <>
                <label className={DS.field.label} htmlFor={`${id}-interval`}>every</label>
                <TextInput id={`${id}-interval`} type="number" min={1} max={99} value={form.interval} disabled={pending} className="w-20"
                  onChange={(event) => set("interval", event.target.value)} />
                <label className={DS.field.label} htmlFor={`${id}-until`}>until</label>
                <TextInput id={`${id}-until`} type="date" value={form.until} min={form.startDate} disabled={pending} className="w-44"
                  onChange={(event) => set("until", event.target.value)} />
              </>}
            </div>
          </FormRow>
          <FormRow label="Where" htmlFor={`${id}-location`}>
            <TextInput id={`${id}-location`} value={form.location} disabled={pending} maxLength={300}
              onChange={(event) => set("location", event.target.value)} />
          </FormRow>
          <FormRow label="Task" htmlFor={`${id}-task`}>
            <Select id={`${id}-task`} value={form.taskId} disabled={pending} onChange={(event) => set("taskId", event.target.value)}>
              <option value="">None</option>
              {activeTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </Select>
          </FormRow>
          <FormRow label="Notes" htmlFor={`${id}-notes`}>
            <TextArea id={`${id}-notes`} rows={3} value={form.notes} disabled={pending} maxLength={4000}
              onChange={(event) => set("notes", event.target.value)} />
          </FormRow>
          {existing?.repeat && <p className={DS.text.prose}>Changes apply to every repeat.</p>}
          {error && <Notice tone="danger" title="The event was not saved">{error}</Notice>}
          <div className={cx("flex flex-wrap items-center gap-2", existing ? "justify-between" : "justify-end")}>
            {existing && <Button type="button" variant={confirmDelete ? "danger" : "ghost"} disabled={pending}
              onClick={() => confirmDelete ? void run(() => deleteCalendarEvent(existing.id)) : setConfirmDelete(true)}>
              {confirmDelete ? existing.repeat ? "Delete every repeat" : "Delete event" : "Delete"}
            </Button>}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={pending || !form.title.trim()}>{pending ? "Saving…" : "Save"}</Button>
            </div>
          </div>
        </form>
      )}
    </Dialog>
  );
}
