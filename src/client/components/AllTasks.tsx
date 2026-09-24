import { useMemo, useState } from "react";
import { Archive, Check, ChevronDown, ChevronRight, Clock3, Moon, Pin, Plus, RefreshCw, Sparkles, Activity, ArrowRight, Hourglass, CircleDashed, EyeOff } from "lucide-react";
import type { TaskOverviewRow } from "../../shared/task-overview";
import { TASK_STATE_LABELS, TASK_STATE_ORDER, type TaskState } from "../../shared/task-state";
import { Badge, Button, EmptyHint, IdentitySwatch, Notice, SegmentedControl } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { useTaskOverviewQuery } from "../hooks/queries/useTaskOverview";
import { useTaskOutcomes } from "../hooks/useTaskOutcomes";
import { contextLine, describeIdle, stateBadge } from "../lib/task-state-ui";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import { OutcomeNotice, QuietReviewDialog } from "./QuietTasks";

type Grouping = "state" | "group";
const GROUPING_KEY = "bridge.allTasks.grouping";
const STATE_HINT: Record<TaskState, string> = {
  needs_you: "a question, a stalled conversation or a revisit date that has arrived",
  in_motion: "touched this week",
  waiting: "waiting on someone or a revisit date",
  up_next: "has a next step, not touched this week",
  no_next_step: "nothing recorded yet",
  gone_quiet: "untouched for 30+ days",
  set_aside: "deferred or muted",
};
const STATE_ICON: Record<TaskState, typeof Clock3> = {
  needs_you: Clock3, in_motion: Activity, waiting: Hourglass, up_next: ArrowRight, no_next_step: CircleDashed, gone_quiet: Moon, set_aside: EyeOff,
};
const engaged = (row: TaskOverviewRow) => (row.lastEngagedAt ? Date.parse(row.lastEngagedAt) : 0);
function sortForState(state: TaskState, rows: TaskOverviewRow[]): TaskOverviewRow[] {
  const sorted = [...rows];
  if (state === "gone_quiet") return sorted.sort((a, b) => engaged(a) - engaged(b) || a.order - b.order);
  if (state === "needs_you") return sorted.sort((a, b) => a.order - b.order);
  return sorted.sort((a, b) => engaged(b) - engaged(a) || a.order - b.order);
}
function loadGrouping(): Grouping {
  try { return localStorage.getItem(GROUPING_KEY) === "group" ? "group" : "state"; } catch { return "state"; }
}

interface Props {
  onSelectTask: (id: string) => void;
  /** Phone layout: filter chips instead of the stat band, short sections, no bulk selection. */
  compact?: boolean;
  scrollRestoration?: PullToRefreshScrollRestoration;
}

