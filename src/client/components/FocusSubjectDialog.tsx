import { useFocusEpisodePagesQuery, useFocusHistoryPagesQuery } from "../hooks/queries/useFocus";
import { FOCUS_LIFECYCLE_LABELS, isFocusOpen } from "../focus-view-model";
import type { FocusSubjectTarget } from "../lib/focus-subject-links";
import FocusDialog from "./FocusDialog";
import FocusEpisodeDetails, { FocusTransitionList } from "./FocusEpisodeDetails";
import FocusItemCard from "./FocusItemCard";
import type { FocusInteractionProps } from "./FocusInteractions";
import { UI } from "./shared/design-system";

export default function FocusSubjectDialog({
  target, onClose, onInspectCurrent, ...props
}: FocusInteractionProps & {
  target: FocusSubjectTarget;
  onClose: () => void;
  onInspectCurrent: (target: FocusSubjectTarget) => void;
}) {
  const episodeQuery = useFocusEpisodePagesQuery(target.objectId, target.activationId ?? "", Boolean(target.activationId));
  const historyQuery = useFocusHistoryPagesQuery({ objectId: target.objectId }, !target.activationId);
  const episode = episodeQuery.data?.pages[0];
  const entry = !target.activationId ? historyQuery.data?.pages.flatMap((page) => page.objects).find((item) => item.id === target.objectId) : undefined;
  const current = target.activationId ? episode?.currentObject ?? null : entry?.object && "objectType" in entry.object ? entry.object : null;
  const retained = target.activationId ? !episode?.isCurrentEpisode ? episode?.previousEpisode : null : entry?.matchedEpisode;
  const error = target.activationId ? episodeQuery.error : historyQuery.error;
  const loading = target.activationId ? episodeQuery.isLoading : historyQuery.isLoading;
  const deleted = episode?.deleted ?? entry?.deleted;
  const quarantined = episode?.quarantined ?? entry?.quarantined;
  const oldEpisode = Boolean(target.activationId && episode && !episode.isCurrentEpisode);
  const transitions = target.activationId
    ? episodeQuery.data?.pages.flatMap((page) => page.transitions) ?? []
    : entry?.matchedTransition ? [entry.matchedTransition] : entry?.transitions ?? [];
  const showCurrent = current && !retained && !oldEpisode && !deleted && !quarantined;
  const readOnly = Boolean(error || deleted || quarantined || oldEpisode || (current && !isFocusOpen(current.lifecycle)));
  const title = retained?.title ?? (oldEpisode ? "Earlier Focus episode" : current?.title ?? entry?.title ?? "Focus record");

  return <FocusDialog title={title} description="Exact subject lookup. Opening this link does not acknowledge, resolve, reactivate, or launch anything." pending={false} onClose={onClose}>
    <div className="space-y-3">
      <p className="break-all text-xs text-text-muted">Object: {target.objectId}{target.activationId ? ` · Linked episode: ${target.activationId}` : " · Current record lookup"}</p>
      {loading && <p role="status" className="text-sm text-text-muted">Loading the exact Focus subject...</p>}
      {error && <p role="alert" className="text-sm text-error">Could not retrieve this exact subject: {error.message}
        <button type="button" className={`${UI.button.secondary} ml-2 min-h-11 text-xs`} onClick={() => void (target.activationId ? episodeQuery.refetch() : historyQuery.refetch())}>Retry subject lookup</button>
      </p>}
      {!loading && !error && !episode && !entry && <p className="text-sm text-text-muted">This record was not found in History. No state was changed.</p>}
      {deleted && <p className="text-sm text-text-muted">This record was deleted. Retained evidence is read-only, not a resolved outcome.</p>}
      {quarantined && <p className="text-sm text-warning">This record is quarantined. Its current state cannot be verified; retained history is read-only.</p>}
      {oldEpisode && <div className="space-y-2 rounded-lg border border-border p-3 text-sm text-text-secondary">
        <p>This link refers to a superseded or earlier episode. Today's content is not substituted for it.</p>
        {current && <><p>Current record: {current.title} — {FOCUS_LIFECYCLE_LABELS[current.lifecycle]}.</p>
          <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => onInspectCurrent({ objectId: current.id, activationId: current.activationId })}>Inspect current episode</button>
        </>}
      </div>}
      {showCurrent && !isFocusOpen(current.lifecycle) && <p className="text-sm text-text-secondary">This episode is {FOCUS_LIFECYCLE_LABELS[current.lifecycle].toLowerCase()}. This notification is now read-only; it did not reactivate the concern.</p>}
      {episode?.historyIncomplete && <p className="text-sm text-warning">Historical coverage is incomplete. No full prior snapshot was retained for this old episode; its outcome cannot be inferred.</p>}
      {retained && <FocusEpisodeDetails episode={retained} onSelectTask={props.onSelectTask} onSelectSession={props.onSelectSession} onInspectHistory={props.onInspectHistory} />}
      {showCurrent && <FocusItemCard {...props} object={current} readOnly={readOnly} />}
      {!target.activationId && entry?.object && !("objectType" in entry.object) && <div className="space-y-2 text-sm text-text-secondary">
        <p>{entry.object.text}</p><p>{entry.object.done ? "Action completed" : "Action open"}. Source resolution is independent.</p>
        {entry.object.taskId && <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`}
          onClick={() => props.onSelectTask(entry.object!.taskId!, { checklistItemId: entry.id })}>Open Action task</button>}
      </div>}
      {transitions.length > 0 && <section className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">{target.activationId ? "Linked episode history" : "Retained object history"}</h3>
        <FocusTransitionList transitions={transitions} onSelectTask={props.onSelectTask} onSelectSession={props.onSelectSession} onInspectHistory={props.onInspectHistory} />
      </section>}
      {!target.activationId && entry && props.onInspectHistory && (quarantined || deleted || entry.transitionTotal > transitions.length) && <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`}
        onClick={() => props.onInspectHistory!(target.objectId)}>Inspect complete object History</button>}
      {target.activationId && episodeQuery.hasNextPage && <button type="button" disabled={episodeQuery.isFetchingNextPage} className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => void episodeQuery.fetchNextPage()}>
        {episodeQuery.isFetchingNextPage ? "Loading..." : "Load more episode history"}
      </button>}
    </div>
  </FocusDialog>;
}
