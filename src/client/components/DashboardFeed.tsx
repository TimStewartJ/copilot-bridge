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

  const handleFeedStatusChange = async (cardId: string, status: FeedCardStatus) => {
    await patchFeedCard(cardId, { status });
    await onRefetchFeed();
  };

  const handleFeedDelete = async (cardId: string) => {
    await deleteFeedCard(cardId);
    await onRefetchFeed();
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
            {feedCards.map((card) => (
              <FeedCard
                key={card.id}
                card={card}
                onSelectTask={onSelectTask}
                onSelectSession={onSelectSession}
                onAction={openFeedAction}
                onStatusChange={(feedCard, status) => handleFeedStatusChange(feedCard.id, status)}
                onDelete={(feedCard) => handleFeedDelete(feedCard.id)}
              />
            ))}
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
