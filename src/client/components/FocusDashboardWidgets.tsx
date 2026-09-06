import { ArrowRight, CheckCircle2, Clock3, HelpCircle } from "lucide-react";
import type { Task } from "../api";
import { focusTime } from "../focus-view-model";
import { timeAgo } from "../time";
import { UI } from "./shared/design-system";
import FocusProtectionControl from "./FocusProtectionControl";

export const FOCUS_DASHBOARD_PANEL_CLASS = "min-w-0 rounded-2xl border border-border/80 bg-bg-secondary/75 p-4 shadow-sm sm:p-5";

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
    className="min-w-0 rounded-xl border border-border/80 bg-bg-secondary px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-lg font-semibold text-text-primary">Focus</h2>
        <div data-focus-attention-count={attentionCount ?? "unknown"} className={`inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
          state === "clear" ? "border-success/25 bg-success/10 text-success" : state === "partial" ? "border-warning/25 bg-warning/10 text-warning" : "border-info-border bg-info-surface text-info"
        }`}>
          {state === "clear" ? <CheckCircle2 size={16} className="shrink-0" /> : <HelpCircle size={16} className="shrink-0" />}
          {state === "partial" ? "Partial / unknown - not an all-clear"
            : state === "clear" ? "No intervention found in the checked sources"
              : overdueHandoffTotal ? "Unresolved handoffs need review"
                : handedOffTotal ? "Open handoffs remain under review"
                : "Review the known concerns and coverage"}
        </div>
        <FocusProtectionControl />
      </div>
        <p className="mt-2 text-xs text-text-faint">{generatedAt ? `Snapshot: ${focusTime(generatedAt)}.` : "Snapshot not yet available."} This is not an assurance beyond the stated coverage.</p>
        <div aria-label="Focus section shortcuts" className="mt-2 flex flex-wrap gap-2">
          {(handedOffTotal == null || handedOffTotal > 0) && <button type="button" onClick={onInspectHandoffs} data-focus-metric="under-review"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border/70 px-2.5 text-xs text-text-muted hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent">
            Under review<span className="font-medium text-text-secondary">{handedOffTotal ?? "Unknown"}</span>
          </button>}
          {[
            { key: "actions", label: "Due Actions", value: urgentActionCount, href: "#focus-actions" },
            { key: "alerts", label: "Alerts", value: alertTotal, href: "#focus-alerts" },
            { key: "decisions", label: "Decisions", value: decisionTotal, href: "#focus-decisions" },
            { key: "handoffs", label: "Due handoffs", value: overdueHandoffTotal, href: "#focus-next-intervention" },
            { key: "follow-ups", label: "Follow-ups", value: dueFollowUpCount, href: "#focus-follow-ups" },
          ].map((metric) => <a key={metric.key} href={metric.href} data-focus-metric={metric.key}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border/70 px-2.5 text-xs text-text-muted hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent">
            {metric.label}<span className="font-medium text-text-secondary">{metric.value ?? "Unknown"}</span>
          </a>)}
          <a href="#focus-actions" className="inline-flex min-h-11 items-center text-xs font-medium text-accent underline">Quick Action access</a>
        </div>
        {problems.length > 0 && <details className="mt-2 text-xs text-warning">
          <summary className="min-h-11 cursor-pointer py-3">Incomplete checks ({problems.length})</summary>
          <ul className="list-inside list-disc space-y-1">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
          <button type="button" onClick={onRetry} className={`${UI.button.secondary} mt-2 min-h-11 text-xs`}>Retry Focus checks</button>
        </details>}
  </section>;
}

export function FocusFollowUpPanel({ tasks, onSelectTask }: { tasks: Task[]; onSelectTask: (id: string) => void }) {
  return <section id="focus-follow-ups" data-dashboard-panel="follow-ups" className={FOCUS_DASHBOARD_PANEL_CLASS}>
    <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Clock3 size={15} />Follow up now</h3>
    <p className="mt-1 text-xs text-text-muted">Revisit times, not proof of missed deadlines.</p>
    {tasks.length === 0 ? <p className="mt-3 text-sm text-text-muted">No follow-ups due in the loaded tasks.</p>
      : <div className="mt-3 space-y-2">{tasks.slice(0, 3).map((task) => <button key={task.id} type="button" onClick={() => onSelectTask(task.id)}
        className="flex min-h-11 w-full items-start gap-2 rounded-xl border border-border/70 bg-bg-surface p-3 text-left hover:bg-bg-hover">
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium text-text-primary">{task.title}</span>
          <span className="mt-1 block line-clamp-2 text-xs text-text-muted">{task.nextAction || task.waitingOn || "Follow-up time has arrived."}</span>
          <span className="mt-1 block text-xs text-info">Revisit {timeAgo(task.nextTouchAt!)}</span>
        </span><ArrowRight size={14} className="mt-1 shrink-0 text-text-faint" />
      </button>)}
        {tasks.length > 3 && <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-text-muted">{tasks.length - 3} more due follow-ups</summary>
          {tasks.slice(3).map((task) => <button key={task.id} type="button" className="block min-h-11 text-left text-sm text-accent" onClick={() => onSelectTask(task.id)}>{task.title}</button>)}
        </details>}
      </div>}
  </section>;
}
