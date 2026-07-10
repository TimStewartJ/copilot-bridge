import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  fetchSlashCommands,
  fetchMessagesFast,
  warmSession,
  loginMcpServer,
  fetchMcpStatus,
  fetchSessionContext,
  reportTiming,
  submitUserInputResponse,
  undoSessionTurn,
  type Attachment,
  type BackgroundAgentsSummary,
  type ChatEntry,
  type ChatMessage,
  type McpServerStatus,
  type PendingUserInputRequestView,
  type SlashCommandInfo,
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
import useLongPressMenu from "../hooks/useLongPressMenu";
import type { Draft } from "../useDrafts";
import { DEFAULT_SEND_MODE, type SendMode } from "../../shared/send-mode.js";
import type { SessionContextResponse } from "../../shared/session-context.js";
import MessageBubble from "./MessageBubble";
import CompletionCard from "./CompletionCard";
import {
  MessageActionsMenu,
  MessageActionToolbar,
  writeClipboardText,
  type MessageActionMenuTarget,
} from "./MessageActions";
import VisualArtifactCard from "./VisualArtifactCard";
import SkillLoadedCard from "./SkillLoadedCard";
import ToolCallNodeGroup from "./ToolCallNodeGroup";
import ChatInput from "./ChatInput";
import PlanSheet from "./PlanSheet";
import McpStatusBar from "./McpStatusBar";
import SessionAgentsBar from "./SessionAgentsBar";
import { ArrowUpCircle, ClipboardList, Loader2 } from "lucide-react";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";

const INITIAL_PAGE_SIZE = 50;
const MANUAL_LOAD_PAGE_SIZE = 200;
const AUTO_LOAD_TOP_THRESHOLD = 24;
const AUTO_LOAD_DELAY_MS = 400;
const STREAM_RENDER_INTERVAL_MS = 60;
const LIVE_STREAMING_MESSAGE_ID = "live-assistant-stream";
const FOLLOW_BOTTOM_THRESHOLD_PX = 96;
const FOLLOW_SCROLL_EASE = 0.35;
const FOLLOW_SCROLL_SETTLE_PX = 1.5;
const LATEST_MESSAGE_TOP_THRESHOLD_PX = 8;
const CHAT_RAIL_CLASS = "mx-auto w-full max-w-4xl px-3 sm:px-4 md:px-6 lg:px-8";

type PendingStatusTone = "sending" | "thinking" | "creating";

interface ChatViewProps {
  composerKey: string;
  sessionId: string | null;
  hasPlan?: boolean;
  onMessageSent: () => void;
  draft?: Draft | null;
  onDraftChange?: (text: string, attachments?: Attachment[]) => void;
  onDraftClear?: () => void;
  onCreateAndSend?: (prompt: string, attachments?: Attachment[], mode?: SendMode) => Promise<void>;
  voiceJob?: VoiceBackgroundJob | null;
  onSubmitVoiceCapture: (capture: { composerKey: string; audio: Blob; submitMode: VoiceSubmitMode }) => Promise<void>;
  onReviewVoiceJob?: (composerKey: string) => void;
  onClearVoiceJobError?: (composerKey: string) => void;
  onRetryVoiceJobUpload?: (composerKey: string) => void;
  reloadToken?: number;
  reloadMcpServers?: McpServerStatus[];
  /** Incremented when an external source (e.g. schedule) starts work on this session */
  busySignal?: number;
  /** Incremented when server history was truncated and the loaded window must be replaced. */
  historySignal?: number;
  activeSessionActivityAt?: string;
  backgroundAgents?: BackgroundAgentsSummary;
  onForkSession?: (sessionId: string, opts?: { toEventId?: string }) => Promise<void> | void;
  onRenderedReadThrough?: (sessionId: string, readThroughActivityAt: string) => void; newWorkDisabled?: boolean; newWorkDisabledHint?: string;
}

function useThrottledText(value: string, intervalMs: number): string {
  const [displayValue, setDisplayValue] = useState(value);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    if (value === displayValue) return;
    if (!value || !value.startsWith(displayValue)) {
      lastUpdateRef.current = Date.now();
      setDisplayValue(value);
      return;
    }

    const elapsed = Date.now() - lastUpdateRef.current;
    const delay = Math.max(0, intervalMs - elapsed);
    const timeout = setTimeout(() => {
      lastUpdateRef.current = Date.now();
      setDisplayValue(value);
    }, delay);
    return () => clearTimeout(timeout);
  }, [displayValue, intervalMs, value]);

  return displayValue;
}

function getDistanceFromBottom(el: HTMLElement): number {
  return Math.max(0, getMaxScrollTop(el) - getSafeScrollTop(el));
}

function getSafeScrollTop(el: HTMLElement): number {
  return Number.isFinite(el.scrollTop) ? el.scrollTop : 0;
}

function getMaxScrollTop(el: HTMLElement): number {
  const scrollHeight = Number.isFinite(el.scrollHeight) ? el.scrollHeight : 0;
  const clientHeight = Number.isFinite(el.clientHeight) ? el.clientHeight : 0;
  return Math.max(0, scrollHeight - clientHeight);
}

function isChatMessageEntry(entry: ChatEntry): entry is ChatMessage & { type?: "message" } {
  return !entry.type || entry.type === "message";
}

function getMessageAnchorKey(message: ChatMessage, fallbackIndex: number): string {
  if (message.turnId) return `turn:${message.turnId}:${message.role}`;
  return message.id ?? `${message.role}:${fallbackIndex}`;
}

function getLatestMessageAnchorKey(entries: ChatEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isChatMessageEntry(entry)) return getMessageAnchorKey(entry, index);
  }
  return null;
}

function getLatestMessageRole(entries: ChatEntry[]): ChatMessage["role"] | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isChatMessageEntry(entry)) return entry.role;
  }
  return null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function renderLiveStatusPill(
  key: string,
  tone: PendingStatusTone,
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
    <div key={key} className={CHAT_RAIL_CLASS}>
      <div
        className="inline-flex max-w-lg items-center gap-2 rounded-full border px-3 py-1.5 text-sm shadow-sm"
        style={style}
        title={detail}
      >
        {sending ? (
          <ArrowUpCircle size={14} className="shrink-0" />
        ) : (
          <Loader2 size={14} className="shrink-0 animate-spin" />
        )}
        <span className="min-w-0 truncate font-medium">{title}</span>
      </div>
    </div>
  );
}

