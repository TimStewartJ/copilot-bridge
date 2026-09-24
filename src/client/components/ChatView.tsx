import UserInputQuestionCard from "./UserInputQuestionCard";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  fetchSlashCommands,
  fetchMessagesFast,
  searchBridge,
  warmSession,
  ApiError,
  loginMcpServer,
  fetchSessionContext,
  reportTiming,
  submitElicitationResponse,
  submitUserInputResponse,
  undoSessionTurn,
  type Attachment,
  type AgentInstruction,
  type BackgroundAgentsSummary,
  type ChatEntry,
  type ChatMessage,
  type ChatMessageAcceptedResponse,
  type ChatMessageDelivery,
  type ChatVisualEntry,
  type ElicitationResponseEndpointPayload,
  type PendingElicitationRequestView,
  type PendingUserInputRequestView,
  type SlashCommandInfo,
  type ToolCall,
  type UserInputAnswerEndpointPayload,
} from "../api";
import { getCachedChatSnapshot, replaceHistoryWindow, setCachedChatSnapshot } from "../chat-cache";
import { timeAgo } from "../time";
import type { VoiceBackgroundJob } from "../hooks/useBackgroundVoiceJobs";
import { writeClipboardText } from "../lib/clipboard";
import { getAppAbsoluteUrl } from "../lib/app-url";
import { textMatchesSearchQuery } from "../lib/search-text";
import { deriveLiveRunHeaderState } from "../lib/live-run-phase";
import { resolveExternalSessionWorkAction } from "../lib/external-session-work";
import { buildToolCallForest, getActiveToolCallRoots, segmentChatEntries } from "../lib/tool-call-tree";
import { groupActivitySegments } from "../lib/chat-activity";
import type { VoiceSubmitMode } from "../lib/voice-submit-mode";
import { useSessionStream, type LiveReasoningBlock } from "../useSessionStream";
import { useOverlayParam } from "../hooks/useOverlayParam";
import { holdPageReload } from "../lib/voice-capture-guard";
import { useMcpStatusSnapshotQuery } from "../hooks/queries/useMcpStatus";
import { useSessionUsageMetricsQuery } from "../hooks/queries/useSessionUsageMetrics";
import useLongPressMenu from "../hooks/useLongPressMenu";
import { queryKeys } from "../queryClient";
import type { Draft } from "../useDrafts";
import { DEFAULT_SEND_MODE, type SendMode } from "../../shared/send-mode.js";
import type { SessionContextResponse } from "../../shared/session-context.js";
import type { RunNotice } from "../../shared/session-stream.js";
import type { BridgeSearchResponse } from "../../shared/search.js";
import MessageBubble from "./MessageBubble";
import CompletionCard from "./CompletionCard";
import ElicitationCard from "./ElicitationCard";
import ElicitationCancellationNotice from "./ElicitationCancellationNotice";
import {
  MessageActionsMenu,
  MessageActionToolbar,
  type MessageActionMenuTarget,
} from "./MessageActions";
import VisualArtifactCard from "./VisualArtifactCard";
import SkillLoadedCard from "./SkillLoadedCard";
import AskUserRecordBlock from "./chat/AskUserRecord";
import ActivityBlock from "./chat/ActivityBlock";
import { ChatRunActiveProvider } from "./chat/chat-run-context";
import LiveStatusLine from "./chat/LiveStatusLine";
import PromptMarkdown from "./chat/PromptMarkdown";
import { DS, cx } from "../design/tokens";
import { Button, ChoiceButton, EmptyHint, Notice, Panel, TextInput } from "../design/primitives";
import ChatInput from "./ChatInput";
import PlanSheet from "./PlanSheet";
import McpStatusBar from "./McpStatusBar";
import SessionAgentsBar from "./SessionAgentsBar";
import { ArrowDown, ArrowLeft, Check, CircleAlert, CircleSlash, ClipboardList, Copy, Loader2, Terminal } from "lucide-react";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";
import { prefersReducedMotion } from "../lib/motion";

const INITIAL_PAGE_SIZE = 50;
const MANUAL_LOAD_PAGE_SIZE = 200;
const AUTO_LOAD_TOP_THRESHOLD = 24;
const AUTO_LOAD_DELAY_MS = 400;
const STREAM_RENDER_INTERVAL_MS = 60;
/**
 * Minimum spacing between disk-history refreshes driven by `history_advanced`. The first advance
 * after an idle gap refreshes immediately (leading edge); further advances inside the window
 * coalesce into one trailing refresh, so a burst of tool events cannot storm the reader.
 */
const HISTORY_REFRESH_THROTTLE_MS = 250;
/** Upper bound on entries re-read when refreshing a paginated window. */
const HISTORY_REFRESH_MAX_LIMIT = 200;
/**
 * Cached history paints instantly, so a sync that lands inside this window never shows an
 * indicator; anything slower gets a clear, full-width strip instead of a flash.
 */
const HISTORY_SYNC_INDICATOR_DELAY_MS = 150;
const LIVE_STREAMING_MESSAGE_ID = "live-assistant-stream";
/** How long attaching to a run's stream may take before the status line calls it reconnecting. */
const RECONNECT_LABEL_DELAY_MS = 600;
/** How long a pause after visible output must last before the status line appears under it. */
const MID_RUN_STATUS_DELAY_MS = 350;
/**
 * The chat column width from which a reply's hover actions fit in the margin beside the text: the
 * 56rem rail plus room on its right for the control. It is measured on the column itself because
 * the task rail and side panels change it independently of the viewport.
 */
const ACTION_GUTTER_MIN_COLUMN_PX = 1024;
const FOLLOW_BOTTOM_THRESHOLD_PX = 96;
const FOLLOW_SCROLL_EASE = 0.35;
const FOLLOW_SCROLL_SETTLE_PX = 1.5;
const LATEST_MESSAGE_TOP_THRESHOLD_PX = 8;
const CHAT_RAIL_CLASS = DS.layout.readingColumn;
const SEARCH_MATCH_PAGE_SIZE = 20;

interface ChatViewProps {
  composerKey: string;
  sessionId: string | null;
  hasPlan?: boolean;
  sessionModelSummary?: ReactNode;
  onMessageSent: () => void;
  draft?: Draft | null;
  onDraftChange?: (text: string, attachments?: Attachment[]) => void;
  onDraftClear?: () => void;
  onCreateAndSend?: (
    prompt: string,
    attachments?: Attachment[],
    mode?: SendMode,
    clientMessageId?: string,
  ) => Promise<void>;
  emptyState?: ReactNode;
  defaultSendMode?: SendMode;
  voiceJob?: VoiceBackgroundJob | null;
  onSubmitVoiceCapture: (capture: { composerKey: string; audio: Blob; submitMode: VoiceSubmitMode }) => Promise<void>;
  onReviewVoiceJob?: (composerKey: string) => void;
  onClearVoiceJobError?: (composerKey: string) => void;
  onRetryVoiceJobUpload?: (composerKey: string) => void;
  onDiscardVoiceRecording?: (composerKey: string) => void;
  reloadToken?: number;
  /** Incremented when an external source (e.g. schedule) starts work on this session */
  busySignal?: number;
  /** Incremented when server history was truncated and the loaded window must be replaced. */
  historySignal?: number;
  activeSessionActivityAt?: string;
  externallyInUse?: boolean;
  backgroundAgents?: BackgroundAgentsSummary;
  onForkSession?: (sessionId: string, opts?: { toEventId?: string }) => Promise<void> | void;
  onRenderedReadThrough?: (sessionId: string, readThroughActivityAt: string) => void; newWorkDisabled?: boolean; newWorkDisabledHint?: string;
  /** Rendered between the transcript and the composer (Helm's hands-free dock). */
  composerAccessory?: ReactNode;
  /** Hides the composer's record button while something else owns the microphone. */
  hideVoiceInput?: boolean;
  composerPlaceholder?: string;
  /** Incremented to move focus into the composer (desktop only). */
  composerFocusRequest?: number;
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

function getReasoningShapeKey(blocks: LiveReasoningBlock[]): string {
  return blocks
    .map((block) => `${block.id}:${block.sourceEventId ?? ""}:${block.completedAt ? "done" : "open"}`)
    .join("|");
}

/**
 * Thinking arrives a few characters at a time. A block opening, closing or being committed shows
 * at once; text that only grew is batched to the same cadence as streamed reply text.
 */
function useThrottledReasoning(blocks: LiveReasoningBlock[], intervalMs: number): LiveReasoningBlock[] {
  const [displayBlocks, setDisplayBlocks] = useState(blocks);
  const lastUpdateRef = useRef(0);
  const shapeKey = getReasoningShapeKey(blocks);
  const displayShapeKey = getReasoningShapeKey(displayBlocks);

  useEffect(() => {
    if (blocks === displayBlocks) return;
    if (shapeKey !== displayShapeKey) {
      lastUpdateRef.current = Date.now();
      setDisplayBlocks(blocks);
      return;
    }
    const sameText = blocks.every((block, index) => block.content === displayBlocks[index]?.content);
    if (sameText) return;
    const elapsed = Date.now() - lastUpdateRef.current;
    const timeout = setTimeout(() => {
      lastUpdateRef.current = Date.now();
      setDisplayBlocks(blocks);
    }, Math.max(0, intervalMs - elapsed));
    return () => clearTimeout(timeout);
  }, [blocks, displayBlocks, displayShapeKey, intervalMs, shapeKey]);

  return displayBlocks;
}

/** True only once `value` has stayed true for `delayMs`; false again immediately. */
function useSustained(value: boolean, delayMs: number): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!value) {
      setSustained(false);
      return;
    }
    const timeout = setTimeout(() => setSustained(true), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, value]);
  return value && sustained;
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

type FailedOptimisticChatMessage = ChatMessage & {
  id: string;
  delivery: ChatMessageDelivery & { failed: true };
};

/** A message this client is delivering (or failed to deliver); never part of disk history. */
interface PendingSend {
  id: string;
  content: string;
  attachments?: Attachment[];
  delivery?: ChatMessageDelivery;
}

let clientMessageIdCounter = 0;

