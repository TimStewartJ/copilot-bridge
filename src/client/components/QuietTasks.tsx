import { useEffect, useId, useMemo, useState } from "react";
import { Archive, CalendarDays, Check, EyeOff, Pin, RotateCcw } from "lucide-react";
import type { TaskOverviewRow } from "../../shared/task-overview";
import Dialog from "../design/Dialog";
import { Button, IdentitySwatch, Notice, TextInput } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { contextLine, describeIdle, formatSpan, KEEP_DAYS, type TaskOutcome } from "../lib/task-state-ui";
import { toDateTimeStorageValue } from "../lib/task-revisit";
import type { OutcomeReceipt } from "../hooks/useTaskOutcomes";

/** How long a quiet task has been untouched, said once. */
export function quietLabel(row: TaskOverviewRow): string {
  if (row.idleDays === null) return "No recent activity from you";
  return `Quiet for ${formatSpan(row.idleDays)}`;
}

/** The ways to settle a quiet task. Every choice takes it off the quiet list. */
export function QuietTaskActions({ row, disabled, onOutcome, onLater, size = "sm" }: {
  row: TaskOverviewRow;
  disabled?: boolean;
  onOutcome: (outcome: TaskOutcome) => void;
  onLater: () => void;
  size?: "sm" | "md";
}) {
  const keepLabel = row.staleWait ? "Still waiting" : "Still active";
  const keepTitle = `Keep it; if it is still quiet it comes back in ${KEEP_DAYS / 7} weeks.`;
  if (row.kind === "ongoing") {
    return <div className="flex flex-wrap gap-1.5">
      <Button size={size} disabled={disabled} onClick={onLater} title="Hide from Continue working until you resume it">Set aside…</Button>
      <Button size={size} disabled={disabled} onClick={() => onOutcome("mute")} title="Stop unread indicators and keep it out of Home">Mute</Button>
      <Button size={size} variant="ghost" disabled={disabled} onClick={() => onOutcome("keep")} title={keepTitle}>{keepLabel}</Button>
    </div>;
  }
  return <div className="flex flex-wrap gap-1.5">
    <Button size={size} disabled={disabled} icon={<Check size={13} aria-hidden="true" />} onClick={() => onOutcome("finished")} title="Mark complete and archive">Finished</Button>
    <Button size={size} disabled={disabled} onClick={() => onOutcome("archive")} title="Archive without marking complete">Not doing it</Button>
    <Button size={size} variant="ghost" disabled={disabled} onClick={onLater}>Later…</Button>
    <Button size={size} variant="ghost" disabled={disabled} onClick={() => onOutcome("keep")} title={keepTitle}>{keepLabel}</Button>
  </div>;
}

/** Confirms what an outcome did and offers to put it back exactly as it was. */
export function OutcomeNotice({ receipt, error, pending, onUndo, onDismiss }: {
  receipt: OutcomeReceipt | null; error: string; pending: boolean; onUndo: () => void; onDismiss: () => void;
}) {
  if (error) return <Notice tone="danger" title="The change was not saved" action={<Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}>{error}</Notice>;
  if (!receipt) return null;
  return <Notice tone="success" icon={<Check size={15} />} title={receipt.message}
    action={<div className="flex gap-1"><Button size="sm" disabled={pending} icon={<RotateCcw size={13} aria-hidden="true" />} onClick={onUndo}>Undo</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onDismiss}>Dismiss</Button></div>} />;
}

const OUTCOME_KEYS: Record<string, TaskOutcome | "later"> = { f: "finished", a: "archive", l: "later", k: "keep", m: "mute" };