function renderRefreshingHistoryTailSkeleton(isLoading: boolean) {
  return (
    <LoadingSkeletonRegion
      isLoading={isLoading}
      label="Loading newer chat content"
      className="pt-4"
      delayMs={200}
    >
      <div className="space-y-3">
        <div className={CHAT_RAIL_CLASS}>
          <div className="max-w-lg rounded-2xl border border-border bg-bg-secondary px-4 py-3">
            <SkeletonText lines={3} widths={["84%", "68%", "42%"]} />
          </div>
        </div>
        <div className={CHAT_RAIL_CLASS}>
          <div className="inline-flex w-full max-w-md items-center gap-3 rounded-xl border border-border/70 bg-bg-secondary/70 px-3 py-2">
            <Skeleton shape="circle" width={16} height={16} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <SkeletonText lines={2} widths={["62%", "38%"]} />
            </div>
          </div>
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function isNewerActivityTimestamp(currentActivityAt?: string, cachedActivityAt?: string): boolean {
  if (!currentActivityAt || !cachedActivityAt) return false;
  const currentTime = Date.parse(currentActivityAt);
  const cachedTime = Date.parse(cachedActivityAt);
  return Number.isFinite(currentTime) && Number.isFinite(cachedTime) && currentTime > cachedTime;
}

function activityTimestampCovers(loadedActivityAt: string | undefined, markerActivityAt: string | undefined): boolean {
  if (!markerActivityAt) return true;
  const markerTime = Date.parse(markerActivityAt);
  if (!Number.isFinite(markerTime)) return true;
  if (!loadedActivityAt) return false;
  const loadedTime = Date.parse(loadedActivityAt);
  return Number.isFinite(loadedTime) && loadedTime >= markerTime;
}

function maxActivityTimestamp(left?: string | null, right?: string | null): string | undefined {
  const leftTime = left ? Date.parse(left) : Number.NaN;
  const rightTime = right ? Date.parse(right) : Number.NaN;
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return undefined;
  return new Date(Math.max(
    Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY,
    Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY,
  )).toISOString();
}

function getEntryActivityTimestamp(entry: ChatEntry): string | undefined {
  if (entry.type === "tool") return entry.toolCall.completedAt ?? entry.toolCall.startedAt;
  if (entry.type === "visual") return entry.timestamp;
  if (entry.type === "completion") return entry.timestamp;
  if (entry.type === "skill") return entry.timestamp;
  if ("role" in entry && ((entry.content ?? "").trim() || entry.attachments?.length)) {
    return entry.timestamp;
  }
  return undefined;
}

function getLatestEntryActivityTimestamp(entries: ChatEntry[]): string | undefined {
  let latest: string | undefined;
  for (const entry of entries) {
    latest = maxActivityTimestamp(latest, getEntryActivityTimestamp(entry));
  }
  return latest;
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
    <div className={CHAT_RAIL_CLASS}>
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
  onRetryVoiceJobUpload,
  reloadToken = 0,
  reloadMcpServers,
  busySignal = 0,
  historySignal = 0,
  activeSessionActivityAt,
  backgroundAgents,
  onForkSession,
  onRenderedReadThrough, newWorkDisabled = false, newWorkDisabledHint,
}: ChatViewProps) {
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [showRefreshingTailSkeleton, setShowRefreshingTailSkeleton] = useState(false);
  const [warming, setWarming] = useState(false);
  const planOverlay = useOverlayParam("sheet");
  const showPlan = planOverlay.isOpen && planOverlay.value === "plan";
  const [creating, setCreating] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([]);
  const [manualMcpOverride, setManualMcpOverride] = useState<McpServerStatus[] | null>(null);
  const [sessionContext, setSessionContext] = useState<SessionContextResponse | null>(null);
  const [sessionContextError, setSessionContextError] = useState<string | null>(null);
  const [sessionContextLoading, setSessionContextLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forkingBoundaryEventId, setForkingBoundaryEventId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [undoingEventId, setUndoingEventId] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [messageMenuTarget, setMessageMenuTarget] = useState<MessageActionMenuTarget | null>(null);
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsSupported, setSlashCommandsSupported] = useState(false);
  const slashCommandFetchKeyRef = useRef<string | null>(null);
  const {
    bind: bindMessageMenu,
    menu: messageMenu,
    openMenu: openMessageMenu,
    closeMenu,
    isTarget: isMessageLongPressTarget,
  } = useLongPressMenu<string>();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const firstItemIndex = useRef(0);
  const totalEntriesRef = useRef(0);
  const historyLastVisibleActivityAtRef = useRef<string | undefined>(undefined);
  const entriesRef = useRef<ChatEntry[]>([]);
  const sessionIdRef = useRef<string | null>(sessionId);
  const activeSessionActivityAtRef = useRef<string | undefined>(activeSessionActivityAt);
  const loadingMoreRef = useRef(false);
  const prevScrollHeightRef = useRef<number | null>(null);
  const loadRequestIdRef = useRef(0);
  const refreshingHistoryRef = useRef(false);
  const autoLoadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoLoadArmedRef = useRef(false);
  const suppressAutoLoadRef = useRef(false);
  const topAutoFillConsumedRef = useRef(false);
  const staleTailRefreshRetryRef = useRef<string | undefined>(undefined);
  const tailSkeletonRefreshEligibleRef = useRef(false);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followScrollFrameRef = useRef<number | null>(null);
  const resetProgrammaticScrollFrameRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const messageElementRefs = useRef(new Map<string, HTMLDivElement>());
  const latestMessageAnchorKeyRef = useRef<string | null>(null);
  const anchoredMessageKeyRef = useRef<string | null>(null);
  const pendingLiveAnchorCarryRef = useRef(false);
  const contextRefreshStreamingRef = useRef(false);
  const pendingRenderedReadThroughRef = useRef<{
    sessionId: string;
    readThroughActivityAt: string;
  } | null>(null);
  const queuedSendRef = useRef<{
    sessionId: string | null;
    composerKey: string;
    prompt: string;
    attachments?: Attachment[];
    mode?: SendMode;
  } | null>(null);
  // Exposed for external triggers (e.g. busySignal from scheduled work)
  const loadAndReconnectRef = useRef<(opts?: { background?: boolean; replace?: boolean }) => void>(() => {});
  activeSessionActivityAtRef.current = activeSessionActivityAt;

  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  const applyHistory = useCallback((
    nextEntries: ChatEntry[],
    opts: {
      ownerSessionId?: string | null;
      firstItemIndex?: number;
      total?: number;
      hasMore?: boolean;
      isCanonical?: boolean;
      lastVisibleActivityAt?: string | null;
    } = {},
  ) => {
    const ownerSessionId = opts.ownerSessionId === undefined ? sessionIdRef.current : opts.ownerSessionId;
    const nextFirstItemIndex = opts.firstItemIndex ?? firstItemIndex.current;
    const nextTotal = opts.total ?? Math.max(totalEntriesRef.current, nextFirstItemIndex + nextEntries.length);
    const nextHasMore = opts.hasMore ?? nextFirstItemIndex > 0;

    firstItemIndex.current = nextFirstItemIndex;
    totalEntriesRef.current = nextTotal;
    const nextLastVisibleActivityAt = opts.lastVisibleActivityAt === null
      ? undefined
      : opts.lastVisibleActivityAt ?? historyLastVisibleActivityAtRef.current;
    historyLastVisibleActivityAtRef.current = ownerSessionId ? nextLastVisibleActivityAt : undefined;
    entriesRef.current = nextEntries;
    setEntries(nextEntries);
    setHasMore(nextHasMore);

    const nextReadThrough = maxActivityTimestamp(
      nextLastVisibleActivityAt,
      getLatestEntryActivityTimestamp(nextEntries),
    );
    pendingRenderedReadThroughRef.current = ownerSessionId && nextReadThrough
      ? { sessionId: ownerSessionId, readThroughActivityAt: nextReadThrough }
      : null;

    if (!ownerSessionId) return;
    setCachedChatSnapshot(queryClient, {
      sessionId: ownerSessionId,
      entries: nextEntries,
      firstItemIndex: nextFirstItemIndex,
      total: nextTotal,
      hasMore: nextHasMore,
      fetchedAt: Date.now(),
      isCanonical: opts.isCanonical ?? false,
      lastVisibleActivityAt: nextLastVisibleActivityAt,
    });
  }, [queryClient]);

  const invalidateHistoryRefresh = useCallback(() => {
    setShowRefreshingTailSkeleton(false);
    tailSkeletonRefreshEligibleRef.current = false;
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
    activeTools = [],
    currentTurnTools = [],
    isStreaming,
    streamStatus,
    hadVisibleOutput,
    pendingOrigin,
    runMode,
    pendingUserInputs = [],
    mcpServers: streamMcpServers,
    contextSummary: streamContextSummary,
    sendMessage,
    abortSession,
    reconnect,
  } = useSessionStream(sessionId, handleNewEntries, onMessageSent);

  useEffect(() => {
    if (!sessionId || loading || creating) {
      setSlashCommands([]);
      setSlashCommandsSupported(false);
      slashCommandFetchKeyRef.current = null;
      return;
    }
    const fetchKey = `${sessionId}:${isStreaming ? "busy" : "idle"}`;
    if (slashCommandFetchKeyRef.current === fetchKey) return;
    slashCommandFetchKeyRef.current = fetchKey;
    let cancelled = false;
    fetchSlashCommands(sessionId)
      .then((result) => {
        if (cancelled) return;
        setSlashCommands(result.commands);
        setSlashCommandsSupported(result.supported);
      })
      .catch(() => {
        if (cancelled) return;
        setSlashCommands([]);
        setSlashCommandsSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [creating, isStreaming, loading, sessionId]);

  // Prefer a manual override immediately after reload, then return to live stream updates.
  const effectiveMcpServers = (manualMcpOverride ?? (streamMcpServers?.length > 0 ? streamMcpServers : mcpStatus)) ?? [];
  const refreshMcpStatus = useCallback(async () => {
    if (!sessionId) return;
    const servers = await fetchMcpStatus(sessionId);
    setMcpStatus(servers);
    setManualMcpOverride(servers);
  }, [sessionId]);

  const handleMcpAuthenticate = useCallback(async (
    serverName: string,
    options: { forceReauth?: boolean } = {},
  ) => {
    if (!sessionId) throw new Error("Open a session before signing in to an MCP server.");
    const result = await loginMcpServer(sessionId, serverName, options);
    setMcpStatus(result.servers);
    setManualMcpOverride(result.servers);
    return result;
  }, [sessionId]);

  const refreshSessionContext = useCallback(async (
    targetSessionId: string,
    options: { background?: boolean; signal?: AbortSignal } = {},
  ) => {
    if (!options.background) setSessionContextLoading(true);
    setSessionContextError(null);
    try {
      const nextContext = await fetchSessionContext(targetSessionId, { signal: options.signal });
      if (options.signal?.aborted) return;
      setSessionContext(nextContext);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) return;
      setSessionContextError(getErrorMessage(error));
    } finally {
      if (!options.signal?.aborted) setSessionContextLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!sessionId) {
      contextRefreshStreamingRef.current = false;
      setSessionContext(null);
      setSessionContextError(null);
      setSessionContextLoading(false);
      return;
    }
    const controller = new AbortController();
    setSessionContext(null);
    setSessionContextError(null);
    void refreshSessionContext(sessionId, { signal: controller.signal });
    return () => controller.abort();
  }, [historySignal, refreshSessionContext, reloadToken, sessionId]);

  useEffect(() => {
    const wasStreaming = contextRefreshStreamingRef.current;
    contextRefreshStreamingRef.current = isStreaming;
    if (!sessionId || !wasStreaming || isStreaming) return;
    void refreshSessionContext(sessionId, { background: true });
    loadAndReconnectRef.current({ background: true });
  }, [isStreaming, refreshSessionContext, sessionId]);

  const cancelFollowScroll = useCallback(() => {
    if (followScrollFrameRef.current != null) {
      window.cancelAnimationFrame(followScrollFrameRef.current);
      followScrollFrameRef.current = null;
    }
  }, []);

  const clearProgrammaticScroll = useCallback(() => {
    if (resetProgrammaticScrollFrameRef.current != null) {
      window.cancelAnimationFrame(resetProgrammaticScrollFrameRef.current);
      resetProgrammaticScrollFrameRef.current = null;
    }
    programmaticScrollRef.current = false;
  }, []);

  const settleProgrammaticScroll = useCallback(() => {
    if (resetProgrammaticScrollFrameRef.current != null) {
      window.cancelAnimationFrame(resetProgrammaticScrollFrameRef.current);
    }
    resetProgrammaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      resetProgrammaticScrollFrameRef.current = null;
      programmaticScrollRef.current = false;
    });
  }, []);

  const getMessageTopWithinScroller = useCallback((messageKey: string): number | null => {
    const scroller = scrollContainerRef.current;
    const messageEl = messageElementRefs.current.get(messageKey);
    if (!scroller || !messageEl) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const messageRect = messageEl.getBoundingClientRect();
    return messageRect.top - scrollerRect.top + getSafeScrollTop(scroller);
  }, []);

  const scrollToLatest = useCallback((opts: { immediate?: boolean; force?: boolean; anchorKey?: string | null } = {}) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (opts.force) {
      stickToBottomRef.current = true;
      anchoredMessageKeyRef.current = null;
      setShowJumpToLatest(false);
    } else if (!stickToBottomRef.current) {
      return;
    }

    cancelFollowScroll();
    const reducedMotion = prefersReducedMotion();
    const immediate = opts.immediate || reducedMotion;

    const step = () => {
      const anchorKey = opts.anchorKey ?? null;
      const currentScrollTop = getSafeScrollTop(el);
      const bottomTarget = getMaxScrollTop(el);
      const anchorTop = anchorKey ? getMessageTopWithinScroller(anchorKey) : null;
      const hasAnchorTarget = anchorTop != null && Number.isFinite(anchorTop);
      const canAnchorToMessage = hasAnchorTarget
        && bottomTarget > 0
        && bottomTarget >= anchorTop - LATEST_MESSAGE_TOP_THRESHOLD_PX;
      if (!opts.force && anchorKey && canAnchorToMessage && anchorTop <= currentScrollTop + LATEST_MESSAGE_TOP_THRESHOLD_PX) {
        programmaticScrollRef.current = true;
        if (Math.abs(anchorTop - currentScrollTop) <= LATEST_MESSAGE_TOP_THRESHOLD_PX) {
          el.scrollTop = Math.max(0, Math.min(bottomTarget, anchorTop));
        }
        followScrollFrameRef.current = null;
        stickToBottomRef.current = true;
        anchoredMessageKeyRef.current = anchorKey;
        setShowJumpToLatest(false);
        settleProgrammaticScroll();
        return;
      }

      const target = hasAnchorTarget ? Math.min(bottomTarget, anchorTop) : bottomTarget;
      const delta = target - currentScrollTop;
      programmaticScrollRef.current = true;

      if (immediate || Math.abs(delta) <= FOLLOW_SCROLL_SETTLE_PX) {
        el.scrollTop = target;
        followScrollFrameRef.current = null;
        stickToBottomRef.current = true;
        anchoredMessageKeyRef.current = anchorKey && canAnchorToMessage && Math.abs(target - anchorTop) <= LATEST_MESSAGE_TOP_THRESHOLD_PX
          ? anchorKey
          : null;
        setShowJumpToLatest(false);
        settleProgrammaticScroll();
        return;
      }

      const nextScrollTop = currentScrollTop + delta * FOLLOW_SCROLL_EASE;
      if (anchorKey && canAnchorToMessage && Math.abs(target - anchorTop) <= LATEST_MESSAGE_TOP_THRESHOLD_PX && nextScrollTop >= anchorTop - LATEST_MESSAGE_TOP_THRESHOLD_PX) {
        el.scrollTop = Math.max(0, Math.min(bottomTarget, anchorTop));
        followScrollFrameRef.current = null;
        stickToBottomRef.current = true;
        anchoredMessageKeyRef.current = anchorKey;
        setShowJumpToLatest(false);
        settleProgrammaticScroll();
        return;
      }

      anchoredMessageKeyRef.current = null;
      el.scrollTop = nextScrollTop;
      followScrollFrameRef.current = window.requestAnimationFrame(step);
    };

    if (immediate) {
      step();
    } else {
      followScrollFrameRef.current = window.requestAnimationFrame(step);
    }
  }, [cancelFollowScroll, getMessageTopWithinScroller, settleProgrammaticScroll]);

  const handleUserScrollIntent = useCallback(() => {
    cancelFollowScroll();
    clearProgrammaticScroll();
    stickToBottomRef.current = false;
    anchoredMessageKeyRef.current = null;
    if (isStreaming || creating || pendingUserInputs.length > 0) {
      setShowJumpToLatest(true);
    }
  }, [cancelFollowScroll, clearProgrammaticScroll, creating, isStreaming, pendingUserInputs.length]);

  const handleJumpToLatest = useCallback(() => {
    scrollToLatest({ force: true });
  }, [scrollToLatest]);

  useEffect(() => () => {
    cancelFollowScroll();
    clearProgrammaticScroll();
  }, [cancelFollowScroll, clearProgrammaticScroll]);


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
    setForkError(null);
    setUndoError(null);
    setUndoingEventId(null);
    setLoadMoreError(null);

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
      setShowRefreshingTailSkeleton(false);
      tailSkeletonRefreshEligibleRef.current = false;
      setWarming(false);
      setCreating(false);
      setLoadingMore(false);
      setHasMore(false);
      setLoadMoreError(null);
      setShowJumpToLatest(false);
      setMcpStatus([]);
      setManualMcpOverride(null);
      cancelFollowScroll();
      clearProgrammaticScroll();
      anchoredMessageKeyRef.current = null;
      latestMessageAnchorKeyRef.current = null;
      pendingLiveAnchorCarryRef.current = false;
      messageElementRefs.current.clear();
      firstItemIndex.current = 0;
      totalEntriesRef.current = 0;
      historyLastVisibleActivityAtRef.current = undefined;
      staleTailRefreshRetryRef.current = undefined;
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
    anchoredMessageKeyRef.current = null;
    latestMessageAnchorKeyRef.current = null;
    pendingLiveAnchorCarryRef.current = false;
    messageElementRefs.current.clear();
    setShowJumpToLatest(false);
    cancelFollowScroll();
    clearProgrammaticScroll();

    const controller = new AbortController();

    const loadAndReconnect = ({ background = false, replace = false }: { background?: boolean; replace?: boolean } = {}) => {
      const requestId = ++loadRequestIdRef.current;
      if (background) {
        refreshingHistoryRef.current = true;
        setRefreshingHistory(true);
      } else {
        refreshingHistoryRef.current = false;
        setLoading(true);
        setRefreshingHistory(false);
        setShowRefreshingTailSkeleton(false);
        tailSkeletonRefreshEligibleRef.current = false;
        setWarming(false);
      }
      const pageLoadStart = performance.now();

      // Phase 1: Fast load messages from disk — don't wait for MCP status
      fetchMessagesFast(sessionId, { limit: INITIAL_PAGE_SIZE })
        .then(({ messages: msgs, busy, total, warm, lastVisibleActivityAt }) => {
          if (controller.signal.aborted) return;
          if (requestId !== loadRequestIdRef.current) {
            return;
          }
          const shouldReplaceLoadedWindow = !background
            || (replace && !(busy && hasClientGeneratedEntries(entriesRef.current)));
          if (shouldReplaceLoadedWindow) {
            staleTailRefreshRetryRef.current = undefined;
            if (!background) tailSkeletonRefreshEligibleRef.current = false;
            const nextFirstItemIndex = Math.max(0, total - msgs.length);
            const activeActivityAt = activeSessionActivityAtRef.current;
            const responseCoversActiveActivity = activityTimestampCovers(
              lastVisibleActivityAt,
              activeActivityAt,
            );
            const responseHasKnownActiveCoverage = !!activeActivityAt && responseCoversActiveActivity;
            applyHistory(msgs, {
              ownerSessionId: sessionId,
              firstItemIndex: nextFirstItemIndex,
              total,
              hasMore: nextFirstItemIndex > 0,
              isCanonical: responseHasKnownActiveCoverage,
              lastVisibleActivityAt: lastVisibleActivityAt ?? null,
            });
          } else {
            const merged = mergeTailMessages(entriesRef.current, firstItemIndex.current, total, msgs);
            const activeActivityAt = activeSessionActivityAtRef.current;
            const responseCoversActiveActivity = activityTimestampCovers(
              lastVisibleActivityAt,
              activeActivityAt,
            );
            const isCanonical = !merged.hasOptimisticTail
              && !merged.hasClientGeneratedEntries
              && !!activeActivityAt
              && responseCoversActiveActivity;
            applyHistory(merged.entries, {
              ownerSessionId: sessionId,
              firstItemIndex: merged.firstItemIndex,
              total: merged.total,
              hasMore: merged.firstItemIndex > 0,
              isCanonical,
              lastVisibleActivityAt: lastVisibleActivityAt ?? null,
            });
            if (responseCoversActiveActivity) {
              staleTailRefreshRetryRef.current = undefined;
            } else if (activeActivityAt && staleTailRefreshRetryRef.current !== activeActivityAt) {
              staleTailRefreshRetryRef.current = activeActivityAt;
              setLoading(false);
              setShowRefreshingTailSkeleton(
                tailSkeletonRefreshEligibleRef.current
                  && entriesRef.current.length > 0
                  && isNewerActivityTimestamp(activeActivityAt, historyLastVisibleActivityAtRef.current),
              );
              loadAndReconnect({ background: true });
              return;
            }
          }
          setLoading(false);
          refreshingHistoryRef.current = false;
          setRefreshingHistory(false);
          setShowRefreshingTailSkeleton(false);
          tailSkeletonRefreshEligibleRef.current = false;

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
          if (controller.signal.aborted) return;
          if (requestId !== loadRequestIdRef.current) {
            return;
          }
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
          setShowRefreshingTailSkeleton(false);
          tailSkeletonRefreshEligibleRef.current = false;
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
    setShowRefreshingTailSkeleton(false);
    staleTailRefreshRetryRef.current = undefined;
    tailSkeletonRefreshEligibleRef.current = false;
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
        lastVisibleActivityAt: cachedSnapshot.lastVisibleActivityAt,
      });
      setLoading(false);
      setRefreshingHistory(false);
      setWarming(false);
      tailSkeletonRefreshEligibleRef.current = cachedSnapshot.entries.length > 0;
      setShowRefreshingTailSkeleton(
        cachedSnapshot.entries.length > 0
          && isNewerActivityTimestamp(activeSessionActivityAtRef.current, cachedSnapshot.lastVisibleActivityAt),
      );
      loadAndReconnect({ background: true });
    } else {
      applyHistory([], {
        ownerSessionId: null,
        firstItemIndex: 0,
        total: 0,
        hasMore: false,
        isCanonical: false,
      });
      setShowRefreshingTailSkeleton(false);
      tailSkeletonRefreshEligibleRef.current = false;
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
      setShowRefreshingTailSkeleton(false);
      tailSkeletonRefreshEligibleRef.current = false;
      loadAndReconnectRef.current = () => {};
      clearPendingAutoLoad();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cancelFollowScroll, clearPendingAutoLoad, clearProgrammaticScroll, composerKey, reconnect, sessionId, applyHistory, queryClient]);

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

  const prevHistorySignalRef = useRef(historySignal);
  useEffect(() => {
    prevHistorySignalRef.current = historySignal;
  }, [sessionId]);
  useEffect(() => {
    const prev = prevHistorySignalRef.current;
    if (!sessionId || historySignal === prev) return;
    prevHistorySignalRef.current = historySignal;
    loadAndReconnectRef.current({ background: true, replace: true });
  }, [historySignal, sessionId]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    refreshingHistoryRef.current = refreshingHistory;
  }, [refreshingHistory]);

  useLayoutEffect(() => {
    const pending = pendingRenderedReadThroughRef.current;
    if (!pending || pending.sessionId !== sessionId) return;
    pendingRenderedReadThroughRef.current = null;
    onRenderedReadThrough?.(pending.sessionId, pending.readThroughActivityAt);
  }, [entries, onRenderedReadThrough, sessionId]);

  useEffect(() => {
    if (!tailSkeletonRefreshEligibleRef.current || !refreshingHistoryRef.current || entriesRef.current.length === 0) return;
    if (isNewerActivityTimestamp(activeSessionActivityAt, historyLastVisibleActivityAtRef.current)) {
      setShowRefreshingTailSkeleton(true);
    }
  }, [activeSessionActivityAt]);

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

    // Otherwise auto-scroll to bottom for initial load and ordinary appends.
    // When a message is top-anchored, message-key changes handle the next scroll.
    if (stickToBottomRef.current && !anchoredMessageKeyRef.current) {
      scrollToLatest({ immediate: true });
    }
  }, [entries, scrollToLatest]);

  const loadOlderMessages = useCallback((opts: {
    limit?: number;
    preserveScrollPosition?: boolean;
  } = {}) => {
    if (!sessionId || !hasMore || loadingMoreRef.current) return;
    const { limit = INITIAL_PAGE_SIZE, preserveScrollPosition = true } = opts;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    const beforeIndex = firstItemIndex.current;
    const requestSessionId = sessionId;
    fetchMessagesFast(sessionId, { limit, before: beforeIndex })
      .then(({ messages: older, hasMore: more, total, lastVisibleActivityAt }) => {
        if (sessionIdRef.current !== requestSessionId || firstItemIndex.current !== beforeIndex) return;
        const currentEntries = entriesRef.current;
        if (older.length > 0) {
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
          const reachesLatestTail = nextFirstItemIndex + nextEntries.length >= total;
          const hasOptimisticEntries = hasOptimisticTail(nextFirstItemIndex, nextEntries.length, total);
          const hasClientEntries = hasClientGeneratedEntries(nextEntries);
          const loadedTailActivityAt = historyLastVisibleActivityAtRef.current;
          const activeActivityAt = activeSessionActivityAtRef.current;
          const loadedTailMatchesKnownActivity = activityTimestampCovers(
            loadedTailActivityAt,
            activeActivityAt,
          ) && activityTimestampCovers(loadedTailActivityAt, lastVisibleActivityAt);
          const isCanonical = reachesLatestTail && !!activeActivityAt && loadedTailMatchesKnownActivity
            && !hasOptimisticEntries && !hasClientEntries;
          if (isCanonical) invalidateHistoryRefresh();
          applyHistory(nextEntries, {
            ownerSessionId: requestSessionId,
            firstItemIndex: nextFirstItemIndex,
            total: Math.max(total, nextFirstItemIndex + nextEntries.length),
            hasMore: more,
            isCanonical,
            ...(isCanonical ? { lastVisibleActivityAt: loadedTailActivityAt ?? lastVisibleActivityAt } : {}),
          });
        } else if (!more) {
          const nextEntries = normalizeCommittedClientEntries(currentEntries, 0, total);
          const reachesLatestTail = nextEntries.length >= total;
          const hasOptimisticEntries = hasOptimisticTail(0, nextEntries.length, total);
          const hasClientEntries = hasClientGeneratedEntries(nextEntries);
          const loadedTailActivityAt = historyLastVisibleActivityAtRef.current;
          const activeActivityAt = activeSessionActivityAtRef.current;
          const loadedTailMatchesKnownActivity = activityTimestampCovers(
            loadedTailActivityAt,
            activeActivityAt,
          ) && activityTimestampCovers(loadedTailActivityAt, lastVisibleActivityAt);
          const isCanonical = reachesLatestTail && !!activeActivityAt && loadedTailMatchesKnownActivity
            && !hasOptimisticEntries && !hasClientEntries;
          applyHistory(nextEntries, {
            ownerSessionId: requestSessionId,
            firstItemIndex: 0,
            total: Math.max(total, nextEntries.length),
            hasMore: false,
            isCanonical,
            ...(isCanonical ? { lastVisibleActivityAt: loadedTailActivityAt ?? lastVisibleActivityAt } : {}),
          });
        }
      })
      .catch((err) => {
        if (sessionIdRef.current !== requestSessionId || firstItemIndex.current !== beforeIndex) return;
        console.error("Failed to load older messages:", err);
        setLoadMoreError(`Could not load older messages: ${getErrorMessage(err)}`);
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [sessionId, hasMore, invalidateHistoryRefresh, applyHistory]);

  const handleLoadMoreClick = useCallback(() => {
    clearPendingAutoLoad();
    suppressAutoLoadRef.current = true;
    autoLoadArmedRef.current = false;
    handleUserScrollIntent();
    loadOlderMessages({ limit: MANUAL_LOAD_PAGE_SIZE, preserveScrollPosition: false });
  }, [clearPendingAutoLoad, handleUserScrollIntent, loadOlderMessages]);

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
    if (programmaticScrollRef.current) return;

    const following = getDistanceFromBottom(el) <= FOLLOW_BOTTOM_THRESHOLD_PX;
    stickToBottomRef.current = following;
    anchoredMessageKeyRef.current = null;
    if (following) {
      setShowJumpToLatest(false);
    } else if (isStreaming || creating || pendingUserInputs.length > 0) {
      setShowJumpToLatest(true);
    }

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
  }, [clearPendingAutoLoad, creating, isStreaming, pendingUserInputs.length, scheduleAutoLoad]);

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

  const handleSend = useCallback(async (prompt: string, attachments?: Attachment[], mode?: SendMode) => {
    if (loading) {
      queuedSendRef.current = { sessionId, composerKey, prompt, attachments, mode };
      return;
    }
    if (creating || (isStreaming && !sessionId)) return;

    // Draft mode: create session on first message
    if (!sessionId && onCreateAndSend) {
      const draftMode = mode ?? DEFAULT_SEND_MODE;
      setCreating(true);
      applyHistory([{ role: "user", content: prompt, id: `draft-user-0`, ...(attachments?.length ? { attachments } : {}) }], {
        ownerSessionId: null,
        firstItemIndex: 0,
        total: 1,
        hasMore: false,
        isCanonical: false,
      });
      try {
        await onCreateAndSend(prompt, attachments, draftMode);
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
      const messageMode = isStreaming ? undefined : (mode ?? DEFAULT_SEND_MODE);
      if (messageMode) {
        await sendMessage(prompt, attachments, messageMode);
      } else {
        await sendMessage(prompt, attachments);
      }
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
    if (loading || creating || (isStreaming && !queuedSend.sessionId)) return;
    if (queuedSend.sessionId !== sessionId || queuedSend.composerKey !== composerKey) {
      queuedSendRef.current = null;
      return;
    }
    queuedSendRef.current = null;
    void handleSend(queuedSend.prompt, queuedSend.attachments, queuedSend.mode);
  }, [composerKey, creating, handleSend, isStreaming, loading, sessionId]);

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
  const displayedStreamingContent = useThrottledText(streamingContent, STREAM_RENDER_INTERVAL_MS);
  const hasStreamingText = displayedStreamingContent.trim().length > 0;
  const historicalEntries = useMemo(() => {
    if ((!isStreaming && !creating) || liveToolCallIds.size === 0) return entries;
    return entries.filter((entry) => (
      entry.type !== "tool"
      || !entry.toolCall
      || !liveToolCallIds.has(entry.toolCall.toolCallId)
    ));
  }, [creating, entries, isStreaming, liveToolCallIds]);
  const liveEntries = useMemo<ChatEntry[]>(() => {
    const nextEntries: ChatEntry[] = liveToolCalls.map((tool, index) => ({
      id: `live-tool-${tool.toolCallId}-${index}`,
      type: "tool",
      turnId: tool.turnId,
      toolCall: tool,
      liveSource: "snapshot",
    }));
    if (isStreaming && hasStreamingText) {
      nextEntries.push({
        id: LIVE_STREAMING_MESSAGE_ID,
        type: "message",
        role: "assistant",
        content: displayedStreamingContent,
        turnId: liveToolCalls.find((tool) => tool.turnId)?.turnId,
      });
    }
    return nextEntries;
  }, [displayedStreamingContent, hasStreamingText, isStreaming, liveToolCalls]);
  const displayEntries = useMemo(
    () => liveEntries.length > 0 ? [...historicalEntries, ...liveEntries] : historicalEntries,
    [historicalEntries, liveEntries],
  );
  const messageAnchorKeys = useMemo(() => {
    const keys = new WeakMap<object, string>();
    displayEntries.forEach((entry, index) => {
      if (isChatMessageEntry(entry)) {
        keys.set(entry, getMessageAnchorKey(entry, index));
      }
    });
    return keys;
  }, [displayEntries]);
  const latestMessageAnchorKey = useMemo(
    () => getLatestMessageAnchorKey(displayEntries),
    [displayEntries],
  );
  const latestMessageRole = useMemo(
    () => getLatestMessageRole(displayEntries),
    [displayEntries],
  );
  const toolEntries = useMemo(
    () => displayEntries.flatMap((entry) => entry.type === "tool" && entry.toolCall ? [entry.toolCall] : []),
    [displayEntries],
  );
  const toolForest = useMemo(() => buildToolCallForest(toolEntries), [toolEntries]);
  const activeToolForest = useMemo(() => buildToolCallForest(activeToolCalls), [activeToolCalls]);
  const activeRootNodes = useMemo(() => getActiveToolCallRoots(activeToolForest.roots), [activeToolForest.roots]);
  const runHeaderState = useMemo(() => deriveLiveRunHeaderState({
    creating,
    isStreaming,
    streamStatus,
    pendingOrigin,
    runMode,
    streamingContent,
    activeTrackCount: activeRootNodes.length,
    intentText,
    hadVisibleOutput,
  }), [creating, isStreaming, streamStatus, pendingOrigin, runMode, streamingContent, activeRootNodes.length, intentText, hadVisibleOutput]);

  useLayoutEffect(() => {
    const previousMessageKey = latestMessageAnchorKeyRef.current;
    if (previousMessageKey === latestMessageAnchorKey) return;

    const wasAnchored = Boolean(previousMessageKey && anchoredMessageKeyRef.current === previousMessageKey);
    const isLiveMessageReplacement = previousMessageKey === LIVE_STREAMING_MESSAGE_ID
      && latestMessageAnchorKey !== null;
    latestMessageAnchorKeyRef.current = latestMessageAnchorKey;

    if (!latestMessageAnchorKey) {
      anchoredMessageKeyRef.current = null;
      pendingLiveAnchorCarryRef.current = false;
      return;
    }

    if (isLiveMessageReplacement) {
      if (wasAnchored && latestMessageRole === "assistant") {
        anchoredMessageKeyRef.current = latestMessageAnchorKey;
        pendingLiveAnchorCarryRef.current = false;
      } else if (wasAnchored) {
        anchoredMessageKeyRef.current = null;
        pendingLiveAnchorCarryRef.current = true;
      }
      return;
    }

    if (pendingLiveAnchorCarryRef.current && latestMessageRole === "assistant") {
      anchoredMessageKeyRef.current = latestMessageAnchorKey;
      pendingLiveAnchorCarryRef.current = false;
      return;
    }

    pendingLiveAnchorCarryRef.current = false;
    anchoredMessageKeyRef.current = null;
    if (previousMessageKey && stickToBottomRef.current) {
      scrollToLatest({ anchorKey: latestMessageAnchorKey });
    }
  }, [latestMessageAnchorKey, latestMessageRole, scrollToLatest]);

  // Auto-scroll during streaming until the newest message itself reaches the viewport top.
  useEffect(() => {
    if (!isStreaming && !creating && !hasPendingUserInputs) return;
    if (latestMessageAnchorKey && anchoredMessageKeyRef.current === latestMessageAnchorKey) return;
    scrollToLatest({ anchorKey: latestMessageAnchorKey });
  }, [
    creating,
    currentTurnTools,
    displayedStreamingContent,
    hasPendingUserInputs,
    isStreaming,
    latestMessageAnchorKey,
    liveEntries.length,
    pendingUserInputRequests.length,
    runHeaderState?.phase,
    scrollToLatest,
  ]);

  // Build lightweight pending-only UI. Live tools and assistant text render in the normal chat flow.
  const pendingContent = useMemo(() => {
    const parts: React.ReactNode[] = [];
    const showStatusPill = runHeaderState && !hasStreamingText && activeRootNodes.length === 0;

    if (showStatusPill) {
      parts.push(
        renderLiveStatusPill(
          "run-header",
          runHeaderState.tone,
          runHeaderState.title,
          runHeaderState.detail,
        ),
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
    return <div className="space-y-3 pb-4">{parts}</div>;
  }, [activeRootNodes.length, handleSubmitUserInput, hasStreamingText, pendingUserInputRequests, runHeaderState]);

  const isDraft = !sessionId && !!onCreateAndSend;
  const composerDisabled = newWorkDisabled || warming || loading || Boolean(undoingEventId);
  const composerDisabledHint = newWorkDisabled
    ? newWorkDisabledHint
    : loading
      ? "Loading history…"
      : warming
        ? "Reconnecting…"
        : undoingEventId
          ? "Undoing chat history…"
          : undefined;
  const forkFromHereDisabled = loading
    || isStreaming
    || creating
    || warming
    || refreshingHistory
    || Boolean(undoingEventId);
  const handleForkFromHere = useCallback(async (message: ChatMessage) => {
    if (!sessionId || !onForkSession || !message.forkBoundaryEventId) return;
    setForkError(null);
    setForkingBoundaryEventId(message.forkBoundaryEventId);
    try {
      await onForkSession(sessionId, { toEventId: message.forkBoundaryEventId });
    } catch (err) {
      console.error("Failed to fork session from message:", err);
      setForkError(`Fork failed: ${getErrorMessage(err)}`);
    } finally {
      setForkingBoundaryEventId((current) =>
        current === message.forkBoundaryEventId ? null : current,
      );
    }
  }, [onForkSession, sessionId]);

  const closeMessageMenu = useCallback(() => {
    closeMenu();
    setMessageMenuTarget(null);
  }, [closeMenu]);

  const openMessageActionsMenu = useCallback((x: number, y: number, key: string, message: ChatMessage) => {
    setMessageMenuTarget({ key, message });
    openMessageMenu(x, y, key);
  }, [openMessageMenu]);

  const handleCopySpecificMessage = useCallback((key: string, message: ChatMessage) => {
    void writeClipboardText(message.content).then(() => {
      setCopiedMessageKey(key);
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = setTimeout(() => {
        setCopiedMessageKey((current) => (current === key ? null : current));
      }, 1_800);
    }).catch((err) => {
      console.error("Failed to copy message:", err);
    });
  }, []);

  const handleCopyMessage = useCallback(() => {
    const target = messageMenuTarget;
    if (!target) return;
    closeMessageMenu();
    handleCopySpecificMessage(target.key, target.message);
  }, [closeMessageMenu, handleCopySpecificMessage, messageMenuTarget]);

  const handleForkMessageMenu = useCallback(() => {
    const target = messageMenuTarget;
    if (!target) return;
    closeMessageMenu();
    void handleForkFromHere(target.message);
  }, [closeMessageMenu, handleForkFromHere, messageMenuTarget]);

  const handleUndoFromHere = useCallback(async (message: ChatMessage) => {
    if (!sessionId || !message.undoEventId) return;
    const confirmed = window.confirm(
      "Undo this turn and every later turn?\n\n"
      + "This removes chat history from this point. It does not reverse files, commands, tasks, docs, browser actions, or other external side effects.",
    );
    if (!confirmed) return;

    const targetSessionId = sessionId;
    const undoEventId = message.undoEventId;
    setUndoError(null);
    setUndoingEventId(undoEventId);
    try {
      await undoSessionTurn(targetSessionId, undoEventId);
      if (sessionIdRef.current !== targetSessionId) return;
      const boundaryIndex = entriesRef.current.findIndex(
        (entry) => isChatMessageEntry(entry) && entry.undoEventId === undoEventId,
      );
      if (boundaryIndex >= 0) {
        const nextEntries = entriesRef.current.slice(0, boundaryIndex);
        applyHistory(nextEntries, {
          total: firstItemIndex.current + nextEntries.length,
          hasMore: firstItemIndex.current > 0,
          isCanonical: false,
          lastVisibleActivityAt: getLatestEntryActivityTimestamp(nextEntries) ?? null,
        });
      }
      loadAndReconnectRef.current({ background: true, replace: true });
    } catch (error) {
      console.error("Failed to undo chat turn:", error);
      setUndoError(`Undo failed: ${getErrorMessage(error)}`);
    } finally {
      setUndoingEventId((current) => current === undoEventId ? null : current);
    }
  }, [applyHistory, sessionId]);

  const handleUndoMessageMenu = useCallback(() => {
    const target = messageMenuTarget;
    if (!target) return;
    closeMessageMenu();
    void handleUndoFromHere(target.message);
  }, [closeMessageMenu, handleUndoFromHere, messageMenuTarget]);

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
    const segments = segmentChatEntries(displayEntries);

    segments.forEach((segment, index) => {
      if (segment.type === "tool-segment") {
        const roots = buildRenderableSegmentRoots(segment.entries, toolForest);
        if (roots.length === 0) return;
        const segmentKey = segment.turnId
          ? `tool-turn-${segment.turnId}`
          : segment.entries[0]?.id ?? `tool-segment-${index}`;
        result.push(
          <div key={segmentKey} className={`${CHAT_RAIL_CLASS} pt-2`}>
            <ToolCallNodeGroup
              nodes={roots}
              defaultExpanded={roots.some((node) => node.children.length > 0)}
              activeToolCallIds={activeToolCallIds}
            />
          </div>,
        );
        return;
      }

      if (segment.type === "visual-segment") {
        const { entry } = segment;
        result.push(
          <div key={entry.id ?? `visual-${index}`} className={`${CHAT_RAIL_CLASS} pt-3`}>
            <VisualArtifactCard visual={entry.visual} />
          </div>,
        );
        return;
      }

      if (segment.type === "skill-segment") {
        const { entry } = segment;
        result.push(
          <div key={entry.id ?? `skill-${index}`} className={`${CHAT_RAIL_CLASS} pt-3`}>
            <SkillLoadedCard entry={entry} />
          </div>,
        );
        return;
      }

      if (segment.type === "completion-segment") {
        const { entry } = segment;
        result.push(
          <div key={entry.id ?? `completion-${index}`} className={`${CHAT_RAIL_CLASS} pt-3`}>
            <CompletionCard entry={entry} />
          </div>,
        );
        return;
      }

      const msg = segment.entry as ChatMessage;
      const messageKey = msg.id ?? msg.turnId ?? `${msg.role}-${index}`;
      const messageAnchorKey = messageAnchorKeys.get(msg) ?? getMessageAnchorKey(msg, index);
      const isLiveStreamingMessage = msg.id === LIVE_STREAMING_MESSAGE_ID;
      const menuBindings = isLiveStreamingMessage ? null : bindMessageMenu(messageKey, () => {});
      const isLongPressTarget = !isLiveStreamingMessage && isMessageLongPressTarget(messageKey);
      const actionSlot = isLiveStreamingMessage ? undefined : (
        <MessageActionToolbar
          messageKey={messageKey}
          message={msg}
          copied={copiedMessageKey === messageKey}
          onCopy={handleCopySpecificMessage}
          onOpenMenu={openMessageActionsMenu}
        />
      );
      result.push(
        <div
          key={messageKey}
          ref={(node) => {
            if (node) {
              messageElementRefs.current.set(messageAnchorKey, node);
            } else {
              messageElementRefs.current.delete(messageAnchorKey);
            }
          }}
          data-chat-message-key={messageAnchorKey}
          data-latest-chat-message={messageAnchorKey === latestMessageAnchorKey ? "true" : undefined}
          className={`${CHAT_RAIL_CLASS} relative pt-4 transition-colors ${
            isLongPressTarget ? "bg-accent/5" : ""
          }`}
          onClick={menuBindings?.onClick}
          onTouchStart={(event) => {
            if (!menuBindings) return;
            setMessageMenuTarget({ key: messageKey, message: msg });
            menuBindings.onTouchStart(event);
          }}
          onTouchMove={menuBindings?.onTouchMove}
          onTouchEnd={menuBindings?.onTouchEnd}
          onTouchCancel={menuBindings?.onTouchCancel}
        >
          <MessageBubble message={msg} actionSlot={actionSlot} isStreaming={isLiveStreamingMessage} />
        </div>,
      );
    });

    return result;
  }, [
    bindMessageMenu,
    copiedMessageKey,
    displayEntries,
    latestMessageAnchorKey,
    messageAnchorKeys,
    activeToolCallIds,
    handleCopySpecificMessage,
    isMessageLongPressTarget,
    openMessageActionsMenu,
    toolForest,
  ]);

  const messageMenuForkBoundary = messageMenuTarget?.message.role === "assistant"
    ? messageMenuTarget.message.forkBoundaryEventId
    : undefined;
  const messageMenuForkLoading = Boolean(
    messageMenuForkBoundary && forkingBoundaryEventId === messageMenuForkBoundary,
  );
  const messageMenuUndoBoundary = messageMenuTarget?.message.undoEventId;
  const messageMenuUndoLoading = Boolean(
    messageMenuUndoBoundary && undoingEventId === messageMenuUndoBoundary,
  );

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
      <McpStatusBar
        chatEntries={displayEntries}
        context={sessionContext}
        contextError={sessionContextError}
        contextLoading={sessionContextLoading}
        liveContextSummary={streamContextSummary}
        servers={effectiveMcpServers}
        onAuthenticate={sessionId ? handleMcpAuthenticate : undefined}
        onRefresh={sessionId ? refreshMcpStatus : undefined}
      />
      <SessionAgentsBar sessionId={sessionId} backgroundAgents={backgroundAgents} />
      {loading && entries.length === 0 ? (
        <LoadingSkeletonRegion
          isLoading
          label="Loading chat history"
          className="flex-1 flex items-end overflow-hidden pb-6"
        >
          <div className={`${CHAT_RAIL_CLASS} space-y-4`}>
            <div className="max-w-lg rounded-2xl border border-border bg-bg-secondary px-4 py-3">
              <SkeletonText lines={3} widths={["88%", "72%", "46%"]} />
            </div>
            <div className="ml-auto max-w-md rounded-2xl border border-accent-border bg-accent-surface px-4 py-3">
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
          onWheel={handleUserScrollIntent}
          onTouchMove={handleUserScrollIntent}
        >
          {refreshingHistory && (
            <div className="sticky top-0 z-10 flex justify-center px-3 pt-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/95 px-3 py-1 text-xs text-text-muted shadow-sm backdrop-blur-sm">
                <Loader2 size={12} className="animate-spin text-accent/70" />
                Refreshing history...
              </div>
            </div>
          )}
          {loadMoreError && (
            <div className="px-3 py-2 text-center text-xs text-error" role="alert">
              {loadMoreError}
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
          {renderRefreshingHistoryTailSkeleton(showRefreshingTailSkeleton)}
          {pendingContent && <div className="pt-4">{pendingContent}</div>}
          {showJumpToLatest && (
            <div className="sticky bottom-3 z-20 flex justify-center px-3 pointer-events-none">
              <button
                type="button"
                aria-label="Jump to latest"
                onClick={handleJumpToLatest}
                className="pointer-events-auto rounded-full border border-border bg-bg-secondary/95 px-3 py-1.5 text-xs font-medium text-text-secondary shadow-sm backdrop-blur transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                Jump to latest
              </button>
            </div>
          )}
          <div aria-hidden="true" className="h-4" />
        </div>
      )}
      {messageMenu && messageMenuTarget && (
        <MessageActionsMenu
          position={messageMenu}
          target={messageMenuTarget}
          copied={copiedMessageKey === messageMenuTarget.key}
          forkLoading={messageMenuForkLoading}
          forkDisabled={forkFromHereDisabled}
          undoLoading={messageMenuUndoLoading}
          undoDisabled={forkFromHereDisabled}
          onClose={closeMessageMenu}
          onCopy={handleCopyMessage}
          onFork={handleForkMessageMenu}
          onUndo={handleUndoMessageMenu}
        />
      )}
      {forkError && (
        <div className={`${CHAT_RAIL_CLASS} pb-2`}>
          <div
            className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs text-error"
            role="alert"
          >
            {forkError}
          </div>
        </div>
      )}
      {undoError && (
        <div className={`${CHAT_RAIL_CLASS} pb-2`}>
          <div
            className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs text-error"
            role="alert"
          >
            {undoError}
          </div>
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
        onRetryVoiceJobUpload={onRetryVoiceJobUpload}
        disabled={composerDisabled}
        disabledHint={composerDisabledHint}
        slashCommands={slashCommands}
        slashCommandsSupported={slashCommandsSupported}
      />
      {/* Plan sheet overlay */}
      {showPlan && sessionId && (
        <PlanSheet
          sessionId={sessionId}
          onClose={planOverlay.close}
        />
      )}
    </div>
  );
}