/** Every active task grouped by what it needs, for reviewing and tidying the whole list. The sidebar keeps Tim's own order. */
export default function AllTasks({ onSelectTask, compact = false, scrollRestoration }: Props) {
  const query = useTaskOverviewQuery();
  const outcomes = useTaskOutcomes();
  const [grouping, setGroupingState] = useState<Grouping>(loadGrouping);
  const [filter, setFilter] = useState<TaskState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const rows = query.data?.tasks ?? [];
  const counts = query.data?.counts;
  const byId = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows]);
  const quiet = useMemo(() => sortForState("gone_quiet", rows.filter(row => row.state === "gone_quiet")), [rows]);
  const visibleRows = filter ? rows.filter(row => row.state === filter) : rows;
  const selectedRows = [...selected].flatMap(id => byId.get(id) ?? []);
  const setGrouping = (value: Grouping) => { setGroupingState(value); try { localStorage.setItem(GROUPING_KEY, value); } catch { /* preference only */ } };
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleSection = (key: string) => setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const bulk = async (outcome: "finished" | "archive" | "set_aside") => {
    if (outcome === "finished" && selectedRows.some(row => row.kind !== "task")) return;
    await outcomes.apply(selectedRows, outcome);
    setSelected(new Set());
  };

  const sections: Array<{ key: string; title: string; hint?: string; state?: TaskState; color?: string; rows: TaskOverviewRow[] }> = grouping === "state"
    ? TASK_STATE_ORDER.map(state => ({ key: state, title: TASK_STATE_LABELS[state], hint: STATE_HINT[state], state, rows: sortForState(state, visibleRows.filter(row => row.state === state)) }))
      .filter(section => section.rows.length)
    : [...new Map(visibleRows.map(row => [row.groupId ?? "", { name: row.groupName ?? "Ungrouped", color: row.groupColor }])).entries()]
      .sort(([a], [b]) => (a === "" ? 1 : 0) - (b === "" ? 1 : 0))
      .map(([groupId, group]) => ({ key: `group:${groupId}`, title: group.name, color: group.color,
        rows: visibleRows.filter(row => (row.groupId ?? "") === groupId)
          .sort((a, b) => TASK_STATE_ORDER.indexOf(a.state) - TASK_STATE_ORDER.indexOf(b.state) || engaged(b) - engaged(a)) }));

  const activeTotal = rows.length;
  const header = <header className="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className={compact ? "text-xl font-semibold text-text-primary" : "text-2xl font-semibold tracking-tight text-text-primary"}>All tasks</h1>
      <p className={cx(DS.text.prose, "mt-1")}>{query.data ? `${activeTotal} active${compact ? "" : ". How your work stands, grouped by what it needs."}` : "Loading…"}</p>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl ariaLabel="Group tasks" size="sm" value={grouping} onChange={setGrouping}
        options={[{ value: "state", label: compact ? "State" : "By state" }, { value: "group", label: compact ? "Group" : "By group" }]} />
      {quiet.length > 0 && !compact && <Button variant="primary" size="sm" icon={<Sparkles size={13} aria-hidden="true" />} onClick={() => setReviewing(true)}>Review {quiet.length} quiet {quiet.length === 1 ? "task" : "tasks"}</Button>}
      {!compact && <Button variant="ghost" size="sm" aria-label="Refresh task states" onClick={() => void query.refetch()}><RefreshCw size={15} /></Button>}
    </div>
  </header>;

  const statTiles = counts && TASK_STATE_ORDER.filter(state => counts[state] > 0 || state === "needs_you");
  const stats = counts && (compact
    ? <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter tasks">
      <button type="button" aria-pressed={!filter} onClick={() => setFilter(null)} className={cx(DS.choice.option, "shrink-0 whitespace-nowrap", !filter ? DS.choice.selected : DS.choice.unselected)}>All {activeTotal}</button>
      {statTiles!.map(state => <button key={state} type="button" aria-pressed={filter === state} onClick={() => setFilter(filter === state ? null : state)}
        className={cx(DS.choice.option, "shrink-0 whitespace-nowrap", filter === state ? DS.choice.selected : DS.choice.unselected, filter !== state && state === "needs_you" && counts[state] > 0 && DS.tone.warning)}>
        {TASK_STATE_LABELS[state]} {counts[state]}</button>)}
    </div>
    : <div className={cx(DS.surface.group, "grid overflow-hidden")} style={{ gridTemplateColumns: `repeat(${statTiles!.length}, minmax(0, 1fr))` }} data-ds-surface="group">
      {statTiles!.map((state, index) => <button key={state} type="button" aria-pressed={filter === state} onClick={() => setFilter(filter === state ? null : state)}
        className={cx(DS.focus, "min-w-0 px-4 py-3 text-left transition-colors hover:bg-bg-hover/60", index > 0 && "border-l border-border", filter === state && DS.row.selected)}>
        <span className={cx("block text-xl font-semibold tabular-nums", state === "needs_you" && counts[state] ? DS.tone.warning : "text-text-primary")}>{counts[state]}</span>
        <span className="mt-0.5 block truncate text-xs text-text-secondary">{TASK_STATE_LABELS[state]}</span>
      </button>)}
    </div>);

  const renderRow = (row: TaskOverviewRow, showState: boolean) => {
    const badge = showState ? { label: TASK_STATE_LABELS[row.state], tone: row.state === "needs_you" ? "warning" as const : "neutral" as const } : stateBadge(row);
    const context = contextLine(row);
    const picked = selected.has(row.id);
    return <div key={row.id} className={cx("flex min-w-0 items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0", picked && DS.row.selected)}>
      {!compact && <button type="button" role="checkbox" aria-checked={picked} aria-label={`Select ${row.title}`} onClick={() => toggle(row.id)}
        className={cx(DS.focus, "-m-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-bg-hover/60")}>
        <span className={cx(DS.checkbox.base, "h-4 w-4", picked ? DS.checkbox.checked : "border-text-faint")}>{picked && <Check size={11} strokeWidth={3} />}</span>
      </button>}
      {row.groupColor && grouping === "state" ? <IdentitySwatch color={row.groupColor} /> : <span className="w-2 shrink-0" />}
      <button type="button" className={cx(DS.focus, "min-w-0 flex-1 rounded-sm text-left")} onClick={() => onSelectTask(row.id)}>
        <span className="flex items-center gap-1.5 truncate font-semibold text-text-primary">{row.title}
          {row.kind === "ongoing" && <Pin size={11} className="shrink-0 rotate-45 text-text-faint" aria-label="Ongoing" />}</span>
        <span className={cx("mt-0.5 block truncate text-[13px]", context.empty ? "text-text-secondary" : "text-text-muted")}>{context.text}</span>
      </button>
      {row.state === "no_next_step" && !compact
        ? <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden="true" />} onClick={() => onSelectTask(row.id)}>Next step</Button>
        : badge && <Badge tone={badge.tone === "warning" ? "warning" : badge.tone === "info" ? "info" : "neutral"}>{badge.label}</Badge>}
      <span className={cx(DS.text.meta, "hidden w-24 shrink-0 text-right sm:block")} title={row.engagementApproximate ? "Estimated from conversation activity" : undefined}>{describeIdle(row)}</span>
    </div>;
  };

  const list = sections.map(section => {
    const Icon = section.state ? STATE_ICON[section.state] : undefined;
    const collapsible = section.state === "set_aside";
    const open = collapsible ? expanded.has(section.key) || filter === "set_aside" : true;
    const limit = compact && !expanded.has(section.key) && section.state !== "needs_you" ? 3 : Infinity;
    const shown = open ? section.rows.slice(0, limit) : [];
    return <section key={section.key} aria-label={section.title} className={cx(DS.surface.group, "overflow-hidden")} data-ds-surface="group">
      <div className={cx(DS.collection.header, "flex items-center gap-2 px-4")}>
        {collapsible ? <button type="button" aria-expanded={open} onClick={() => toggleSection(section.key)} className={cx(DS.focus, "flex min-h-9 items-center gap-2 rounded-sm")}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="font-semibold text-text-primary">{section.title}</span></button>
          : <span className="flex min-h-9 items-center gap-2">{Icon && <Icon size={14} className={section.state === "needs_you" ? DS.tone.warning : "text-text-secondary"} />}
            {section.color && <IdentitySwatch color={section.color} />}<span className="font-semibold text-text-primary">{section.title}</span></span>}
        <span className={DS.text.meta}>{section.rows.length}{section.hint && !compact ? ` · ${section.hint}` : ""}</span>
        {section.state === "gone_quiet" && <Button className="ml-auto" size="sm" variant="ghost" onClick={() => setReviewing(true)}>Review one by one <ArrowRight size={13} /></Button>}
      </div>
      {shown.map(row => renderRow(row, grouping === "group"))}
      {open && section.rows.length > shown.length && <button type="button" onClick={() => toggleSection(section.key)} className={cx(DS.focus, "w-full border-t border-border px-4 py-2.5 text-left text-[13px] text-text-secondary hover:text-text-primary")}>
        + {section.rows.length - shown.length} more</button>}
    </section>;
  });

  const content = <div className={cx(compact ? "space-y-3 px-4 py-4" : cx(DS.layout.pageColumn, "max-w-5xl space-y-5"), selectedRows.length > 0 && "pb-24")}>
    {header}
    <OutcomeNotice receipt={outcomes.receipt} error={outcomes.error} pending={outcomes.pending} onUndo={() => void outcomes.undoLast()} onDismiss={outcomes.dismiss} />
    {query.error && <Notice tone="warning" title="Task states unavailable">{query.error.message}{query.data ? " Showing the last result." : ""}</Notice>}
    {query.data?.sourceErrors.map(error => <Notice key={error} tone="warning" title="Some information is unavailable">{error}</Notice>)}
    {stats}
    {compact && quiet.length > 0 && <Button fullWidth size="sm" icon={<Sparkles size={13} aria-hidden="true" />} onClick={() => setReviewing(true)}>Review {quiet.length} quiet {quiet.length === 1 ? "task" : "tasks"}</Button>}
    {!query.data ? <EmptyHint>{query.error ? "Task states are unavailable, not empty." : "Loading task states…"}</EmptyHint>
      : !sections.length ? <EmptyHint>{filter ? "No tasks in this state." : "No active tasks."}</EmptyHint> : <div className="space-y-3">{list}</div>}
  </div>;

  // On a phone this sits inside the Work tab's own pull-to-refresh scroller.
  return <div className={compact ? "min-w-0" : "relative flex-1 min-h-0"}>
    {compact ? content : <PullToRefresh className="absolute inset-0" scrollRestoration={scrollRestoration} onRefresh={async () => { await query.refetch(); }}>{content}</PullToRefresh>}
    {selectedRows.length > 0 && <div className={cx(DS.surface.floating, "fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 px-3 py-2")} role="toolbar" aria-label="Selected tasks">
      <span className="px-1 text-sm font-medium text-text-primary">{selectedRows.length} selected</span>
      <Button size="sm" disabled={outcomes.pending || selectedRows.some(row => row.kind !== "task")} icon={<Check size={13} aria-hidden="true" />}
        title={selectedRows.some(row => row.kind !== "task") ? "Ongoing tasks have no finish line; deselect them to mark the rest finished" : undefined} onClick={() => void bulk("finished")}>Finished</Button>
      <Button size="sm" disabled={outcomes.pending} icon={<Archive size={13} aria-hidden="true" />} onClick={() => void bulk("archive")}>Archive</Button>
      <Button size="sm" disabled={outcomes.pending} onClick={() => void bulk("set_aside")}>Set aside</Button>
      <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
    </div>}
    {reviewing && <QuietReviewDialog rows={quiet} pending={outcomes.pending}
      onOutcome={(row, outcome) => outcomes.apply([row], outcome)} onSetAside={(row, revisitAt) => outcomes.apply([row], "set_aside", revisitAt)}
      onOpenTask={row => { setReviewing(false); onSelectTask(row.id); }} onClose={() => setReviewing(false)} />}
  </div>;
}
