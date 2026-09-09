import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock3, Inbox, Layers3 } from "lucide-react";
import type { FocusAlert, FocusDecision, FocusDigest, FocusHistoryFilter, FocusSnapshot, Task, TaskGroup } from "../api";
import { assessFocusOverview, focusDueHandoffCount, focusQueryProblem, focusTime, isFocusReadFresh, type FocusQueryHealth } from "../focus-view-model";
import type { DashboardChecklistState } from "../hooks/useDashboardChecklist";
import { getDashboardPanelId, getDashboardTabId } from "../lib/dashboard-routes";
import DashboardChecklist from "./DashboardChecklist";
import FocusAutonomyPanel from "./FocusAutonomyPanel";
import FocusAuditWarning from "./FocusAuditWarning";
import { FOCUS_DASHBOARD_PANEL_CLASS, FocusDashboardOverview, FocusFollowUpPanel } from "./FocusDashboardWidgets";
import FocusDigestSection from "./FocusDigestSection";
import FocusHistorySection from "./FocusHistorySection";
import FocusItemCard from "./FocusItemCard";
import { FocusInteractionProvider, type FocusInteractionProps } from "./FocusInteractions";
import { UI } from "./shared/design-system";
import type { FocusSubjectTarget } from "../lib/focus-subject-links";
import FocusSubjectDialog from "./FocusSubjectDialog";
import FocusQuietSources from "./FocusQuietSources";
import FocusDialog from "./FocusDialog";
import { useMediaQuery } from "../useIsMobile";

export const FOCUS_WIDE_PREVIEW_QUERY = "(min-width: 1280px)";

interface DashboardFocusProps {
  active: boolean;
  tabbed: boolean;
  checklist: DashboardChecklistState;
  tasks: Task[];
  taskGroups: TaskGroup[];
  focusSnapshot?: FocusSnapshot;
  alertTotal: number | null;
  decisionTotal: number | null;
  alerts: FocusAlert[];
  decisions: FocusDecision[];
  alertsLoading: boolean;
  alertsHasMore: boolean;
  alertsLoadingMore: boolean;
  decisionsLoading: boolean;
  decisionsHasMore: boolean;
  decisionsLoadingMore: boolean;
  focusLoading: boolean;
  focusError?: unknown;
  actionsLoading: boolean;
  actionsError?: unknown;
  alertsError?: unknown;
  decisionsError?: unknown;
  actionsUpdatedAt: number;
  alertsUpdatedAt: number;
  decisionsUpdatedAt: number;
  nowMs: number;
  onSelectTask: FocusInteractionProps["onSelectTask"];
  onSelectSession: FocusInteractionProps["onSelectSession"];
  onStartPromptSession: FocusInteractionProps["onStartPromptSession"];
  onLoadMoreAlerts: () => void | Promise<unknown>;
  onLoadMoreDecisions: () => void | Promise<unknown>;
  onRetryFocus: () => void | Promise<unknown>;
  onRefresh: () => Promise<unknown>;
  notificationTarget?: FocusSubjectTarget | null;
  notificationError?: string | null;
  onCloseNotification?: () => void;
  onInspectSubject?: (target: FocusSubjectTarget) => void;
  initialHistoryQuery?: string;
}

export function getDueFollowUpTasks(tasks: Task[], now = new Date()): Task[] {
  return tasks.filter((task) => task.status === "active" && !task.muted && task.nextTouchAt
    && Number.isFinite(Date.parse(task.nextTouchAt)) && Date.parse(task.nextTouchAt) <= now.getTime())
    .sort((left, right) => Date.parse(left.nextTouchAt!) - Date.parse(right.nextTouchAt!));
}

export function getDashboardFocusCount(checklist: DashboardChecklistState, attentionTotal: number, dueFollowUpCount: number, overdueHandoffTotal = 0): number {
  return checklist.checklistIndicator.urgentCount + attentionTotal + dueFollowUpCount + overdueHandoffTotal;
}

