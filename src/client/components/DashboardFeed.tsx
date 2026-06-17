import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Filter, Inbox, Undo2, X } from "lucide-react";
import {
  deleteFeedCard,
  patchFeedCard,
  type FeedCard as FeedCardData,
  type FeedCardStatus,
  type Task,
  type TaskGroup,
} from "../api";
import {
  buildFeedCardChatContext,
  buildFeedCardChatPrompt,
  DEFAULT_FEED_CHAT_LABEL,
  resolveFeedActionTaskId,
} from "../feed-action-helpers";
import EmptyState from "./shared/EmptyState";
import FeedActionDialog, { type FeedActionSubmitMode, type FeedActionTaskPreview } from "./FeedActionDialog";
import FeedCard from "./FeedCard";
import { Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { UI } from "./shared/design-system";

interface FeedActionDraft {
  source: "action" | "chat";
  card: FeedCardData;
  prompt: string;
  context?: string;
  taskId: string | null;
  label?: string;
  eyebrow: string;
  description: string;
  promptLabel?: string;
  promptPlaceholder?: string;
  allowEmptyPrompt?: boolean;
}

interface StartedFeedAction {
  sessionId: string;
  taskId: string | null;
  prompt: string;
}

interface StartedFeedChat {
  sessionId: string;
  taskId: string | null;
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
const SCROLL_TOP_EPSILON = 1;
const KEY_PREFIX_COMMIT_DELAY_MS = 250;
const KEY_PREFIX_MAX_LENGTH = 200;
const KEY_PREFIX_SUGGESTION_LIMIT = 50;

export interface FeedFilterState {
  kind: string;
  keyPrefix: string;
}

const feedFilterControlInputClass = "min-h-9 rounded-md border border-border bg-bg-surface px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent";

function deriveKeyFamilyPrefixes(key: string | null): string[] {
  if (!key) return [];
  const prefixes: string[] = [];
  for (let index = 0; index < key.length; index += 1) {
    if (key[index] === ":") prefixes.push(key.slice(0, index + 1));
  }
  return prefixes;
}

function formatFeedMutationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removeRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function getParentElement(element: HTMLElement): HTMLElement | null {
  const parent = element.parentElement ?? element.parentNode;
  return parent?.nodeType === 1 ? parent as HTMLElement : null;
}

function getComputedOverflowY(element: HTMLElement): string | null {
  try {
    const view = element.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
    if (!view || typeof view.getComputedStyle !== "function") return null;
    return view.getComputedStyle(element)?.overflowY ?? null;
  } catch {
    return null;
  }
}

function isScrollableElement(element: HTMLElement): boolean {
  if ((element.scrollTop ?? 0) > 0) return true;
  const scrollHeight = element.scrollHeight ?? 0;
  const clientHeight = element.clientHeight ?? 0;
  if (scrollHeight <= clientHeight) return false;
  const overflowY = getComputedOverflowY(element);
  // When the computed style is unavailable (e.g. test environments) fall back to
  // the size heuristic; otherwise only treat genuinely scrollable overflow as a container.
  if (overflowY === null) return true;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = getParentElement(element);
  while (current) {
    if (isScrollableElement(current)) return current;
    current = getParentElement(current);
  }
  return null;
}

// Adjusts the scroll container so an anchor element stays visually fixed after a
// re-render shifts the list. Instant (no smooth animation) so it never races
// mobile touch momentum.
function compensateScrollForAnchor(anchorElement: HTMLElement, previousTop: number) {
  const scrollContainer = findScrollableAncestor(anchorElement);
  if (!scrollContainer) return;

  const delta = anchorElement.getBoundingClientRect().top - previousTop;
  if (Math.abs(delta) < SCROLL_TOP_EPSILON) return;

  const top = Math.max(0, scrollContainer.scrollTop + delta);
  if (typeof scrollContainer.scrollTo === "function") {
    scrollContainer.scrollTo({ top, behavior: "auto" });
  } else {
    scrollContainer.scrollTop = top;
  }
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
  tasks?: Task[];
  taskGroups?: TaskGroup[];
  feedLoading: boolean;
  showResolvedFeed: boolean;
  feedFilter?: FeedFilterState;
  onFeedFilterChange?: (patch: Partial<FeedFilterState>) => void;
  activeHasMore?: boolean;
  resolvedHasMore?: boolean;
  activeLoadingMore?: boolean;
  resolvedLoadingMore?: boolean;
  onToggleResolvedFeed: () => void;
  onSelectTask: (id: string) => void;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  onStartPromptSession: (
    prompt: string,
    taskId?: string,
    options?: { navigateOnError?: boolean },
  ) => Promise<string>;
  onRefetchFeed: () => Promise<unknown>;
  onLoadMoreActive?: () => void | Promise<unknown>;
  onLoadMoreResolved?: () => void | Promise<unknown>;
}

export default function DashboardFeed({
  active,
  feedCards,
  tasks = [],
  taskGroups = [],
  feedLoading,
  showResolvedFeed,
  feedFilter = { kind: "", keyPrefix: "" },
  onFeedFilterChange,
  activeHasMore = false,
  resolvedHasMore = false,
  activeLoadingMore = false,
  resolvedLoadingMore = false,
  onToggleResolvedFeed,
  onSelectTask,
  onSelectSession,
  onStartPromptSession,
  onRefetchFeed,
  onLoadMoreActive,
  onLoadMoreResolved,
}: DashboardFeedProps) {
  const [actionDraft, setActionDraft] = useState<FeedActionDraft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSubmitMode, setActionSubmitMode] = useState<FeedActionSubmitMode | null>(null);
  const [feedMutationError, setFeedMutationError] = useState<string | null>(null);
  const [feedFeedback, setFeedFeedback] = useState<FeedFeedback | null>(null);
  const [startedFeedActions, setStartedFeedActions] = useState<Record<string, StartedFeedAction>>({});
  const [startedFeedChats, setStartedFeedChats] = useState<Record<string, StartedFeedChat>>({});
  const [pendingStatuses, setPendingStatuses] = useState<Record<string, PendingStatusMutation>>({});
  const [pendingDeletes, setPendingDeletes] = useState<Record<string, FeedCardData>>({});
  const [knownKinds, setKnownKinds] = useState<string[]>([]);
  const [knownKeyPrefixes, setKnownKeyPrefixes] = useState<string[]>([]);
  const [keyPrefixDraft, setKeyPrefixDraft] = useState(feedFilter.keyPrefix);
  const mutationRequestIdRef = useRef(0);
  const deleteTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingDeletesRef = useRef<Record<string, FeedCardData>>({});
  const startedDeleteIdsRef = useRef<Set<string>>(new Set());
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedCardElementsRef = useRef<Record<string, HTMLDivElement>>({});
  const pendingScrollAnchorRef = useRef<{ anchorCardId: string; previousTop: number } | null>(null);
  const statusMutationInFlightRef = useRef<Set<string>>(new Set());
  const keyPrefixCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedKeyPrefixRef = useRef(feedFilter.keyPrefix);
  const actionSubmitting = actionSubmitMode !== null;

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const taskGroupById = useMemo(() => new Map(taskGroups.map((group) => [group.id, group])), [taskGroups]);
  const actionTaskPreview = useMemo<FeedActionTaskPreview | null>(() => {
    if (!actionDraft?.taskId) return null;
    const task = taskById.get(actionDraft.taskId);
    if (!task) return null;
    const group = task.groupId ? taskGroupById.get(task.groupId) ?? null : null;
    return {
      id: task.id,
      title: task.title,
      group: group ? { name: group.name, color: group.color } : null,
    };
  }, [actionDraft?.taskId, taskById, taskGroupById]);

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
  // When the resolved section is hidden, optimistically-resolved cards are dropped
  // from view entirely (like a pending delete) instead of flashing in a transient
  // "Resolved" section that then vanishes on refetch.
  const resolvedFeedCards = showResolvedFeed
    ? displayFeedCards.filter((card) => card.status !== "active")
    : [];
  const showResolvedDivider = activeFeedCards.length > 0 && resolvedFeedCards.length > 0;
  const renderedFeedCards = [...activeFeedCards, ...resolvedFeedCards];
  const visibleFeedCardCount = renderedFeedCards.length;

  useEffect(() => {
    setKnownKinds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const card of feedCards) {
        if (card.kind && !next.has(card.kind)) {
          next.add(card.kind);
          changed = true;
        }
      }
      return changed ? Array.from(next) : current;
    });
    setKnownKeyPrefixes((current) => {
      const next = new Set(current);
      let changed = false;
      for (const card of feedCards) {
        for (const prefix of deriveKeyFamilyPrefixes(card.dedupeKey)) {
          if (!next.has(prefix)) {
            next.add(prefix);
            changed = true;
          }
        }
      }
      return changed ? Array.from(next) : current;
    });
  }, [feedCards]);

  useEffect(() => {
    if (feedFilter.keyPrefix !== lastCommittedKeyPrefixRef.current) {
      lastCommittedKeyPrefixRef.current = feedFilter.keyPrefix;
      setKeyPrefixDraft(feedFilter.keyPrefix);
    }
  }, [feedFilter.keyPrefix]);

  useEffect(() => () => {
    if (keyPrefixCommitTimerRef.current) {
      clearTimeout(keyPrefixCommitTimerRef.current);
      keyPrefixCommitTimerRef.current = null;
    }
  }, []);

  const kindFilterOptions = useMemo(() => {
    const options = new Set(knownKinds);
    if (feedFilter.kind) options.add(feedFilter.kind);
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [knownKinds, feedFilter.kind]);

  const keyPrefixSuggestions = useMemo(
    () => [...knownKeyPrefixes].sort((a, b) => a.localeCompare(b)).slice(0, KEY_PREFIX_SUGGESTION_LIMIT),
    [knownKeyPrefixes],
  );

  const hasActiveFeedFilter = Boolean(feedFilter.kind || feedFilter.keyPrefix);
  const showFeedFilterControl = visibleFeedCardCount > 0 || hasActiveFeedFilter;

  const commitKeyPrefix = (value: string) => {
    if (keyPrefixCommitTimerRef.current) {
      clearTimeout(keyPrefixCommitTimerRef.current);
      keyPrefixCommitTimerRef.current = null;
    }
    const trimmed = value.trim();
    if (trimmed === lastCommittedKeyPrefixRef.current) return;
    lastCommittedKeyPrefixRef.current = trimmed;
    onFeedFilterChange?.({ keyPrefix: trimmed });
  };

  const handleKeyPrefixInputChange = (value: string) => {
    setKeyPrefixDraft(value);
    if (keyPrefixCommitTimerRef.current) {
      clearTimeout(keyPrefixCommitTimerRef.current);
    }
    keyPrefixCommitTimerRef.current = setTimeout(() => {
      keyPrefixCommitTimerRef.current = null;
      commitKeyPrefix(value);
    }, KEY_PREFIX_COMMIT_DELAY_MS);
  };

  const handleKindFilterChange = (value: string) => {
    onFeedFilterChange?.({ kind: value });
  };

  const clearFeedFilter = () => {
    if (keyPrefixCommitTimerRef.current) {
      clearTimeout(keyPrefixCommitTimerRef.current);
      keyPrefixCommitTimerRef.current = null;
    }
    lastCommittedKeyPrefixRef.current = "";
    setKeyPrefixDraft("");
    onFeedFilterChange?.({ kind: "", keyPrefix: "" });
  };

  useLayoutEffect(() => {
    const pendingScrollAnchor = pendingScrollAnchorRef.current;
    if (!pendingScrollAnchor) return;
    pendingScrollAnchorRef.current = null;

    const anchorElement = feedCardElementsRef.current[pendingScrollAnchor.anchorCardId];
    if (anchorElement) compensateScrollForAnchor(anchorElement, pendingScrollAnchor.previousTop);
  });

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

  const captureScrollAnchor = (cardId: string): { anchorCardId: string; previousTop: number } | null => {
    const cardIndex = renderedFeedCards.findIndex((candidate) => candidate.id === cardId);
    if (cardIndex < 0) return null;
    const anchorCard = renderedFeedCards[cardIndex + 1] ?? renderedFeedCards[cardIndex - 1] ?? null;
    if (!anchorCard) return null;
    const anchorElement = feedCardElementsRef.current[anchorCard.id];
    if (!anchorElement) return null;
    return { anchorCardId: anchorCard.id, previousTop: anchorElement.getBoundingClientRect().top };
  };

  const handleFeedStatusChange = async (card: FeedCardData, status: FeedCardStatus) => {
    if (statusMutationInFlightRef.current.has(card.id)) return;
    if ((status === "done" || status === "dismissed") && card.status === "active") {
      pendingScrollAnchorRef.current = captureScrollAnchor(card.id);
    }
    statusMutationInFlightRef.current.add(card.id);
    try {
      await commitFeedStatusChange({
        cardId: card.id,
        title: card.title,
        status,
        previousStatus: card.status,
      });
    } finally {
      statusMutationInFlightRef.current.delete(card.id);
    }
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
      source: "action",
      card,
      prompt: card.action.prompt,
      taskId: resolveFeedActionTaskId(card),
      label: card.action.label,
      eyebrow: "Feed action preview",
      description: "Review or edit the prompt before starting a new session.",
    });
    setActionError(null);
  };

  const openFeedChat = (card: FeedCardData) => {
    setActionDraft({
      source: "chat",
      card,
      prompt: "",
      context: buildFeedCardChatContext(card),
      taskId: card.taskId,
      label: DEFAULT_FEED_CHAT_LABEL,
      eyebrow: "Feed card chat",
      description: "The card context is included. Add what you want to ask or leave it blank to start from the card.",
      promptLabel: "Message to send",
      promptPlaceholder: "What do you want to ask or do with this card?",
      allowEmptyPrompt: true,
    });
    setActionError(null);
  };

  const closeFeedAction = () => {
    if (actionSubmitting) return;
    setActionDraft(null);
    setActionError(null);
  };

  const handleStartFeedAction = async (mode: FeedActionSubmitMode) => {
    if (!actionDraft || actionSubmitting) return;
    const draft = actionDraft;
    const prompt = actionDraft.prompt.trim();
    if (draft.source === "action" && !prompt) {
      setActionError("Prompt is required.");
      return;
    }
    const latestCard = feedCards.find((card) => card.id === actionDraft.card.id);
    if (!latestCard) {
      setActionError("This card is no longer available. Close the preview and reopen the feed if needed.");
      return;
    }
    if (actionDraft.source === "action") {
      const latestActionTaskId = resolveFeedActionTaskId(latestCard);
      if (
        latestCard.status !== "active"
        || !latestCard.action
        || latestCard.action.prompt !== actionDraft.card.action?.prompt
        || latestActionTaskId !== actionDraft.taskId
      ) {
        if (latestCard.status !== "active" || !latestCard.action) {
          setActionError("This action is no longer available. Close the preview and reopen the card if needed.");
          return;
        }
        setActionDraft({
          source: "action",
          card: latestCard,
          prompt: latestCard.action.prompt,
          taskId: latestActionTaskId,
          label: latestCard.action.label,
          eyebrow: "Feed action preview",
          description: "Review or edit the prompt before starting a new session.",
        });
        setActionError("This card changed while the preview was open. Review the latest prompt before starting.");
        return;
      }
    }
    if (
      draft.source === "chat"
      && (
        latestCard.status !== draft.card.status
        || latestCard.taskId !== draft.taskId
        || latestCard.sessionId !== draft.card.sessionId
        || latestCard.updatedAt !== draft.card.updatedAt
      )
    ) {
      setActionDraft({
        source: "chat",
        card: latestCard,
        prompt: draft.prompt,
        context: buildFeedCardChatContext(latestCard),
        taskId: latestCard.taskId,
        label: DEFAULT_FEED_CHAT_LABEL,
        eyebrow: "Feed card chat",
        description: "The card context is included. Add what you want to ask or leave it blank to start from the card.",
        promptLabel: "Message to send",
        promptPlaceholder: "What do you want to ask or do with this card?",
        allowEmptyPrompt: true,
      });
      setActionError("This card changed while the preview was open. Review the latest card context before starting.");
      return;
    }
    const shouldLinkChatToCard = draft.source === "chat" && !latestCard.sessionId;
    const promptToSend = draft.source === "chat"
      ? buildFeedCardChatPrompt(draft.context ?? buildFeedCardChatContext(draft.card), prompt)
      : prompt;
    setActionSubmitMode(mode);
    setActionError(null);
    setFeedMutationError(null);
    let sessionId: string;
    try {
      sessionId = mode === "background"
        ? await onStartPromptSession(promptToSend, draft.taskId ?? undefined, { navigateOnError: false })
        : await onStartPromptSession(promptToSend, draft.taskId ?? undefined);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setActionSubmitMode(null);
      return;
    }

    if (draft.source === "action") {
      setStartedFeedActions((current) => ({
        ...current,
        [draft.card.id]: {
          sessionId,
          taskId: draft.taskId,
          prompt: promptToSend,
        },
      }));
    }
    setActionDraft(null);
    setActionSubmitMode(null);
    if (mode === "foreground") {
      onSelectSession(sessionId, draft.taskId ?? undefined);
    } else {
      setFeedFeedback((current) => (
        current?.kind === "delete"
          ? current
          : {
              kind: "notice",
              message: draft.source === "action"
                ? `Started "${draft.card.title}" in background.`
                : `Started chat for "${draft.card.title}" in background.`,
            }
      ));
    }

    let patchError: string | null = null;
    if (draft.source === "action") {
      try {
        await patchFeedCard(draft.card.id, { status: "done", sessionId });
      } catch (error) {
        patchError = formatFeedMutationError(error);
      }
    } else if (shouldLinkChatToCard) {
      try {
        await patchFeedCard(draft.card.id, { sessionId });
        setStartedFeedChats((current) => ({
          ...current,
          [draft.card.id]: {
            sessionId,
            taskId: draft.taskId,
          },
        }));
      } catch (error) {
        patchError = formatFeedMutationError(error);
      }
    }

    let refreshError: string | null = null;
    if (draft.source === "action" || shouldLinkChatToCard) {
      try {
        await onRefetchFeed();
      } catch (error) {
        refreshError = formatFeedMutationError(error);
      }
    }

    if (patchError) {
      const actionMessage = draft.source === "action"
        ? "failed to mark feed card done"
        : "failed to link feed card to the session";
      setFeedMutationError(
        refreshError
          ? `Session started, but ${actionMessage}: ${patchError} Also failed to refresh feed: ${refreshError}`
          : `Session started, but ${actionMessage}: ${patchError}`,
      );
    } else if (refreshError) {
      setFeedMutationError(`Session started, but refreshing the feed failed: ${refreshError}`);
    }
  };

  const renderFeedCard = (card: FeedCardData) => {
    const startedAction = getStartedFeedAction(card);
    const startedChat = startedFeedChats[card.id];
    const displayCard = {
      ...card,
      action: startedAction ? null : card.action,
      taskId: card.taskId ?? startedAction?.taskId ?? startedChat?.taskId ?? null,
      sessionId: startedAction?.sessionId ?? card.sessionId ?? startedChat?.sessionId ?? null,
    };

    return (
      <div
        key={card.id}
        ref={(element) => {
          if (element) {
            feedCardElementsRef.current[card.id] = element;
          } else {
            delete feedCardElementsRef.current[card.id];
          }
        }}
        data-feed-card-id={card.id}
      >
        <FeedCard
          card={displayCard}
          pending={Boolean(pendingStatuses[card.id])}
          onSelectTask={onSelectTask}
          onSelectSession={onSelectSession}
          onAction={openFeedAction}
          onChat={openFeedChat}
          onStatusChange={handleFeedStatusChange}
          onDelete={handleFeedDelete}
        />
      </div>
    );
  };

  const canUndoFeedback = feedFeedback?.kind === "status" || feedFeedback?.kind === "delete";
  const undoingFeedback = feedFeedback?.kind === "status" && feedFeedback.undoing;
  const loadMoreButtonClass = "w-full rounded-lg border border-border/70 bg-bg-secondary px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <>
      {active && (
      <section className={`space-y-2 ${feedFeedback ? "pb-24 sm:pb-0" : ""}`}>
        <div className="flex items-center justify-between">
          <h2 className={UI.text.sectionTitle}>
            <Inbox size={14} />
            Feed
            {visibleFeedCardCount > 0 && (
              <span className="text-text-faint font-normal">({visibleFeedCardCount})</span>
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

        {showFeedFilterControl && (
          <div className="flex flex-wrap items-center gap-2">
            <Filter size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
            <select
              aria-label="Filter feed by kind"
              value={feedFilter.kind}
              onChange={(event) => handleKindFilterChange(event.target.value)}
              className={feedFilterControlInputClass}
            >
              <option value="">All kinds</option>
              {kindFilterOptions.map((kind) => (
                <option key={kind} value={kind}>{kind}</option>
              ))}
            </select>
            <input
              type="text"
              aria-label="Filter feed by key prefix"
              list="dashboard-feed-key-prefixes"
              value={keyPrefixDraft}
              maxLength={KEY_PREFIX_MAX_LENGTH}
              placeholder="Key prefix (e.g. docs-maintenance:)"
              onChange={(event) => handleKeyPrefixInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitKeyPrefix(keyPrefixDraft);
                }
              }}
              onBlur={() => commitKeyPrefix(keyPrefixDraft)}
              className={`${feedFilterControlInputClass} min-w-0 flex-1 sm:flex-none sm:w-64`}
            />
            <datalist id="dashboard-feed-key-prefixes">
              {keyPrefixSuggestions.map((prefix) => (
                <option key={prefix} value={prefix} />
              ))}
            </datalist>
            {hasActiveFeedFilter && (
              <button
                type="button"
                onClick={clearFeedFilter}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <X size={12} />
                Clear
              </button>
            )}
          </div>
        )}

        {feedMutationError && (
          <div
            className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-sm text-error"
            role="alert"
          >
            {feedMutationError}
          </div>
        )}

        {feedLoading && visibleFeedCardCount === 0 ? (
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
        ) : visibleFeedCardCount > 0 ? (
          <div className="space-y-2">
            {activeFeedCards.map(renderFeedCard)}
            {activeHasMore && (
              <button
                type="button"
                onClick={() => { void onLoadMoreActive?.(); }}
                disabled={activeLoadingMore}
                className={loadMoreButtonClass}
              >
                {activeLoadingMore ? "Loading active…" : "Load more active"}
              </button>
            )}
            {showResolvedDivider && (
              <div className="flex items-center gap-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                <span className="h-px flex-1 bg-border/60" />
                Resolved
                <span className="h-px flex-1 bg-border/60" />
              </div>
            )}
            {resolvedFeedCards.map(renderFeedCard)}
            {showResolvedFeed && resolvedHasMore && (
              <button
                type="button"
                onClick={() => { void onLoadMoreResolved?.(); }}
                disabled={resolvedLoadingMore}
                className={loadMoreButtonClass}
              >
                {resolvedLoadingMore ? "Loading resolved…" : "Load more resolved"}
              </button>
            )}
          </div>
        ) : (
          hasActiveFeedFilter ? (
            <EmptyState
              message="No feed cards match this filter"
              sub="Adjust the kind or key prefix, or clear the filter. Key prefix matches keyed cards only."
            />
          ) : (
            <EmptyState
              message="No feed cards"
              sub="Agents can publish durable cards here for curated alerts, follow-ups, decisions, and artifacts."
            />
          )
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
          eyebrow={actionDraft.eyebrow}
          actionLabel={actionDraft.label}
          description={actionDraft.description}
          taskId={actionDraft.taskId}
          taskPreview={actionTaskPreview}
          context={actionDraft.context}
          prompt={actionDraft.prompt}
          promptLabel={actionDraft.promptLabel}
          promptPlaceholder={actionDraft.promptPlaceholder}
          allowEmptyPrompt={actionDraft.allowEmptyPrompt}
          error={actionError}
          submitting={actionSubmitting}
          submitMode={actionSubmitMode}
          onPromptChange={(prompt) => {
            setActionDraft((current) => current ? { ...current, prompt } : current);
            setActionError(null);
          }}
          onClose={closeFeedAction}
          onStart={() => void handleStartFeedAction("foreground")}
          onStartInBackground={() => void handleStartFeedAction("background")}
        />
      )}
    </>
  );
}
