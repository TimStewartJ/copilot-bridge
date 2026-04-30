import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  fetchMessages,
  fetchMessagesFast,
  warmSession,
  fetchMcpStatus,
  reportTiming,
  submitUserInputResponse,
  type Attachment,
  type ChatEntry,
  type ChatMessage,
  type McpServerStatus,
  type PendingUserInputRequestView,
  type ToolCall,
  type UserInputAnswerEndpointPayload,
} from "../api";
import { appendLiveEntries, getCachedChatSnapshot, hasClientGeneratedEntries, hasOptimisticTail, mergeTailMessages, normalizeCommittedClientEntries, setCachedChatSnapshot } from "../chat-cache";
import type { VoiceBackgroundJob } from "../hooks/useBackgroundVoiceJobs";
import { deriveLiveRunHeaderState } from "../lib/live-run-phase";
import { resolveExternalSessionWorkAction } from "../lib/external-session-work";
import { buildRenderableSegmentRoots, buildToolCallForest, getActiveToolCallRoots, segmentChatEntries } from "../lib/tool-call-tree";
import type { VoiceSubmitMode } from "../lib/voice-submit-mode";
import { useSessionStream } from "../useSessionStream";
import { useOverlayParam } from "../hooks/useOverlayParam";
import type { Draft } from "../useDrafts";
import MessageBubble from "./MessageBubble";
import VisualArtifactCard from "./VisualArtifactCard";
import ToolCallNodeGroup from "./ToolCallNodeGroup";
import ChatInput from "./ChatInput";
import PlanSheet from "./PlanSheet";
import McpStatusBar from "./McpStatusBar";
import { ArrowUpCircle, ClipboardList, Loader2 } from "lucide-react";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";

const INITIAL_PAGE_SIZE = 50;
const MANUAL_LOAD_PAGE_SIZE = 200;
const AUTO_LOAD_TOP_THRESHOLD = 24;
const AUTO_LOAD_DELAY_MS = 400;

type PendingStatusTone = "sending" | "thinking" | "creating";

interface ChatViewProps {
  composerKey: string;
  sessionId: string | null;
  hasPlan?: boolean;
  onMessageSent: () => void;
  draft?: Draft | null;
  onDraftChange?: (text: string, attachments?: Attachment[]) => void;
  onDraftClear?: () => void;
  onCreateAndSend?: (prompt: string, attachments?: Attachment[]) => Promise<void>;
  voiceJob?: VoiceBackgroundJob | null;
  onSubmitVoiceCapture: (capture: { composerKey: string; audio: Blob; submitMode: VoiceSubmitMode }) => Promise<void>;
  onReviewVoiceJob?: (composerKey: string) => void;
  onClearVoiceJobError?: (composerKey: string) => void;
  reloadToken?: number;
  reloadMcpServers?: McpServerStatus[];
  /** Incremented when an external source (e.g. schedule) starts work on this session */
  busySignal?: number;
}

function renderPendingStatusCard(
  key: string,
  tone: PendingStatusTone,
  label: string,
  title: string,
  detail: string,
) {
  const sending = tone === "sending";
  const creating = tone === "creating";
  const style = sending
    ? {
        backgroundColor: "var(--color-chat-sending-bg)",
        borderColor: "var(--color-chat-sending-border)",
        color: "var(--color-chat-sending-text)",
      }
    : creating
      ? {
          backgroundColor: "var(--color-chat-creating-bg)",
          borderColor: "var(--color-chat-creating-border)",
          color: "var(--color-chat-creating-text)",
        }
      : {
          backgroundColor: "var(--color-chat-thinking-bg)",
          borderColor: "var(--color-chat-thinking-border)",
          color: "var(--color-chat-thinking-text)",
        };

  return (
    <div key={key} className="px-3 md:px-5">
      <div
        className="inline-flex max-w-lg items-start gap-3 rounded-2xl border px-4 py-3 shadow-sm"
        style={style}
      >
        {sending ? (
          <ArrowUpCircle size={18} className="mt-0.5 shrink-0" />
        ) : (
          <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin" />
        )}
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-80">
            {label}
          </div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs opacity-80">{detail}</div>
        </div>
      </div>
    </div>
  );
}

function sortPendingUserInputRequests(
  requests: PendingUserInputRequestView[],
): PendingUserInputRequestView[] {
  return requests
    .map((request, index) => {
      const requestedAt = request.requestedAt ? Date.parse(request.requestedAt) : Number.NaN;
      return { request, index, requestedAt };
    })
    .sort((a, b) => {
      const aHasTime = Number.isFinite(a.requestedAt);
      const bHasTime = Number.isFinite(b.requestedAt);
      if (aHasTime && bHasTime && a.requestedAt !== b.requestedAt) {
        return a.requestedAt - b.requestedAt;
      }
      if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ request }) => request);
}

function getUserInputSubmitError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Failed to submit response.";
}

