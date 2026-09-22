import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { patchTask, type Task, type TaskPatch } from "../api";
import Dialog from "../design/Dialog";
import { Button, FormRow, Notice, TextInput } from "../design/primitives";
import { DS } from "../design/tokens";
import { invalidateTaskChangeQueries } from "../lib/task-change-invalidation";
import { toDateTimeInputValue, toDateTimeStorageValue } from "../lib/task-revisit";

export type DeferralTask = Pick<Task, "id" | "title" | "deferred" | "nextTouchAt">;

export default function TaskDeferralDialog({ task, onClose, onSaved }: {
  task: DeferralTask;
  onClose: () => void;
  onSaved?: (task: Task) => void;
}) {
  const client = useQueryClient();
  const dateId = useId();
  const [initial] = useState(() => ({ id: task.id, deferred: task.deferred, date: toDateTimeInputValue(task.nextTouchAt) }));
  const [date, setDate] = useState(initial.date);
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
      invalidateTaskChangeQueries(client, task.id);
      onSaved?.(updated);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return <Dialog title={initial.deferred ? "Resume task" : "Defer task"} description={task.title} pending={pending} onClose={onClose}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className={DS.text.prose}>{initial.deferred
        ? "Return to Continue working."
        : "Hide from Continue working, not your task list. Nothing is archived or muted."}</p>
      <FormRow label="Revisit on (optional)" htmlFor={dateId}>
        <TextInput id={dateId} type="datetime-local" value={date} disabled={pending}
          aria-describedby={`${dateId}-help`}
          onChange={event => setDate(event.target.value)} />
      </FormRow>
      <p id={`${dateId}-help`} className={DS.text.prose}>Optional review date. No automatic resume or start.</p>
      {date && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setDate("")}>Clear revisit date</Button>}
      {revisitsNow && <Notice title="Date already reached">This task will still appear in Ready to revisit. Change or clear the date to review it later.</Notice>}
      <p className={DS.text.prose}>Sessions, schedules and deferred jobs keep running. Questions, replies and deadlines keep their usual visibility.</p>
      {stale && <Notice title="Task changed">Reopen to review its current state. Closing discards this draft; nothing has been saved.</Notice>}
      {error && <Notice tone="danger" title="The change was not saved">{error}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={pending || stale}>{pending ? "Saving…" : initial.deferred ? "Resume task" : "Defer task"}</Button>
      </div>
    </form>
  </Dialog>;
}
