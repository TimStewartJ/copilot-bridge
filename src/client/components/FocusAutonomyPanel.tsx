import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { FocusAuthorityGrant, FocusSnapshot, Task } from "../api";
import { coverageNeedsRefresh, focusTime, isFocusReadFresh } from "../focus-view-model";
import { useFocusAuthorityPagesQuery, useFocusCoveragePagesQuery } from "../hooks/queries/useFocus";
import { FocusEvidenceList } from "./FocusCard";
import { FOCUS_DASHBOARD_PANEL_CLASS } from "./FocusDashboardWidgets";
import { UI } from "./shared/design-system";

const BUTTON = `${UI.button.secondary} min-h-11 text-xs`;

function AuthorityDisclosure({ snapshot, tasks, nowMs, onSelectTask }: {
  snapshot?: FocusSnapshot; tasks: Task[]; nowMs: number; onSelectTask: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const query = useFocusAuthorityPagesQuery(expanded);
  const useSnapshot = Boolean(snapshot && (!query.data || Date.parse(snapshot.generatedAt) > query.dataUpdatedAt));
  const grants: FocusAuthorityGrant[] = useSnapshot ? snapshot!.authorityConstraints : query.data?.pages.flat() ?? [];
  const authorityVerified = !query.error && (!useSnapshot && query.data
    ? isFocusReadFresh(query.dataUpdatedAt, nowMs)
    : Boolean(snapshot && snapshot.domainHealth.authority.status === "ok" && isFocusReadFresh(Date.parse(snapshot.generatedAt), nowMs)));
  const state = (grant: FocusAuthorityGrant) => {
    if (grant.orphanedAt) return "Orphaned - not active";
    if (grant.status === "revoked") return "Revoked";
    if (Date.parse(grant.validUntil) <= nowMs) return "Expired";
    if (Date.parse(grant.validFrom) > nowMs) return "Not yet active";
    if (grant.taskId && !tasks.some((task) => task.id === grant.taskId && task.status === "active")) return "Task availability unverified";
    return "Active recorded grant";
  };
  return <div className="mt-4 border-t border-border pt-3">
    <button type="button" className={BUTTON} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>Authority grants and constraints</button>
    {expanded && <div className="mt-3 space-y-3 text-xs text-text-muted">
      <p>Scope and constraints are recorded declarations. Matching grants are checked for Focus notification eligibility; they are not general execution permissions.</p>
      <p>Runtime-enforced permissions depend on the actual action path. This panel does not verify or enforce those permissions.</p>
      {query.isLoading && <p role="status">Loading authority grants...</p>}
      {query.error && <p role="alert">Authority unavailable; last loaded grants are not current assurance. {query.error.message} <button type="button" className={BUTTON} onClick={() => void query.refetch()}>Retry authority</button></p>}
      {!query.isLoading && !query.error && grants.length === 0 && <p>No authority grants recorded. Do not infer authorization from silence.</p>}
      {grants.map((grant) => <article key={grant.id} className="min-w-0 space-y-1 rounded-lg border border-border bg-bg-surface p-3">
        <h4 className="break-words text-sm font-medium text-text-primary">{grant.title}</h4>
        <p className="font-medium">{authorityVerified ? state(grant) : "Current authority unknown"}</p>
        <p>Declared scope: {grant.scope}</p>
        <p>Source: {grant.sourceFamily} · Producer: {grant.producer}</p>
        <p>Valid from {focusTime(grant.validFrom)} until {focusTime(grant.validUntil)}</p>
        <p>Granted by: {grant.grantedBy}</p>
        <p>Immediate notifications: {grant.allowImmediate ? "allowed by grant, subject to delivery policy" : "not allowed"}</p>
        <p>Quiet-hours override: {grant.allowQuietHoursOverride ? "permitted only when settings also allow it" : "not allowed"}</p>
        {grant.constraints.length > 0 ? <ul className="list-inside list-disc">{grant.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul>
          : <p>No additional declarative constraints recorded. Notification matching still checks scope and validity.</p>}
        {grant.revokeReason && <p>Revocation reason: {grant.revokeReason}</p>}
        {grant.taskId ? <button type="button" className={BUTTON} onClick={() => onSelectTask(grant.taskId!)}>Open grant task</button> : <p>Global scope</p>}
      </article>)}
      {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} className={BUTTON} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading..." : "Load more grants"}</button>}
    </div>}
  </div>;
}

export default function FocusAutonomyPanel({ snapshot, nowMs, tasks, onRetry, onSelectTask }: {
  snapshot?: FocusSnapshot; nowMs: number; tasks: Task[]; onRetry: () => void; onSelectTask: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const query = useFocusCoveragePagesQuery(expanded);
  const useSnapshot = Boolean(snapshot && (!query.data || Date.parse(snapshot.generatedAt) > query.dataUpdatedAt));
  const summary = useSnapshot ? snapshot!.coverage.summary : query.data?.pages[0]?.summary;
  const assertions = useSnapshot ? snapshot!.coverage.assertions : query.data?.pages.flatMap((page) => page.assertions) ?? [];
  const knownAssertions = new Map((useSnapshot ? [] : snapshot?.coverage.assertions ?? []).map((assertion) => [assertion.id, assertion]));
  for (const assertion of assertions) knownAssertions.set(assertion.id, assertion);
  const stale = !isFocusReadFresh(useSnapshot ? Date.parse(snapshot!.generatedAt) : query.dataUpdatedAt, nowMs);
  const unavailable = (useSnapshot && snapshot?.domainHealth.coverage.status !== "ok") || stale || Boolean(query.error);
  const timeChanged = [...knownAssertions.values()].some((assertion) => coverageNeedsRefresh(assertion, nowMs));
  const titleFor = (id: string) => assertions.find((assertion) => assertion.id === id)?.title ?? id;
  return <section id="focus-coverage" data-dashboard-panel="coverage" className={FOCUS_DASHBOARD_PANEL_CLASS}>
    <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><ShieldCheck size={16} />Autonomy coverage</h3>
    <p className="mt-1 text-xs text-text-muted">Assurances are bounded by the stated scope, evidence, and horizon. No claim of overall safety.</p>
    {(unavailable || timeChanged || !summary?.total) && <div className="mt-3 rounded-lg border border-warning/25 bg-warning/10 p-3 text-xs text-warning">
      {timeChanged ? "A stated observation or validity horizon has elapsed. Refresh before relying on these counts."
        : stale ? "Coverage freshness unknown or stale."
          : snapshot?.domainHealth.coverage.error ?? "Coverage is incomplete or unknown. No assurance can be inferred from absent Alerts."}
      <button type="button" className={`${BUTTON} mt-2`} onClick={() => { onRetry(); if (expanded) void query.refetch(); }}>Retry coverage checks</button>
    </div>}
    {summary && <div className="mt-4 space-y-3">
      <p className="text-xs text-text-faint">Reported at the last successful check, not continuously verified:</p>
      <dl className="grid grid-cols-2 gap-2">
        {([
          ["valid", "Valid assurances"], ["at-risk", "At risk"], ["expired", "Expired"], ["broken", "Broken"], ["unknown", "Unknown"],
        ] as const).map(([state, label]) => <div key={state} data-coverage-state={state} className="rounded-lg border border-border/70 bg-bg-surface p-2.5">
          <dt className="text-xs text-text-muted">{label}</dt><dd className="mt-1 font-semibold text-text-primary">{summary.counts[state]}</dd>
        </div>)}
      </dl>
      <div className="text-xs text-text-secondary"><h4 className="font-semibold">Observation gaps ({summary.observationGaps.length})</h4>
        {summary.observationGaps.length === 0 ? <p className="mt-1 text-text-muted">None reported within the checked assertions.</p>
          : <ul className="mt-1 list-inside list-disc">{summary.observationGaps.map((gap) => <li key={gap.id}>{gap.title}: {gap.reason}</li>)}</ul>}
      </div>
      <div className="text-xs text-text-secondary"><h4 className="font-semibold">Upcoming intervention windows</h4>
        {summary.upcomingInterventions.length === 0 ? <p className="mt-1 text-text-muted">No windows reported by coverage assertions.</p>
          : <ul className="mt-1 space-y-1">{summary.upcomingInterventions.slice(0, 3).map((item) => <li key={item.id}>{item.title} — {Date.parse(item.interventionBy) <= nowMs ? "time reached: " : ""}{focusTime(item.interventionBy)}</li>)}</ul>}
        {summary.upcomingInterventions.length > 3 && <p className="mt-1 text-text-muted">{summary.upcomingInterventions.length - 3} additional windows in the assertions below.</p>}
      </div>
      <div className="text-xs text-text-secondary"><h4 className="font-semibold">Recorded authority gaps / constraints ({summary.constrainedAutonomy.length})</h4>
        {summary.constrainedAutonomy.length === 0 ? <p className="mt-1 text-text-muted">No authority gaps or declarative constraints reported in these assertions.</p>
          : <ul className="mt-1 list-inside list-disc">{summary.constrainedAutonomy.map((item) => <li key={item.id}>{titleFor(item.id)}: {item.constraints.join("; ")}</li>)}</ul>}
        <p className="mt-1 text-text-muted">A missing or expired grant can prevent a Focus notification from being eligible. It does not, by itself, prove that execution is stopped or blocked.</p>
      </div>
    </div>}
    <button type="button" className={`${BUTTON} mt-4`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>Inspect coverage assertions</button>
    {expanded && <div className="mt-3 space-y-3">
      {query.isLoading && <p className="text-xs text-text-muted" role="status">Loading assertions...</p>}
      {query.error && <p role="alert" className="text-xs text-error">Coverage assertions unavailable: {query.error.message}</p>}
      {assertions.map((assertion) => <article key={assertion.id} className="min-w-0 space-y-2 rounded-lg border border-border bg-bg-surface p-3 text-xs text-text-muted">
        <h4 className="break-words text-sm font-medium text-text-primary">{assertion.title}</h4>
        <p>Reported state: {assertion.state}{coverageNeedsRefresh(assertion, nowMs) ? " - needs refresh; do not rely on old validity" : ""}</p>
        <p>Declared coverage scope: {assertion.scope}</p><p>Source: {assertion.sourceFamily} · Producer: {assertion.producer}</p>
        <p>Last checked: {focusTime(assertion.lastCheckedAt)} · Expected every {assertion.expectedIntervalMinutes} minutes</p>
        <p>Valid until: {focusTime(assertion.validUntil)} · Intervention: {focusTime(assertion.interventionBy)}</p>
        {assertion.reason && <p>Reason: {assertion.reason}</p>}
        {assertion.observationGap && <p className="text-warning">Observation gap: {assertion.observationGap}</p>}
        {assertion.constrainedAutonomy.length > 0 && <p>Recorded constraints / authority gaps: {assertion.constrainedAutonomy.join("; ")}</p>}
        <FocusEvidenceList evidence={assertion.evidence} />
      </article>)}
      {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} className={BUTTON} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading..." : "Load more assertions"}</button>}
    </div>}
    <AuthorityDisclosure snapshot={snapshot} tasks={tasks} nowMs={nowMs} onSelectTask={onSelectTask} />
  </section>;
}