interface UserInputQuestionCardProps {
  request: PendingUserInputRequestView;
  onSubmit: (requestId: string, payload: UserInputAnswerEndpointPayload) => Promise<void>;
}

function UserInputQuestionCard({ request, onSubmit }: UserInputQuestionCardProps) {
  const [freeform, setFreeform] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const submittingRef = useRef(false);
  const choices = request.choices?.filter((choice) => choice.trim().length > 0) ?? [];
  const controlsDisabled = submitting || submitted;

  const submitResponse = useCallback(async (payload: UserInputAnswerEndpointPayload) => {
    if (submittingRef.current || submitted) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request.requestId, payload);
      setSubmitted(true);
    } catch (err) {
      submittingRef.current = false;
      setError(getUserInputSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, request.requestId, submitted]);

  const handleChoiceClick = useCallback((choice: string) => {
    if (!choice.trim()) {
      setError("Choice response cannot be blank.");
      return;
    }
    void submitResponse({ answer: choice, wasFreeform: false });
  }, [submitResponse]);

  const handleFreeformSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = freeform.trim();
    if (!answer) {
      setError("Enter a response before submitting.");
      return;
    }
    void submitResponse({ answer, wasFreeform: true });
  }, [freeform, submitResponse]);

  return (
    <div className="px-3 md:px-5">
      <div className="max-w-xl rounded-2xl border border-accent/30 bg-bg-secondary px-4 py-3 shadow-sm">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
          Question
        </div>
        <div className="mt-1 whitespace-pre-wrap text-sm font-medium leading-6 text-text-primary">
          {request.question}
        </div>

        {choices.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {choices.map((choice, index) => (
              <button
                key={`${choice}-${index}`}
                type="button"
                onClick={() => handleChoiceClick(choice)}
                disabled={controlsDisabled}
                className="rounded-full border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-accent/60 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {choice}
              </button>
            ))}
          </div>
        )}

        {request.allowFreeform && (
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={handleFreeformSubmit}>
            <input
              value={freeform}
              onChange={(event) => setFreeform(event.target.value)}
              disabled={controlsDisabled}
              className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              placeholder={choices.length > 0 ? "Or type a response..." : "Type a response..."}
              aria-label="Answer question"
            />
            <button
              type="submit"
              disabled={controlsDisabled}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? "Submitting..." : submitted ? "Submitted" : "Submit"}
            </button>
          </form>
        )}

        {choices.length === 0 && !request.allowFreeform && (
          <div className="mt-3 text-xs text-text-muted">
            No response options are available for this question.
          </div>
        )}

        {error && (
          <div
            className="mt-3 rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs text-error"
            role="alert"
          >
            {error}
          </div>
        )}
        {!error && (submitting || submitted) && (
          <div
            className="mt-3 flex items-center gap-2 text-xs text-text-muted"
            role="status"
            aria-live="polite"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            {submitting ? "Submitting response..." : "Response submitted. Waiting for the run to continue..."}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatView({
  composerKey,
  sessionId,
  hasPlan,
  onMessageSent,
  draft,
  onDraftChange,
  onDraftClear,
  onCreateAndSend,
  voiceJob,
  onSubmitVoiceCapture,
  onReviewVoiceJob,
  onClearVoiceJobError,
  reloadToken = 0,
  reloadMcpServers,
  busySignal = 0,
}: ChatViewProps) {
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [warming, setWarming] = useState(false);
  const planOverlay = useOverlayParam("sheet");
  const showPlan = planOverlay.isOpen && planOverlay.value === "plan";
  const [creating, setCreating] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([]);
  const [manualMcpOverride, setManualMcpOverride] = useState<McpServerStatus[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const firstItemIndex = useRef(0);
  const totalEntriesRef = useRef(0);
  const entriesRef = useRef<ChatEntry[]>([]);
  const sessionIdRef = useRef<string | null>(sessionId);
  const loadingMoreRef = useRef(false);
  const prevScrollHeightRef = useRef<number | null>(null);
  const loadRequestIdRef = useRef(0);
  const refreshingHistoryRef = useRef(false);
  const autoLoadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoLoadArmedRef = useRef(false);
  const suppressAutoLoadRef = useRef(false);
  const topAutoFillConsumedRef = useRef(false);
  const queuedSendRef = useRef<{
    sessionId: string | null;
    composerKey: string;
    prompt: string;
    attachments?: Attachment[];
  } | null>(null);
  // Exposed for external triggers (e.g. busySignal from scheduled work)
  const loadAndReconnectRef = useRef<(opts?: { background?: boolean }) => void>(() => {});

  const applyHistory = useCallback((
    nextEntries: ChatEntry[],
    opts: {
      ownerSessionId?: string | null;
      firstItemIndex?: number;
      total?: number;
      hasMore?: boolean;
      isCanonical?: boolean;
    } = {},
  ) => {
    const ownerSessionId = opts.ownerSessionId === undefined ? sessionIdRef.current : opts.ownerSessionId;
    const nextFirstItemIndex = opts.firstItemIndex ?? firstItemIndex.current;
    const nextTotal = opts.total ?? Math.max(totalEntriesRef.current, nextFirstItemIndex + nextEntries.length);
    const nextHasMore = opts.hasMore ?? nextFirstItemIndex > 0;

    firstItemIndex.current = nextFirstItemIndex;
    totalEntriesRef.current = nextTotal;
    entriesRef.current = nextEntries;
    setEntries(nextEntries);
    setHasMore(nextHasMore);

    if (!ownerSessionId) return;
    setCachedChatSnapshot(queryClient, {
      sessionId: ownerSessionId,
      entries: nextEntries,
      firstItemIndex: nextFirstItemIndex,
      total: nextTotal,
      hasMore: nextHasMore,
      fetchedAt: Date.now(),
      isCanonical: opts.isCanonical ?? false,
    });
  }, [queryClient]);

  const invalidateHistoryRefresh = useCallback(() => {
    if (!refreshingHistoryRef.current) return;
    loadRequestIdRef.current += 1;
    refreshingHistoryRef.current = false;
    setRefreshingHistory(false);
  }, []);

  const clearPendingAutoLoad = useCallback(() => {
    if (autoLoadTimeoutRef.current == null) return;
    clearTimeout(autoLoadTimeoutRef.current);
    autoLoadTimeoutRef.current = null;
  }, []);

  const handleNewEntries = useCallback((newEntries: ChatEntry[]) => {
    invalidateHistoryRefresh();
    const withIds = newEntries.map((e, i) => ({
      ...e,
      id: e.id ?? `stream-${Date.now()}-${i}`,
    }));
    const previousEntries = entriesRef.current;
    const nextEntries = appendLiveEntries(previousEntries, withIds);
    if (nextEntries === previousEntries) return;
    applyHistory(nextEntries, {
      total: Math.max(totalEntriesRef.current, firstItemIndex.current + nextEntries.length),
      hasMore: firstItemIndex.current > 0,
      isCanonical: false,
    });
  }, [applyHistory, invalidateHistoryRefresh]);

  const {
    streamingContent,
    intentText,
    activeTools,
    currentTurnTools,
    isStreaming,
    streamStatus,
    hadVisibleOutput,
    pendingOrigin,
    pendingUserInputs,
    mcpServers: streamMcpServers,
    sendMessage,
    startFleet,
    abortSession,
    reconnect,
  } = useSessionStream(sessionId, handleNewEntries, onMessageSent);

  // Prefer a manual override immediately after reload, then return to live stream updates.
  const effectiveMcpServers = (manualMcpOverride ?? (streamMcpServers?.length > 0 ? streamMcpServers : mcpStatus)) ?? [];

  // Load history + MCP status when session changes.
  const prevSessionRef = useRef<string | null | undefined>(undefined);
  const prevComposerKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prevSession = prevSessionRef.current;
    const prevComposerKey = prevComposerKeyRef.current;
    const wasDraft = prevSession === null && creating;
    const draftComposerChanged = prevSession === null
      && prevComposerKey !== undefined
      && prevComposerKey !== composerKey;
    prevSessionRef.current = sessionId;
    prevComposerKeyRef.current = composerKey;

    if (!sessionId) {
      // Clear draft-only state when entering draft mode from an existing
      // session or when switching between distinct draft composers.
      if (draftComposerChanged || prevSession !== undefined || !onCreateAndSend) {
        applyHistory([], {
          ownerSessionId: null,
          firstItemIndex: 0,
          total: 0,
          hasMore: false,
          isCanonical: false,
        });
      }
      setLoading(false);
      refreshingHistoryRef.current = false;
      setRefreshingHistory(false);
      setWarming(false);
      setCreating(false);
      setLoadingMore(false);
      setHasMore(false);
      setMcpStatus([]);
      setManualMcpOverride(null);
      firstItemIndex.current = 0;
      totalEntriesRef.current = 0;
      entriesRef.current = [];
      loadingMoreRef.current = false;
      autoLoadArmedRef.current = false;
      suppressAutoLoadRef.current = false;
      topAutoFillConsumedRef.current = false;
      clearPendingAutoLoad();
      return;
    }

    // Transitioning from draft → real session: keep messages, just connect stream
    if (wasDraft) {
      applyHistory(entriesRef.current, {
        ownerSessionId: sessionId,
        firstItemIndex: 0,
        total: entriesRef.current.length,
        hasMore: false,
        isCanonical: false,
      });
      setCreating(false);
      reconnect(sessionId);
      return;
    }

    // Reset stick-to-bottom so the new session starts following output,
    // regardless of scroll position in the previous session.
    stickToBottomRef.current = true;

    const controller = new AbortController();

    const loadAndReconnect = ({ background = false }: { background?: boolean } = {}) => {
      const requestId = ++loadRequestIdRef.current;
      if (background) {
        refreshingHistoryRef.current = true;
        setRefreshingHistory(true);
      } else {
        refreshingHistoryRef.current = false;
        setLoading(true);
        setRefreshingHistory(false);
        setWarming(false);
      }
      const pageLoadStart = performance.now();

      // Phase 1: Fast load messages from disk — don't wait for MCP status
      fetchMessagesFast(sessionId, { limit: INITIAL_PAGE_SIZE })
        .then(({ messages: msgs, busy, total, warm }) => {
          if (controller.signal.aborted || requestId !== loadRequestIdRef.current) return;
          if (!background) {
            const nextFirstItemIndex = Math.max(0, total - msgs.length);
            applyHistory(msgs, {
              ownerSessionId: sessionId,
              firstItemIndex: nextFirstItemIndex,
              total,
              hasMore: nextFirstItemIndex > 0,
              isCanonical: true,
            });
          } else {
            const merged = mergeTailMessages(entriesRef.current, firstItemIndex.current, total, msgs);
            applyHistory(merged.entries, {
              ownerSessionId: sessionId,
              firstItemIndex: merged.firstItemIndex,
              total: merged.total,
              hasMore: merged.firstItemIndex > 0,
              isCanonical: !merged.hasClientGeneratedEntries,
            });
          }
          setLoading(false);
          refreshingHistoryRef.current = false;
          setRefreshingHistory(false);

          // Report time from navigation to messages rendered
          const loadDuration = Math.round(performance.now() - pageLoadStart);
          reportTiming("page.sessionLoad", loadDuration, {
            sessionId,
            metadata: { messageCount: msgs.length, warm, busy },
          }).catch(() => {});

          if (busy) {
            reconnect(sessionId);
            return;
          }

          // Phase 2: Warm the session in background if needed
          if (!warm) {
            setWarming(true);
            warmSession(sessionId)
              .then(() => {
                if (!controller.signal.aborted) setWarming(false);
              })
              .catch(() => {
                if (!controller.signal.aborted) setWarming(false);
              });
          }
        })
        .catch((err) => {
          if (controller.signal.aborted || requestId !== loadRequestIdRef.current) return;
          if (!background) {
            applyHistory([
              { role: "assistant", content: `Error loading history: ${err.message}` },
            ], {
              ownerSessionId: null,
              firstItemIndex: 0,
              total: 0,
              hasMore: false,
              isCanonical: false,
            });
          }
          setLoading(false);
          refreshingHistoryRef.current = false;
          setRefreshingHistory(false);
        });

      // MCP status loads independently — doesn't block message rendering
      fetchMcpStatus(sessionId)
        .then((mcpServers) => {
          if (!controller.signal.aborted && requestId === loadRequestIdRef.current) {
            setMcpStatus(mcpServers);
          }
        })
        .catch(() => {});
    };

    loadAndReconnectRef.current = loadAndReconnect;

    loadingMoreRef.current = false;
    setLoadingMore(false);
    autoLoadArmedRef.current = false;
    suppressAutoLoadRef.current = false;
    topAutoFillConsumedRef.current = false;
    clearPendingAutoLoad();
    const cachedSnapshot = getCachedChatSnapshot(queryClient, sessionId);
    if (cachedSnapshot?.isCanonical) {
      applyHistory(cachedSnapshot.entries, {
        ownerSessionId: sessionId,
        firstItemIndex: cachedSnapshot.firstItemIndex,
        total: cachedSnapshot.total,
        hasMore: cachedSnapshot.hasMore,
        isCanonical: cachedSnapshot.isCanonical,
      });
      setLoading(false);
      setRefreshingHistory(false);
      setWarming(false);
      loadAndReconnect({ background: true });
    } else {
      applyHistory([], {
        ownerSessionId: null,
        firstItemIndex: 0,
        total: 0,
        hasMore: false,
        isCanonical: false,
      });
      loadAndReconnect();
    }

    // Close plan sheet when switching sessions (close is a stable callback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    planOverlay.close();

    // Reconnect when the tab wakes from sleep (mobile screen-off, etc.)
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      loadAndReconnect({ background: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      refreshingHistoryRef.current = false;
      loadAndReconnectRef.current = () => {};
      clearPendingAutoLoad();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [composerKey, reconnect, sessionId, applyHistory, queryClient, clearPendingAutoLoad]);

  // Reconnect when an external source starts work on this session
  const prevBusySignalRef = useRef(busySignal);
  useEffect(() => {
    prevBusySignalRef.current = busySignal;
  }, [sessionId]);
  useEffect(() => {
    const prev = prevBusySignalRef.current;
    const action = resolveExternalSessionWorkAction({
      sessionId,
      previousBusySignal: prev,
      nextBusySignal: busySignal,
      isStreaming,
      pendingOrigin,
      isRefreshingHistory: refreshingHistory,
      isLoadingHistory: loading,
      isLoadingOlderMessages: loadingMore,
      isCreatingSession: creating,
    });
    if (action === "defer") {
      return;
    }
    prevBusySignalRef.current = busySignal;
    if (action === "reconnect") {
      loadAndReconnectRef.current({ background: true });
    }
  }, [busySignal, creating, isStreaming, loading, loadingMore, pendingOrigin, refreshingHistory, sessionId]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    refreshingHistoryRef.current = refreshingHistory;
  }, [refreshingHistory]);

  useEffect(() => {
    if (!sessionId || reloadMcpServers === undefined) return;
    setManualMcpOverride(reloadMcpServers);
    setMcpStatus(reloadMcpServers);
  }, [sessionId, reloadToken, reloadMcpServers]);

  useEffect(() => {
    if ((streamMcpServers?.length ?? 0) === 0) return;
    setManualMcpOverride(null);
  }, [streamMcpServers]);

  // Scroll preservation on prepend + auto-scroll on message changes.
  // useLayoutEffect runs before paint, preventing flash.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    // If we just prepended older messages, preserve scroll position.
    const prevHeight = prevScrollHeightRef.current;
    if (prevHeight != null) {
      el.scrollTop += el.scrollHeight - prevHeight;
      prevScrollHeightRef.current = null;
      return;
    }

    // Otherwise auto-scroll to bottom (initial load, new messages appended, etc.)
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const loadOlderMessages = useCallback((opts: {
    limit?: number;
    preserveScrollPosition?: boolean;
  } = {}) => {
    if (!sessionId || !hasMore || loadingMoreRef.current) return;
    const { limit = INITIAL_PAGE_SIZE, preserveScrollPosition = true } = opts;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const beforeIndex = firstItemIndex.current;
    const requestSessionId = sessionId;
    fetchMessages(sessionId, { limit, before: beforeIndex })
      .then(({ messages: older, hasMore: more, total }) => {
        if (sessionIdRef.current !== requestSessionId || firstItemIndex.current !== beforeIndex) return;
        const currentEntries = entriesRef.current;
        if (older.length > 0) {
          invalidateHistoryRefresh();
          if (preserveScrollPosition) {
            // Save scroll height before prepending so the layout effect can preserve position.
            prevScrollHeightRef.current = scrollContainerRef.current?.scrollHeight ?? null;
          }
          const nextFirstItemIndex = beforeIndex - older.length;
          const nextEntries = normalizeCommittedClientEntries(
            [...older, ...currentEntries],
            nextFirstItemIndex,
            total,
          );
          applyHistory(nextEntries, {
            ownerSessionId: requestSessionId,
            firstItemIndex: nextFirstItemIndex,
            total: Math.max(total, nextFirstItemIndex + nextEntries.length),
            hasMore: more,
            isCanonical: !hasOptimisticTail(nextFirstItemIndex, nextEntries.length, total)
              && !hasClientGeneratedEntries(nextEntries),
          });
        } else if (!more) {
          const nextEntries = normalizeCommittedClientEntries(currentEntries, 0, total);
          applyHistory(nextEntries, {
            ownerSessionId: requestSessionId,
            firstItemIndex: 0,
            total: Math.max(total, nextEntries.length),
            hasMore: false,
            isCanonical: !hasOptimisticTail(0, nextEntries.length, total)
              && !hasClientGeneratedEntries(nextEntries),
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [sessionId, hasMore, invalidateHistoryRefresh, applyHistory]);

  const handleLoadMoreClick = useCallback(() => {
    clearPendingAutoLoad();
    suppressAutoLoadRef.current = true;
    autoLoadArmedRef.current = false;
    loadOlderMessages({ limit: MANUAL_LOAD_PAGE_SIZE, preserveScrollPosition: false });
  }, [clearPendingAutoLoad, loadOlderMessages]);

  const handleLoadMorePointerDown = useCallback(() => {
    clearPendingAutoLoad();
  }, [clearPendingAutoLoad]);

  const handleLoadMoreKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      clearPendingAutoLoad();
    }
  }, [clearPendingAutoLoad]);

  const scheduleAutoLoad = useCallback((opts: { consumeTopAutoFill?: boolean } = {}) => {
    if (!sessionId || !hasMore || loadingMoreRef.current || autoLoadTimeoutRef.current != null) return;
    autoLoadTimeoutRef.current = setTimeout(() => {
      autoLoadTimeoutRef.current = null;
      if (!loadingMoreRef.current) {
        if (opts.consumeTopAutoFill) {
          topAutoFillConsumedRef.current = true;
        }
        autoLoadArmedRef.current = false;
        loadOlderMessages();
      }
    }, AUTO_LOAD_DELAY_MS);
  }, [hasMore, loadOlderMessages, sessionId]);

  // Detect stick-to-bottom and schedule an auto-load after the user reaches the top.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const nearTop = el.scrollTop <= AUTO_LOAD_TOP_THRESHOLD;
    if (!nearTop) {
      autoLoadArmedRef.current = true;
      suppressAutoLoadRef.current = false;
      topAutoFillConsumedRef.current = false;
      clearPendingAutoLoad();
      return;
    }
    if (!autoLoadArmedRef.current) return;
    scheduleAutoLoad();
  }, [clearPendingAutoLoad, scheduleAutoLoad]);

  // If the first page doesn't overflow, schedule the same delayed auto-load from the top.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !sessionId || !hasMore || loading || loadingMore) return;
    if (suppressAutoLoadRef.current || topAutoFillConsumedRef.current) return;
    const nearTop = el.scrollTop <= AUTO_LOAD_TOP_THRESHOLD;
    const overflowing = el.scrollHeight > el.clientHeight + AUTO_LOAD_TOP_THRESHOLD;
    if (!nearTop || overflowing) return;
    scheduleAutoLoad({ consumeTopAutoFill: true });
  }, [entries, hasMore, loading, loadingMore, scheduleAutoLoad, sessionId]);

  const handleSend = useCallback(async (prompt: string, attachments?: Attachment[]) => {
    if (loading) {
      queuedSendRef.current = { sessionId, composerKey, prompt, attachments };
      return;
    }
    if (isStreaming || creating) return;

    // Draft mode: create session on first message
    if (!sessionId && onCreateAndSend) {
      setCreating(true);
      applyHistory([{ role: "user", content: prompt, id: `draft-user-0`, ...(attachments?.length ? { attachments } : {}) }], {
        ownerSessionId: null,
        firstItemIndex: 0,
        total: 1,
        hasMore: false,
        isCanonical: false,
      });
      try {
        await onCreateAndSend(prompt, attachments);
      } catch (err: any) {
        const nextEntries = [
          ...entriesRef.current,
          { role: "assistant", content: `⚠️ Error: ${err.message}`, id: `draft-err-0` } satisfies ChatEntry,
        ];
        applyHistory(nextEntries, {
          ownerSessionId: null,
          firstItemIndex: 0,
          total: nextEntries.length,
          hasMore: false,
          isCanonical: false,
        });
        setCreating(false);
      }
      return;
    }

    if (!sessionId) return;
    onDraftClear?.();
    invalidateHistoryRefresh();
    const nextEntries = [...entriesRef.current, { role: "user", content: prompt, id: `local-${Date.now()}`, ...(attachments?.length ? { attachments } : {}) } satisfies ChatEntry];
    applyHistory(nextEntries, {
      ownerSessionId: sessionId,
      total: Math.max(totalEntriesRef.current, firstItemIndex.current + nextEntries.length),
      hasMore: firstItemIndex.current > 0,
      isCanonical: false,
    });
    // Force stick-to-bottom so auto-scroll kicks in after the next render
    stickToBottomRef.current = true;
    try {
      await sendMessage(prompt, attachments);
    } catch (err: any) {
      const nextEntriesWithError = [...entriesRef.current, { role: "assistant", content: `⚠️ Error: ${err.message}`, id: `err-${Date.now()}` } satisfies ChatEntry];
      applyHistory(nextEntriesWithError, {
        ownerSessionId: sessionId,
        total: Math.max(totalEntriesRef.current, firstItemIndex.current + nextEntriesWithError.length),
        hasMore: firstItemIndex.current > 0,
        isCanonical: false,
      });
    }
  }, [sessionId, composerKey, loading, isStreaming, creating, sendMessage, onDraftClear, onCreateAndSend, invalidateHistoryRefresh, applyHistory]);

  useEffect(() => {
    const queuedSend = queuedSendRef.current;
    if (!queuedSend) return;
    if (loading || isStreaming || creating) return;
    if (queuedSend.sessionId !== sessionId || queuedSend.composerKey !== composerKey) {
      queuedSendRef.current = null;
      return;
    }
    queuedSendRef.current = null;
    void handleSend(queuedSend.prompt, queuedSend.attachments);
  }, [composerKey, creating, handleSend, isStreaming, loading, sessionId]);

  const handleRunFleet = useCallback(async () => {
    if (!sessionId) throw new Error("Session not available");
    if (isStreaming) throw new Error("Session is busy, please wait");
    if (creating) throw new Error("Session is still being created");
    if (warming) throw new Error("Session is reconnecting, please wait");
    invalidateHistoryRefresh();
    stickToBottomRef.current = true;
    await startFleet();
  }, [sessionId, isStreaming, creating, warming, invalidateHistoryRefresh, startFleet]);

  const pendingUserInputRequests = useMemo(
    () => sortPendingUserInputRequests(pendingUserInputs),
    [pendingUserInputs],
  );
  const hasPendingUserInputs = pendingUserInputRequests.length > 0;

  const handleSubmitUserInput = useCallback(async (
    requestId: string,
    payload: UserInputAnswerEndpointPayload,
  ) => {
    if (!sessionId) throw new Error("Session not available");
    await submitUserInputResponse(sessionId, requestId, payload);
  }, [sessionId]);

  const activeToolCalls = useMemo<ToolCall[]>(
    () => activeTools.map((tool) => ({
      toolCallId: tool.toolCallId,
      name: tool.name,
      args: tool.args,
      parentToolCallId: tool.parentToolCallId,
      isSubAgent: tool.isSubAgent,
      startedAt: tool.startedAt,
      progressText: tool.progressText,
    })),
    [activeTools],
  );
  const activeToolCallIds = useMemo(
    () => new Set(activeTools.map((tool) => tool.toolCallId)),
    [activeTools],
  );
  const liveToolCalls = currentTurnTools.length > 0 ? currentTurnTools : activeToolCalls;
  const liveToolCallIds = useMemo(
    () => new Set(liveToolCalls.map((tool) => tool.toolCallId)),
    [liveToolCalls],
  );
  const historicalEntries = useMemo(() => {
    if ((!isStreaming && !creating) || liveToolCallIds.size === 0) return entries;
    return entries.filter((entry) => (
      entry.type !== "tool"
      || !entry.toolCall
      || !liveToolCallIds.has(entry.toolCall.toolCallId)
    ));
  }, [creating, entries, isStreaming, liveToolCallIds]);
  const toolEntries = useMemo(
    () => historicalEntries.flatMap((entry) => entry.type === "tool" && entry.toolCall ? [entry.toolCall] : []),
    [historicalEntries],
  );
  const toolForest = useMemo(() => buildToolCallForest(toolEntries), [toolEntries]);
  const activeToolForest = useMemo(() => buildToolCallForest(activeToolCalls), [activeToolCalls]);
  const liveToolForest = useMemo(() => buildToolCallForest(liveToolCalls), [liveToolCalls]);
  const activeRootNodes = useMemo(() => getActiveToolCallRoots(activeToolForest.roots), [activeToolForest.roots]);
  const runHeaderState = useMemo(() => deriveLiveRunHeaderState({
    creating,
    isStreaming,
    streamStatus,
    pendingOrigin,
    streamingContent,
    activeTrackCount: activeRootNodes.length,
    intentText,
    hadVisibleOutput,
  }), [creating, isStreaming, streamStatus, pendingOrigin, streamingContent, activeRootNodes.length, intentText, hadVisibleOutput]);

  // Auto-scroll during streaming (content grows within the pending block).
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamingContent, runHeaderState?.phase, isStreaming, creating, currentTurnTools, pendingUserInputRequests.length]);

  // Build pending indicator content (run header + streaming text).
  const pendingContent = useMemo(() => {
    const parts: React.ReactNode[] = [];

    if (runHeaderState) {
      parts.push(
        renderPendingStatusCard(
          "run-header",
          runHeaderState.tone,
          runHeaderState.label,
          runHeaderState.title,
          runHeaderState.detail,
        ),
      );
    }

    if (liveToolForest.roots.length > 0) {
      parts.push(
        <div key="live-tools" className="px-3 md:px-5">
          <ToolCallNodeGroup
            nodes={liveToolForest.roots}
            defaultExpanded={liveToolForest.roots.some((node) => node.children.length > 0)}
            activeToolCallIds={activeToolCallIds}
          />
        </div>,
      );
    }

    if (streamingContent) {
      parts.push(
        <div key="streaming" className="px-3 md:px-5">
          <MessageBubble message={{ role: "assistant", content: streamingContent }} />
        </div>,
      );
    }

    for (const request of pendingUserInputRequests) {
      parts.push(
        <UserInputQuestionCard
          key={`user-input-${request.requestId}`}
          request={request}
          onSubmit={handleSubmitUserInput}
        />,
      );
    }

    if (parts.length === 0) return null;
    return <div className="space-y-4 pb-4">{parts}</div>;
  }, [activeToolCallIds, handleSubmitUserInput, liveToolForest.roots, pendingUserInputRequests, runHeaderState, streamingContent]);

  const isDraft = !sessionId && !!onCreateAndSend;
  const runFleetDisabledReason = !hasPlan
    ? "This session does not have a plan yet."
    : loading
      ? "Wait for the current session history to finish loading."
      : creating
        ? "Finish creating the session before launching Fleet."
        : warming
          ? "Wait for the session to reconnect before launching Fleet."
          : isStreaming
            ? "Wait for the current run to finish before launching Fleet."
            : null;
  const isLaunchingFleet = isStreaming && pendingOrigin === "fleet";
  const composerDisabled = warming || loading;
  const composerDisabledHint = loading ? "Loading history…" : warming ? "Reconnecting…" : undefined;

  if (!sessionId && !isDraft) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-lg">
        Create or select a session to start
      </div>
    );
  }

  /** Render messages in order, but group each tool turn into real parallel root tracks. */
  const renderedEntries = useMemo(() => {
    const result: React.ReactNode[] = [];
    const segments = segmentChatEntries(historicalEntries);

    segments.forEach((segment, index) => {
      if (segment.type === "tool-segment") {
        const roots = buildRenderableSegmentRoots(segment.entries, toolForest);
        if (roots.length === 0) return;
        const segmentKey = segment.turnId
          ? `tool-turn-${segment.turnId}`
          : segment.entries[0]?.id ?? `tool-segment-${index}`;
        result.push(
          <div key={segmentKey} className="px-3 md:px-5 pt-2">
            <ToolCallNodeGroup
              nodes={roots}
              defaultExpanded={roots.some((node) => node.children.length > 0)}
            />
          </div>,
        );
        return;
      }

      if (segment.type === "visual-segment") {
        const { entry } = segment;
        result.push(
          <div key={entry.id ?? `visual-${index}`} className="px-3 md:px-5 pt-3">
            <VisualArtifactCard visual={entry.visual} />
          </div>,
        );
        return;
      }

      const msg = segment.entry as ChatMessage;
      result.push(
        <div key={msg.id ?? `${msg.role}-${index}`} className="px-3 md:px-5 pt-4">
          <MessageBubble message={msg} />
        </div>,
      );
    });

    return result;
  }, [historicalEntries, toolForest]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Plan header bar */}
      {hasPlan && (
        <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border bg-bg-secondary">
          <span className="text-xs text-text-muted flex items-center gap-1.5">
            <ClipboardList size={12} />
            Plan available
          </span>
          <button
            onClick={() => planOverlay.open("plan")}
            className="text-xs text-accent hover:text-accent-hover transition-colors font-medium"
          >
            View
          </button>
        </div>
      )}
      {/* MCP server status */}
      <McpStatusBar servers={effectiveMcpServers} />
      {loading && entries.length === 0 ? (
        <LoadingSkeletonRegion
          isLoading
          label="Loading chat history"
          className="flex-1 flex items-end overflow-hidden px-3 pb-6 md:px-5"
        >
          <div className="w-full space-y-4">
            <div className="max-w-lg rounded-2xl border border-border bg-bg-secondary px-4 py-3">
              <SkeletonText lines={3} widths={["88%", "72%", "46%"]} />
            </div>
            <div className="ml-auto max-w-md rounded-2xl border border-accent/20 bg-accent/10 px-4 py-3">
              <SkeletonText lines={2} widths={["78%", "52%"]} />
            </div>
            <div className="max-w-lg rounded-2xl border border-border bg-bg-secondary px-4 py-3">
              <div className="mb-3 flex items-center gap-2">
                <Skeleton shape="circle" width={18} height={18} />
                <Skeleton height={10} width="32%" shape="pill" />
              </div>
              <SkeletonText lines={3} widths={["94%", "80%", "60%"]} />
            </div>
          </div>
        </LoadingSkeletonRegion>
      ) : entries.length === 0 && !isStreaming && !creating && !hasPendingUserInputs ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-lg">
          Send a message to get started
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden"
          onScroll={handleScroll}
        >
          {refreshingHistory && (
            <div className="sticky top-0 z-10 flex justify-center px-3 pt-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/95 px-3 py-1 text-xs text-text-muted shadow-sm backdrop-blur-sm">
                <Loader2 size={12} className="animate-spin text-accent/70" />
                Refreshing history...
              </div>
            </div>
          )}
          {loadingMore ? (
            <div className="text-center py-3 text-accent/60 text-xs">
              <Loader2 size={14} className="inline animate-spin mr-1" />
              Loading older messages...
            </div>
          ) : hasMore ? (
            <div className="text-center py-2 text-xs">
              <button
                type="button"
                onPointerDown={handleLoadMorePointerDown}
                onKeyDown={handleLoadMoreKeyDown}
                onClick={handleLoadMoreClick}
                className="inline-flex flex-col items-center gap-0.5 font-medium text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:text-text-primary"
                aria-label={`Load ${MANUAL_LOAD_PAGE_SIZE} older messages`}
                title={`Load ${MANUAL_LOAD_PAGE_SIZE} older messages`}
              >
                <span className="underline underline-offset-2">Scroll up for more</span>
                <span className="text-[11px] opacity-75">Click to load {MANUAL_LOAD_PAGE_SIZE} older messages</span>
              </button>
            </div>
          ) : null}
          {renderedEntries}
          {pendingContent && <div className="pt-4">{pendingContent}</div>}
          <div className="h-4" />
        </div>
      )}
      <ChatInput
        onSend={handleSend}
        onAbort={isStreaming ? abortSession : undefined}
        composerKey={composerKey}
        sessionId={sessionId}
        isDraft={isDraft}
        draft={draft}
        onDraftChange={onDraftChange}
        voiceJob={voiceJob}
        onSubmitVoiceCapture={onSubmitVoiceCapture}
        onReviewVoiceJob={onReviewVoiceJob}
        onClearVoiceJobError={onClearVoiceJobError}
        disabled={composerDisabled}
        disabledHint={composerDisabledHint}
      />
      {/* Plan sheet overlay */}
      {showPlan && sessionId && (
        <PlanSheet
          sessionId={sessionId}
          onClose={planOverlay.close}
          onRunFleet={handleRunFleet}
          runFleetDisabledReason={runFleetDisabledReason}
          isRunningFleet={isLaunchingFleet}
        />
      )}
    </div>
  );
}
