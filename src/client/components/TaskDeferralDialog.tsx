import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { patchTask, type Task, type TaskPatch } from "../api";
import Dialog from "../design/Dialog";
import { Button, FormRow, Notice, TextInput } from "../design/primitives";
import { DS } from "../design/tokens";
import { invalidateTaskChangeQueries } from "../lib/task-change-invalidation";
import { formatRevisitMoment, isRevisitDue, toDateTimeInputValue, toDateTimeStorageValue } from "../lib/task-revisit";
import { haptic } from "../lib/haptics";

export type DeferralTask = Pick<Task, "id" | "title" | "deferred" | "nextTouchAt">;

export default function TaskDeferralDialog({ task, onClose, onSaved }: {
  task: DeferralTask;
  onClose: () => void;
  onSaved?: (task: Task) => void;
}) {
  const client = useQueryClient();
  const dateId = useId();
  // A reached date has done its job once the task is resumed, so resuming starts from no date.
  const [initial] = useState(() => ({ id: task.id, deferred: task.deferred, date: toDateTimeInputValue(task.nextTouchAt),
    reached: task.deferred && isRevisitDue(task.nextTouchAt) ? task.nextTouchAt : undefined }));
  const [date, setDate] = useState(initial.reached ? "" : initial.date);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const revisitsNow = !!date && new Date(date).getTime() <= Date.now();
  const stale = task.id !== initial.id || task.deferred !== initial.deferred || toDateTimeInputValue(task.nextTouchAt) !== initial.date;

  async function save() {
    if (pending || stale) return;
    setError("");
    let updates: TaskPatch;
    try {
      updates = { deferred: !initial.deferred,
        ...(date !== initial.date ? { nextTouchAt: date ? toDateTimeStorageValue(date) : null } : {}) };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setPending(true);
    try {
      const updated = await patchTask(task.id, updates);
      haptic("success");
      invalidateTaskChangeQueries(client, task.id);
      onSaved?.(updated);
      onClose();
    } catch (cause) {
      haptic("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return <Dialog title={initial.deferred ? "Resume task" : "Defer task"} description={task.title} pending={pending} onClose={onClose}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      {!initial.deferred && <p className={DS.text.prose}>Out of your task list and Home until you resume it.</p>}
      <FormRow label="Revisit on (optional)" htmlFor={dateId}>
        <TextInput id={dateId} type="datetime-local" value={date} disabled={pending}
          aria-describedby={`${dateId}-help`}
          onChange={event => setDate(event.target.value)} />
      </FormRow>
      <p id={`${dateId}-help`} className={DS.text.prose}>It shows under Needs you on this date. Nothing starts by itself.</p>
      {initial.reached && !date && <p className={DS.text.prose}>Its revisit date ({formatRevisitMoment(initial.reached)}) has passed and will be cleared.</p>}
      {date && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setDate("")}>Clear revisit date</Button>}
      {revisitsNow && <Notice title="Date already reached">It will show under Needs you right away.</Notice>}
      <p className={DS.text.prose}>Sessions, schedules and deferred jobs keep running.</p>
      {stale && <Notice title="Task changed">Nothing was saved. Reopen to see its current state.</Notice>}
      {error && <Notice tone="danger" title="The change was not saved">{error}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={pending || stale}>{pending ? "Saving…" : initial.deferred ? "Resume task" : "Defer task"}</Button>
      </div>
    </form>
  </Dialog>;
}
