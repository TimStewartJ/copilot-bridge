import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Check, ChevronRight } from "lucide-react";
import { patchChecklistItem } from "../api";
import type { HomeAction, HomeActionCounts } from "../../shared/home";
import { Button, EmptyHint, IconButton, IdentitySwatch, Section, StatusIcon } from "../design/primitives";
import { DS, cx } from "../design/tokens";

/** How long a completed item stays on screen, ticked, with an Undo. */
export const CHECKLIST_UNDO_MS = 6000;
const DAY_MS = 86_400_000;

export type DeadlineTone = "danger" | "warning" | "neutral";

function utcDay(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** A deadline as a reader says it, measured against the same day the server counted with. */
export function describeDeadline(deadline: string, today: string): { label: string; tone: DeadlineTone } {
  const diff = Math.round((utcDay(deadline) - utcDay(today)) / DAY_MS);
  const sameYear = deadline.slice(0, 4) === today.slice(0, 4);
  const date = new Date(utcDay(deadline)).toLocaleDateString(undefined,
    { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
  if (diff === -1) return { label: "Overdue since yesterday", tone: "danger" };
  if (diff < 0) return { label: `Overdue since ${date}`, tone: "danger" };
  if (diff === 0) return { label: "Due today", tone: "warning" };
  if (diff === 1) return { label: "Due tomorrow", tone: "neutral" };
  if (diff < 7) return { label: `Due ${new Date(utcDay(deadline)).toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" })}`, tone: "neutral" };
  return { label: `Due ${date}`, tone: "neutral" };
}

interface ChecklistGroup { key: string; taskId: string | null; taskTitle?: string; groupColor?: string; items: HomeAction[] }

/** Groups items by task in the order each task first appears, so the most urgent task leads. */
export function groupHomeChecklist(items: readonly HomeAction[]): ChecklistGroup[] {
  const groups = new Map<string, ChecklistGroup>();
  for (const item of items) {
    const key = item.taskId ?? "__global__";
    let group = groups.get(key);
    if (!group) { group = { key, taskId: item.taskId, taskTitle: item.taskTitle, groupColor: item.groupColor, items: [] }; groups.set(key, group); }
    group.items.push(item);
  }
  return [...groups.values()];
}

interface DateBucket { key: string; label: string; tone?: "danger" | "warning"; items: HomeAction[] }

/** Buckets items by when they are due: overdue, today, the next two weeks, later, undated. Order within stays as given. */
export function groupHomeChecklistByDate(items: readonly HomeAction[], today: string): DateBucket[] {
  const buckets: DateBucket[] = [
    { key: "overdue", label: "Overdue", tone: "danger", items: [] }, { key: "today", label: "Due today", tone: "warning", items: [] },
    { key: "soon", label: "Next two weeks", items: [] }, { key: "later", label: "Later", items: [] }, { key: "undated", label: "No date", items: [] },
  ];
  for (const item of items) {
    const diff = item.deadline ? Math.round((utcDay(item.deadline) - utcDay(today)) / DAY_MS) : null;
    const key = diff === null ? "undated" : diff < 0 ? "overdue" : diff === 0 ? "today" : diff <= 14 ? "soon" : "later";
    buckets.find(bucket => bucket.key === key)!.items.push(item);
  }
  return buckets.filter(bucket => bucket.items.length);
}

interface RecentlyDone { item: HomeAction; index: number; expires: number }

/** Keeps just-completed items in their place until their Undo window closes, even after a refetch drops them. */
export function mergeRecentlyDone(items: readonly HomeAction[], recent: readonly RecentlyDone[]): HomeAction[] {
  const ids = new Set(recent.map(entry => entry.item.id));
  const merged = items.filter(item => !ids.has(item.id));
  for (const entry of [...recent].sort((a, b) => a.index - b.index)) merged.splice(Math.min(entry.index, merged.length), 0, entry.item);
  return merged;
}

interface Props {
  mode: "overview" | "full";
  /** Home groups by due date so to-dos stay separate from task status; the full list keeps task grouping. */
  grouping?: "task" | "date";
  items: HomeAction[];
  counts: HomeActionCounts;
  today: string;
  action?: ReactNode;
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}

export default function HomeChecklist({ mode, grouping = "task", items, counts, today, action, onSelectTask, onChanged, onError }: Props) {
  const [recent, setRecent] = useState<RecentlyDone[]>([]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const recentRef = useRef(recent);
  recentRef.current = recent;

  useEffect(() => {
    if (!recent.length) return;
    const next = Math.min(...recent.map(entry => entry.expires));
    const timer = setTimeout(() => setRecent(list => list.filter(entry => entry.expires > Date.now())), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [recent]);

  const run = useCallback(async (id: string, work: () => Promise<void>) => {
    setBusy(set => new Set(set).add(id));
    try { await work(); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(set => { const copy = new Set(set); copy.delete(id); return copy; }); }
  }, [onError]);

  const shown = mergeRecentlyDone(items, recent);
  const doneIds = new Set(recent.map(entry => entry.item.id));

  function complete(item: HomeAction) {
    const index = shown.findIndex(candidate => candidate.id === item.id);
    setRecent(list => [...list.filter(entry => entry.item.id !== item.id), { item, index, expires: Date.now() + CHECKLIST_UNDO_MS }]);
    void run(item.id, async () => {
      try { await patchChecklistItem(item.id, { done: true }); }
      catch (error) { setRecent(list => list.filter(entry => entry.item.id !== item.id)); throw error; }
      await onChanged();
    });
  }
  function undo(item: HomeAction) {
    void run(item.id, async () => {
      await patchChecklistItem(item.id, { done: false });
      setRecent(list => list.filter(entry => entry.item.id !== item.id));
      await onChanged();
    });
  }
  function reschedule(item: HomeAction, deadline: string | null) {
    if ((item.deadline ?? null) === deadline) return;
    void run(item.id, async () => { await patchChecklistItem(item.id, { deadline }); await onChanged(); });
  }

  const summary = counts.open > 0 && (mode === "overview" || counts.overdue > 0 || counts.dueToday > 0) && <p className={cx(DS.text.meta, "flex flex-wrap items-center gap-x-3 gap-y-1")}>
    {counts.overdue > 0 && <span className={cx("inline-flex items-center gap-1 font-medium", DS.tone.danger)}><StatusIcon kind="danger" decorative />{counts.overdue} overdue</span>}
    {counts.dueToday > 0 && <span className={cx("inline-flex items-center gap-1 font-medium", DS.tone.warning)}><StatusIcon kind="warning" decorative />{counts.dueToday} due today</span>}
    {mode === "overview" && <span>{counts.open} open</span>}
  </p>;

  return <Section label={mode === "full" ? "Open items" : "Checklist"} level={mode === "full" ? "page" : "group"} surface action={action}>
    {summary}
    {grouping === "date" && groupHomeChecklistByDate(shown, today).map(bucket => <div key={bucket.key} className="mt-3 border-t border-border pt-3">
      <p className={cx(DS.text.meta, "font-medium", bucket.tone && DS.tone[bucket.tone])}>{bucket.label}</p>
      <ul className="mt-1">{bucket.items.map(item => <ChecklistRow key={item.id} item={item} mode={mode} today={today}
        done={doneIds.has(item.id)} busy={busy.has(item.id)} onComplete={() => complete(item)} onUndo={() => undo(item)}
        onReschedule={deadline => reschedule(item, deadline)} source={{ title: item.taskTitle, onOpen: item.taskId ? () => onSelectTask(item.taskId!, { checklistItemId: item.id }) : undefined }} />)}</ul>
    </div>)}
    {grouping === "task" && groupHomeChecklist(shown).map(group => <div key={group.key} className="mt-3 border-t border-border pt-3">
      <div className="flex min-w-0 items-center gap-2">
        {group.groupColor && <IdentitySwatch color={group.groupColor} />}
        {group.taskId
          ? <button type="button" className={cx(DS.text.sectionLabel, DS.focus, "inline-flex min-w-0 items-center gap-0.5 rounded-sm text-left hover:text-text-primary")}
            onClick={() => onSelectTask(group.taskId!)}><span className="truncate">{group.taskTitle ?? "Task"}</span><ChevronRight size={12} className="shrink-0" /></button>
          : <span className={DS.text.sectionLabel}>Global checklist</span>}
      </div>
      <ul className="mt-1">{group.items.map(item => <ChecklistRow key={item.id} item={item} mode={mode} today={today}
        done={doneIds.has(item.id)} busy={busy.has(item.id)} onComplete={() => complete(item)} onUndo={() => undo(item)}
        onReschedule={deadline => reschedule(item, deadline)} />)}</ul>
    </div>)}
    {!shown.length && <EmptyHint className="mt-2">{mode === "full" && counts.open > 0 ? "No open items on this page." : "Nothing on your checklist."}</EmptyHint>}
  </Section>;
}

function ChecklistRow({ item, mode, today, done, busy, onComplete, onUndo, onReschedule, source }: {
  item: HomeAction; mode: Props["mode"]; today: string; done: boolean; busy: boolean;
  onComplete: () => void; onUndo: () => void; onReschedule: (deadline: string | null) => void;
  /** Where the to-do comes from, shown as secondary text when rows are not grouped under their task. */
  source?: { title?: string; onOpen?: () => void };
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null), dateRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, item.text]);
  const deadline = item.deadline ? describeDeadline(item.deadline, today) : undefined;
  const clamp = mode === "overview" ? "line-clamp-2" : "line-clamp-4";
  return <li className="relative flex items-start gap-1">
    <button type="button" disabled={busy} aria-pressed={done}
      aria-label={done ? `Undo completing ${item.text}` : `Complete ${item.text}`} title={done ? "Undo" : "Mark complete"}
      onClick={() => done ? onUndo() : onComplete()}
      className={cx(DS.focus, "-ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-bg-hover/60 disabled:cursor-wait md:h-8 md:w-8")}>
      <span className={cx(DS.checkbox.base, "h-4 w-4", done ? DS.checkbox.checked : "border-text-faint")}>{done && <Check size={11} strokeWidth={3} />}</span>
    </button>
    <div className="min-w-0 flex-1 py-2 md:py-1.5">
      <p ref={textRef} className={cx("text-sm leading-snug whitespace-pre-line break-words", done ? "text-text-faint line-through" : "text-text-primary", !expanded && clamp)}>{item.text}</p>
      <div className={cx(DS.text.meta, "mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5")}>
        {done ? <span>Done</span> : deadline && <span className={cx("inline-flex items-center gap-1",
          deadline.tone === "danger" && cx("font-medium", DS.tone.danger), deadline.tone === "warning" && cx("font-medium", DS.tone.warning))}>
          {deadline.tone === "danger" && <StatusIcon kind="danger" decorative />}{deadline.tone === "warning" && <StatusIcon kind="warning" decorative />}{deadline.label}</span>}
        {source && (source.onOpen
          ? <button type="button" className={cx(DS.focus, "rounded-sm hover:text-text-primary")} onClick={source.onOpen}>from {source.title ?? "task"}</button>
          : <span>Global checklist</span>)}
        {done && <Button variant="ghost" size="sm" className="-my-1" disabled={busy} onClick={onUndo}>Undo</Button>}
        {!done && (overflows || expanded) && <button type="button" className={cx(DS.focus, "rounded-sm text-text-secondary hover:text-text-primary")}
          aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</button>}
      </div>
    </div>
    {!done && <>
      <IconButton label={item.deadline ? "Change date" : "Set a date"} disabled={busy} className="mt-0.5"
        onClick={() => { const input = dateRef.current; if (!input) return; input.focus(); try { input.showPicker(); } catch { /* focus alone opens it on mobile */ } }}>
        <CalendarDays size={14} />
      </IconButton>
      {/* opacity-0 rather than sr-only: showPicker() needs a rendered box on mobile */}
      <input ref={dateRef} type="date" tabIndex={-1} aria-hidden="true" value={item.deadline ?? ""}
        className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0"
        onChange={event => onReschedule(event.target.value || null)} />
    </>}
  </li>;
}