function FocusObjectSection({ title, objects, total, health, hasMore, loadingMore, onLoadMore, onRetry, nowMs, ...interactions }: FocusInteractionProps & {
  title: "Alerts" | "Decisions";
  objects: Array<FocusAlert | FocusDecision>;
  total: number | null;
  health: FocusQueryHealth;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  nowMs: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const wide = useMediaQuery(FOCUS_WIDE_PREVIEW_QUERY);
  const previewLimit = wide ? 3 : 1;
  const problem = focusQueryProblem(title, health, nowMs);
  const preview = showAll ? objects : objects.slice(0, previewLimit);
  return <section id={`focus-${title.toLowerCase()}`} data-dashboard-panel={title.toLowerCase()} data-focus-preview={showAll ? "expanded" : "bounded"} data-priority-preview-limit={previewLimit} className={`${FOCUS_DASHBOARD_PANEL_CLASS} focus-priority-preview`}>
    <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">{title === "Alerts" ? <AlertTriangle size={15} /> : <Inbox size={15} />}{title} <span className="text-text-faint">({total ?? "unknown"})</span></h3>
    <p className="mt-1 text-xs text-text-muted">{title === "Alerts" ? "Conditions, evidence, and useful intervention time." : "Exact questions, consequences, and no-response behavior."}</p>
    {problem && <div role={health.error ? "alert" : "status"} className="mt-3 rounded-lg border border-warning/25 p-3 text-xs text-warning">
      {problem}.{health.error instanceof Error ? ` ${health.error.message}` : ""}
      <button type="button" className={`${UI.button.secondary} ml-2 min-h-11 text-xs`} onClick={onRetry}>Retry {title}</button>
    </div>}
    <div className="mt-3 space-y-3">
      {health.loading && objects.length === 0 ? <p className="text-sm text-text-muted">Loading {title.toLowerCase()}...</p>
        : objects.length === 0 && !problem ? <p className="text-sm text-text-muted">No {title.toLowerCase()} in the checked attention scope.</p>
          : <ol aria-label={`${title} priority previews`} className="space-y-3">
            {preview.map((object) => <li key={object.id}><FocusItemCard object={object} compact {...interactions} /></li>)}
          </ol>}
    </div>
    {(objects.length > previewLimit || hasMore) && <div className="mt-3 space-y-2 border-t border-border pt-3">
      <p className="text-xs text-text-faint">Showing {preview.length} of {total ?? "an unknown number of"} {title.toLowerCase()}. Previews are bounded on mobile and desktop; no records are discarded.</p>
      <div className="flex flex-wrap gap-2">
        {objects.length > previewLimit && <button type="button" aria-expanded={showAll} className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => setShowAll((value) => !value)}>{showAll ? `Show fewer ${title.toLowerCase()}` : `Show all ${objects.length} loaded ${title.toLowerCase()}`}</button>}
        {hasMore && <button type="button" disabled={loadingMore} className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => { setShowAll(true); onLoadMore(); }}>{loadingMore ? "Loading..." : `Load more ${title.toLowerCase()}`}</button>}
      </div>
    </div>}
  </section>;
}