function createClientMessageId(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoRef?.randomUUID) return `client-${cryptoRef.randomUUID()}`;
  clientMessageIdCounter += 1;
  return `client-${Date.now().toString(36)}-${clientMessageIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isFailedOptimisticChatMessage(message: ChatMessage): message is FailedOptimisticChatMessage {
  return typeof message.id === "string" && message.delivery?.failed === true;
}

function createSendingDelivery(mode?: SendMode): ChatMessageDelivery {
  return mode === undefined ? { failed: false } : { failed: false, mode };
}

function haveSameAgentInstructions(
  left: readonly AgentInstruction[] | undefined,
  right: readonly AgentInstruction[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((instruction, index) => (
    instruction.kind === right[index]?.kind
    && instruction.content === right[index]?.content
  ));
}

function isLaterTimestamp(candidate: string | undefined, baseline: string | undefined): boolean {
  if (!candidate || !baseline) return false;
  const candidateTime = Date.parse(candidate);
  const baselineTime = Date.parse(baseline);
  return Number.isFinite(candidateTime)
    && Number.isFinite(baselineTime)
    && candidateTime > baselineTime;
}


function getMessageAnchorKey(message: ChatMessage, fallbackIndex: number): string {
  if (message.id) return message.id;
  if (message.turnId) return `turn:${message.turnId}:${message.role}`;
  return `${message.role}:${fallbackIndex}`;
}

const MESSAGE_TOUCH_CONTROL_SELECTOR = "button, input, textarea, select, [contenteditable]:not([contenteditable=\"false\"]), a, img";
const MESSAGE_NATIVE_CONTEXT_SELECTOR = MESSAGE_TOUCH_CONTROL_SELECTOR;

function targetMatchesSelector(target: EventTarget | null, selector: string): boolean {
  const candidate = target as { closest?: (value: string) => unknown } | null;
  if (typeof candidate?.closest === "function") {
    return Boolean(candidate.closest(selector));
  }
  const parent = (target as { parentElement?: { closest?: (value: string) => unknown } } | null)?.parentElement;
  return typeof parent?.closest === "function" && Boolean(parent.closest(selector));
}

function browserSelectionIntersects(container: Node): boolean {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString().trim()) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(container)) return true;
    } catch {
      if (container.contains(selection.anchorNode) || container.contains(selection.focusNode)) return true;
    }
  }
  return false;
}

function shouldUseNativeMessageContextMenu(container: Node, target: EventTarget | null): boolean {
  return targetMatchesSelector(target, MESSAGE_NATIVE_CONTEXT_SELECTOR)
    || browserSelectionIntersects(container);
}

function isSameMessageTarget(
  target: MessageActionMenuTarget | null,
  message: ChatMessage,
  anchorKey: string,
): boolean {
  if (!target) return false;
  if (target.message.id || target.message.turnId) return target.key === anchorKey;
  return target.message === message;
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

function safeInternalPath(value: string | null): string | null {
  return value?.startsWith("/") && !value.startsWith("//") ? value : null;
}

function parseNonNegativeInteger(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}


function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/**
 * True when `timestamp` is at or before the newest committed entry, meaning disk already carries
 * this item even if the loaded window does not reach it. Items with no timestamp are treated as
 * uncommitted, since an accepted-but-unpersisted prompt has none yet.
 */
function isAtOrBeforeWatermark(timestamp: string | undefined, watermarkMs: number): boolean {
  if (!timestamp || !Number.isFinite(watermarkMs)) return false;
  const itemMs = Date.parse(timestamp);
  return Number.isFinite(itemMs) && itemMs <= watermarkMs;
}

function getCommittedSourceEventIds(entries: ChatEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.sourceEventId) ids.add(entry.sourceEventId);
  }
  return ids;
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


function sortPendingRequests<T extends { requestedAt?: string }>(
  requests: T[],
): T[] {
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





const RUN_NOTICE_LABELS: Record<RunNotice["kind"], string> = {
  stopped: "Stopped",
  interrupted: "Interrupted",
  error: "Run failed",
  command: "Command output",
};

/**
 * Renders a run outcome that `events.jsonl` does not contain. Keeping it outside the transcript is
 * what lets disk history stay the sole authority for committed content.
 */
function RunNoticeCard({ notice }: { notice: RunNotice }) {
  const detail = notice.kind === "error" ? notice.message : notice.content;
  const isError = notice.kind === "error";
  return (
    <div className={CHAT_RAIL_CLASS}>
      <Notice
        tone={isError ? "danger" : notice.kind === "interrupted" ? "warning" : "neutral"}
        icon={isError ? <CircleAlert size={14} /> : notice.kind === "command" ? <Terminal size={14} /> : <CircleSlash size={14} />}
        title={RUN_NOTICE_LABELS[notice.kind]}
        className="max-w-xl"
      >
        {detail && <div className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">{detail}</div>}
      </Notice>
    </div>
  );
}



export default function ChatView({
  composerKey,
  sessionId,
  hasPlan,
  sessionModelSummary,
  onMessageSent,
  draft,
  onDraftChange,
  onDraftClear,
  onCreateAndSend,
  emptyState,
  defaultSendMode = DEFAULT_SEND_MODE,
  voiceJob,
  onSubmitVoiceCapture,
  onReviewVoiceJob,
  onClearVoiceJobError,
  onRetryVoiceJobUpload,
  onDiscardVoiceRecording,
  reloadToken = 0,
  busySignal = 0,
  historySignal = 0,
  activeSessionActivityAt,
  externallyInUse = false,
  backgroundAgents,
  onForkSession,
  onRenderedReadThrough, newWorkDisabled = false, newWorkDisabledHint,
  composerAccessory,
  hideVoiceInput,
  composerPlaceholder,
  composerFocusRequest,
}: ChatViewProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [routeSearchParams] = useSearchParams();
  const targetSourceEventId = routeSearchParams.get("message");
  const historyOnlyMode = routeSearchParams.get("history") === "1";
  const searchQuery = routeSearchParams.get("search")?.trim() ?? "";
  const requestedMatchOffset = parseNonNegativeInteger(routeSearchParams.get("matchOffset"));
  const returnToSearch = safeInternalPath(routeSearchParams.get("from"));
  const historicalMode = Boolean(sessionId && (targetSourceEventId || historyOnlyMode));
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  /**
   * Client-owned optimistic sends (in flight or failed). They live outside `entries` so the
   * committed window stays purely disk-derived.
   */
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [warming, setWarming] = useState(false);
  const planOverlay = useOverlayParam("sheet");
  const showPlan = planOverlay.isOpen && planOverlay.value === "plan";
  const [creating, setCreating] = useState(false);
  const mcpStatusQuery = useMcpStatusSnapshotQuery(historicalMode ? null : sessionId);
  const sessionUsageMetricsQuery = useSessionUsageMetricsQuery(historicalMode ? null : sessionId);
  const sessionCostLoading = Boolean(
    sessionId
    && !historicalMode
    && sessionUsageMetricsQuery.isLoading
    && !sessionUsageMetricsQuery.data,
  );
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
  const [selectingMessageTarget, setSelectingMessageTarget] = useState<MessageActionMenuTarget | null>(null);
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [historicalUnavailable, setHistoricalUnavailable] = useState(false);
  const [historicalLoadError, setHistoricalLoadError] = useState<string | null>(null);
  const [historicalHasNewer, setHistoricalHasNewer] = useState(false);
  const [copiedMessageLink, setCopiedMessageLink] = useState(false);
  const [messageLinkCopyError, setMessageLinkCopyError] = useState<string | null>(null);
  const [searchMatchPage, setSearchMatchPage] = useState<{
    ids: string[];
    offset: number;
    total: number;
    coverage: BridgeSearchResponse["coverage"];
  } | null>(null);
  const [searchMatchPageLoading, setSearchMatchPageLoading] = useState(false);
  const [searchMatchPageError, setSearchMatchPageError] = useState<string | null>(null);
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

  /** Activity blocks the reader opened or closed by hand; everything else stays collapsed. */
  const [activityExpansion, setActivityExpansion] = useState<Record<string, boolean>>({});
  const liveActivityKeyRef = useRef<string | null>(null);
  /** The run state the last disk read reported; unknown until the first read of a session. */
  const [historyRunBusy, setHistoryRunBusy] = useState<boolean | null>(null);
  // Held in state, not a ref: the root only mounts once there is a session or a draft to show.
  const [chatRoot, setChatRoot] = useState<HTMLDivElement | null>(null);
  const [hasActionGutter, setHasActionGutter] = useState(false);

  useLayoutEffect(() => {
    if (!chatRoot) return;
    const measure = () => setHasActionGutter(chatRoot.clientWidth >= ACTION_GUTTER_MIN_COLUMN_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(chatRoot);
    return () => observer.disconnect();
  }, [chatRoot]);

  useEffect(() => {
    setSelectingMessageTarget(null);
    setActivityExpansion({});
    setHistoryRunBusy(null);
  }, [sessionId]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const firstItemIndex = useRef(0);
  const totalEntriesRef = useRef(0);
  const historyLastVisibleActivityAtRef = useRef<string | undefined>(undefined);
  /** When the displayed window was last read from disk; drives the "showing messages from…" hint. */
  const historyFetchedAtRef = useRef<number | null>(null);
  const entriesRef = useRef<ChatEntry[]>([]);
  const pendingSendsRef = useRef<PendingSend[]>([]);
  const historyRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followScrollFrameRef = useRef<number | null>(null);
  const resetProgrammaticScrollFrameRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const messageElementRefs = useRef(new Map<string, HTMLDivElement>());
  const sourceMessageElementRefs = useRef(new Map<string, HTMLDivElement>());
  const latestMessageAnchorKeyRef = useRef<string | null>(null);
  const anchoredMessageKeyRef = useRef<string | null>(null);
  const pendingLiveAnchorCarryRef = useRef(false);
  /** Armed on session navigation so the first painted history lands on the newest reply's top. */
  const pendingInitialAnchorRef = useRef(false);
  const pendingHistoricalAnchorRef = useRef<string | null>(null);
  /** Anchor applied by the navigation landing, released when a new run needs the live tail. */
  const loadAnchoredMessageKeyRef = useRef<string | null>(null);
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
  const loadAndReconnectRef = useRef<
    (opts?: { background?: boolean; replace?: boolean; silent?: boolean; forceReconnect?: boolean }) => Promise<void>
  >(async () => {});
  activeSessionActivityAtRef.current = activeSessionActivityAt;

  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  useEffect(() => {
    setHistoricalUnavailable(false);
    setHistoricalLoadError(null);
    setHistoricalHasNewer(false);
    setCopiedMessageLink(false);
    setMessageLinkCopyError(null);
    pendingHistoricalAnchorRef.current = targetSourceEventId;
  }, [sessionId, targetSourceEventId]);

  useEffect(() => {
    if (!historicalMode || !targetSourceEventId || !sessionId || !searchQuery) {
      setSearchMatchPage(null);
      setSearchMatchPageLoading(false);
      setSearchMatchPageError(null);
      return;
    }
    const controller = new AbortController();
    setSearchMatchPageLoading(true);
    setSearchMatchPageError(null);
    void searchBridge({
      q: searchQuery,
      scope: "session",
      sessionId,
      kind: "chat",
      limit: SEARCH_MATCH_PAGE_SIZE,
      offset: requestedMatchOffset,
    }, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      const hit = result.chats.items[0];
      setSearchMatchPage({
        ids: hit?.matches.map((match) => match.sourceEventId) ?? [],
        offset: requestedMatchOffset,
        total: hit?.matchCount ?? 0,
        coverage: result.coverage,
      });
    }, (reason: unknown) => {
      if (!controller.signal.aborted) {
        setSearchMatchPage(null);
        setSearchMatchPageError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setSearchMatchPageLoading(false);
    });
    return () => controller.abort();
  }, [historicalMode, requestedMatchOffset, searchQuery, sessionId]);

  useEffect(() => {
    setSearchMatchPage(null);
    setSearchMatchPageError(null);
  }, [historicalMode, requestedMatchOffset, searchQuery, sessionId]);

  const applyHistory = useCallback((
    nextEntries: ChatEntry[],
    opts: {
      ownerSessionId?: string | null;
      firstItemIndex?: number;
      total?: number;
      hasMore?: boolean;
      lastVisibleActivityAt?: string | null;
      /** Disk read time of `nextEntries`; defaults to now. Cached resumes pass the snapshot's. */
      fetchedAt?: number;
      persistSnapshot?: boolean;
      reportReadThrough?: boolean;
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
    pendingRenderedReadThroughRef.current = ownerSessionId && opts.reportReadThrough !== false && nextReadThrough
      ? { sessionId: ownerSessionId, readThroughActivityAt: nextReadThrough }
      : null;

    if (!ownerSessionId) {
      historyFetchedAtRef.current = null;
      return;
    }
    const fetchedAt = opts.fetchedAt ?? Date.now();
    historyFetchedAtRef.current = fetchedAt;
    if (opts.persistSnapshot === false) return;
    setCachedChatSnapshot(queryClient, {
      sessionId: ownerSessionId,
      entries: nextEntries,
      firstItemIndex: nextFirstItemIndex,
      total: nextTotal,
      hasMore: nextHasMore,
      fetchedAt,
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

  const handleStreamSettled = useCallback(() => {
    onMessageSent();
    loadAndReconnectRef.current({ background: true, replace: true, silent: true });
  }, [onMessageSent]);
  const refreshMcpObservation = useCallback(() => {
    if (!sessionId) return;
    // Runtime events are refresh hints, not a second writer of connection/readiness state.
    void queryClient.invalidateQueries(
      { queryKey: queryKeys.mcpStatus(sessionId), exact: true },
      { cancelRefetch: false },
    );
  }, [queryClient, sessionId]);

  const {
    streamingContent,
    liveAssistantSegments = [],
    liveReasoning = [],
    pendingUserMessages = [],
    intentText,
    liveTools = [],
    liveVisuals = [],
    liveCompletion,
    isStreaming,
    streamStatus,
    hadVisibleOutput,
    pendingOrigin,
    runMode,
    pendingUserInputs = [],
    pendingElicitations = [],
    elicitationCancellation,
    runNotice,
    historyEpoch,
    contextSummary: streamContextSummary,
    sendMessage,
    abortSession,
    reconnect,
    ensureConnected,
    activeTurnId,
    activeTurnInstanceId,
  } = useSessionStream(historicalMode ? null : sessionId, handleStreamSettled, onMessageSent, refreshMcpObservation);
  const pendingInteractionCount = pendingUserInputs.length + pendingElicitations.length;
  // Disk owns the committed transcript. Live items hand off by exact source-event identity: each
  // disappears from the overlay the moment its persisted entry is present in the loaded window.
  const committedSourceEventIds = useMemo(() => getCommittedSourceEventIds(entries), [entries]);
  // Identity alone is not enough: the loaded window is only a suffix of history, so an item whose
  // disk entry sits above the window would otherwise re-render at the bottom, out of order. Disk is
  // append-ordered, so its newest entry is a watermark — anything at or before it is committed.
  const committedWatermarkMs = useMemo(() => {
    const latest = getLatestEntryActivityTimestamp(entries);
    return latest ? Date.parse(latest) : Number.NaN;
  }, [entries]);
  const isCommittedByWatermark = useCallback(
    (timestamp?: string) => isAtOrBeforeWatermark(timestamp, committedWatermarkMs),
    [committedWatermarkMs],
  );
  const uncommittedUserMessages = useMemo(
    () => pendingUserMessages.filter((message) => (
      (!message.sourceEventId || !committedSourceEventIds.has(message.sourceEventId))
      && !isCommittedByWatermark(message.timestamp)
    )),
    [committedSourceEventIds, isCommittedByWatermark, pendingUserMessages],
  );
  const uncommittedAssistantSegments = useMemo(
    () => liveAssistantSegments.filter((segment) => {
      // Bridge-native text has no disk counterpart at all, so no watermark applies to it.
      if (segment.bridgeNative) return true;
      if (segment.sourceEventId && committedSourceEventIds.has(segment.sourceEventId)) return false;
      return !isCommittedByWatermark(segment.timestamp);
    }),
    [committedSourceEventIds, isCommittedByWatermark, liveAssistantSegments],
  );
  /**
   * Thinking is persisted on its turn's assistant message, so a live block hands off to the disk
   * entry that names the same message. Until then it has no timestamp to compare against the
   * watermark, which is correct: text still streaming cannot be on disk.
   */
  const committedReasoningMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.type === "reasoning" && entry.reasoning.messageEventId) {
        ids.add(entry.reasoning.messageEventId);
      }
    }
    return ids;
  }, [entries]);
  const uncommittedReasoning = useMemo(
    () => liveReasoning.filter((block) => {
      if (!block.content.trim()) return false;
      if (!block.sourceEventId) return true;
      if (committedReasoningMessageIds.has(block.sourceEventId)) return false;
      // The message that persisted this thinking is already in loaded history, or older than it.
      if (committedSourceEventIds.has(block.sourceEventId)) return false;
      return !isCommittedByWatermark(block.committedAt);
    }),
    [committedReasoningMessageIds, committedSourceEventIds, isCommittedByWatermark, liveReasoning],
  );
  /** In-flight tools only — drives the run-status header and the spinner on tool cards. */
  const activeTools = useMemo(
    () => liveTools.filter((tool) => !tool.completedAt),
    [liveTools],
  );
  const liveToolsById = useMemo(
    () => new Map(liveTools.map((tool) => [tool.toolCallId, tool])),
    [liveTools],
  );
  const committedToolCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.type === "tool") ids.add(entry.toolCall.toolCallId);
    }
    return ids;
  }, [entries]);
  /** Tools disk history has not surfaced at all yet; these append to the overlay. */
  const uncommittedLiveTools = useMemo(
    () => liveTools.filter((tool) => (
      !committedToolCallIds.has(tool.toolCallId) && !isCommittedByWatermark(tool.startedAt)
    )),
    [committedToolCallIds, isCommittedByWatermark, liveTools],
  );
  const committedArtifactIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.type === "visual") ids.add(entry.visual.artifactId);
    }
    return ids;
  }, [entries]);
  const uncommittedVisuals = useMemo(
    () => liveVisuals.filter((visual) => (
      !committedArtifactIds.has(visual.artifactId) && !isCommittedByWatermark(visual.timestamp)
    )),
    [committedArtifactIds, isCommittedByWatermark, liveVisuals],
  );
  const uncommittedCompletion = useMemo(() => {
    if (!liveCompletion) return null;
    const committed = entries.some((entry) => entry.type === "completion"
      && (!liveCompletion.sourceEventId || entry.sourceEventId === liveCompletion.sourceEventId));
    if (committed || isCommittedByWatermark(liveCompletion.timestamp)) return null;
    return liveCompletion;
  }, [entries, isCommittedByWatermark, liveCompletion]);

  useLayoutEffect(() => {
    if (!sessionId) return;
    let liveReadThrough: string | undefined;
    for (const segment of uncommittedAssistantSegments) {
      liveReadThrough = maxActivityTimestamp(liveReadThrough, segment.timestamp);
    }
    for (const message of uncommittedUserMessages) {
      liveReadThrough = maxActivityTimestamp(liveReadThrough, message.timestamp);
    }
    if (liveReadThrough) onRenderedReadThrough?.(sessionId, liveReadThrough);
  }, [onRenderedReadThrough, sessionId, uncommittedAssistantSegments, uncommittedUserMessages]);

  useEffect(() => {
    if (!sessionId || historicalMode || loading || creating) {
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
  }, [creating, historicalMode, isStreaming, loading, sessionId]);

  const refreshMcpStatus = useCallback(async () => {
    if (!sessionId || historicalMode) return;
    await mcpStatusQuery.refetch();
  }, [mcpStatusQuery.refetch, sessionId]);

  const handleMcpAuthenticate = useCallback(async (
    serverName: string,
    options: { forceReauth?: boolean } = {},
  ) => {
    if (!sessionId) throw new Error("Open a session before signing in to an MCP server.");
    const result = await loginMcpServer(sessionId, serverName, options);
    refreshMcpObservation();
    return result;
  }, [sessionId, refreshMcpObservation]);

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
    if (!sessionId || historicalMode) {
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
  }, [historicalMode, historySignal, refreshSessionContext, reloadToken, sessionId]);

  useEffect(() => {
    const wasStreaming = contextRefreshStreamingRef.current;
    contextRefreshStreamingRef.current = isStreaming;
    if (!sessionId || historicalMode || !wasStreaming || isStreaming) return;
    void refreshSessionContext(sessionId, { background: true });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.sessionUsageMetrics(sessionId),
      exact: true,
    });
    loadAndReconnectRef.current({ background: true, silent: true });
  }, [historicalMode, isStreaming, queryClient, refreshSessionContext, sessionId]);

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
    if (isStreaming || creating || pendingInteractionCount > 0) {
      setShowJumpToLatest(true);
    }
  }, [cancelFollowScroll, clearProgrammaticScroll, creating, isStreaming, pendingInteractionCount]);

  const handleToggleActivity = useCallback((key: string, expanded: boolean) => {
    setActivityExpansion((current) => ({ ...current, [key]: expanded }));
    // Opening earlier work is a decision to read it, so new output must not pull the view away.
    // The block the run is still writing into keeps following.
    if (expanded && key !== liveActivityKeyRef.current) handleUserScrollIntent();
  }, [handleUserScrollIntent]);

  const handleJumpToLatest = useCallback(() => {
    scrollToLatest({ force: true });
  }, [scrollToLatest]);

  const handleExitHistoricalMode = useCallback(() => {
    navigate(location.pathname, { replace: true });
  }, [location.pathname, navigate]);

  const handleCopyMessageLink = useCallback(() => {
    if (!targetSourceEventId) return;
    const url = getAppAbsoluteUrl(location.pathname);
    url.searchParams.set("message", targetSourceEventId);
    setMessageLinkCopyError(null);
    void writeClipboardText(url.toString()).then(
      () => setCopiedMessageLink(true),
      (reason: unknown) => setMessageLinkCopyError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [location.pathname, targetSourceEventId]);

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
    const transitionedFromDraft = prevSession === null;
    const draftComposerChanged = prevSession === null
      && prevComposerKey !== undefined
      && prevComposerKey !== composerKey;
    prevSessionRef.current = sessionId;
    prevComposerKeyRef.current = composerKey;
    setForkError(null);
    setUndoError(null);
    setUndoingEventId(null);
    setLoadMoreError(null);
    pendingSendsRef.current = [];
    setPendingSends([]);
    if (!sessionId) {
      // Clear draft-only state when entering draft mode from an existing
      // session or when switching between distinct draft composers.
      if (draftComposerChanged || prevSession !== undefined || !onCreateAndSend) {
        applyHistory([], {
          ownerSessionId: null,
          firstItemIndex: 0,
          total: 0,
          hasMore: false,
        });
      }
      setLoading(false);
      refreshingHistoryRef.current = false;
      setRefreshingHistory(false);
      setWarming(false);
      setCreating(false);
      setLoadingMore(false);
      setHasMore(false);
      setLoadMoreError(null);
      setShowJumpToLatest(false);
      cancelFollowScroll();
      clearProgrammaticScroll();
      anchoredMessageKeyRef.current = null;
      latestMessageAnchorKeyRef.current = null;
      pendingLiveAnchorCarryRef.current = false;
      pendingInitialAnchorRef.current = false;
      loadAnchoredMessageKeyRef.current = null;
      messageElementRefs.current.clear();
      firstItemIndex.current = 0;
      totalEntriesRef.current = 0;
      historyLastVisibleActivityAtRef.current = undefined;
      entriesRef.current = [];
      loadingMoreRef.current = false;
      autoLoadArmedRef.current = false;
      suppressAutoLoadRef.current = false;
      topAutoFillConsumedRef.current = false;
      clearPendingAutoLoad();
      return;
    }

    if (transitionedFromDraft) {
      setCreating(false);
    }
    // Reset stick-to-bottom so the new session starts following output,
    // regardless of scroll position in the previous session.
    stickToBottomRef.current = true;
    anchoredMessageKeyRef.current = null;
    latestMessageAnchorKeyRef.current = null;
    pendingLiveAnchorCarryRef.current = false;
    if (prevSession !== sessionId) {
      // Arm the landing anchor per navigation only. Re-running this effect for the same session
      // (composer or callback identity churn) must not yank an established reading position.
      pendingInitialAnchorRef.current = !historicalMode;
      loadAnchoredMessageKeyRef.current = null;
    }
    messageElementRefs.current.clear();
    setShowJumpToLatest(false);
    cancelFollowScroll();
    clearProgrammaticScroll();

    const controller = new AbortController();

    const loadAndReconnect = ({
      background = false,
      replace = false,
      // Routine disk-tail syncs are the steady state now, not an exceptional catch-up, so they
      // must not flash a progress pill or disable transcript actions.
      silent = false,
      // A stream that may have died unnoticed (the tab slept) is replaced; a healthy one is kept.
      forceReconnect = false,
    }: { background?: boolean; replace?: boolean; silent?: boolean; forceReconnect?: boolean } = {}): Promise<void> => {
      const requestId = ++loadRequestIdRef.current;
      if (background) {
        if (!silent) {
          refreshingHistoryRef.current = true;
          setRefreshingHistory(true);
        }
      } else {
        refreshingHistoryRef.current = false;
        setLoading(true);
        setRefreshingHistory(false);
        setWarming(false);
        if (historicalMode) {
          setHistoricalUnavailable(false);
          setHistoricalLoadError(null);
        }
      }
      const pageLoadStart = performance.now();

      // Phase 1: Fast load messages from disk — don't wait for MCP status.
      // Disk is the sole authority for committed transcript ordering, so a refresh reads a window
      // that covers everything currently loaded and replaces it wholesale.
      const historyRead = (() => {
      const requestLimit = background
        ? Math.min(
            HISTORY_REFRESH_MAX_LIMIT,
            Math.max(INITIAL_PAGE_SIZE, entriesRef.current.length),
          )
        : INITIAL_PAGE_SIZE;
      const historicalRequest = targetSourceEventId
        ? { before: 50, after: 50, aroundEventId: targetSourceEventId }
        : { limit: requestLimit };
      return fetchMessagesFast(sessionId, historicalRequest)
        .then(({ messages: msgs, runState, total, warm, lastVisibleActivityAt, startOffset, hasNewer }) => {
          const busy = runState !== "idle";
          if (controller.signal.aborted) return;
          if (requestId !== loadRequestIdRef.current) {
            return;
          }
          setHistoryRunBusy(busy);
          if (historicalMode) {
            const found = !targetSourceEventId || msgs.some((entry) => isChatMessageEntry(entry)
              && (entry.sourceEventId === targetSourceEventId || entry.id === targetSourceEventId));
            const historicalStartOffset = startOffset ?? Math.max(0, total - msgs.length);
            setHistoricalUnavailable(!found);
            setHistoricalHasNewer(Boolean(hasNewer));
            stickToBottomRef.current = false;
            applyHistory(found ? msgs : [], {
              ownerSessionId: sessionId,
              firstItemIndex: historicalStartOffset,
              total,
              hasMore: historicalStartOffset > 0,
              lastVisibleActivityAt: lastVisibleActivityAt ?? null,
              persistSnapshot: false,
              reportReadThrough: false,
            });
          } else if (background && !replace) {
            const merged = replaceHistoryWindow(
              entriesRef.current,
              firstItemIndex.current,
              msgs,
              total,
            );
            applyHistory(merged.entries, {
              ownerSessionId: sessionId,
              firstItemIndex: merged.firstItemIndex,
              total: merged.total,
              hasMore: merged.firstItemIndex > 0,
              lastVisibleActivityAt: lastVisibleActivityAt ?? null,
            });
            if (merged.hasGap) {
              // The window grew past what one refresh covers; reload from the top of the window.
              loadAndReconnect({ background: true, replace: true, silent, forceReconnect });
              return;
            }
          } else {
            const nextFirstItemIndex = Math.max(0, total - msgs.length);
            applyHistory(msgs, {
              ownerSessionId: sessionId,
              firstItemIndex: nextFirstItemIndex,
              total,
              hasMore: nextFirstItemIndex > 0,
              lastVisibleActivityAt: lastVisibleActivityAt ?? null,
            });
          }
          setLoading(false);
          refreshingHistoryRef.current = false;
          setRefreshingHistory(false);

          if (historicalMode) return;

          // Report time from navigation to messages rendered
          const loadDuration = Math.round(performance.now() - pageLoadStart);
          reportTiming("page.sessionLoad", loadDuration, {
            sessionId,
            metadata: { messageCount: msgs.length, warm, busy },
          }).catch(() => {});

          if (busy) {
            if (forceReconnect) reconnect(sessionId);
            else ensureConnected(sessionId);
            return;
          }

          // Phase 2: Warm the session in background if needed
          if (!warm) {
            setWarming(true);
            warmSession(sessionId)
              .then(() => {
                if (controller.signal.aborted) return;
                setWarming(false);
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.sessionUsageMetrics(sessionId),
                  exact: true,
                });
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
          if (historicalMode) {
            applyHistory([], {
              ownerSessionId: null,
              firstItemIndex: 0,
              total: 0,
              hasMore: false,
              persistSnapshot: false,
              reportReadThrough: false,
            });
            if (targetSourceEventId && err instanceof ApiError && err.status === 404) {
              setHistoricalUnavailable(true);
            } else {
              setHistoricalLoadError(`Could not load this saved message: ${getErrorMessage(err)}`);
            }
          } else if (!background) {
            applyHistory([
              { role: "assistant", content: `Error loading history: ${err.message}` },
            ], {
              ownerSessionId: null,
              firstItemIndex: 0,
              total: 0,
              hasMore: false,
            });
          }
          setLoading(false);
          refreshingHistoryRef.current = false;
          setRefreshingHistory(false);
        });

      })();

      return historyRead;
    };

    loadAndReconnectRef.current = loadAndReconnect;

    loadingMoreRef.current = false;
    setLoadingMore(false);
    autoLoadArmedRef.current = false;
    suppressAutoLoadRef.current = false;
    topAutoFillConsumedRef.current = false;
    clearPendingAutoLoad();
    const cachedSnapshot = historicalMode ? null : getCachedChatSnapshot(queryClient, sessionId);
    if (cachedSnapshot && cachedSnapshot.entries.length > 0) {
      // Cached windows are always disk-derived, so they can be shown immediately and then
      // replaced by the background read.
      applyHistory(cachedSnapshot.entries, {
        ownerSessionId: sessionId,
        firstItemIndex: cachedSnapshot.firstItemIndex,
        total: cachedSnapshot.total,
        hasMore: cachedSnapshot.hasMore,
        fetchedAt: cachedSnapshot.fetchedAt,
      });
      setLoading(false);
      setRefreshingHistory(false);
      setWarming(false);
      loadAndReconnect({ background: true, replace: true });
    } else {
      applyHistory([], {
        ownerSessionId: null,
        firstItemIndex: 0,
        total: 0,
        hasMore: false,
      });
      loadAndReconnect();
    }

    // Close plan sheet when switching sessions (close is a stable callback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    planOverlay.close();

    // Reconnect when the tab wakes from sleep (mobile screen-off, etc.)
    const onVisible = () => {
      if (historicalMode || document.visibilityState !== "visible") return;
      loadAndReconnect({ background: true, silent: true, forceReconnect: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      refreshingHistoryRef.current = false;
      loadAndReconnectRef.current = async () => {};
      clearPendingAutoLoad();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [
    applyHistory,
    cancelFollowScroll,
    clearPendingAutoLoad,
    clearProgrammaticScroll,
    composerKey,
    ensureConnected,
    historicalMode,
    queryClient,
    reconnect,
    sessionId,
    targetSourceEventId,
  ]);

  // Reconnect when an external source starts work on this session
  const prevBusySignalRef = useRef(busySignal);
  useEffect(() => {
    prevBusySignalRef.current = busySignal;
  }, [historicalMode, sessionId, targetSourceEventId]);
  useEffect(() => {
    if (historicalMode) {
      prevBusySignalRef.current = busySignal;
      return;
    }
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
  }, [busySignal, creating, historicalMode, isStreaming, loading, loadingMore, pendingOrigin, refreshingHistory, sessionId]);

  const prevHistorySignalRef = useRef(historySignal);
  useEffect(() => {
    prevHistorySignalRef.current = historySignal;
  }, [sessionId]);
  useEffect(() => {
    const prev = prevHistorySignalRef.current;
    if (!sessionId || historicalMode || historySignal === prev) return;
    prevHistorySignalRef.current = historySignal;
    loadAndReconnectRef.current({ background: true, replace: true });
  }, [historicalMode, historySignal, sessionId]);

  /**
   * Committed history advanced on the server: re-read the disk window.
   *
   * Single-flight with a queued "latest requested epoch" marker so a long autopilot run emitting
   * an advance per committed event collapses into a bounded refresh rate, while never losing the
   * final refresh. Failures and load-more collisions reschedule instead of dropping the request.
   */
  const requestedHistoryEpochRef = useRef(0);
  const refreshedHistoryEpochRef = useRef(0);
  const historyRefreshInFlightRef = useRef(false);

  const lastHistoryRefreshAtRef = useRef(0);

  const runHistoryRefresh = useCallback(() => {
    if (historyRefreshTimerRef.current != null) return;
    if (requestedHistoryEpochRef.current <= refreshedHistoryEpochRef.current) return;
    if (historyRefreshInFlightRef.current || loadingMoreRef.current) return;

    const dispatch = () => {
      if (!sessionIdRef.current) return;
      if (historyRefreshInFlightRef.current || loadingMoreRef.current) {
        // Retry once the reader is free; the marker keeps the pending request alive.
        historyRefreshTimerRef.current = setTimeout(() => {
          historyRefreshTimerRef.current = null;
          runHistoryRefresh();
        }, HISTORY_REFRESH_THROTTLE_MS);
        return;
      }
      const targetEpoch = requestedHistoryEpochRef.current;
      historyRefreshInFlightRef.current = true;
      lastHistoryRefreshAtRef.current = Date.now();
      void loadAndReconnectRef.current({ background: true, silent: true })
        .then(() => {
          refreshedHistoryEpochRef.current = targetEpoch;
        })
        .finally(() => {
          historyRefreshInFlightRef.current = false;
          runHistoryRefresh();
        });
    };

    // Leading edge: the first advance after a quiet period lands immediately.
    const sinceLast = Date.now() - lastHistoryRefreshAtRef.current;
    if (sinceLast >= HISTORY_REFRESH_THROTTLE_MS) {
      dispatch();
      return;
    }
    historyRefreshTimerRef.current = setTimeout(() => {
      historyRefreshTimerRef.current = null;
      dispatch();
    }, HISTORY_REFRESH_THROTTLE_MS - sinceLast);
  }, []);

  useEffect(() => {
    if (!sessionId || historicalMode || historyEpoch === 0) return;
    requestedHistoryEpochRef.current = historyEpoch;
    runHistoryRefresh();
  }, [historicalMode, historyEpoch, runHistoryRefresh, sessionId]);

  useEffect(() => {
    requestedHistoryEpochRef.current = 0;
    refreshedHistoryEpochRef.current = 0;
    historyRefreshInFlightRef.current = false;
    lastHistoryRefreshAtRef.current = 0;
    return () => {
      if (historyRefreshTimerRef.current != null) {
        clearTimeout(historyRefreshTimerRef.current);
        historyRefreshTimerRef.current = null;
      }
    };
  }, [sessionId]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    refreshingHistoryRef.current = refreshingHistory;
  }, [refreshingHistory]);

  const [showHistorySync, setShowHistorySync] = useState(false);
  useEffect(() => {
    if (!refreshingHistory) {
      setShowHistorySync(false);
      return;
    }
    const timer = setTimeout(() => setShowHistorySync(true), HISTORY_SYNC_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [refreshingHistory]);

  useLayoutEffect(() => {
    const pending = pendingRenderedReadThroughRef.current;
    if (!pending || pending.sessionId !== sessionId) return;
    pendingRenderedReadThroughRef.current = null;
    onRenderedReadThrough?.(pending.sessionId, pending.readThroughActivityAt);
  }, [entries, onRenderedReadThrough, sessionId]);

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
    if (!sessionId || historicalMode || !hasMore || loadingMoreRef.current) return;
    const { limit = INITIAL_PAGE_SIZE, preserveScrollPosition = true } = opts;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    const beforeIndex = firstItemIndex.current;
    const requestSessionId = sessionId;
    fetchMessagesFast(sessionId, { limit, before: beforeIndex })
      .then(({ messages: older, hasMore: more, total }) => {
        if (sessionIdRef.current !== requestSessionId || firstItemIndex.current !== beforeIndex) return;
        const currentEntries = entriesRef.current;
        if (older.length > 0) {
          if (preserveScrollPosition) {
            // Save scroll height before prepending so the layout effect can preserve position.
            prevScrollHeightRef.current = scrollContainerRef.current?.scrollHeight ?? null;
          }
          const nextFirstItemIndex = beforeIndex - older.length;
          const nextEntries = [...older, ...currentEntries];
          applyHistory(nextEntries, {
            ownerSessionId: requestSessionId,
            firstItemIndex: nextFirstItemIndex,
            total: Math.max(total, nextFirstItemIndex + nextEntries.length),
            hasMore: more,
          });
        } else if (!more) {
          applyHistory(currentEntries, {
            ownerSessionId: requestSessionId,
            firstItemIndex: 0,
            total: Math.max(total, currentEntries.length),
            hasMore: false,
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
  }, [sessionId, historicalMode, hasMore, applyHistory]);

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
    if (!sessionId || historicalMode || !hasMore || loadingMoreRef.current || autoLoadTimeoutRef.current != null) return;
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
  }, [hasMore, historicalMode, loadOlderMessages, sessionId]);

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
    } else if (isStreaming || creating || pendingInteractionCount > 0) {
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
  }, [clearPendingAutoLoad, creating, isStreaming, pendingInteractionCount, scheduleAutoLoad]);

  // If the first page doesn't overflow, schedule the same delayed auto-load from the top.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !sessionId || historicalMode || !hasMore || loading || loadingMore) return;
    if (suppressAutoLoadRef.current || topAutoFillConsumedRef.current) return;
    const nearTop = el.scrollTop <= AUTO_LOAD_TOP_THRESHOLD;
    const overflowing = el.scrollHeight > el.clientHeight + AUTO_LOAD_TOP_THRESHOLD;
    if (!nearTop || overflowing) return;
    scheduleAutoLoad({ consumeTopAutoFill: true });
  }, [entries, hasMore, historicalMode, loading, loadingMore, scheduleAutoLoad, sessionId]);

  /**
   * Keep the ref and state in lockstep so synchronous callers (for example a double-clicked retry)
   * always observe the latest delivery state.
   */
  const updatePendingSends = useCallback((
    updater: (current: PendingSend[]) => PendingSend[],
  ) => {
    const next = updater(pendingSendsRef.current);
    pendingSendsRef.current = next;
    setPendingSends(next);
  }, []);

  // A message still being delivered, or one that failed and can be retried, exists only in this page.
  const hasUndeliveredMessage = pendingSends.some((send) => send.delivery !== undefined);
  useEffect(() => (hasUndeliveredMessage ? holdPageReload() : undefined), [hasUndeliveredMessage]);

  const updateOptimisticMessageDelivery = useCallback((
    messageId: string,
    ownerSessionId: string | null,
    delivery: ChatMessageDelivery | undefined,
  ) => {
    if (sessionIdRef.current !== ownerSessionId) return;
    updatePendingSends((current) => current.map((send) => send.id === messageId
      ? { ...send, delivery }
      : send));
  }, [updatePendingSends]);

  const removeOptimisticMessage = useCallback((
    messageId: string,
    ownerSessionId: string | null,
  ) => {
    if (sessionIdRef.current !== ownerSessionId) return;
    updatePendingSends((current) => current.filter((send) => send.id !== messageId));
  }, [updatePendingSends]);

  const deliverOptimisticMessage = useCallback(async (
    messageId: string,
    ownerSessionId: string | null,
    prompt: string,
    attachments: Attachment[] | undefined,
    mode: SendMode | undefined,
  ) => {
    try {
      let response: ChatMessageAcceptedResponse | void;
      if (ownerSessionId === null) {
        if (!onCreateAndSend) throw new Error("Draft session creation is unavailable.");
        response = await onCreateAndSend(prompt, attachments, mode, messageId);
      } else if (mode !== undefined) {
        response = await sendMessage(prompt, attachments, mode, messageId);
      } else {
        response = await sendMessage(prompt, attachments, undefined, messageId);
      }
      if (response?.mode === "command") {
        removeOptimisticMessage(messageId, ownerSessionId);
      } else {
        updateOptimisticMessageDelivery(messageId, ownerSessionId, undefined);
      }
      if (ownerSessionId === null && sessionIdRef.current) {
        loadAndReconnectRef.current({ background: true, replace: true });
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error).trim() || "Message could not be sent.";
      updateOptimisticMessageDelivery(messageId, ownerSessionId, {
        failed: true,
        ...(mode === undefined ? {} : { mode }),
        error: errorMessage,
      });
      if (ownerSessionId === null) {
        setCreating(false);
      }
    }
  }, [onCreateAndSend, removeOptimisticMessage, sendMessage, updateOptimisticMessageDelivery]);

  const handleRetryMessage = useCallback(async (message: FailedOptimisticChatMessage) => {
    const currentSend = pendingSendsRef.current.find((send) => send.id === message.id);
    if (!currentSend || currentSend.delivery?.failed !== true) return;

    const ownerSessionId = sessionId;
    updateOptimisticMessageDelivery(
      currentSend.id,
      ownerSessionId,
      createSendingDelivery(currentSend.delivery.mode),
    );
    if (ownerSessionId === null) setCreating(true);
    await deliverOptimisticMessage(
      currentSend.id,
      ownerSessionId,
      currentSend.content,
      currentSend.attachments,
      currentSend.delivery.mode,
    );
  }, [deliverOptimisticMessage, sessionId, updateOptimisticMessageDelivery]);

  const handleSend = useCallback(async (prompt: string, attachments?: Attachment[], mode?: SendMode) => {
    if (loading) {
      queuedSendRef.current = { sessionId, composerKey, prompt, attachments, mode };
      return;
    }
    if (creating || (isStreaming && !sessionId)) return;

    // Draft mode: create session on first message
    if (!sessionId && onCreateAndSend) {
      const draftMode = mode ?? DEFAULT_SEND_MODE;
      const draftMessageId = createClientMessageId();
      setCreating(true);
      updatePendingSends(() => [{
        id: draftMessageId,
        content: prompt,
        delivery: createSendingDelivery(draftMode),
        ...(attachments?.length ? { attachments } : {}),
      }]);
      await deliverOptimisticMessage(
        draftMessageId,
        null,
        prompt,
        attachments,
        draftMode,
      );
      return;
    }

    if (!sessionId) return;
    onDraftClear?.();
    invalidateHistoryRefresh();
    // Force stick-to-bottom so auto-scroll kicks in after the next render
    stickToBottomRef.current = true;
    const messageMode = isStreaming ? undefined : (mode ?? DEFAULT_SEND_MODE);
    const messageId = createClientMessageId();
    updatePendingSends((current) => [
      ...current,
      {
        id: messageId,
        content: prompt,
        delivery: createSendingDelivery(messageMode),
        ...(attachments?.length ? { attachments } : {}),
      },
    ]);
    await deliverOptimisticMessage(messageId, sessionId, prompt, attachments, messageMode);
  }, [
    composerKey,
    creating,
    deliverOptimisticMessage,
    invalidateHistoryRefresh,
    isStreaming,
    loading,
    onCreateAndSend,
    onDraftClear,
    sessionId,
    updatePendingSends,
  ]);

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
    () => sortPendingRequests(pendingUserInputs),
    [pendingUserInputs],
  );
  const pendingElicitationRequests = useMemo(
    () => sortPendingRequests(pendingElicitations),
    [pendingElicitations],
  );
  const hasPendingInteractions = pendingUserInputRequests.length > 0
    || pendingElicitationRequests.length > 0;

  const handleSubmitUserInput = useCallback(async (
    requestId: string,
    payload: UserInputAnswerEndpointPayload,
  ) => {
    if (!sessionId) throw new Error("Session not available");
    await submitUserInputResponse(sessionId, requestId, payload);
  }, [sessionId]);

  const handleSubmitElicitation = useCallback(async (
    requestId: string,
    payload: ElicitationResponseEndpointPayload,
  ) => {
    if (!sessionId) throw new Error("Session not available");
    await submitElicitationResponse(sessionId, requestId, payload);
  }, [sessionId]);

  const activeToolCalls = useMemo<ToolCall[]>(
    () => activeTools.map((tool) => ({
      toolCallId: tool.toolCallId,
      name: tool.name,
      turnId: tool.turnId,
      turnInstanceId: tool.turnInstanceId,
      args: tool.args,
      parentToolCallId: tool.parentToolCallId,
      isSubAgent: tool.isSubAgent,
      agentInstructions: tool.agentInstructions,
      startedAt: tool.startedAt,
      progressText: tool.progressText,
    })),
    [activeTools],
  );
  const displayedStreamingContent = useThrottledText(streamingContent, STREAM_RENDER_INTERVAL_MS);
  const hasStreamingText = displayedStreamingContent.trim().length > 0;
  const displayedReasoning = useThrottledReasoning(uncommittedReasoning, STREAM_RENDER_INTERVAL_MS);
  const clientOwnedCommittedSourceEventIds = useMemo(() => {
    const sendsById = new Map(pendingSends.map((send) => [send.id, send]));
    return new Set(pendingUserMessages.flatMap((message) => (
      message.sourceEventId && sendsById.get(message.id)?.delivery !== undefined
        ? [message.sourceEventId]
        : []
    )));
  }, [pendingSends, pendingUserMessages]);
  /**
   * The live overlay, rendered strictly after committed history. It never interleaves with, or is
   * merged into, the disk-backed transcript: it only holds prompts and assistant text that
   * `events.jsonl` has not surfaced yet, plus optimistic sends this client owns.
   */
  const liveEntries = useMemo<ChatEntry[]>(() => {
    const nextEntries: ChatEntry[] = [];
    const pendingSendsById = new Map(pendingSends.map((send) => [send.id, send]));
    const projectedUserMessageIds = new Set(pendingUserMessages.map((message) => message.id));
    const uncommittedProjectedUserMessageIds = new Set(uncommittedUserMessages.map((message) => message.id));
    for (const message of uncommittedUserMessages) {
      const pendingSend = pendingSendsById.get(message.id);
      if (pendingSend?.delivery?.failed) continue;
      nextEntries.push({
        id: `live-user-${message.id}`,
        type: "message",
        role: "user",
        content: message.content,
        ...(pendingSend?.delivery ? { delivery: pendingSend.delivery } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      });
    }
    // Within one model call the order is fixed: thinking, then text, then tool calls. The overlay
    // can briefly hold the turn that just ended as well (its history read is still in flight), and
    // that turn's items come first.
    const endedTurnEntries: ChatEntry[] = [];
    const currentTurnEntries: ChatEntry[] = [];
    const bucketFor = (turnInstanceId?: string) => (
      turnInstanceId && activeTurnInstanceId && turnInstanceId !== activeTurnInstanceId
        ? endedTurnEntries
        : currentTurnEntries
    );
    for (const block of displayedReasoning) {
      bucketFor(block.turnInstanceId).push({
        id: `live-reasoning-${block.id}`,
        type: "reasoning",
        content: block.content,
        ...(block.turnId ? { turnId: block.turnId } : {}),
        ...(block.turnInstanceId ? { turnInstanceId: block.turnInstanceId } : {}),
        ...(block.committedAt ?? block.completedAt
          ? { timestamp: block.committedAt ?? block.completedAt }
          : {}),
        reasoning: {
          ...(block.sourceEventId ? { messageEventId: block.sourceEventId } : {}),
          ...(block.startedAt ? { startedAt: block.startedAt } : {}),
          ...(isStreaming && !block.completedAt ? { streaming: true } : {}),
        },
      });
    }
    for (const segment of uncommittedAssistantSegments) {
      bucketFor(segment.turnInstanceId).push({
        id: `live-assistant-${segment.id}`,
        type: "message",
        role: "assistant",
        content: segment.content,
        ...(segment.turnId ? { turnId: segment.turnId } : {}),
        ...(segment.turnInstanceId ? { turnInstanceId: segment.turnInstanceId } : {}),
        ...(segment.timestamp ? { timestamp: segment.timestamp } : {}),
      });
    }
    for (const tool of uncommittedLiveTools) {
      bucketFor(tool.turnInstanceId).push({
        id: `live-tool-${tool.toolCallId}`,
        type: "tool",
        turnId: tool.turnId,
        turnInstanceId: tool.turnInstanceId,
        sourceEventId: tool.sourceEventId,
        toolCall: {
          toolCallId: tool.toolCallId,
          name: tool.name,
          turnId: tool.turnId,
          turnInstanceId: tool.turnInstanceId,
          args: tool.args,
          parentToolCallId: tool.parentToolCallId,
          isSubAgent: tool.isSubAgent,
          agentInstructions: tool.agentInstructions,
          startedAt: tool.startedAt,
          progressText: tool.progressText,
          completedAt: tool.completedAt,
          success: tool.success,
          result: tool.result,
        },
      });
    }
    for (const visual of uncommittedVisuals) {
      bucketFor(visual.turnInstanceId).push({
        id: `live-visual-${visual.artifactId}`,
        type: "visual",
        ...(visual.turnId ? { turnId: visual.turnId } : {}),
        ...(visual.turnInstanceId ? { turnInstanceId: visual.turnInstanceId } : {}),
        visual: visual as unknown as ChatVisualEntry["visual"],
        ...(visual.timestamp ? { timestamp: visual.timestamp } : {}),
      });
    }
    nextEntries.push(...endedTurnEntries, ...currentTurnEntries);
    if (uncommittedCompletion) {
      nextEntries.push({
        id: `live-completion-${uncommittedCompletion.sourceEventId ?? "run"}`,
        type: "completion",
        content: uncommittedCompletion.completion.content,
        completion: uncommittedCompletion.completion,
        ...(uncommittedCompletion.turnId ? { turnId: uncommittedCompletion.turnId } : {}),
        ...(uncommittedCompletion.turnInstanceId
          ? { turnInstanceId: uncommittedCompletion.turnInstanceId }
          : {}),
        ...(uncommittedCompletion.timestamp ? { timestamp: uncommittedCompletion.timestamp } : {}),
      });
    }
    for (const send of pendingSends) {
      const hasProjectedMessage = projectedUserMessageIds.has(send.id);
      const hasVisibleProjectedMessage = uncommittedProjectedUserMessageIds.has(send.id);
      if (
        (send.delivery === undefined && hasProjectedMessage)
        || (send.delivery?.failed === false && hasVisibleProjectedMessage)
      ) {
        continue;
      }
      nextEntries.push({
        id: send.id,
        type: "message",
        role: "user",
        content: send.content,
        delivery: send.delivery,
        ...(send.attachments?.length ? { attachments: send.attachments } : {}),
      });
    }
    if (isStreaming && hasStreamingText) {
      nextEntries.push({
        id: LIVE_STREAMING_MESSAGE_ID,
        type: "message",
        role: "assistant",
        content: displayedStreamingContent,
        turnId: activeTurnId,
        turnInstanceId: activeTurnInstanceId,
      });
    }
    return nextEntries;
  }, [
    activeTurnId,
    activeTurnInstanceId,
    displayedReasoning,
    displayedStreamingContent,
    hasStreamingText,
    isStreaming,
    pendingSends,
    pendingUserMessages,
    uncommittedAssistantSegments,
    uncommittedCompletion,
    uncommittedLiveTools,
    uncommittedUserMessages,
    uncommittedVisuals,
  ]);

  useEffect(() => {
    const projectedUserMessageIds = new Set(pendingUserMessages.map((message) => message.id));
    if (!pendingSendsRef.current.some((send) => (
      send.delivery === undefined && projectedUserMessageIds.has(send.id)
    ))) {
      return;
    }
    updatePendingSends((current) => current.filter((send) => (
      send.delivery !== undefined || !projectedUserMessageIds.has(send.id)
    )));
  }, [pendingUserMessages, updatePendingSends]);
  const committedEntries = useMemo(() => {
    const visibleEntries = clientOwnedCommittedSourceEventIds.size === 0
      ? entries
      : entries.filter((entry) => (
          !isChatMessageEntry(entry)
          || !entry.sourceEventId
          || !clientOwnedCommittedSourceEventIds.has(entry.sourceEventId)
        ));
    if (liveToolsById.size === 0) return visibleEntries;
    return visibleEntries.map((entry) => {
      if (entry.type !== "tool") return entry;
      const live = liveToolsById.get(entry.toolCall.toolCallId);
      if (!live) return entry;
      // Disk owns where the tool sits; the stream can only be fresher about its state.
      const gainsResult = live.result !== undefined
        && live.result !== entry.toolCall.result
        && (
          live.isSubAgent === true
            ? (
                entry.toolCall.completedAt === undefined
                || isLaterTimestamp(live.completedAt, entry.toolCall.completedAt)
              )
            : live.completedAt !== undefined && entry.toolCall.completedAt === undefined
        );
      const gainsProgress = !!live.progressText && live.progressText !== entry.toolCall.progressText;
      const gainsCompletion = live.completedAt !== undefined
        && live.completedAt !== entry.toolCall.completedAt;
      const gainsIdentity = live.isSubAgent === true && live.name !== "unknown" && (
        live.name !== entry.toolCall.name
        || entry.toolCall.isSubAgent !== true
      );
      const gainsInstructions = live.agentInstructions !== undefined
        && !haveSameAgentInstructions(live.agentInstructions, entry.toolCall.agentInstructions);
      if (
        !gainsResult
        && !gainsProgress
        && !gainsCompletion
        && !gainsIdentity
        && !gainsInstructions
      ) return entry;
      return {
        ...entry,
        toolCall: {
          ...entry.toolCall,
          ...(gainsProgress ? { progressText: live.progressText } : {}),
          ...(gainsIdentity
            ? { name: live.name, isSubAgent: live.isSubAgent ?? entry.toolCall.isSubAgent }
            : {}),
          ...(gainsInstructions ? { agentInstructions: live.agentInstructions } : {}),
          ...(gainsCompletion
            ? {
                completedAt: live.completedAt,
                success: live.success ?? entry.toolCall.success,
              }
            : {}),
          ...(gainsResult
            ? {
                completedAt: live.completedAt ?? entry.toolCall.completedAt,
                success: live.success ?? entry.toolCall.success,
                result: live.result,
              }
            : {}),
        },
      };
    });
  }, [clientOwnedCommittedSourceEventIds, entries, liveToolsById]);
  const displayEntries = useMemo(
    () => liveEntries.length > 0 ? [...committedEntries, ...liveEntries] : committedEntries,
    [committedEntries, liveEntries],
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
  useEffect(() => {
    if (!selectingMessageTarget) return;
    const stillVisible = displayEntries.some((entry, index) => (
      isChatMessageEntry(entry)
      && isSameMessageTarget(
        selectingMessageTarget,
        entry,
        messageAnchorKeys.get(entry) ?? getMessageAnchorKey(entry, index),
      )
    ));
    if (!stillVisible) setSelectingMessageTarget(null);
  }, [displayEntries, messageAnchorKeys, selectingMessageTarget]);
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
  /**
   * A step with no recorded end is only "running" while something can still end it: this view's
   * stream, a run the last disk read reported (or no read yet), a background agent, or another
   * Copilot client holding the session. Otherwise it simply never finished.
   */
  const runActive = isStreaming
    || creating
    || historyRunBusy !== false
    || (backgroundAgents?.running ?? 0) > 0
    || externallyInUse;
  const renderBlocks = useMemo(
    () => groupActivitySegments(segmentChatEntries(displayEntries), { includeUnfinishedQuestions: !runActive }),
    [displayEntries, runActive],
  );
  /**
   * While the run is between steps, the block at the end of the transcript is where the next step
   * will land, so it carries the "still working" state instead of a separate indicator below it.
   */
  const liveActivityKey = useMemo(() => {
    if (!isStreaming || hasStreamingText) return null;
    const trailing = renderBlocks[renderBlocks.length - 1];
    return trailing?.type === "activity" ? trailing.key : null;
  }, [hasStreamingText, isStreaming, renderBlocks]);
  liveActivityKeyRef.current = liveActivityKey;
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
  // Attaching to a run's stream normally takes a few milliseconds. Naming that step every time
  // makes the status blink through "Reconnecting" on its way to "Thinking", so it is only named
  // once it is taking long enough to be worth explaining.
  const reconnectIsSlow = useSustained(runHeaderState?.phase === "reconnecting", RECONNECT_LABEL_DELAY_MS);
  /**
   * The line that says the run is still going, for when nothing else on screen does. Once the run
   * has produced output, the gaps between a reply ending and the next step (or the run's end) are
   * usually a few milliseconds, so the line waits to be sure there really is a pause to explain.
   */
  const statusLineWanted = Boolean(runHeaderState) && !hasStreamingText && !liveActivityKey;
  const midRunPause = statusLineWanted && hadVisibleOutput;
  const midRunPauseSustained = useSustained(midRunPause, MID_RUN_STATUS_DELAY_MS);
  const showStatusLine = statusLineWanted && (!midRunPause || midRunPauseSustained);

  useLayoutEffect(() => {
    const previousMessageKey = latestMessageAnchorKeyRef.current;
    if (previousMessageKey === latestMessageAnchorKey) return;

    const wasAnchored = Boolean(previousMessageKey && anchoredMessageKeyRef.current === previousMessageKey);
    loadAnchoredMessageKeyRef.current = null;
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

  // Landing on a session should show the start of the newest reply, not its tail. The bottom-follow
  // layout effect above jams the first painted history to the bottom, which clips the top of a long
  // assistant message and forces the reader to scroll back up. Re-anchor once per navigation; the
  // anchored target is clamped to the max scroll top, so short replies still land at the bottom.
  // `entries` is a dependency because two sessions can share a newest message id, and cached
  // navigation between them would otherwise never re-run this effect.
  useLayoutEffect(() => {
    if (!pendingInitialAnchorRef.current || loading) return;
    // Consume the arming even when there is nothing to anchor, so a later reply in a session that
    // opened empty is treated as ordinary live output.
    pendingInitialAnchorRef.current = false;
    if (!latestMessageAnchorKey || latestMessageRole !== "assistant") return;
    // Active runs keep the existing live-follow behaviour; the tail is what matters there.
    if (isStreaming || creating) return;
    scrollToLatest({ immediate: true, force: true, anchorKey: latestMessageAnchorKey });
    loadAnchoredMessageKeyRef.current = anchoredMessageKeyRef.current;
  }, [creating, entries, isStreaming, latestMessageAnchorKey, latestMessageRole, loading, scrollToLatest]);

  // Auto-scroll during streaming until the newest message itself reaches the viewport top.
  useEffect(() => {
    if (!isStreaming && !creating && !hasPendingInteractions) return;
    if (loadAnchoredMessageKeyRef.current
      && anchoredMessageKeyRef.current === loadAnchoredMessageKeyRef.current) {
      // New work started under a transcript still parked where navigation left it: fall back to the
      // live tail so status, tools, and pending prompts stay visible.
      loadAnchoredMessageKeyRef.current = null;
      scrollToLatest({ force: true });
      return;
    }
    if (latestMessageAnchorKey && anchoredMessageKeyRef.current === latestMessageAnchorKey) return;
    scrollToLatest({ anchorKey: latestMessageAnchorKey });
  }, [
    creating,
    activeTools.length,
    displayedReasoning,
    displayedStreamingContent,
    hasPendingInteractions,
    isStreaming,
    latestMessageAnchorKey,
    liveActivityKey,
    liveEntries.length,
    pendingUserInputRequests.length,
    pendingElicitationRequests.length,
    runHeaderState?.phase,
    scrollToLatest,
  ]);

  // Build lightweight pending-only UI. Live tools and assistant text render in the normal chat flow.
  const pendingContent = useMemo(() => {
    const parts: React.ReactNode[] = [];

    if (showStatusLine && runHeaderState) {
      const attaching = runHeaderState.phase === "reconnecting" && !reconnectIsSlow;
      parts.push(
        <div key="run-header" className={CHAT_RAIL_CLASS}>
          <LiveStatusLine
            label={attaching ? "Thinking" : runHeaderState.label}
            detail={intentText || undefined}
            description={attaching ? undefined : `${runHeaderState.title}. ${runHeaderState.detail}`}
          />
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

    for (const request of pendingElicitationRequests) {
      parts.push(
        <ElicitationCard
          key={`elicitation-${request.requestId}`}
          request={request}
          onSubmit={handleSubmitElicitation}
        />,
      );
    }

    if (elicitationCancellation) {
      parts.push(
        <ElicitationCancellationNotice
          key={`elicitation-canceled-${elicitationCancellation.requestId}`}
          notice={elicitationCancellation}
        />,
      );
    }

    if (runNotice) {
      parts.push(<RunNoticeCard key={`run-notice-${runNotice.kind}`} notice={runNotice} />);
    }

    if (parts.length === 0) return null;
    return <div className="space-y-3 pb-4">{parts}</div>;
  }, [
    handleSubmitElicitation,
    handleSubmitUserInput,
    elicitationCancellation,
    intentText,
    pendingElicitationRequests,
    pendingUserInputRequests,
    reconnectIsSlow,
    runHeaderState,
    runNotice,
    showStatusLine,
  ]);

  const isDraft = !sessionId && !!onCreateAndSend;
  const cachedHistoryAt = historyFetchedAtRef.current;
  const historySyncDetail = showHistorySync && cachedHistoryAt && Date.now() - cachedHistoryAt >= 60_000
    ? `Showing messages from ${timeAgo(new Date(cachedHistoryAt).toISOString())} while checking for new ones`
    : "Showing cached messages while checking for new ones";
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

  const handleSelectMessageText = useCallback(() => {
    const target = messageMenuTarget;
    if (!target) return;
    closeMessageMenu();
    window.getSelection?.()?.removeAllRanges();
    setSelectingMessageTarget(target);
  }, [closeMessageMenu, messageMenuTarget]);

  const handleFinishSelectingMessageText = useCallback(() => {
    window.getSelection?.()?.removeAllRanges();
    setSelectingMessageTarget(null);
  }, []);

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

  const historicalMatchIds = useMemo(() => {
    if (!historicalMode || !searchQuery) return [];
    return displayEntries.flatMap((entry) => {
      if (!isChatMessageEntry(entry) || !textMatchesSearchQuery(entry.content, searchQuery)) return [];
      const sourceId = entry.sourceEventId ?? entry.id;
      return sourceId ? [sourceId] : [];
    });
  }, [displayEntries, historicalMode, searchQuery]);
  const activeSearchMatchPage = searchMatchPage?.ids.includes(targetSourceEventId ?? "")
    ? searchMatchPage
    : null;
  const navigableMatchIds = activeSearchMatchPage
    ? activeSearchMatchPage.ids
    : historicalMatchIds;
  const navigableMatchOffset = activeSearchMatchPage
    ? activeSearchMatchPage.offset
    : 0;
  const navigableMatchTotal = activeSearchMatchPage
    ? activeSearchMatchPage.total
    : navigableMatchIds.length;
  const matchCoveragePartial = activeSearchMatchPage && (
    activeSearchMatchPage.coverage.state !== "ready"
    || activeSearchMatchPage.coverage.errors.length > 0
  );
  const historicalMatchIndex = targetSourceEventId
    ? navigableMatchIds.indexOf(targetSourceEventId)
    : -1;
  const scrollToSourceMessage = useCallback((sourceEventId: string) => {
    const node = sourceMessageElementRefs.current.get(sourceEventId);
    node?.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);
  const moveHistoricalMatch = useCallback(async (direction: -1 | 1) => {
    if (!sessionId || navigableMatchIds.length === 0) return;
    const currentIndex = Math.max(0, historicalMatchIndex);
    const nextIndex = currentIndex + direction;
    let nextId = navigableMatchIds[nextIndex];
    let nextOffset = navigableMatchOffset;
    if (!nextId && searchMatchPage && searchQuery) {
      const adjacentOffset = direction > 0
        ? searchMatchPage.offset + searchMatchPage.ids.length
        : Math.max(0, searchMatchPage.offset - SEARCH_MATCH_PAGE_SIZE);
      const hasAdjacentPage = direction > 0
        ? adjacentOffset < searchMatchPage.total
        : searchMatchPage.offset > 0;
      if (!hasAdjacentPage) return;
      setSearchMatchPageLoading(true);
      setSearchMatchPageError(null);
      try {
        const result = await searchBridge({
          q: searchQuery,
          scope: "session",
          sessionId,
          kind: "chat",
          limit: SEARCH_MATCH_PAGE_SIZE,
          offset: adjacentOffset,
        });
        const hit = result.chats.items[0];
        const ids = hit?.matches.map((match) => match.sourceEventId) ?? [];
        if (ids.length === 0) return;
        const adjacentId = direction > 0 ? ids[0] : ids.at(-1);
        if (!adjacentId) return;
        nextId = adjacentId;
        nextOffset = adjacentOffset;
        setSearchMatchPage({
          ids,
          offset: adjacentOffset,
          total: hit?.matchCount ?? 0,
          coverage: result.coverage,
        });
      } catch (reason) {
        setSearchMatchPageError(reason instanceof Error ? reason.message : String(reason));
        return;
      } finally {
        setSearchMatchPageLoading(false);
      }
    }
    if (!nextId) return;
    const next = new URLSearchParams(routeSearchParams);
    next.set("message", nextId);
    next.set("matchOffset", String(nextOffset));
    navigate(`${location.pathname}?${next.toString()}`, { replace: true });
  }, [
    historicalMatchIndex,
    location.pathname,
    navigate,
    navigableMatchIds,
    navigableMatchOffset,
    routeSearchParams,
    searchMatchPage,
    searchQuery,
    sessionId,
  ]);

  useLayoutEffect(() => {
    if (!historicalMode || loading || !targetSourceEventId || historicalUnavailable) return;
    if (pendingHistoricalAnchorRef.current !== targetSourceEventId) return;
    pendingHistoricalAnchorRef.current = null;
    scrollToSourceMessage(targetSourceEventId);
  }, [entries, historicalMode, historicalUnavailable, loading, scrollToSourceMessage, targetSourceEventId]);

  if (!sessionId && !isDraft) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-lg">
        Create or select a session to start
      </div>
    );
  }

  /** Render the transcript in order, folding each run of thinking and tool calls into one block. */
  const renderedEntries = useMemo(() => {
    const result: React.ReactNode[] = [];

    renderBlocks.forEach((segment, index) => {
      if (segment.type === "activity") {
        result.push(
          <div key={segment.key} className={`${CHAT_RAIL_CLASS} pt-3`}>
            <ActivityBlock
              block={segment}
              toolForest={toolForest}
              expanded={activityExpansion[segment.key] ?? false}
              onToggle={handleToggleActivity}
              live={segment.key === liveActivityKey}
              liveLabel={intentText}
            />
          </div>,
        );
        return;
      }

      if (segment.type === "question") {
        result.push(
          <div key={segment.key} className={`${CHAT_RAIL_CLASS} pt-4`}>
            <AskUserRecordBlock toolCall={segment.toolCall} />
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
      const messageSourceId = msg.sourceEventId ?? msg.id;
      const isLiveStreamingMessage = msg.id === LIVE_STREAMING_MESSAGE_ID;
      const isSelectingText = isSameMessageTarget(selectingMessageTarget, msg, messageAnchorKey);
      const failedOptimisticMessage = isFailedOptimisticChatMessage(msg) ? msg : null;
      const canRetryFailedMessage = Boolean(
        failedOptimisticMessage && (sessionId !== null || onCreateAndSend),
      );
      const menuBindings = isLiveStreamingMessage || isSelectingText
        ? null
        : bindMessageMenu(messageAnchorKey, () => {});
      const isLongPressTarget = !isLiveStreamingMessage && isMessageLongPressTarget(messageAnchorKey);
      // A reply reads as the continuation of the work that produced it, so it sits closer to it.
      const followsActivity = msg.role === "assistant" && renderBlocks[index - 1]?.type === "activity";
      const actionSlot = isLiveStreamingMessage || isSelectingText ? undefined : (
        <MessageActionToolbar
          messageKey={messageAnchorKey}
          message={msg}
          copied={copiedMessageKey === messageAnchorKey}
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
              if (messageSourceId) sourceMessageElementRefs.current.set(messageSourceId, node);
            } else {
              messageElementRefs.current.delete(messageAnchorKey);
              if (messageSourceId) sourceMessageElementRefs.current.delete(messageSourceId);
            }
          }}
          data-chat-message-key={messageAnchorKey}
          data-latest-chat-message={messageAnchorKey === latestMessageAnchorKey ? "true" : undefined}
          data-message-actions-trigger={menuBindings ? "true" : undefined}
          data-message-text-selection={isSelectingText ? "true" : undefined}
          data-source-event-id={messageSourceId}
          className={`${CHAT_RAIL_CLASS} relative ${followsActivity ? "pt-2" : "pt-5"} transition-colors ${
            isLongPressTarget ? "bg-bg-hover/50" : ""
          } ${historicalMode && messageSourceId === targetSourceEventId ? "bg-warning/10 ring-1 ring-inset ring-warning/30" : ""}`}
          onClick={menuBindings?.onClick}
          onContextMenu={menuBindings ? (event: ReactMouseEvent<HTMLDivElement>) => {
            if (shouldUseNativeMessageContextMenu(event.currentTarget, event.target)) return;
            event.preventDefault();
            openMessageActionsMenu(event.clientX, event.clientY, messageAnchorKey, msg);
          } : undefined}
          onTouchStart={menuBindings ? (event: ReactTouchEvent<HTMLDivElement>) => {
            if (targetMatchesSelector(event.target, MESSAGE_TOUCH_CONTROL_SELECTOR)) return;
            if (!menuBindings) return;
            setMessageMenuTarget({ key: messageAnchorKey, message: msg });
            menuBindings.onTouchStart(event);
          } : undefined}
          onTouchMove={menuBindings?.onTouchMove}
          onTouchEnd={menuBindings?.onTouchEnd}
          onTouchCancel={menuBindings?.onTouchCancel}
        >
          <MessageBubble
            message={msg}
            actionSlot={actionSlot}
            isStreaming={isLiveStreamingMessage}
            selectingText={isSelectingText}
            onFinishSelectingText={isSelectingText ? handleFinishSelectingMessageText : undefined}
            onRetry={canRetryFailedMessage && failedOptimisticMessage
              ? () => { void handleRetryMessage(failedOptimisticMessage); }
              : undefined}
          />
        </div>,
      );
    });

    return result;
  }, [
    activityExpansion,
    bindMessageMenu,
    copiedMessageKey,
    handleToggleActivity,
    intentText,
    latestMessageAnchorKey,
    liveActivityKey,
    messageAnchorKeys,
    renderBlocks,
    handleCopySpecificMessage,
    handleFinishSelectingMessageText,
    handleRetryMessage,
    isMessageLongPressTarget,
    onCreateAndSend,
    openMessageActionsMenu,
    selectingMessageTarget,
    sessionId,
    historicalMode,
    targetSourceEventId,
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

  const planButton = (
    <Button size="sm" variant="ghost" icon={<ClipboardList size={13} />} onClick={() => planOverlay.open("plan")} title="Open this session's plan">
      Plan
    </Button>
  );

  return (
    <div
      ref={setChatRoot}
      className="chat-ui flex-1 flex flex-col min-h-0"
      data-action-gutter={hasActionGutter ? "true" : undefined}
    >
      {historicalMode && (
        <div className="shrink-0 border-b border-border px-3 py-1.5 sm:px-4">
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {returnToSearch && <Button variant="ghost" className="-ml-2" icon={<ArrowLeft size={14} />} onClick={() => navigate(returnToSearch)}>Back to results</Button>}
            <span className="min-w-0 text-text-muted">{targetSourceEventId ? "Viewing saved history around an exact message." : "Viewing the latest saved history for this conversation."} This does not resume the chat.{historicalHasNewer ? " Newer messages are available." : ""}</span>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {navigableMatchTotal > 1 && <>
                <Button variant="ghost" disabled={searchMatchPageLoading || navigableMatchOffset + historicalMatchIndex <= 0} onClick={() => { void moveHistoricalMatch(-1); }}>Previous match</Button>
                <span className="px-1 tabular-nums text-text-muted">{activeSearchMatchPage
                  ? `${Math.max(1, navigableMatchOffset + historicalMatchIndex + 1)} of ${navigableMatchTotal}${matchCoveragePartial ? " indexed" : ""}`
                  : `${Math.max(1, historicalMatchIndex + 1)} of ${navigableMatchTotal} in loaded context`}</span>
                <Button variant="ghost" disabled={searchMatchPageLoading || navigableMatchOffset + historicalMatchIndex + 1 >= navigableMatchTotal} onClick={() => { void moveHistoricalMatch(1); }}>Next match</Button>
              </>}
              {targetSourceEventId && <Button variant="ghost" icon={copiedMessageLink ? <Check size={13} /> : <Copy size={13} />} onClick={handleCopyMessageLink}>
                {copiedMessageLink ? "Copied" : "Copy link"}
              </Button>}
              {hasPlan && planButton}
              <Button onClick={handleExitHistoricalMode}>Jump to latest</Button>
            </div>
          </div>
          {messageLinkCopyError && <p role="alert" className="mx-auto mt-1 w-full max-w-4xl text-xs text-error">Could not copy the message link: {messageLinkCopyError}</p>}
          {searchMatchPageError && <p role="alert" className="mx-auto mt-1 w-full max-w-4xl text-xs text-error">Could not load full-chat match navigation: {searchMatchPageError}</p>}
          {activeSearchMatchPage && matchCoveragePartial && <p role="status" className="mx-auto mt-1 w-full max-w-4xl text-xs text-warning">
            Full-chat navigation reflects partial search coverage ({activeSearchMatchPage.coverage.state}).
            {activeSearchMatchPage.coverage.errors.length > 0 ? ` ${activeSearchMatchPage.coverage.errors.join(" ")}` : ""}
          </p>}
          {!activeSearchMatchPage && searchQuery && !searchMatchPageLoading && !searchMatchPageError && <p role="status" className="mx-auto mt-1 w-full max-w-4xl text-xs text-warning">
            Full-chat match paging is unavailable for this message; Previous and Next cover only the loaded history window.
          </p>}
        </div>
      )}
      {/* One line of chrome: what this session is, what it runs on, and how it is doing. */}
      {!historicalMode && <McpStatusBar
        leading={sessionModelSummary}
        actions={hasPlan ? planButton : undefined}
        chatEntries={displayEntries}
        context={sessionContext}
        contextError={sessionContextError}
        contextLoading={sessionContextLoading}
        liveContextSummary={streamContextSummary}
        sessionCostLoading={sessionCostLoading}
        sessionCostUsd={sessionUsageMetricsQuery.data?.costUsd}
        sessionUsage={sessionUsageMetricsQuery.data}
        sessionCostError={sessionUsageMetricsQuery.error instanceof Error
          ? sessionUsageMetricsQuery.error.message
          : sessionUsageMetricsQuery.error ? String(sessionUsageMetricsQuery.error) : undefined}
        servers={mcpStatusQuery.data?.servers ?? []}
        toolReadiness={mcpStatusQuery.data?.toolReadiness ?? undefined}
        statusState={!sessionId
          ? "ready"
          : mcpStatusQuery.error
            ? mcpStatusQuery.data === undefined ? "error" : "stale"
            : mcpStatusQuery.data === undefined ? "loading" : "ready"}
        statusError={mcpStatusQuery.error instanceof Error
          ? mcpStatusQuery.error.message
          : mcpStatusQuery.error ? String(mcpStatusQuery.error) : undefined}
        onAuthenticate={sessionId ? handleMcpAuthenticate : undefined}
        onRefresh={sessionId ? refreshMcpStatus : undefined}
      />}
      {!historicalMode && <SessionAgentsBar sessionId={sessionId} backgroundAgents={backgroundAgents} />}
      {externallyInUse && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-text-muted sm:px-4" role="status">
          <Terminal size={12} className="shrink-0 text-info" aria-hidden="true" />
          <span>This session is open in another Copilot client. Sending here is still allowed.</span>
        </div>
      )}
      {loading && displayEntries.length === 0 ? (
        <LoadingSkeletonRegion
          isLoading
          label="Loading chat history"
          className="flex-1 flex items-end overflow-hidden pb-6"
        >
          {/* The shape of a transcript: a prompt in its bubble, a reply as plain text. */}
          <div className={`${CHAT_RAIL_CLASS} space-y-6`}>
            <div className="ml-auto w-2/5 max-w-md rounded-2xl bg-bg-elevated px-4 py-3">
              <SkeletonText lines={1} widths={["70%"]} />
            </div>
            <div className="max-w-2xl">
              <SkeletonText lines={3} widths={["94%", "82%", "48%"]} />
            </div>
            <Skeleton height={10} width={168} shape="pill" />
            <div className="max-w-2xl">
              <SkeletonText lines={4} widths={["90%", "96%", "74%", "38%"]} />
            </div>
          </div>
        </LoadingSkeletonRegion>
      ) : historicalUnavailable ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-base font-medium text-text-primary">This saved message is unavailable.</p>
          <p className="max-w-lg text-sm text-text-muted">It may have been removed or the readable history window could not be retrieved. Bridge did not substitute the latest messages.</p>
          {returnToSearch && <Button onClick={() => navigate(returnToSearch)}>Back to results</Button>}
        </div>
      ) : historicalLoadError ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-base font-medium text-error">{historicalLoadError}</p>
          <p className="max-w-lg text-sm text-text-muted">Bridge did not resume the session or substitute another history window.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => loadAndReconnectRef.current()}>Retry</Button>
            {returnToSearch && <Button variant="ghost" onClick={() => navigate(returnToSearch)}>Back to results</Button>}
          </div>
        </div>
      ) : displayEntries.length === 0 && !runNotice && !isStreaming && !creating && !hasPendingInteractions ? (
        emptyState ?? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-text-faint">
            Send a message to get started
          </div>
        )
      ) : (
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden"
          onScroll={handleScroll}
          onWheel={handleUserScrollIntent}
          onTouchMove={handleUserScrollIntent}
        >
          {showHistorySync && (
            <div
              role="status"
              aria-live="polite"
              className="sticky top-0 z-10 border-b border-border bg-bg-primary/90 backdrop-blur-sm"
            >
              <div className="history-sync-bar" aria-hidden="true" />
              <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs">
                <span className={cx("font-medium", DS.motion.live)}>Syncing chat history…</span>
                <span className="hidden text-text-faint sm:inline">{historySyncDetail}</span>
              </div>
            </div>
          )}
          {loadMoreError && (
            <div className="px-3 py-2 text-center text-xs text-error" role="alert">
              {loadMoreError}
            </div>
          )}
          {loadingMore ? (
            <div className="py-3 text-center text-xs" role="status">
              <span className={DS.motion.live}>Loading older messages...</span>
            </div>
          ) : hasMore && !historicalMode ? (
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
          {/* Cached transcript dims and shimmers while the disk read is in flight; live content below stays crisp. */}
          <ChatRunActiveProvider value={runActive}>
            <div className={showHistorySync ? "history-syncing" : undefined}>
              {renderedEntries}
            </div>
          </ChatRunActiveProvider>
          {pendingContent && <div className="pt-4">{pendingContent}</div>}
          {!historicalMode && showJumpToLatest && (
            <div className="sticky bottom-3 z-20 flex justify-center px-3 pointer-events-none">
              <button
                type="button"
                aria-label="Jump to latest"
                title="Jump to latest"
                onClick={historicalMode ? handleExitHistoricalMode : handleJumpToLatest}
                className={cx("pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-border bg-bg-elevated/95 text-text-secondary backdrop-blur transition-colors hover:bg-bg-hover hover:text-text-primary", DS.surface.lift, DS.focus)}
              >
                <ArrowDown size={16} aria-hidden="true" />
                <span className="sr-only">Jump to latest</span>
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
          onSelectText={handleSelectMessageText}
          onFork={handleForkMessageMenu}
          onUndo={handleUndoMessageMenu}
        />
      )}
      {forkError && (
        <div className={`${CHAT_RAIL_CLASS} pb-2`}>
          <Notice tone="danger" icon={<CircleAlert size={14} />}>{forkError}</Notice>
        </div>
      )}
      {undoError && (
        <div className={`${CHAT_RAIL_CLASS} pb-2`}>
          <Notice tone="danger" icon={<CircleAlert size={14} />}>{undoError}</Notice>
        </div>
      )}
      {!historicalMode && composerAccessory}
      {!historicalMode && <ChatInput
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
        onDiscardVoiceRecording={onDiscardVoiceRecording}
        disabled={composerDisabled}
        disabledHint={composerDisabledHint}
        slashCommands={slashCommands}
        slashCommandsSupported={slashCommandsSupported}
        defaultSendMode={defaultSendMode}
        hideVoiceInput={hideVoiceInput}
        placeholder={composerPlaceholder}
        focusRequest={composerFocusRequest}
      />}
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
