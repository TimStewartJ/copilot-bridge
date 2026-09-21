import { ArrowRight, CheckCircle2, Clock3, HelpCircle } from "lucide-react";
import type { Task } from "../api";
import { focusTime } from "../focus-view-model";
import { timeAgo } from "../time";
import FocusProtectionControl from "./FocusProtectionControl";
import { DS, cx } from "../design/tokens";

export const FOCUS_DASHBOARD_PANEL_CLASS = DS.layout.section;

interface FocusDashboardOverviewProps {
  attentionCount: number | null;
  urgentActionCount: number | null;
  alertTotal: number | null;
  decisionTotal: number | null;
  overdueHandoffTotal: number | null;
  handedOffTotal: number | null;
  dueFollowUpCount: number;
  state: "partial" | "complete" | "clear";
  problems: string[];
  generatedAt?: string;
  onRetry: () => void;
  onInspectHandoffs: () => void;
}

export function FocusDashboardOverview({
  attentionCount, urgentActionCount, alertTotal, decisionTotal, overdueHandoffTotal, handedOffTotal, dueFollowUpCount, state, problems, generatedAt, onRetry, onInspectHandoffs,
}: FocusDashboardOverviewProps) {
  return <section data-dashboard-panel="overview" data-focus-completeness={state}
    className="min-w-0 pb-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className={DS.text.pageTitle}>Focus</h2>
        <div data-focus-attention-count={attentionCount ?? "unknown"} className={cx("inline-flex max-w-full items-center gap-2 text-xs", state === "partial" ? DS.tone.warning : "text-text-secondary")}>
          {state === "clear" ? <CheckCircle2 size={16} className="shrink-0" /> : <HelpCircle size={16} className="shrink-0" />}
          {state === "partial" ? "Partial / unknown - not an all-clear"
            : state === "clear" ? "No intervention found in the checked sources"
              : overdueHandoffTotal ? "Unresolved handoffs need review"
                : handedOffTotal ? "Open handoffs remain under review"
                : "Review the known concerns and coverage"}
        </div>
        <FocusProtectionControl />
      </div>
        <p className={cx(DS.usage.meta, "mt-2")}>{generatedAt ? `Snapshot: ${focusTime(generatedAt)}.` : "Snapshot not yet available."} This is not an assurance beyond the stated coverage.</p>
        <div aria-label="Focus section shortcuts" className="mt-2 flex flex-wrap gap-2">
          {(handedOffTotal == null || handedOffTotal > 0) && <button type="button" onClick={onInspectHandoffs} data-focus-metric="under-review"
            className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "gap-1.5")}>
            Under review<span className="font-medium text-text-secondary">{handedOffTotal ?? "Unknown"}</span>
          </button>}
          {[
            { key: "actions", label: "Due Actions", value: urgentActionCount, href: "#focus-actions" },
            { key: "alerts", label: "Alerts", value: alertTotal, href: "#focus-alerts" },
            { key: "decisions", label: "Decisions", value: decisionTotal, href: "#focus-decisions" },
            { key: "handoffs", label: "Due handoffs", value: overdueHandoffTotal, href: "#focus-next-intervention" },
            { key: "follow-ups", label: "Follow-ups", value: dueFollowUpCount, href: "#focus-follow-ups" },
          ].map((metric) => <a key={metric.key} href={metric.href} data-focus-metric={metric.key}
            className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "gap-1.5")}>
            {metric.label}<span className="font-medium text-text-secondary">{metric.value ?? "Unknown"}</span>
          </a>)}
          <a href="#focus-actions" className="inline-flex min-h-11 items-center text-xs font-medium text-accent underline">Quick Action access</a>
        </div>
        {problems.length > 0 && <details className="mt-2 text-xs text-warning">
          <summary className="min-h-11 cursor-pointer py-3">Incomplete checks ({problems.length})</summary>
          <ul className="list-inside list-disc space-y-1">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
          <button type="button" onClick={onRetry} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary, "mt-2 text-xs")}>Retry Focus checks</button>
        </details>}
  </section>;
}

export function FocusFollowUpPanel({ tasks, onSelectTask }: { tasks: Task[]; onSelectTask: (id: string) => void }) {
  return <section id="focus-follow-ups" data-dashboard-panel="follow-ups" className={FOCUS_DASHBOARD_PANEL_CLASS}>
    <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Clock3 size={15} />Follow up now</h3>
    <p className="mt-1 text-xs text-text-muted">Revisit times, not proof of missed deadlines.</p>
    {tasks.length === 0 ? <p className="mt-3 text-sm text-text-muted">No follow-ups due in the loaded tasks.</p>
      : <div className="mt-3 space-y-2">{tasks.slice(0, 3).map((task) => <button key={task.id} type="button" onClick={() => onSelectTask(task.id)}
        className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "items-start gap-2 py-2")}>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium text-text-primary">{task.title}</span>
          <span className="mt-1 block line-clamp-2 text-xs text-text-muted">{task.nextAction || task.waitingOn || "Follow-up time has arrived."}</span>
          <span className="mt-1 block text-xs text-info">Revisit {timeAgo(task.nextTouchAt!)}</span>
        </span><ArrowRight size={14} className="mt-1 shrink-0 text-text-faint" />
      </button>)}
        {tasks.length > 3 && <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-text-muted">{tasks.length - 3} more due follow-ups</summary>
          {tasks.slice(3).map((task) => <button key={task.id} type="button" className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "block text-left text-accent")} onClick={() => onSelectTask(task.id)}>{task.title}</button>)}
        </details>}
      </div>}
  </section>;
}
