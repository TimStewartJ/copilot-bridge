import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, VolumeX } from "lucide-react";
import type { FocusDigest } from "../api";
import { useDashboardDigestPagesQuery } from "../hooks/queries/useDashboard";
import { useMarkFocusDigestViewedMutation } from "../hooks/queries/useFocus";
import { focusTime } from "../focus-view-model";
import { timeAgo } from "../time";
import FocusItemCard from "./FocusItemCard";
import type { FocusInteractionProps } from "./FocusInteractions";
import { DS, cx } from "../design/tokens";
import { Badge } from "../design/primitives";

interface FocusDigestSectionProps extends FocusInteractionProps {
  digest: FocusDigest;
}

function formatFamily(family: string): string {
  return family
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export default function FocusDigestSection({
  digest,
  tasks,
  taskGroups,
  onSelectTask,
  onSelectSession,
  onStartPromptSession,
  onChanged,
  onInspectHistory,
  onInspectHistoryFilter,
}: FocusDigestSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const receipt = useRef<{ watermark: string; sent: boolean; viewedAt?: string } | null>(null);
  const markViewed = useMarkFocusDigestViewedMutation();
  const query = useDashboardDigestPagesQuery(digest, expanded);
  const cards = useMemo(
    () => query.data?.pages.flatMap((page) => page.objects) ?? [],
    [query.data],
  );
  useEffect(() => {
    const viewing = receipt.current;
    if (!expanded || !viewing || viewing.sent || !query.data || query.error || query.isLoading || cards.length === 0) return;
    // Freeze the server watermark at opening; refetches must not mark new
    // observations as consumed, and browser clock skew must not advance it.
    const latestRendered = cards.reduce((latest, card) => card.details.lastMeaningfulChangeAt > latest ? card.details.lastMeaningfulChangeAt : latest, cards[0].details.lastMeaningfulChangeAt);
    viewing.viewedAt = viewing.watermark < latestRendered ? viewing.watermark : latestRendered;
    viewing.sent = true;
    markViewed.mutate({ digestId: digest.id, viewedAt: viewing.viewedAt });
  }, [expanded, query.data, query.error, query.isLoading, cards, digest.id, markViewed.mutate]);

  const refresh = async () => {
    await Promise.all([query.refetch(), onChanged()]);
  };

  return (
    <article
      data-expanded={expanded}
      className={cx(DS.layout.objectRow, "overflow-hidden", expanded && "md:col-span-2 xl:col-span-3")}
    >
      <button
        type="button"
        onClick={() => {
          if (!expanded) receipt.current = { watermark: digest.latestUpdatedAt, sent: false };
          setExpanded((value) => !value);
        }}
        aria-expanded={expanded}
        aria-controls={contentId}
        className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "group items-start gap-3 py-2", expanded && DS.row.selected)}
      >
        <span className={"mt-0.5 inline-flex shrink-0 rounded-lg border border-border/70 bg-bg-secondary p-1.5 text-text-faint transition-colors group-hover:text-accent"}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-faint">
            <span>{digest.taskTitle ?? (digest.orphaned ? "Removed task" : "Global Focus")}</span>
            <span aria-hidden="true">·</span>
            <span>{timeAgo(digest.latestUpdatedAt)}</span>
          </span>
          <span className="mt-1 block text-sm font-semibold tracking-tight text-text-primary">
            {formatFamily(digest.family)}
          </span>
          <span className="mt-1 block text-xs text-text-muted">{digest.newCount} new since {digest.lastViewedAt ? focusTime(digest.lastViewedAt) : "last view (not yet viewed)"}</span>
          <span className="mt-1 block text-[11px] text-text-faint">Last meaningful change: {focusTime(digest.latestUpdatedAt)}</span>
          {!expanded && (
            <span className="mt-2 block space-y-1">
              {digest.samples.map((sample) => (
                <span key={sample.id} className="block truncate text-xs text-text-muted">
                  {sample.title}
                </span>
              ))}
              {digest.count > digest.samples.length && (
                <span className="block text-[11px] text-text-faint">
                  +{digest.count - digest.samples.length} more
                </span>
              )}
            </span>
          )}
        </span>
        <Badge tone="neutral">
          {digest.quiet && <VolumeX size={10} />}
          {digest.quiet ? `Quiet · ${digest.count}` : `${digest.count} items`}
        </Badge>
      </button>

      {expanded && (
        <div id={contentId} className={cx(DS.rail, "mt-3 space-y-3 pb-1")}>
          <p className="text-xs text-text-muted">Digest horizon: meaningful changes in the last 7 days, plus pinned Events. Older active Events remain in History. These observations are not a coverage assurance; omissions and failed sources may be unknown.</p>
          {digest.quiet && <p className="text-xs text-text-muted">Quiet source: muted, archived, or removed task context. Quiet does not mean resolved or healthy.</p>}
          {onInspectHistoryFilter && <button type="button" className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "text-accent underline")} onClick={() => onInspectHistoryFilter({
            ...(digest.sourceFamily ? { sourceFamily: digest.sourceFamily } : {}),
            ...(digest.orphaned && digest.originalTaskId ? { originalTaskId: digest.originalTaskId } : digest.taskId ? { taskId: digest.taskId } : {}),
          })}>{digest.sourceFamily ? "Inspect source History" : "Inspect task History (source family not recorded)"}</button>}
          {markViewed.error && <p role="alert" className="text-xs text-error">
            Could not record this view: {markViewed.error.message}
            <button type="button" disabled={markViewed.isPending} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "ml-2 underline")} onClick={() => {
              if (receipt.current?.viewedAt) markViewed.mutate({ digestId: digest.id, viewedAt: receipt.current.viewedAt });
            }}>Retry view receipt</button>
          </p>}
          {query.error && <div role="alert" className={cx(DS.notice.surface, "px-3 py-2 text-sm text-error")}>
            Source items unavailable or incomplete: {query.error.message}
            <button type="button" className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "ml-2 underline")} onClick={() => void query.refetch()}>Retry source items</button>
          </div>}
          {query.isLoading && cards.length === 0 ? (
            <div className="px-2 py-4 text-sm text-text-muted">Loading source items…</div>
          ) : !query.error && cards.length === 0 ? (
            <p className="text-sm text-text-muted">No current items in this digest. Its summary may have changed; refresh Focus.</p>
          ) : (
            cards.map((card) => (
              <FocusItemCard
                key={card.id}
                object={card}
                tasks={tasks}
                taskGroups={taskGroups}
                onSelectTask={onSelectTask}
                onSelectSession={onSelectSession}
                onStartPromptSession={onStartPromptSession}
                onChanged={refresh}
                onInspectHistory={onInspectHistory}
              />
            ))
          )}
          {query.hasNextPage && (
            <button
              type="button"
              onClick={() => { void query.fetchNextPage(); }}
              disabled={query.isFetchingNextPage}
              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary, "w-full border border-border disabled:opacity-60")}
            >
              {query.isFetchingNextPage ? "Loading more…" : "Load more items"}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