function DigestList({ digests, ...props }: FocusInteractionProps & { digests: FocusDigest[] }) {
  const [showAll, setShowAll] = useState(false);
  return <div className="space-y-3">
    <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{(showAll ? digests : digests.slice(0, 6)).map((digest) => <FocusDigestSection key={digest.id} digest={digest} {...props} />)}</div>
    {digests.length > 6 && <button type="button" aria-expanded={showAll} className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer sources" : `Show all ${digests.length} sources`}</button>}
  </div>;
}

export default function DashboardFocus({
  active, tabbed, checklist, tasks, taskGroups, focusSnapshot, alertTotal, decisionTotal, alerts, decisions,
  alertsLoading, alertsHasMore, alertsLoadingMore, decisionsLoading, decisionsHasMore, decisionsLoadingMore,
  focusLoading, focusError, actionsLoading, actionsError, alertsError, decisionsError,
  actionsUpdatedAt, alertsUpdatedAt, decisionsUpdatedAt, nowMs,
  onSelectTask, onSelectSession, onStartPromptSession, onLoadMoreAlerts, onLoadMoreDecisions, onRetryFocus, onRefresh,
  notificationTarget, notificationError, onCloseNotification, onInspectSubject, initialHistoryQuery,
}: DashboardFocusProps) {
  const [historyTarget, setHistoryTarget] = useState<{ filter: FocusHistoryFilter; revision: number } | null>(null);
  const [localSubject, setLocalSubject] = useState<FocusSubjectTarget | null>(null);
  useEffect(() => {
    if (!initialHistoryQuery) return;
    setHistoryTarget((current) => ({
      filter: { query: initialHistoryQuery },
      revision: (current?.revision ?? 0) + 1,
    }));
  }, [initialHistoryQuery]);
  const dueFollowUps = useMemo(() => getDueFollowUpTasks(tasks, new Date(nowMs)), [nowMs, tasks]);
  const health = {
    Actions: { loading: actionsLoading, error: actionsError, updatedAt: actionsUpdatedAt },
    Alerts: { loading: alertsLoading, error: alertsError, updatedAt: alertsUpdatedAt },
    Decisions: { loading: decisionsLoading, error: decisionsError, updatedAt: decisionsUpdatedAt },
  };
  const assessment = assessFocusOverview(focusSnapshot, nowMs, health, focusError);
  const overdueHandoffTotal = focusDueHandoffCount(focusSnapshot, nowMs);
  const attentionCount = alertTotal === null || decisionTotal === null || overdueHandoffTotal === null || focusQueryProblem("Actions", health.Actions, nowMs) ? null
    : getDashboardFocusCount(checklist, alertTotal + decisionTotal, dueFollowUps.length, overdueHandoffTotal);
  const inspectHistory = (filter: FocusHistoryFilter) => setHistoryTarget((current) => ({ filter, revision: (current?.revision ?? 0) + 1 }));
  const inspectSubject = (target: FocusSubjectTarget) => {
    if (onInspectSubject) onInspectSubject(target);
    else setLocalSubject(target);
  };
  const closeSubject = () => { setLocalSubject(null); onCloseNotification?.(); };
  const interactions: FocusInteractionProps = {
    tasks, taskGroups, onSelectTask, onSelectSession, onStartPromptSession, onChanged: onRefresh,
    onInspectHistory: (id) => inspectHistory({ objectId: id }),
    onInspectHistoryFilter: inspectHistory,
  };
  const knownWindows = new Map<string, { id: string; activationId?: string; title: string; at: string; coverage: boolean; overdueHandoff?: boolean; context?: string }>();
  for (const item of focusSnapshot?.upcomingInterventions ?? []) {
    if (item.objectType === "event" || (item.lifecycle === "handed_off" && Date.parse(item.interventionBy) > nowMs)) continue;
    const loaded = [...alerts, ...decisions].find((object) => object.id === item.objectId);
    knownWindows.set(item.objectId, { id: item.objectId, title: item.title, at: item.interventionBy, coverage: false, activationId: loaded?.activationId, overdueHandoff: item.lifecycle === "handed_off" });
  }
  for (const item of [...(focusSnapshot?.overdueHandoffs ?? []), ...(focusSnapshot?.quietConcerns ?? []).filter((item) => item.lifecycle === "handed_off" && item.interventionBy && Date.parse(item.interventionBy) <= nowMs)]) {
    knownWindows.set(item.objectId, {
      id: item.objectId, activationId: item.activationId, title: item.title, at: item.interventionBy!, coverage: false, overdueHandoff: true,
      context: `${item.taskTitle ?? item.originalTaskTitle ?? (item.taskState === "global" ? "Global Focus" : "Removed or unknown task")} · ${item.taskState}`,
    });
  }
  for (const item of focusSnapshot?.coverage.summary?.upcomingInterventions ?? []) {
    knownWindows.set(`coverage:${item.id}`, { id: item.id, title: item.title, at: item.interventionBy, coverage: true });
  }
  const windows = [...knownWindows.values()].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const next = windows[0];
  const nextObject = [...alerts, ...decisions].find((object) => object.id === next?.id);
  const digests = focusSnapshot?.digests ?? [];
  const digestUnknown = !focusSnapshot || Boolean(focusError) || focusSnapshot.domainHealth.digests.status !== "ok"
    || !isFocusReadFresh(Date.parse(focusSnapshot.generatedAt), nowMs);
  const actionProblem = focusQueryProblem("Actions", health.Actions, nowMs);
  if (!active) return null;

  return <FocusInteractionProvider {...interactions} snapshot={focusSnapshot} nowMs={nowMs}>
    <section id={tabbed ? getDashboardPanelId("focus") : undefined} role={tabbed ? "tabpanel" : undefined}
      aria-labelledby={tabbed ? getDashboardTabId("focus") : undefined} tabIndex={tabbed ? 0 : undefined} className="min-w-0 space-y-5 pb-8">
      <FocusDashboardOverview attentionCount={attentionCount}
        urgentActionCount={actionProblem ? null : checklist.checklistIndicator.urgentCount}
        alertTotal={focusQueryProblem("Alerts", health.Alerts, nowMs) ? null : alertTotal}
        decisionTotal={focusQueryProblem("Decisions", health.Decisions, nowMs) ? null : decisionTotal}
        overdueHandoffTotal={overdueHandoffTotal}
        handedOffTotal={focusSnapshot?.handedOffTotal ?? null}
        onInspectHandoffs={() => inspectHistory({ lifecycle: "handed_off" })}
        dueFollowUpCount={dueFollowUps.length} state={assessment.state === "clear" && (attentionCount ?? 0) > 0 ? "complete" : assessment.state}
        problems={assessment.problems} generatedAt={focusSnapshot?.generatedAt} onRetry={() => void onRetryFocus()} />
      <section id="focus-next-intervention" data-dashboard-panel="next-intervention" className={`${FOCUS_DASHBOARD_PANEL_CLASS} border-info-border`}>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Clock3 size={15} />Next intervention</h3>
        {next ? <div className="mt-2 space-y-2 text-sm text-text-secondary">
          <p className="font-medium">{next.title}</p>
          {next.overdueHandoff && <p className="text-warning">Overdue handoff — the concern remains unresolved, even if its Action has completed.</p>}
          {next.context && <p className="text-xs text-text-muted">Source context: {next.context}</p>}
          <p className={Date.parse(next.at) <= nowMs ? "text-warning" : ""}>{Date.parse(next.at) <= nowMs ? "Intervention time reached / passed: " : "Intervene by: "}{focusTime(next.at)}</p>
          {nextObject?.details.consequenceOfDelay && <p>Waiting: {nextObject.details.consequenceOfDelay}</p>}
          {nextObject?.details.fallback && <p>No response: {nextObject.details.fallback}</p>}
          <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => next.coverage
            ? document.getElementById("focus-coverage")?.scrollIntoView({ block: "start" })
            : inspectSubject({ objectId: next.id, activationId: next.activationId })}>Review intervention</button>
          {windows.length > 1 && <p className="text-xs text-text-muted">{windows.length - 1} further known windows remain in coverage and record details.</p>}
          {assessment.state === "partial" && <p className="text-xs text-warning">Timing may be incomplete; this is the next known window, not a complete schedule.</p>}
        </div> : <p className="mt-2 text-sm text-text-muted">{assessment.state === "partial" ? "Next intervention unknown until the affected checks recover." : "No intervention window is currently admitted for review in the checked sources."}</p>}
        {(overdueHandoffTotal ?? 0) > 0 && <div className="mt-3 text-xs text-warning">
          <p>{overdueHandoffTotal} handed-off concerns require overdue review. Snapshot details are bounded; History retains all handed-off work.</p>
          <button type="button" className="min-h-11 underline" onClick={() => inspectHistory({ lifecycle: "handed_off" })}>Inspect handed-off History</button>
        </div>}
      </section>
      <FocusAuditWarning exceptions={focusSnapshot?.auditExceptions ?? []} observedAt={focusSnapshot?.generatedAt} onInspectHistory={interactions.onInspectHistory!} />
      {(focusSnapshot?.compatibilityErrorCount ?? 0) > 0 && <p role="status" className="rounded-xl border border-warning/25 p-3 text-sm text-warning">{focusSnapshot!.compatibilityErrorCount} legacy records are quarantined and excluded from Focus until repaired. History identifies unavailable records.</p>}

      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-12 xl:items-start">
        <div data-dashboard-region="priority" className="grid min-w-0 grid-cols-1 gap-5 xl:col-span-12 xl:grid-cols-2">
          <FocusObjectSection title="Alerts" objects={alerts} total={alertTotal} health={health.Alerts} hasMore={alertsHasMore} loadingMore={alertsLoadingMore}
            onLoadMore={() => void onLoadMoreAlerts()} onRetry={() => void onRetryFocus()} nowMs={nowMs} {...interactions} />
          <FocusObjectSection title="Decisions" objects={decisions} total={decisionTotal} health={health.Decisions} hasMore={decisionsHasMore} loadingMore={decisionsLoadingMore}
            onLoadMore={() => void onLoadMoreDecisions()} onRetry={() => void onRetryFocus()} nowMs={nowMs} {...interactions} />
        </div>
        <section id="focus-actions" data-dashboard-panel="actions" className={`${FOCUS_DASHBOARD_PANEL_CLASS} xl:col-span-8`}>
          {actionProblem && <div role={actionsError ? "alert" : "status"} className="mb-3 text-sm text-warning">{actionProblem}. <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => void onRefresh()}>Retry Actions</button></div>}
          {actionsLoading && checklist.localOpenChecklistItems.length === 0 ? <p className="text-sm text-text-muted">Loading Actions...</p>
            : !actionsError || checklist.localOpenChecklistItems.length > 0 || checklist.localCompletedChecklistItems.length > 0
              ? <DashboardChecklist active embedded bounded heading="Actions" checklist={checklist} onSelectTask={onSelectTask} onInspectFocusObject={interactions.onInspectHistory} />
              : <p className="text-sm text-text-muted">Action state is unavailable, not empty.</p>}
        </section>
        <div className="min-w-0 xl:col-span-4"><FocusAutonomyPanel snapshot={focusSnapshot} nowMs={nowMs} tasks={tasks} onRetry={() => void onRetryFocus()} onSelectTask={onSelectTask} /></div>
        <div className="min-w-0 xl:col-span-12"><FocusFollowUpPanel tasks={dueFollowUps} onSelectTask={onSelectTask} /></div>
      </div>

      <section data-dashboard-panel="digests" className={FOCUS_DASHBOARD_PANEL_CLASS}>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Layers3 size={15} />Active digests</h3>
        <p className="mt-1 text-xs text-text-muted">Recent observations and pinned Events, grouped by source. No obligation to clear them. Horizon: 7 days plus pinned records.</p>
        {digestUnknown && <p role={focusError ? "alert" : "status"} className="mt-3 text-xs text-warning">{focusLoading ? "Loading event digests..." : "Digest state unavailable or incomplete; any shown sources are the last loaded view."} <button type="button" className={`${UI.button.secondary} min-h-11`} onClick={() => void onRetryFocus()}>Retry digests</button></p>}
        <div className="mt-4">{digests.length > 0 ? <DigestList digests={digests} {...interactions} /> : !digestUnknown && <p className="text-sm text-text-muted">No active-source Events in this horizon. This does not establish coverage.</p>}</div>
      </section>
      <FocusQuietSources snapshot={focusSnapshot} {...interactions} />
      <FocusHistorySection {...interactions} nowMs={nowMs} targetFilter={historyTarget?.filter} targetRevision={historyTarget?.revision} />
      {(notificationTarget ?? localSubject) && <FocusSubjectDialog key={`${(notificationTarget ?? localSubject)!.objectId}:${(notificationTarget ?? localSubject)!.activationId ?? "current"}`}
        {...interactions} target={(notificationTarget ?? localSubject)!} onClose={closeSubject} onInspectCurrent={inspectSubject}
        onInspectHistory={(id) => { closeSubject(); inspectHistory({ objectId: id }); }} />}
      {notificationError && <FocusDialog title="Invalid Focus link" description={notificationError} pending={false} onClose={closeSubject}><p className="text-sm text-text-muted">Close this notice to remove only the invalid Focus link parameters.</p></FocusDialog>}
    </section>
  </FocusInteractionProvider>;
}
