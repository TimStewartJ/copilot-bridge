import { useEffect, useId, useState } from "react";
import type { ChecklistItem, FocusHistoryEntry, FocusHistoryFilter, FocusHistoryObjectType, FocusLifecycle } from "../api";
import { patchChecklistItem } from "../api";
import { FOCUS_LIFECYCLE_LABELS, focusTime, isFocusOpen } from "../focus-view-model";
import { useFocusHistoryPagesQuery, useFocusMutation, useFocusTransitionPagesQuery } from "../hooks/queries/useFocus";
import FocusItemCard from "./FocusItemCard";
import { FocusLifecycleBadge } from "./FocusCard";
import FocusEpisodeDetails, { FocusTransitionList } from "./FocusEpisodeDetails";
import type { FocusInteractionProps } from "./FocusInteractions";
import { UI } from "./shared/design-system";
import FocusTaskFilter from "./FocusTaskFilter";
import { describeFocusFilters, focusTaskContext, normalizeFocusReadFilter } from "../focus-filter-helpers";
import { useFocusFilterChoices } from "../hooks/useFocusFilterChoices";

const BUTTON = `${UI.button.secondary} min-h-11 text-xs`;
const FIELD = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-border bg-bg-surface px-3 text-sm text-text-primary";
const FILTER_LABELS: Record<keyof FocusHistoryFilter, string> = {
  query: "Search", objectId: "Object or Action ID", objectType: "Record type", taskId: "Task",
  originalTaskId: "Original task", lifecycle: "Lifecycle", sourceFamily: "Source family", activationId: "Episode ID",
};

function normalizeHistoryFilter(input: FocusHistoryFilter): FocusHistoryFilter {
  const filter: FocusHistoryFilter = normalizeFocusReadFilter(input);
  if (input.objectId?.trim()) filter.objectId = input.objectId.trim();
  if (input.objectType) filter.objectType = input.objectType;
  return filter;
}

function hasStructuredFilters(filter: FocusHistoryFilter): boolean {
  return Object.keys(filter).some((key) => key !== "query");
}

