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
        ? "Return this task to Continue working. Keep, change or clear its revisit date."
        : "Set this task aside from Continue working without archiving or muting it. It stays in your task list."}</p>
      <FormRow label="Revisit on (optional)" htmlFor={dateId}>
        <TextInput id={dateId} type="datetime-local" value={date} disabled={pending}
          aria-describedby={`${dateId}-help`}
          onChange={event => setDate(event.target.value)} />
      </FormRow>
      <p id={`${dateId}-help`} className={DS.text.prose}>Leave blank for no revisit date. A date brings the task back for review, not automatic resumption or execution.</p>
      {date && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setDate("")}>Clear revisit date</Button>}
      {revisitsNow && <Notice title="Ready to revisit">This date has already arrived, so the task will remain in Home's revisit list. Change or clear it if you want to set the task aside until later.</Notice>}
      <p className={DS.text.prose}>Schedules, running sessions and session defer jobs are not paused. Questions, new replies and checklist deadlines keep their usual visibility.</p>
      {stale && <Notice title="Task changed">The task or its deferral/revisit date changed while this dialog was open. Your draft is still here, but closing discards it. Close and reopen to review the current task before saving.</Notice>}
      {error && <Notice tone="danger" title="The change was not saved">{error}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={pending || stale}>{pending ? "Saving…" : initial.deferred ? "Resume task" : "Defer task"}</Button>
      </div>
    </form>
  </Dialog>;
}
