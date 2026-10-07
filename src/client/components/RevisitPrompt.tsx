import { useCallback, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { patchTask, type Task, type TaskPatch } from "../api";
import Dialog from "../design/Dialog";
import { Button, FormRow, Notice, TextInput } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { haptic } from "../lib/haptics";
import { invalidateTaskChangeQueries } from "../lib/task-change-invalidation";
import { formatRevisitMoment, isRevisitDue, revisitInDays, toDateTimeStorageValue } from "../lib/task-revisit";

export type RevisitTask = Pick<Task, "id" | "title" | "deferred" | "muted" | "nextTouchAt">;

function useSaveRevisit(taskId: string, onSaved?: (task: Task) => void) {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const save = useCallback(async (updates: TaskPatch, report: (message: string) => void): Promise<boolean> => {
    setPending(true);
    report("");
    try {
      const updated = await patchTask(taskId, updates);
      haptic("success");
      invalidateTaskChangeQueries(client, taskId);
      onSaved?.(updated);
      return true;
    } catch (cause) {
      haptic("error");
      report(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setPending(false);
    }
  }, [client, onSaved, taskId]);
  return { pending, save };
}

interface RevisitChoicesProps {
  task: RevisitTask;
  /** Ghost buttons sit in a row of other actions; filled ones stand alone in the task's prompt. */
  variant?: "secondary" | "ghost";
  /** Opens the screen's RevisitLaterDialog, which the screen places outside its scroller and status regions. */
  onLater: () => void;
  onSaved?: (task: Task) => void;
  onError?: (message: string) => void;
}

/**
 * The ways to answer a revisit date that has arrived: bring a set-aside task back, see it again
 * later, or drop the date. Every choice takes the task out of Needs you.
 */
export function RevisitChoices({ task, variant = "secondary", onLater, onSaved, onError }: RevisitChoicesProps) {
  const { pending, save } = useSaveRevisit(task.id, onSaved);
  const report = (message: string) => onError?.(message);
  return <>
    {task.deferred && <Button size="sm" variant={variant} disabled={pending} title="Back into your task list; the revisit date is cleared"
      onClick={() => void save({ deferred: false, nextTouchAt: null }, report)}>Resume task</Button>}
    <Button size="sm" variant={variant} disabled={pending} onClick={onLater}>Later…</Button>
    <Button size="sm" variant="ghost" disabled={pending} title={task.deferred ? "Remove the revisit date; the task stays set aside" : "Remove the revisit date"}
      onClick={() => void save({ nextTouchAt: null }, report)}>Clear date</Button>
  </>;
}

/** Picks when a task should ask to be seen again, and saves it. */
export function RevisitLaterDialog({ task, onSaved, onClose }: {
  task: RevisitTask;
  onSaved?: (task: Task) => void;
  onClose: () => void;
}) {
  const dateId = useId();
  const firstChoice = useRef<HTMLButtonElement>(null);
  const { pending, save } = useSaveRevisit(task.id, onSaved);
  const [error, setError] = useState("");
  const [date, setDate] = useState("");
  const [options] = useState(() => [
    { label: "Tomorrow", at: revisitInDays(1) },
    { label: "Next week", at: revisitInDays(7) },
  ]);
  const chosen = date ? new Date(date).getTime() : Number.NaN;
  const past = Number.isFinite(chosen) && chosen <= Date.now();
  const pick = async (at: string) => { if (await save({ nextTouchAt: at }, setError)) onClose(); };

  return <Dialog title="Revisit later" description={task.title} pending={pending} onClose={onClose} initialFocusRef={firstChoice}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (Number.isFinite(chosen) && !past) void pick(toDateTimeStorageValue(date)); }}>
      <p className={DS.text.prose}>It leaves Needs you until then{task.deferred ? " and stays set aside" : ""}. Nothing starts by itself.</p>
      <div className="grid gap-2">
        {options.map((option, index) => <Button key={option.label} ref={index === 0 ? firstChoice : undefined} fullWidth disabled={pending}
          onClick={() => void pick(option.at)}>
          <span className="flex w-full items-center justify-between gap-3"><span>{option.label}</span>
            <span className={DS.text.meta}>{formatRevisitMoment(option.at)}</span></span>
        </Button>)}
      </div>
      <FormRow label="Or on" htmlFor={dateId}>
        <div className="flex gap-2">
          <TextInput id={dateId} type="datetime-local" value={date} disabled={pending} className="min-w-0 flex-1"
            aria-describedby={past ? `${dateId}-past` : undefined} onChange={event => setDate(event.target.value)} />
          <Button type="submit" disabled={pending || past || !Number.isFinite(chosen)}>Set date</Button>
        </div>
        {past && <p id={`${dateId}-past`} className={DS.text.meta}>That time has passed. Pick one ahead of now.</p>}
      </FormRow>
      {error && <Notice tone="danger" title="The change was not saved">{error}</Notice>}
    </form>
  </Dialog>;
}

/** Shown at the top of a task whose revisit date has arrived, so the date can be answered where the task is read. */
export default function RevisitPrompt({ task, onSaved }: { task: RevisitTask; onSaved?: (task: Task) => void }) {
  const [error, setError] = useState("");
  const [choosingLater, setChoosingLater] = useState(false);
  if (!task.nextTouchAt || !isRevisitDue(task.nextTouchAt)) return null;
  return <>
    <Notice tone="warning" icon={<CalendarDays size={15} aria-hidden="true" />} title="Time to revisit">
      <p className={DS.text.prose}>Its revisit date was {formatRevisitMoment(task.nextTouchAt)}.
        {task.deferred ? " It is still set aside." : task.muted ? " It is still muted." : ""}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <RevisitChoices task={task} onLater={() => setChoosingLater(true)} onSaved={onSaved} onError={setError} />
      </div>
      {error && <p className={cx(DS.tone.danger, "mt-2 text-sm")} role="alert">{error}</p>}
    </Notice>
    {choosingLater && <RevisitLaterDialog task={task} onSaved={onSaved} onClose={() => setChoosingLater(false)} />}
  </>;
}
