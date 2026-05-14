import { useState } from "react";
import { Inbox } from "lucide-react";
import {
  deleteFeedCard,
  patchFeedCard,
  type FeedCard as FeedCardData,
  type FeedCardStatus,
} from "../api";
import { resolveFeedActionTaskId } from "../feed-action-helpers";
import EmptyState from "./shared/EmptyState";
import FeedActionDialog from "./FeedActionDialog";
import FeedCard from "./FeedCard";
import { Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { UI } from "./shared/design-system";

interface FeedActionDraft {
  card: FeedCardData;
  prompt: string;
  taskId: string | null;
}

function formatFeedMutationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function feedStatusActionLabel(status: FeedCardStatus): string {
  switch (status) {
    case "done":
      return "mark feed card done";
    case "dismissed":
      return "dismiss feed card";
    case "active":
      return "reactivate feed card";
    default:
      return "update feed card";
  }
}

interface DashboardFeedProps {
  active: boolean;
  feedCards: FeedCardData[];
  feedLoading: boolean;
  showResolvedFeed: boolean;
  onToggleResolvedFeed: () => void;
  onSelectTask: (id: string) => void;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  onStartPromptSession: (prompt: string, taskId?: string) => Promise<string>;
  onRefetchFeed: () => Promise<unknown>;
}

export default function DashboardFeed({
  active,
  feedCards,
  feedLoading,
  showResolvedFeed,
  onToggleResolvedFeed,
  onSelectTask,
  onSelectSession,
  onStartPromptSession,
  onRefetchFeed,
}: DashboardFeedProps) {
  const [actionDraft, setActionDraft] = useState<FeedActionDraft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [feedMutationError, setFeedMutationError] = useState<string | null>(null);
  const activeFeedCards = feedCards.filter((card) => card.status === "active");
  const resolvedFeedCards = feedCards.filter((card) => card.status !== "active");
  const showResolvedDivider = activeFeedCards.length > 0 && resolvedFeedCards.length > 0;

  const refetchAfterFeedMutationFailure = async () => {
    try {
      await onRefetchFeed();
      return null;
    } catch (error) {
      return formatFeedMutationError(error);
    }
  };

  const runFeedMutation = async (actionLabel: string, mutate: () => Promise<unknown>) => {
    setFeedMutationError(null);
    try {
      await mutate();
    } catch (error) {
      const refreshError = await refetchAfterFeedMutationFailure();
      setFeedMutationError(
        refreshError
          ? `Failed to ${actionLabel}: ${formatFeedMutationError(error)} Also failed to refresh feed: ${refreshError}`
          : `Failed to ${actionLabel}: ${formatFeedMutationError(error)}`,
      );
      return;
    }

    try {
      await onRefetchFeed();
    } catch (error) {
      setFeedMutationError(`Feed card updated, but refreshing the feed failed: ${formatFeedMutationError(error)}`);
    }
  };

  const handleFeedStatusChange = async (cardId: string, status: FeedCardStatus) => {
    await runFeedMutation(feedStatusActionLabel(status), () => patchFeedCard(cardId, { status }));
  };

  const handleFeedDelete = async (cardId: string) => {
    await runFeedMutation("delete feed card", () => deleteFeedCard(cardId));
  };

  const openFeedAction = (card: FeedCardData) => {
    if (!card.action) return;
    setActionDraft({
      card,
      prompt: card.action.prompt,
      taskId: resolveFeedActionTaskId(card),
    });
    setActionError(null);
  };

  const closeFeedAction = () => {
    if (actionSubmitting) return;
    setActionDraft(null);
    setActionError(null);
  };

  const handleStartFeedAction = async () => {
    if (!actionDraft) return;
    const draft = actionDraft;
    const prompt = actionDraft.prompt.trim();
    if (!prompt) {
      setActionError("Prompt is required.");
      return;
    }
    const latestCard = feedCards.find((card) => card.id === actionDraft.card.id);
    const latestActionTaskId = latestCard ? resolveFeedActionTaskId(latestCard) : null;
    if (
      !latestCard
      || latestCard.status !== "active"
      || !latestCard.action
      || latestCard.action.prompt !== actionDraft.card.action?.prompt
      || latestActionTaskId !== actionDraft.taskId
    ) {
      if (!latestCard || latestCard.status !== "active" || !latestCard.action) {
        setActionError("This action is no longer available. Close the preview and reopen the card if needed.");
        return;
      }
      setActionDraft({
        card: latestCard,
        prompt: latestCard.action.prompt,
        taskId: latestActionTaskId,
      });
      setActionError("This card changed while the preview was open. Review the latest prompt before starting.");
      return;
    }
    setActionSubmitting(true);
    setActionError(null);
    try {
      const sessionId = await onStartPromptSession(prompt, draft.taskId ?? undefined);
      await patchFeedCard(draft.card.id, { status: "done", sessionId });
      await onRefetchFeed();
      setActionDraft(null);
      setActionSubmitting(false);
      onSelectSession(sessionId, draft.taskId ?? undefined);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setActionSubmitting(false);
    }
  };
  const renderFeedCard = (card: FeedCardData) => (
    <FeedCard
      key={card.id}
      card={card}
      onSelectTask={onSelectTask}
      onSelectSession={onSelectSession}
      onAction={openFeedAction}
      onStatusChange={(feedCard, status) => handleFeedStatusChange(feedCard.id, status)}
      onDelete={(feedCard) => handleFeedDelete(feedCard.id)}
    />
  );

  return (
    <>
      {active && (
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className={UI.text.sectionTitle}>
            <Inbox size={14} />
            Feed
            {feedCards.length > 0 && (
              <span className="text-text-faint font-normal">({feedCards.length})</span>
            )}
          </h2>
          <button
            type="button"
            onClick={onToggleResolvedFeed}
            className="text-[11px] px-1.5 py-0.5 rounded text-text-faint hover:text-text-secondary transition-colors"
          >
            {showResolvedFeed ? "Hide resolved" : "Show resolved"}
          </button>
        </div>

        {feedMutationError && (
          <div
            className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-sm text-error"
            role="alert"
          >
            {feedMutationError}
          </div>
        )}

        {feedLoading && feedCards.length === 0 ? (
          <div className="space-y-2">
            <SkeletonCard className="space-y-3">
              <div className="flex gap-2">
                <Skeleton width={52} height={18} shape="pill" />
                <Skeleton width={44} height={18} shape="pill" />
              </div>
              <SkeletonText lines={3} widths={["72%", "100%", "58%"]} />
            </SkeletonCard>
            <SkeletonCard className="space-y-3">
              <div className="flex gap-2">
                <Skeleton width={60} height={18} shape="pill" />
                <Skeleton width={52} height={18} shape="pill" />
              </div>
              <SkeletonText lines={2} widths={["64%", "82%"]} />
            </SkeletonCard>
          </div>
        ) : feedCards.length > 0 ? (
          <div className="space-y-2">
            {activeFeedCards.map(renderFeedCard)}
            {showResolvedDivider && (
              <div className="flex items-center gap-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                <span className="h-px flex-1 bg-border/60" />
                Resolved
                <span className="h-px flex-1 bg-border/60" />
              </div>
            )}
            {resolvedFeedCards.map(renderFeedCard)}
          </div>
        ) : (
          <EmptyState
            message="No feed cards"
            sub="Agents can publish durable cards here for decisions, previews, artifacts, and summaries."
          />
        )}
      </section>
      )}
      {actionDraft && (
        <FeedActionDialog
          cardTitle={actionDraft.card.title}
          actionLabel={actionDraft.card.action?.label}
          taskId={actionDraft.taskId}
          prompt={actionDraft.prompt}
          error={actionError}
          submitting={actionSubmitting}
          onPromptChange={(prompt) => {
            setActionDraft((current) => current ? { ...current, prompt } : current);
            setActionError(null);
          }}
          onClose={closeFeedAction}
          onStart={handleStartFeedAction}
        />
      )}
    </>
  );
}