function ActionRecord({ action, readOnly = false, onSelectTask, onInspectHistory }: Pick<FocusInteractionProps, "onSelectTask" | "onInspectHistory"> & { action: ChecklistItem; readOnly?: boolean }) {
  const mutation = useFocusMutation(action.id, (done: boolean) => patchChecklistItem(action.id, { done }), true);
  return <div className="space-y-2 rounded-lg border border-border bg-bg-surface p-3 text-sm text-text-secondary">
    <h5 className="font-semibold">{action.text}</h5>
    <p>{readOnly ? "Recorded state: " : ""}{action.done ? "Action completed" : "Action open"}{action.completedAt ? ` at ${focusTime(action.completedAt)}` : ""}.</p>
    {readOnly && <p className="text-xs text-text-muted">This Action record is read-only.</p>}
    <p className="text-xs text-text-muted">Action completion is independent of source resolution.</p>
    {action.orphanedAt && <p className="text-xs text-warning">Original task removed: {action.originalTaskTitle ?? action.originalTaskId}. Work is not silently reassigned to Global Actions.</p>}
    {action.deadline && <p className="text-xs">Deadline: {action.deadline}</p>}
    {action.sources?.map((source) => <div key={`${source.sourceId}:${source.activationId}`} className="text-xs">
      <p>Source {source.sourceType}: {source.title} — {FOCUS_LIFECYCLE_LABELS[source.lifecycle]}{isFocusOpen(source.lifecycle) ? readOnly ? " (recorded open)" : " (still open)" : ""}</p>
      {onInspectHistory && <button type="button" className={BUTTON} onClick={() => onInspectHistory(source.sourceId)}>Inspect source</button>}
    </div>)}
    {action.sourceUrl && <a href={action.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-xs text-accent underline">Source evidence</a>}
    {mutation.error && <p role="alert" className="text-xs text-error">Action update failed: {mutation.error.message}</p>}
    <div className="flex flex-wrap gap-2">
      {!readOnly && <button type="button" disabled={mutation.isPending} className={BUTTON} onClick={() => mutation.mutate(!action.done)}>
        {mutation.isPending ? "Saving..." : action.done ? "Reopen Action" : "Complete Action"}
      </button>}
      {action.taskId && <button type="button" className={BUTTON} onClick={() => onSelectTask(action.taskId!, { checklistItemId: action.id })}>Open Action task</button>}
    </div>
  </div>;
}

function HistoryRecord({ entry, nowMs, ...props }: FocusInteractionProps & { entry: FocusHistoryEntry; nowMs: number }) {
  const [expanded, setExpanded] = useState(false);
  const [showTransitions, setShowTransitions] = useState(false);
  const query = useFocusTransitionPagesQuery(entry.id, expanded && showTransitions && entry.transitionTotal > 0);
  const transitions = query.data?.pages.flat() ?? entry.transitions;
  const currentMatch = entry.matchSource === "current";
  const episode = entry.matchSource === "previous_episode" ? entry.matchedEpisode : null;
  const matchedTransition = currentMatch ? null : entry.matchedTransition;
  const object = currentMatch ? entry.object : null;
  const focus = object && "objectType" in object ? object : null;
  const readOnly = entry.deleted || entry.quarantined;
  const title = currentMatch ? entry.title : episode?.title ?? matchedTransition?.title ?? "Retained match — details unavailable";
  const objectType = episode?.objectType ?? matchedTransition?.objectType ?? entry.objectType;
  const matchedAt = currentMatch ? entry.updatedAt : episode?.updatedAt ?? matchedTransition?.createdAt;
  const lifecycle = episode?.lifecycle ?? focus?.lifecycle;
  const outcome = episode?.outcome ?? focus?.details.outcome;
  const currentEpisodeId = entry.object && "activationId" in entry.object ? entry.object.activationId : null;
  const agedEvent = focus?.objectType === "event" && isFocusOpen(focus.lifecycle)
    && !focus.pinned && Date.parse(focus.details.lastMeaningfulChangeAt) < nowMs - 7 * 86_400_000;
  return <article className="min-w-0 rounded-xl border border-border bg-bg-secondary/50 p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h4 className="break-words text-sm font-semibold text-text-primary">{title}</h4>
        <p className="mt-1 text-xs text-text-muted">{objectType}{matchedAt && <> · {currentMatch ? "Record updated" : episode ? "Snapshot updated" : "Transition recorded"} <time dateTime={matchedAt}>{focusTime(matchedAt)}</time></>}</p>
        {lifecycle && <div className="mt-2"><FocusLifecycleBadge lifecycle={lifecycle} /></div>}
      </div>
      <button type="button" aria-expanded={expanded} className={BUTTON} onClick={() => setExpanded((value) => !value)}>{expanded ? "Close record" : "Inspect record"}</button>
    </div>
    {!currentMatch && <p className="mt-2 text-xs text-text-muted">
      {episode ? "Matched a retained earlier state, not the current record. Read-only."
        : entry.matchSource === "transition" ? "Transition-only match. Full episode details for this match are unknown; the current record is not the historical match."
          : "The matched episode snapshot is unavailable. Prior details and outcome are unknown."}
    </p>}
    {agedEvent && <p className="mt-2 text-xs text-text-muted">Active aged Event - outside the digest horizon, not resolved. An Event carries no inherent obligation.</p>}
    {focus?.objectType !== "event" && focus?.lifecycle === "handed_off" && <p className="mt-2 text-xs text-info">Handed-off concern remains open; execution is not its resolution.</p>}
    {outcome && <p className="mt-2 text-xs text-text-secondary">Outcome: {outcome}</p>}
    {entry.deleted && <p className="mt-2 text-xs text-text-muted">Deleted record. History is read-only; this is not a resolved outcome.</p>}
    {entry.quarantined && <p className="mt-2 text-xs text-warning">Quarantined record. Canonical content is unavailable until repaired; history remains readable.</p>}
    {expanded && <div className="mt-3 space-y-3">
      {episode ? <>
        <FocusEpisodeDetails episode={episode} onSelectTask={props.onSelectTask} onSelectSession={props.onSelectSession} onInspectHistory={props.onInspectHistory} />
        {matchedTransition && <p className="break-all text-xs text-text-muted">Snapshot retained before transition {matchedTransition.id} · Transition episode: {matchedTransition.activationId}</p>}
      </> : !currentMatch ? matchedTransition
        ? <FocusTransitionList transitions={[matchedTransition]} onSelectTask={props.onSelectTask} onSelectSession={props.onSelectSession} onInspectHistory={props.onInspectHistory} />
        : <p className="text-xs text-text-muted">Matching transition details are unavailable. Current content is not substituted.</p>
        : focus ? <FocusItemCard {...props} object={focus} readOnly={readOnly} />
        : object && !("objectType" in object) ? <ActionRecord action={object} readOnly={readOnly} onSelectTask={props.onSelectTask} onInspectHistory={props.onInspectHistory} />
          : <p className="text-xs text-text-muted">Current content and outcome unavailable. Inspect retained transitions below.</p>}
      {!currentMatch && entry.object && !readOnly && props.onInspectHistory && <div className="space-y-1 border-t border-border pt-2">
        <p className="break-all text-xs text-text-muted">Current record is separate from this match.{currentEpisodeId ? ` Current episode: ${currentEpisodeId}.` : ""}</p>
        <button type="button" className={BUTTON} onClick={() => props.onInspectHistory!(entry.id)}>Open current record</button>
      </div>}
      <button type="button" aria-expanded={showTransitions} className={BUTTON} onClick={() => setShowTransitions((value) => !value)}>Lifecycle transitions ({entry.transitionTotal})</button>
      {showTransitions && <div className="space-y-2">
        {query.error && <p role="alert" className="text-xs text-error">Transition history refresh failed: {query.error.message} <button type="button" className={BUTTON} onClick={() => void query.refetch()}>Retry transitions</button></p>}
        {query.isLoading && <p role="status" className="text-xs text-text-muted">Loading transitions...</p>}
        {transitions.length === 0 ? <p className="text-xs text-text-muted">No transitions recorded.</p> : <FocusTransitionList transitions={transitions} onSelectTask={props.onSelectTask} onSelectSession={props.onSelectSession} onInspectHistory={props.onInspectHistory} />}
        {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} className={BUTTON} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading..." : "Load older transitions"}</button>}
      </div>}
    </div>}
  </article>;
}

export default function FocusHistorySection({
  targetId, targetFilter, targetRevision = 0, nowMs, ...props
}: FocusInteractionProps & { targetId?: string; targetFilter?: FocusHistoryFilter; targetRevision?: number; nowMs: number }) {
  const requestedFilter = targetFilter !== undefined ? normalizeHistoryFilter(targetFilter)
    : targetId ? normalizeHistoryFilter({ objectId: targetId }) : null;
  const targetKey = requestedFilter === null ? null : JSON.stringify(requestedFilter);
  const [expanded, setExpanded] = useState(requestedFilter !== null);
  const [filter, setFilter] = useState<FocusHistoryFilter>(requestedFilter ?? {});
  const [draft, setDraft] = useState<FocusHistoryFilter>(requestedFilter ?? {});
  const [showFilters, setShowFilters] = useState(hasStructuredFilters(requestedFilter ?? {}));
  const labelId = useId();
  const invalidSearch = (draft.query?.trim().length ?? 0) > 500;
  const invalidAppliedSearch = (filter.query?.length ?? 0) > 500;
  const query = useFocusHistoryPagesQuery(filter, expanded && !invalidAppliedSearch);
  const entries = query.data?.pages.flatMap((page) => page.objects) ?? [];
  const taskContexts = entries.flatMap((entry) => [
    ...(entry.object ? [focusTaskContext(entry.object)] : []),
    ...(entry.matchedEpisode ? [entry.matchedEpisode] : []),
    ...entry.transitions.flatMap((transition) => transition.details.previousEpisode ? [transition.details.previousEpisode] : []),
  ]);
  const { taskChoices, originalChoices } = useFocusFilterChoices(props.tasks, taskContexts);
  useEffect(() => {
    if (targetKey === null) return;
    const nextFilter = JSON.parse(targetKey) as FocusHistoryFilter;
    setExpanded(true);
    setFilter(nextFilter);
    setDraft(nextFilter);
    setShowFilters(hasStructuredFilters(nextFilter));
    document.getElementById("focus-history")?.scrollIntoView({ block: "start" });
  }, [targetKey, targetRevision]);

  return <section id="focus-history" data-dashboard-panel="history" className="min-w-0 rounded-2xl border border-border/60 bg-bg-secondary/45 p-4">
    <h3><button type="button" className="min-h-11 text-sm font-semibold text-text-secondary" aria-expanded={expanded} aria-controls={labelId} onClick={() => setExpanded((value) => !value)}>History</button></h3>
    <p className="text-xs text-text-muted">Quiet retrieval, not an inbox. Includes open and aged records, lifecycle outcomes, linked work, and cleared or deleted records. No unread state.</p>
    {expanded && <div id={labelId} className="mt-4 space-y-3">
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (invalidSearch) return;
        const nextFilter = normalizeHistoryFilter(draft);
        setFilter(nextFilter);
        setDraft(nextFilter);
      }}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-text-muted">Search history
            <input type="search" name="query" maxLength={500} aria-invalid={invalidSearch || undefined} aria-describedby={invalidSearch ? `${labelId}-search-error` : undefined}
              value={draft.query ?? ""} onChange={(event) => setDraft((current) => ({ ...current, query: event.target.value }))} className={FIELD} />
          </label>
          <button type="submit" disabled={invalidSearch} className={BUTTON}>Find records</button>
          <button type="button" aria-expanded={showFilters} aria-controls={`${labelId}-filters`} className={BUTTON} onClick={() => setShowFilters((value) => !value)}>History filters</button>
          {Object.keys(filter).length > 0 && <button type="button" className={BUTTON} onClick={() => { setFilter({}); setDraft({}); }}>Clear history filter</button>}
        </div>
        {invalidSearch && <p id={`${labelId}-search-error`} role="alert" className="text-xs text-error">Search history must be 500 characters or fewer.</p>}
        {showFilters && <div id={`${labelId}-filters`} className="space-y-2">
          <p className="text-xs text-text-muted">Filter by readable task names and recorded state. Exact identifiers remain available for retained or unlisted tasks.</p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <FocusTaskFilter label="Task" value={draft.taskId} choices={taskChoices} onChange={(taskId) => setDraft((current) => ({ ...current, taskId }))} />
            <FocusTaskFilter label="Original task" value={draft.originalTaskId} choices={originalChoices} onChange={(originalTaskId) => setDraft((current) => ({ ...current, originalTaskId }))} />
            {(["sourceFamily", "objectId", "activationId"] as const).map((field) => <label key={field} className="min-w-0 text-xs text-text-muted">{FILTER_LABELS[field]}
              <input name={field} value={draft[field] ?? ""}
                onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} className={FIELD} />
            </label>)}
            <label className="min-w-0 text-xs text-text-muted">Record type
              <select name="objectType" value={draft.objectType ?? ""} onChange={(event) => setDraft((current) => ({ ...current, objectType: event.target.value ? event.target.value as FocusHistoryObjectType : undefined }))} className={FIELD}>
                <option value="">All records</option><option value="decision">Decisions</option><option value="alert">Alerts</option><option value="event">Events</option><option value="action">Actions</option>
              </select>
            </label>
            <label className="min-w-0 text-xs text-text-muted">Lifecycle
              <select name="lifecycle" value={draft.lifecycle ?? ""} onChange={(event) => setDraft((current) => ({ ...current, lifecycle: event.target.value ? event.target.value as FocusLifecycle : undefined }))} className={FIELD}>
                <option value="">All lifecycles</option>{Object.entries(FOCUS_LIFECYCLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
        </div>}
      </form>
      {Object.keys(filter).length > 0 && <p className="break-words text-xs text-text-muted">Applied filters: {describeFocusFilters(filter, taskChoices, originalChoices)}</p>}
      {query.error && <p role="alert" className="rounded-lg border border-error/25 p-3 text-sm text-error">History unavailable or incomplete: {query.error.message} <button type="button" className={BUTTON} onClick={() => void query.refetch()}>Retry History</button></p>}
      {query.isLoading ? <p role="status" className="text-sm text-text-muted">Loading history...</p>
        : entries.length === 0 && !query.error && !invalidAppliedSearch ? <p className="text-sm text-text-muted">No records match this history view.</p> : null}
      {query.data && <p className="text-xs text-text-faint">Loaded {entries.length} of {query.data.pages[0].total} records.</p>}
      <div key={JSON.stringify(filter)} className="space-y-3">
        {entries.map((entry) => <HistoryRecord key={`${entry.id}:${entry.matchSource}:${entry.matchedTransition?.id ?? ""}`} entry={entry} nowMs={nowMs} {...props} />)}
      </div>
      {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} className={`${BUTTON} w-full`} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading more history..." : "Load more history"}</button>}
    </div>}
  </section>;
}
