import { useId, useState } from "react";
import type { FocusLifecycle, FocusQuietConcernFilter, FocusSnapshot } from "../api";
import { useFocusQuietConcernPagesQuery } from "../hooks/queries/useFocus";
import { FOCUS_LIFECYCLE_LABELS } from "../focus-view-model";
import FocusDigestSection from "./FocusDigestSection";
import type { FocusInteractionProps } from "./FocusInteractions";
import { UI } from "./shared/design-system";
import FocusTaskFilter from "./FocusTaskFilter";
import { describeFocusFilters, focusTaskContext, normalizeFocusReadFilter } from "../focus-filter-helpers";
import { useFocusFilterChoices } from "../hooks/useFocusFilterChoices";

export default function FocusQuietSources({ snapshot, ...props }: FocusInteractionProps & { snapshot?: FocusSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const [showAllDigests, setShowAllDigests] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filter, setFilter] = useState<FocusQuietConcernFilter>({});
  const [draft, setDraft] = useState<FocusQuietConcernFilter>({});
  const filterId = useId();
  const invalidSearch = (draft.query?.trim().length ?? 0) > 500;
  const query = useFocusQuietConcernPagesQuery(filter, expanded);
  const concerns = query.data?.pages.flatMap((page) => page.objects) ?? [];
  const digests = snapshot?.quietDigests ?? [];
  const filtered = Object.keys(filter).length > 0;
  const total = query.data?.pages[0]?.total ?? (filtered ? undefined : snapshot?.quietConcernTotal);
  const taskContexts = [...(snapshot?.quietConcerns ?? []), ...concerns.map(focusTaskContext)];
  const { taskChoices, originalChoices } = useFocusFilterChoices(props.tasks, taskContexts);
  const fieldClass = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-border bg-bg-surface px-3 text-sm text-text-primary";
  return <section data-dashboard-panel="quiet-sources" className="min-w-0 rounded-2xl border border-border/60 p-4">
    <h3><button type="button" className="min-h-11 text-sm font-semibold text-text-secondary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>Quiet sources</button></h3>
    <p className="text-xs text-text-muted">Muted, archived, and removed-task concerns remain retrievable even without recent Events. This inventory has no unread state.</p>
    {expanded && <div className="mt-3 space-y-4">
      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-text-secondary">Quiet Decisions and Alerts</h4>
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (invalidSearch) return;
          const next: FocusQuietConcernFilter = { ...normalizeFocusReadFilter(draft), ...(draft.objectType ? { objectType: draft.objectType } : {}) };
          setFilter(next);
          setDraft(next);
        }}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 text-xs text-text-muted">Search quiet concerns
              <input type="search" maxLength={500} value={draft.query ?? ""} aria-invalid={invalidSearch || undefined}
                aria-describedby={invalidSearch ? `${filterId}-error` : undefined}
                onChange={(event) => setDraft((current) => ({ ...current, query: event.target.value }))} className={fieldClass} />
            </label>
            <button type="submit" disabled={invalidSearch} className={`${UI.button.secondary} min-h-11 text-xs`}>Find quiet concerns</button>
            <button type="button" aria-expanded={showFilters} aria-controls={filterId} className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => setShowFilters((value) => !value)}>Quiet filters</button>
            {filtered && <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => { setFilter({}); setDraft({}); }}>Clear quiet filters</button>}
          </div>
          {invalidSearch && <p id={`${filterId}-error`} role="alert" className="text-xs text-error">Search quiet concerns must be 500 characters or fewer.</p>}
          {showFilters && <div id={filterId} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <FocusTaskFilter label="Task" value={draft.taskId} choices={taskChoices} onChange={(taskId) => setDraft((current) => ({ ...current, taskId }))} />
            <FocusTaskFilter label="Original task" value={draft.originalTaskId} choices={originalChoices} onChange={(originalTaskId) => setDraft((current) => ({ ...current, originalTaskId }))} />
            <label className="min-w-0 text-xs text-text-muted">Source family
              <input value={draft.sourceFamily ?? ""} onChange={(event) => setDraft((current) => ({ ...current, sourceFamily: event.target.value }))} className={fieldClass} />
            </label>
            <label className="min-w-0 text-xs text-text-muted">Lifecycle
              <select value={draft.lifecycle ?? ""} onChange={(event) => {
                const value = event.target.value;
                const lifecycle: FocusLifecycle | undefined = value === "active" || value === "acknowledged" || value === "handed_off" ? value : undefined;
                setDraft((current) => ({ ...current, lifecycle }));
              }} className={fieldClass}>
                <option value="">All open states</option><option value="active">Active</option><option value="acknowledged">Acknowledged</option><option value="handed_off">Handed off</option>
              </select>
            </label>
            <label className="min-w-0 text-xs text-text-muted">Record type
              <select value={draft.objectType ?? ""} onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({ ...current, objectType: value === "decision" || value === "alert" ? value : undefined }));
              }} className={fieldClass}>
                <option value="">Decisions and Alerts</option><option value="decision">Decisions</option><option value="alert">Alerts</option>
              </select>
            </label>
          </div>}
        </form>
        {filtered && <p className="break-words text-xs text-text-muted">Applied quiet filters: {describeFocusFilters(filter, taskChoices, originalChoices)}</p>}
        {query.isLoading && <p role="status" className="text-xs text-text-muted">Loading quiet concern inventory...</p>}
        {query.error && <p role="alert" className="text-xs text-error">Quiet concern inventory unavailable or incomplete: {query.error.message}
          <button type="button" className="ml-2 min-h-11 underline" onClick={() => void query.refetch()}>Retry quiet concerns</button>
        </p>}
        {!query.isLoading && !query.error && concerns.length === 0 && <p className="text-xs text-text-muted">{filtered ? "No quiet concerns match these filters. This is not an all-clear for other scopes." : "No concerns in the checked quiet-task inventory. Other handed-off work remains in History."}</p>}
        {total != null && <p className="text-xs text-text-faint">Loaded {concerns.length} of {total} quiet concerns. These are retrieval records, not unread attention.</p>}
        {concerns.map((concern) => <article key={concern.id} className="min-w-0 space-y-1 rounded-lg border border-border p-3 text-xs text-text-muted">
          <h5 className="break-words text-sm font-medium text-text-primary">{concern.title}</h5>
          <p>{concern.objectType} — {FOCUS_LIFECYCLE_LABELS[concern.lifecycle]} · {concern.suppressionReason}</p>
          <p>Context: {concern.taskTitle ?? concern.details.originalTaskTitle ?? (concern.taskState === "orphaned" ? "Removed task" : "Unspecified task")}</p>
          <p>Source family: {concern.details.sourceFamily ?? "Not recorded"}</p>
          <div className="flex flex-wrap gap-2">
            {props.onInspectHistory && <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => props.onInspectHistory!(concern.id)}>Inspect concern History</button>}
            {props.onInspectHistoryFilter && <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => props.onInspectHistoryFilter!({
              ...(concern.taskState === "orphaned" && concern.details.originalTaskId ? { originalTaskId: concern.details.originalTaskId } : concern.taskId ? { taskId: concern.taskId } : {}),
              ...(concern.details.sourceFamily ? { sourceFamily: concern.details.sourceFamily } : {}),
            })}>Inspect source History</button>}
          </div>
        </article>)}
        {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading..." : "Load more quiet concerns"}</button>}
        {props.onInspectHistoryFilter && <button type="button" className="min-h-11 text-xs text-accent underline" onClick={() => props.onInspectHistoryFilter!({ lifecycle: "handed_off" })}>Inspect all handed-off work in History</button>}
      </section>
      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-text-secondary">Quiet Event digests</h4>
        {digests.length === 0 ? <p className="text-xs text-text-muted">{snapshot?.domainHealth.digests.status === "ok" ? "No quiet Events in the recent digest horizon. This says nothing about older concerns." : "Quiet Event digest state is unknown."}</p>
          : <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">{(showAllDigests ? digests : digests.slice(0, 6)).map((digest) => <FocusDigestSection key={digest.id} digest={digest} {...props} />)}</div>}
        {digests.length > 6 && <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`} aria-expanded={showAllDigests} onClick={() => setShowAllDigests((value) => !value)}>{showAllDigests ? "Show fewer quiet digests" : `Show all ${digests.length} quiet digests`}</button>}
      </section>
    </div>}
  </section>;
}