/** Steps through quiet tasks one at a time. The list is fixed when it opens, so settling one never reshuffles the rest. */
export function QuietReviewDialog({ rows, pending, onOutcome, onSetAside, onOpenTask, onClose }: {
  rows: TaskOverviewRow[];
  pending: boolean;
  onOutcome: (row: TaskOverviewRow, outcome: TaskOutcome) => Promise<void>;
  onSetAside: (row: TaskOverviewRow, revisitAt?: string) => Promise<void>;
  onOpenTask: (row: TaskOverviewRow) => void;
  onClose: () => void;
}) {
  const [queue] = useState(rows);
  const [index, setIndex] = useState(0);
  const [settled, setSettled] = useState(0);
  const [later, setLater] = useState(false);
  const [date, setDate] = useState("");
  const [dateError, setDateError] = useState("");
  const dateId = useId();
  const row = queue[index];
  const done = index >= queue.length;
  const context = useMemo(() => row ? contextLine(row) : undefined, [row]);

  const advance = (didSettle: boolean) => {
    if (didSettle) setSettled(count => count + 1);
    setLater(false); setDate(""); setDateError("");
    setIndex(value => value + 1);
  };
  const choose = async (outcome: TaskOutcome | "later") => {
    if (!row || pending) return;
    if (outcome === "later") { setLater(true); return; }
    if (outcome === "mute" && row.kind !== "ongoing") return;
    if (outcome === "finished" && row.kind === "ongoing") return;
    await onOutcome(row, outcome);
    advance(true);
  };
  const confirmLater = async () => {
    if (!row) return;
    let revisitAt: string | undefined;
    try { revisitAt = date ? toDateTimeStorageValue(`${date}T09:00`) : undefined; }
    catch (error) { setDateError(error instanceof Error ? error.message : String(error)); return; }
    await onSetAside(row, revisitAt);
    advance(true);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (later || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      const outcome = OUTCOME_KEYS[event.key.toLowerCase()];
      if (outcome) { event.preventDefault(); void choose(outcome); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return <Dialog title={done ? "Review complete" : `Review quiet tasks · ${index + 1} of ${queue.length}`} pending={pending} onClose={onClose}>
    <div className="mb-4 flex gap-1" aria-hidden="true">
      {queue.map((item, position) => <span key={item.id} className={cx("h-1 flex-1 rounded-full",
        position < index ? "bg-text-secondary" : position === index ? "bg-text-primary" : "bg-border")} />)}
    </div>
    {done ? <div className="space-y-4">
      <p className={DS.text.prose}>{settled ? `You settled ${settled} of ${queue.length} quiet ${queue.length === 1 ? "task" : "tasks"}.` : "Nothing changed."}</p>
      <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
    </div> : row && <div className="space-y-4">
      <div>
        {row.groupName && <p className={cx(DS.text.meta, "flex items-center gap-1.5")}>{row.groupColor && <IdentitySwatch color={row.groupColor} />}{row.groupName}</p>}
        <h3 className="mt-1 flex items-center gap-2 text-xl font-semibold text-text-primary">{row.title}
          {row.kind === "ongoing" && <Pin size={14} className="rotate-45 text-text-faint" aria-label="Ongoing" />}</h3>
      </div>
      <dl className={cx(DS.surface.inset, "grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-3 text-sm")}>
        <dt className={DS.text.meta}>Last activity</dt><dd className="text-text-primary">{describeIdle(row)}{row.engagementApproximate ? " (from conversations)" : ""}</dd>
        <dt className={DS.text.meta}>{row.nextAction ? "Next step" : row.waitingOn ? "Waiting for" : "Next step"}</dt>
        <dd className={context?.empty ? "text-text-secondary" : "text-text-primary"}>{row.nextAction ?? row.waitingOn ?? "None recorded"}</dd>
        <dt className={DS.text.meta}>Kind</dt><dd className="text-text-primary">{row.kind === "ongoing" ? "Ongoing, no fixed finish line" : "Task"}</dd>
      </dl>
      {later ? <div className="space-y-3">
        <label htmlFor={dateId} className={DS.field.label}>Revisit on (optional)</label>
        <TextInput id={dateId} type="date" value={date} onChange={event => setDate(event.target.value)} />
        <p className={DS.text.meta}>Set aside from Home and your task list's main view. A date brings it back for review; no work starts.</p>
        {dateError && <p className={DS.tone.danger}>{dateError}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setLater(false)}>Back</Button>
          <Button variant="primary" disabled={pending} icon={<CalendarDays size={14} aria-hidden="true" />} onClick={() => void confirmLater()}>Set aside</Button></div>
      </div> : <div className="grid gap-2 sm:grid-cols-2">
        {(row.kind === "ongoing"
          ? [["later", "Set aside…", "Hide until you resume it, with an optional date.", "L"], ["mute", "Mute", "Keep it, without indicators or Home.", "M"], ["keep", row.staleWait ? "Still waiting" : "Still active", `Check back in ${KEEP_DAYS / 7} weeks if still quiet.`, "K"]]
          : [["finished", "Finished", "Mark complete and archive.", "F"], ["archive", "Not doing it", "Archive without completing.", "A"], ["later", "Later…", "Set aside, with an optional date.", "L"], ["keep", row.staleWait ? "Still waiting" : "Still active", `Check back in ${KEEP_DAYS / 7} weeks if still quiet.`, "K"]]
        ).map(([outcome, label, detail, key]) => <button key={outcome} type="button" disabled={pending} onClick={() => void choose(outcome as TaskOutcome | "later")}
          className={cx(DS.focus, DS.surface.inset, "flex flex-col items-start gap-1 p-3 text-left transition-colors hover:bg-bg-hover disabled:opacity-60")}>
          <span className="flex w-full items-center gap-2 text-sm font-medium text-text-primary">
            {outcome === "finished" ? <Check size={14} /> : outcome === "archive" ? <Archive size={14} /> : outcome === "mute" ? <EyeOff size={14} /> : outcome === "later" ? <CalendarDays size={14} /> : <RotateCcw size={14} />}
            {label}<kbd className="ml-auto rounded border border-border px-1.5 text-[10px] text-text-secondary">{key}</kbd></span>
          <span className={DS.text.meta}>{detail}</span>
        </button>)}
      </div>}
      {!later && <div className="flex items-center justify-between gap-2">
        <span className={DS.text.meta}>Any choice removes it from Worth a look.</span>
        <div className="flex gap-1"><Button variant="ghost" onClick={() => onOpenTask(row)}>Open task</Button><Button variant="ghost" onClick={() => advance(false)}>Skip</Button></div>
      </div>}
    </div>}
  </Dialog>;
}
