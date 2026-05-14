import { useEffect, useRef, useState } from "react";
import { Inbox, Undo2, X } from "lucide-react";
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

interface StartedFeedAction {
  sessionId: string;
  taskId: string | null;
  prompt: string;
}

interface PendingStatusMutation {
  status: FeedCardStatus;
  previousStatus: FeedCardStatus;
  requestId: number;
}

type FeedFeedback =
  | {
      kind: "status";
      cardId: string;
      message: string;
      currentStatus: FeedCardStatus;
      undoStatus: FeedCardStatus;
      undoing?: boolean;
    }
  | {
      kind: "delete";
      cardId: string;
      message: string;
    }
  | {
      kind: "notice";
      message: string;
    };

const DELETE_UNDO_DELAY_MS = 5_000;

function formatFeedMutationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removeRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
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

function feedStatusFeedbackMessage(status: FeedCardStatus, title: string): string {
  switch (status) {
    case "done":
      return `Marked "${title}" done.`;
    case "dismissed":
      return `Dismissed "${title}".`;
    case "active":
      return `Reactivated "${title}".`;
    default:
      return `Updated "${title}".`;
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
  const [feedFeedback, setFeedFeedback] = useState<FeedFeedback | null>(null);
  const [startedFeedActions, setStartedFeedActions] = useState<Record<string, StartedFeedAction>>({});
  const [pendingStatuses, setPendingStatuses] = useState<Record<string, PendingStatusMutation>>({});
  const [pendingDeletes, setPendingDeletes] = useState<Record<string, FeedCardData>>({});
  const mutationRequestIdRef = useRef(0);
  const deleteTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingDeletesRef = useRef<Record<string, FeedCardData>>({});
  const startedDeleteIdsRef = useRef<Set<string>>(new Set());
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pendingDeletesRef.current = pendingDeletes;
  }, [pendingDeletes]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(deleteTimersRef.current)) {
        clearTimeout(timer);
      }
      deleteTimersRef.current = {};
      for (const card of Object.values(pendingDeletesRef.current)) {
        if (startedDeleteIdsRef.current.has(card.id)) continue;
        startedDeleteIdsRef.current.add(card.id);
        void deleteFeedCard(card.id).catch((error) => {
          console.error(`Failed to flush pending feed delete for ${card.id} during unmount:`, error);
        });
      }
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    if (!feedFeedback || feedFeedback.kind === "delete") return;

    feedbackTimerRef.current = setTimeout(() => {
      setFeedFeedback(null);
    }, feedFeedback.kind === "status" ? 6_000 : 3_000);

    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, [feedFeedback]);

  useEffect(() => {
    const visibleCardIds = new Set(feedCards.map((card) => card.id));
    setPendingDeletes((current) => {
      let changed = false;
      const next = { ...current };
      for (const cardId of Object.keys(next)) {
        if (!visibleCardIds.has(cardId) && !deleteTimersRef.current[cardId]) {
          delete next[cardId];
          pendingDeletesRef.current = removeRecordKey(pendingDeletesRef.current, cardId);
          startedDeleteIdsRef.current.delete(cardId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [feedCards]);

  const displayFeedCards = feedCards
    .filter((card) => !pendingDeletes[card.id])
    .map((card) => {
      const pendingStatus = pendingStatuses[card.id];
      return pendingStatus ? { ...card, status: pendingStatus.status } : card;
    });
  const activeFeedCards = displayFeedCards.filter((card) => card.status === "active");
  const resolvedFeedCards = displayFeedCards.filter((card) => card.status !== "active");
  const showResolvedDivider = activeFeedCards.length > 0 && resolvedFeedCards.length > 0;

  const refetchAfterFeedMutationFailure = async () => {
    try {
      await onRefetchFeed();
      return null;
    } catch (error) {
      return formatFeedMutationError(error);
    }
  };

  const clearMatchingStatusFeedback = (cardId: string, status: FeedCardStatus) => {
    setFeedFeedback((current) => {
      if (current?.kind === "status" && current.cardId === cardId && current.currentStatus === status) {
        return null;
      }
      return current;
    });
  };

  const commitFeedStatusChange = async ({
    cardId,
    title,
    status,
    previousStatus,
    showFeedback = true,
  }: {
    cardId: string;
    title: string;
    status: FeedCardStatus;
    previousStatus: FeedCardStatus;
    showFeedback?: boolean;
  }) => {
    const requestId = mutationRequestIdRef.current + 1;
    mutationRequestIdRef.current = requestId;
    setFeedMutationError(null);
    setPendingStatuses((current) => ({
      ...current,
      [cardId]: {
        status,
        previousStatus,
        requestId,
      },
    }));
    if (showFeedback) {
      setFeedFeedback({
        kind: "status",
        cardId,
        message: feedStatusFeedbackMessage(status, title),
        currentStatus: status,
        undoStatus: previousStatus,
      });
    }

    try {
      await patchFeedCard(cardId, { status });
    } catch (error) {
      const refreshError = await refetchAfterFeedMutationFailure();
      setPendingStatuses((current) => (
        current[cardId]?.requestId === requestId ? removeRecordKey(current, cardId) : current
      ));
      clearMatchingStatusFeedback(cardId, status);
      setFeedMutationError(
        refreshError
          ? `Failed to ${feedStatusActionLabel(status)}: ${formatFeedMutationError(error)} Also failed to refresh feed: ${refreshError}`
          : `Failed to ${feedStatusActionLabel(status)}: ${formatFeedMutationError(error)}`,
      );
      return false;
    }

    try {
      await onRefetchFeed();
    } catch (error) {
      setFeedMutationError(`Feed card updated, but refreshing the feed failed: ${formatFeedMutationError(error)}`);
    }

    setPendingStatuses((current) => (
      current[cardId]?.requestId === requestId ? removeRecordKey(current, cardId) : current
    ));
    return true;
  };

  const performScheduledDelete = async (card: FeedCardData) => {
    const timer = deleteTimersRef.current[card.id];
    if (timer) {
      clearTimeout(timer);
      delete deleteTimersRef.current[card.id];
    }
    setFeedMutationError(null);
    setFeedFeedback((current) => (
      current?.kind === "delete" && current.cardId === card.id
        ? { kind: "notice", message: `Deleted "${card.title}".` }
        : current
    ));
    startedDeleteIdsRef.current.add(card.id);

    try {
      await deleteFeedCard(card.id);
    } catch (error) {
      const refreshError = await refetchAfterFeedMutationFailure();
      startedDeleteIdsRef.current.delete(card.id);
      pendingDeletesRef.current = removeRecordKey(pendingDeletesRef.current, card.id);
      setPendingDeletes((current) => removeRecordKey(current, card.id));
      setFeedFeedback((current) => (
        current?.kind === "notice" && current.message === `Deleted "${card.title}".`
          ? { kind: "notice", message: `Delete failed for "${card.title}".` }
          : current
      ));
      setFeedMutationError(
        refreshError
          ? `Failed to delete feed card: ${formatFeedMutationError(error)} Also failed to refresh feed: ${refreshError}`
          : `Failed to delete feed card: ${formatFeedMutationError(error)}`,
      );
      return;
    }

    try {
      await onRefetchFeed();
      pendingDeletesRef.current = removeRecordKey(pendingDeletesRef.current, card.id);
      setPendingDeletes((current) => removeRecordKey(current, card.id));
      startedDeleteIdsRef.current.delete(card.id);
    } catch (error) {
      setFeedMutationError(`Feed card deleted, but refreshing the feed failed: ${formatFeedMutationError(error)}`);
    }
  };

  const handleFeedStatusChange = async (card: FeedCardData, status: FeedCardStatus) => {
    await commitFeedStatusChange({
      cardId: card.id,
      title: card.title,
      status,
      previousStatus: card.status,
    });
  };

  const handleFeedDelete = (card: FeedCardData) => {
    const existingTimer = deleteTimersRef.current[card.id];
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    startedDeleteIdsRef.current.delete(card.id);
    setFeedMutationError(null);
    pendingDeletesRef.current = { ...pendingDeletesRef.current, [card.id]: card };
    setPendingDeletes((current) => ({ ...current, [card.id]: card }));
    setFeedFeedback({
      kind: "delete",
      cardId: card.id,
      message: `Deleted "${card.title}".`,
    });
    deleteTimersRef.current[card.id] = setTimeout(() => {
      void performScheduledDelete(card);
    }, DELETE_UNDO_DELAY_MS);
  };

  const handleUndoFeedback = async () => {
    if (!feedFeedback) return;

    if (feedFeedback.kind === "delete") {
      const timer = deleteTimersRef.current[feedFeedback.cardId];
      if (timer) {
        clearTimeout(timer);
        delete deleteTimersRef.current[feedFeedback.cardId];
      }
      const deletedCard = pendingDeletes[feedFeedback.cardId];
      pendingDeletesRef.current = removeRecordKey(pendingDeletesRef.current, feedFeedback.cardId);
      setPendingDeletes((current) => removeRecordKey(current, feedFeedback.cardId));
      setFeedFeedback({
        kind: "notice",
        message: deletedCard ? `Restored "${deletedCard.title}".` : "Delete canceled.",
      });
      return;
    }

    if (feedFeedback.kind === "status") {
      const feedback = feedFeedback;
      setFeedFeedback((current) => (
        current?.kind === "status" && current.cardId === feedback.cardId
          ? { ...current, undoing: true }
          : current
      ));
      const success = await commitFeedStatusChange({
        cardId: feedback.cardId,
        title: "feed card",
        status: feedback.undoStatus,
        previousStatus: feedback.currentStatus,
        showFeedback: false,
      });
      if (success) {
        setFeedFeedback({ kind: "notice", message: "Undone." });
      } else {
        setFeedFeedback((current) => (
          current?.kind === "status" && current.cardId === feedback.cardId
            ? { ...current, undoing: false }
            : current
        ));
      }
    }
  };

  const getStartedFeedAction = (card: FeedCardData) => {
    const startedAction = startedFeedActions[card.id];
    if (!startedAction || !card.action) return null;
    const currentActionTaskId = resolveFeedActionTaskId(card);
    return card.action.prompt === startedAction.prompt && currentActionTaskId === startedAction.taskId
      ? startedAction
      : null;
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
    setFeedMutationError(null);
    let sessionId: string;
    try {
      sessionId = await onStartPromptSession(prompt, draft.taskId ?? undefined);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setActionSubmitting(false);
      return;
    }

    setStartedFeedActions((current) => ({
      ...current,
      [draft.card.id]: {
        sessionId,
        taskId: draft.taskId,
        prompt,
      },
    }));
    setActionDraft(null);
    setActionSubmitting(false);
    onSelectSession(sessionId, draft.taskId ?? undefined);

    let patchError: string | null = null;
    try {
      await patchFeedCard(draft.card.id, { status: "done", sessionId });
    } catch (error) {
      patchError = formatFeedMutationError(error);
    }

    let refreshError: string | null = null;
    try {
      await onRefetchFeed();
    } catch (error) {
      refreshError = formatFeedMutationError(error);
    }

    if (patchError) {
      setFeedMutationError(
        refreshError
          ? `Session started, but failed to mark feed card done: ${patchError} Also failed to refresh feed: ${refreshError}`
          : `Session started, but failed to mark feed card done: ${patchError}`,
      );
    } else if (refreshError) {
      setFeedMutationError(`Session started, but refreshing the feed failed: ${refreshError}`);
    }
  };

  const renderFeedCard = (card: FeedCardData) => {
    const startedAction = getStartedFeedAction(card);
    const displayCard = startedAction
      ? {
          ...card,
          action: null,
          taskId: card.taskId ?? startedAction.taskId,
          sessionId: card.sessionId ?? startedAction.sessionId,
        }
      : card;

    return (
      <FeedCard
        key={card.id}
        card={displayCard}
        pending={Boolean(pendingStatuses[card.id])}
        onSelectTask={onSelectTask}
        onSelectSession={onSelectSession}
        onAction={openFeedAction}
        onStatusChange={handleFeedStatusChange}
        onDelete={handleFeedDelete}
      />
    );
  };

  const canUndoFeedback = feedFeedback?.kind === "status" || feedFeedback?.kind === "delete";
  const undoingFeedback = feedFeedback?.kind === "status" && feedFeedback.undoing;

  return (
    <>
      {active && (
      <section className={`space-y-2 ${feedFeedback ? "pb-24 sm:pb-0" : ""}`}>
        <div className="flex items-center justify-between">
          <h2 className={UI.text.sectionTitle}>
            <Inbox size={14} />
            Feed
            {displayFeedCards.length > 0 && (
              <span className="text-text-faint font-normal">({displayFeedCards.length})</span>
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

        {feedLoading && displayFeedCards.length === 0 ? (
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
        ) : displayFeedCards.length > 0 ? (
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
            sub="Agents can publish durable cards here for curated alerts, follow-ups, decisions, and artifacts."
          />
        )}
      </section>
      )}
      {feedFeedback && (
        <div className="fixed inset-x-3 bottom-20 z-50 mx-auto max-w-lg sm:bottom-4">
          <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-bg-surface px-3 py-2 shadow-lg">
            <p className="min-w-0 flex-1 text-sm text-text-primary" role="status" aria-live="polite">
              {feedFeedback.message}
            </p>
            {canUndoFeedback && (
              <button
                type="button"
                onClick={() => { void handleUndoFeedback(); }}
                disabled={undoingFeedback}
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-accent-surface px-3 text-sm font-medium text-accent transition-colors hover:bg-accent-border/30 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Undo2 size={14} />
                {undoingFeedback ? "Undoing…" : "Undo"}
              </button>
            )}
            <button
              type="button"
              onClick={() => setFeedFeedback(null)}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              aria-label="Dismiss feed feedback"
            >
              <X size={16} />
            </button>
          </div>
        </div>
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
