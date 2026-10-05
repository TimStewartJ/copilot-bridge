import UserInputQuestionCard from "./UserInputQuestionCard";
import {
  Component,
  createRef,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useQueryClient, replaceEqualDeep } from "@tanstack/react-query";
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
  type SlashCommandInfo,
  type ToolCall,
  type TranscriptAgent,
  type UserInputAnswerEndpointPayload,
} from "../api";
import { getCachedChatSnapshot, keepLoadedEntries, replaceHistoryWindow, setCachedChatSnapshot } from "../chat-cache";
import { timeAgo } from "../time";
import type { VoiceBackgroundJob } from "../hooks/useBackgroundVoiceJobs";
import { writeClipboardText } from "../lib/clipboard";
import { haptic } from "../lib/haptics";
import { getAppAbsoluteUrl } from "../lib/app-url";
import { textMatchesSearchQuery } from "../lib/search-text";
import { deriveLiveRunHeaderState } from "../lib/live-run-phase";
import { summarizeAutopilotRuns } from "../lib/autopilot-runs";
import { resolveExternalSessionWorkAction } from "../lib/external-session-work";
import { buildToolCallForest, getActiveToolCallRoots, segmentChatEntries } from "../lib/tool-call-tree";
import { groupActivitySegments, mapLatestAgentBlocks } from "../lib/chat-activity";
import { describeToolCall, describeToolCallBriefly } from "../lib/tool-presentation";
import {
  attachTranscriptAgents,
  buildAgentPlaceholders,
  describeWaitingOnAgents,
  getWorkingAgents,
  withoutWorkingAgents,
  type AgentAttachmentCache,
} from "../lib/transcript-agents";
import { buildTranscriptAgentDirectory, getTopLevelAgentToolCallId } from "../../shared/transcript-agents.js";
import type { SubmitVoiceCapture } from "../lib/voice-submit-mode";
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
import { MessageActionsMenu, type MessageActionMenuTarget } from "./MessageActions";
import VisualArtifactCard from "./VisualArtifactCard";
import SkillLoadedCard from "./SkillLoadedCard";
import AskUserRecordBlock from "./chat/AskUserRecord";
import ActivityBlock from "./chat/ActivityBlock";
import { ChatRunActiveProvider } from "./chat/chat-run-context";
import { TranscriptAgentsProvider, type TranscriptAgentsContextValue } from "./chat/transcript-agents-context";
import LiveStatusLine from "./chat/LiveStatusLine";
import AutopilotRunLine from "./chat/AutopilotRunLine";
import { DS, cx } from "../design/tokens";
import { AutopilotIcon, Button, Notice } from "../design/primitives";
import ChatInput from "./ChatInput";
import PlanSheet from "./PlanSheet";
import McpStatusBar from "./McpStatusBar";
import SessionAgentsBar from "./SessionAgentsBar";
import { ArrowDown, ArrowLeft, Check, CircleAlert, CircleSlash, ClipboardList, Copy, Terminal } from "lucide-react";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";
import { prefersReducedMotion } from "../lib/motion";

const INITIAL_PAGE_SIZE = 50;
/** Older pages make the server read the whole event log, so fewer, larger pages cost less. */
const OLDER_PAGE_SIZE = 200;
const STREAM_RENDER_INTERVAL_MS = 60;
/**
 * Minimum spacing between background history refreshes. The first request after a quiet period
 * reads immediately; further ones inside the window collapse into one trailing read, so a burst
 * of tool events cannot storm the reader.
 */
const HISTORY_REFRESH_THROTTLE_MS = 250;
/** Most entries a refresh of the newest history re-reads; older loaded entries are kept as they are. */
const HISTORY_REFRESH_MAX_LIMIT = 200;
/** How long the transcript must sit still, with no finger on it, before older messages go in above. */
const SCROLL_REST_MS = 120;
/** After this long they go in regardless, in case the end of a touch never reaches the page. */
const SCROLL_REST_TIMEOUT_MS = 5_000;
/** How many rows a change to the transcript is measured against; the change may replace some of them. */
const VIEWPORT_ANCHOR_ROWS = 4;
/**
 * A row overlapping the viewport top by no more than this is not in view: landing on a row
 * leaves a fraction of a pixel of the one above.
 */
const VIEWPORT_EDGE_PX = 1;
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
  onSubmitVoiceCapture: SubmitVoiceCapture;
  onReviewVoiceJob?: (composerKey: string) => void;
  onClearVoiceJobError?: (composerKey: string) => void;
  onRetryVoiceJobUpload?: (composerKey: string) => void;
  onDiscardVoiceRecording?: (composerKey: string) => void;
  reloadToken?: number;
  /** Incremented when an external source (e.g. schedule) starts work on this session */
  busySignal?: number;
  /** Incremented when server history was truncated and the loaded window must be replaced. */
  historySignal?: number;
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

/**
 * Runs `onAdvance` when `counter` rises while `scope` stays the same. A new scope only re-bases
 * the comparison, so a per-session counter never fires for the session being navigated to.
 */
function useCounterAdvance(scope: unknown, counter: number, onAdvance: () => void): void {
  const seenRef = useRef({ scope, counter });
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;
  useEffect(() => {
    const seen = seenRef.current;
    seenRef.current = { scope, counter };
    if (seen.scope === scope && counter > seen.counter) onAdvanceRef.current();
  }, [counter, scope]);
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

/** A transcript row in or below the viewport, and how far below the viewport top it starts. */
interface ViewportAnchor {
  row: Element;
  offset: number;
}

/** Whether the browser itself keeps the reader's place when content above the viewport changes height. */
function browserAnchorsScrolling(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");
}

/**
 * The first `limit` rows in view, top one first, and where each starts. Any row will do, not only
 * a message: the newest reply is often a completion card, or the steps of a run. Rows stack
 * downwards in document order, so the first one in view is found by bisection.
 */
function captureViewportAnchors(scroller: HTMLElement, rows: Element, limit = VIEWPORT_ANCHOR_ROWS): ViewportAnchor[] {
  const viewportTop = scroller.getBoundingClientRect().top;
  const candidates = rows.children;
  let first = 0;
  let end = candidates.length;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    if (candidates[middle].getBoundingClientRect().bottom > viewportTop + VIEWPORT_EDGE_PX) end = middle;
    else first = middle + 1;
  }
  const anchors: ViewportAnchor[] = [];
  for (let index = first; index < candidates.length && anchors.length < limit; index += 1) {
    anchors.push({ row: candidates[index], offset: candidates[index].getBoundingClientRect().top - viewportTop });
  }
  return anchors;
}

/** How far `anchor` now is from where it was. */
function shiftOf(scroller: HTMLElement, { row, offset }: ViewportAnchor): number {
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
}

/** The viewport top cuts through this row: content can grow inside it, above the view, without its top moving. */
function startsAboveView(anchor: ViewportAnchor): boolean {
  return anchor.offset < -VIEWPORT_EDGE_PX;
}

/**
 * The transcript's rows, with the reader's place held when content above it changes height.
 *
 * Across a change to the rows themselves (older messages going in, a refresh), a row in view is
 * measured as React is about to change the DOM and again once it has, so the difference is only
 * what the change itself moved: growth below (live output), the browser's own scroll anchoring,
 * and scrolling the reader did while the change rendered are all left alone.
 *
 * Content also changes height long after it rendered: an image above the view finishes loading,
 * a preview card fills in. Most browsers anchor scrolling through that themselves. Safari before
 * 27 does not, so there the top row in view is put back where it was. Only growth above that row
 * moves it, never something the reader opens in view.
 *
 * Nothing is written when nothing shifted or while the reader is scrolling, because moving a
 * scroller cuts a touch scroll short.
 */
class ViewportKeeper extends Component<{
  scrollerRef: RefObject<HTMLElement | null>;
  className?: string;
  /** Asked as the DOM is about to change: must this change leave the reader's view where it is? */
  shouldKeep: () => boolean;
  /** Whether the reader has stopped scrolling and has no finger on the transcript. */
  atRest: () => boolean;
  /** Moves the transcript by `delta` without it counting as the reader scrolling. */
  shift: (scroller: HTMLElement, delta: number) => void;
  children: ReactNode;
}> {
  private readonly rows = createRef<HTMLDivElement>();
  /** Reports late changes in the rows' height; unused where the browser anchors scrolling itself. */
  private observer: ResizeObserver | null = null;
  /** The top row in view and the scroll position, as of the last render or movement of the view. */
  private settled: { anchor: ViewportAnchor | undefined; scrollTop: number } | null = null;
  private settling = false;

  componentDidMount() {
    if (browserAnchorsScrolling() || typeof ResizeObserver === "undefined" || !this.rows.current) return;
    this.observer = new ResizeObserver(() => {
      this.holdSettled();
      this.settle();
    });
    this.observer.observe(this.rows.current);
    this.settleSoon();
  }

  getSnapshotBeforeUpdate(): { anchors: ViewportAnchor[]; scrollTop: number } | null {
    // A late change the observer has yet to report must not pass for part of this render.
    this.holdSettled();
    const scroller = this.props.scrollerRef.current;
    const rows = this.rows.current;
    if (!scroller || !rows || !this.props.shouldKeep()) return null;
    const anchors = captureViewportAnchors(scroller, rows);
    // Earlier steps joining a run grow its row above the view, so rows that start in view come first.
    if (anchors.length > 1 && startsAboveView(anchors[0])) anchors.push(anchors.shift()!);
    return { anchors, scrollTop: getSafeScrollTop(scroller) };
  }

  componentDidUpdate(_props: unknown, _state: unknown, before: { anchors: ViewportAnchor[]; scrollTop: number } | null) {
    const scroller = this.props.scrollerRef.current;
    const anchor = before?.anchors.find(({ row }) => this.rows.current?.contains(row));
    if (scroller && before && anchor) {
      const delta = shiftOf(scroller, anchor);
      // The view moving by itself during the render is the browser's scroll anchoring, which
      // holds a line inside a row. That row's own top then says nothing about what moved.
      const heldByBrowser = startsAboveView(anchor) && getSafeScrollTop(scroller) !== before.scrollTop;
      if (Math.abs(delta) >= 1 && !heldByBrowser) this.props.shift(scroller, delta);
    }
    this.settleSoon();
  }

  componentWillUnmount() {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** The view moved, so late changes are measured from where it is now. */
  moved() {
    const scroller = this.props.scrollerRef.current;
    // The scroll event for a move made from code arrives a frame later. By then an image may
    // have loaded, and measuring again would take its shift for granted.
    if (this.observer && scroller && this.settled?.scrollTop !== getSafeScrollTop(scroller)) this.settle();
  }

  /** Puts the top row back where it was if content above it has changed height since. */
  private holdSettled() {
    const scroller = this.props.scrollerRef.current;
    const settled = this.settled;
    if (!scroller || !settled?.anchor || !this.rows.current?.contains(settled.anchor.row)) return;
    if (settled.scrollTop !== getSafeScrollTop(scroller) || !this.props.atRest()) return;
    const delta = shiftOf(scroller, settled.anchor);
    if (Math.abs(delta) >= 1) this.props.shift(scroller, delta);
  }

  private settle() {
    const scroller = this.props.scrollerRef.current;
    const rows = this.rows.current;
    this.settled = scroller && rows
      ? { anchor: captureViewportAnchors(scroller, rows, 1)[0], scrollTop: getSafeScrollTop(scroller) }
      : null;
  }

  /** Settles once the render is over, after the layout effects that put the view where it belongs. */
  private settleSoon() {
    if (!this.observer || this.settling) return;
    this.settling = true;
    queueMicrotask(() => {
      this.settling = false;
      if (this.observer) this.settle();
    });
  }

  render() {
    return <div ref={this.rows} className={this.props.className}>{this.props.children}</div>;
  }
}

/** When the reader last moved the transcript, and whether a finger is on it. */
interface ScrollActivity {
  movedAt: number;
  touching: boolean;
}

/**
 * Resolves once the reader has stopped scrolling. Content going in above them means moving the
 * scroller to hold their place, and doing that mid-gesture stops a touch scroll dead; where the
 * browser cannot anchor scrolling itself (Safari before 27) it also lands on a stale position.
 */
function scrollerAtRest(activity: ScrollActivity): Promise<void> {
  const giveUpAt = Date.now() + SCROLL_REST_TIMEOUT_MS;
  return new Promise((resolve) => {
    const check = () => {
      if (Date.now() >= giveUpAt) {
        resolve();
        return;
      }
      const wait = activity.touching ? SCROLL_REST_MS : activity.movedAt + SCROLL_REST_MS - Date.now();
      if (wait > 0) {
        setTimeout(check, wait);
        return;
      }
      // Scroll events held up behind a long task are delivered before the next frame's callbacks.
      const { movedAt } = activity;
      window.requestAnimationFrame(() => {
        if (activity.movedAt === movedAt && !activity.touching) resolve();
        else check();
      });
    };
    check();
  });
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

/**
 * How far back a refresh re-reads, shallowest first: "live" the newest page, which is all a run
 * in flight rewrites; "tail" the newest entries a finished run may have touched; "window" every
 * loaded entry, because what is loaded may no longer match disk.
 */
const HISTORY_REACHES = ["live", "tail", "window"] as const;
type HistoryReach = (typeof HISTORY_REACHES)[number];

function deeperReach(a: HistoryReach = "tail", b: HistoryReach = "tail"): HistoryReach {
  return HISTORY_REACHES[Math.max(HISTORY_REACHES.indexOf(a), HISTORY_REACHES.indexOf(b))];
}

/** How a background refresh reconciles the loaded history window with disk. */
interface HistoryRefresh {
  /** "tail" unless said otherwise. */
  reach?: HistoryReach;
  /** Routine refreshes are the steady state of a run; they show no strip and disable no actions. */
  silent?: boolean;
  /** Replace the run's stream even if it looks healthy; one that died while the tab slept is otherwise kept. */
  reconnect?: boolean;
}

/** What one disk read fetches: "load" the newest page for a navigation, or a refresh of some reach. */
type HistoryReadMode = "load" | HistoryReach;

/** The open session's disk reads. Replaced on every navigation and inert once it is left. */
interface HistoryReader {
  /** The navigation's own read, behind the loading skeleton. */
  load(): void;
  /** Ask for a background refresh. Requests that arrive before it can start collapse into one read. */
  refresh(request?: HistoryRefresh): void;
  /** Drop a visible refresh that is in flight: its result predates the send about to start a run. */
  abandonVisibleRefresh(): void;
}

const NO_HISTORY_READER: HistoryReader = { load() {}, refresh() {}, abandonVisibleRefresh() {} };
/** `applyHistory` options for a transcript that is not a session's disk history: empty, or a load error. */
const NO_HISTORY = { ownerSessionId: null, firstItemIndex: 0 } as const;
/** A session that has run no sub-agents, or one whose history has not been read yet. */
const NO_AGENT_RECORDS: readonly TranscriptAgent[] = Object.freeze([]);
const NO_AGENT_BLOCKS: ReadonlyMap<string, string> = new Map();

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

const MESSAGE_TOUCH_CONTROL_SELECTOR = "button, input, textarea, select, [contenteditable]:not([contenteditable=\"false\"]), a, img, audio, video";
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
   * Every sub-agent the session has run, as its last history read reported them. A step names its
   * agent, and the call that launched the agent is usually far above the loaded window.
   */
  const [agentRecords, setAgentRecords] = useState<readonly TranscriptAgent[]>(NO_AGENT_RECORDS);
  const agentRecordsRef = useRef<readonly TranscriptAgent[]>(NO_AGENT_RECORDS);
  const applyAgentRecords = useCallback((next: readonly TranscriptAgent[] | undefined) => {
    if (!next) return;
    // A read mostly repeats what is known; keeping those objects spares the agents' rows a render.
    const kept = next.length === 0 ? NO_AGENT_RECORDS : replaceEqualDeep(agentRecordsRef.current, next);
    if (kept === agentRecordsRef.current) return;
    agentRecordsRef.current = kept;
    setAgentRecords(kept);
  }, []);
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
  // The agents list is a sheet on a phone, opened the same way so the back button closes it.
  const showAgents = planOverlay.isOpen && planOverlay.value === "agents";
  const openAgentsSheet = useCallback(() => planOverlay.open("agents"), [planOverlay.open]);
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
  const historyLastVisibleActivityAtRef = useRef<string | undefined>(undefined);
  /** When the displayed window was last read from disk; drives the "showing messages from…" hint. */
  const historyFetchedAtRef = useRef<number | null>(null);
  const entriesRef = useRef<ChatEntry[]>([]);
  const pendingSendsRef = useRef<PendingSend[]>([]);
  const sessionIdRef = useRef<string | null>(sessionId);
  const loadingMoreRef = useRef(false);
  /** Set by a history apply that must not move what the reader is looking at; cleared once it is on screen. */
  const keepViewportRef = useRef(false);
  const scrollActivityRef = useRef<ScrollActivity>({ movedAt: 0, touching: false });
  const viewportKeeperRef = useRef<ViewportKeeper>(null);
  /** Where the last scroll event left the transcript, to tell which way the next one moved. */
  const lastScrollTopRef = useRef(0);
  const historyRef = useRef(NO_HISTORY_READER);
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
      lastVisibleActivityAt?: string | null;
      /** Disk read time of `nextEntries`; defaults to now. Cached resumes pass the snapshot's. */
      fetchedAt?: number;
      persistSnapshot?: boolean;
      reportReadThrough?: boolean;
      /** Keep the first visible message still unless the view is following the bottom. */
      keepViewport?: boolean;
    } = {},
  ) => {
    const ownerSessionId = opts.ownerSessionId === undefined ? sessionIdRef.current : opts.ownerSessionId;
    const nextFirstItemIndex = opts.firstItemIndex ?? firstItemIndex.current;

    keepViewportRef.current = Boolean(opts.keepViewport);
    firstItemIndex.current = nextFirstItemIndex;
    const nextLastVisibleActivityAt = opts.lastVisibleActivityAt === null
      ? undefined
      : opts.lastVisibleActivityAt ?? historyLastVisibleActivityAtRef.current;
    historyLastVisibleActivityAtRef.current = ownerSessionId ? nextLastVisibleActivityAt : undefined;
    entriesRef.current = nextEntries;
    setEntries(nextEntries);
    setHasMore(nextFirstItemIndex > 0);

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
      fetchedAt,
      agents: agentRecordsRef.current,
    });
  }, [queryClient]);

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
    dropFinishedRunOutput,
    activeTurnId,
    activeTurnInstanceId,
    mainAgentIdle = false,
  } = useSessionStream(historicalMode ? null : sessionId, onMessageSent, onMessageSent, refreshMcpObservation);
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
  /**
   * Calls that launched an agent in an earlier part of the session. An agent keeps reporting on
   * its launching call for as long as it works, and that call is usually far above the loaded
   * window: such a report updates a row that is not here, and must not add one at the bottom.
   */
  const earlierAgentLaunchIds = useMemo(
    () => new Set(agentRecords.map((agent) => agent.toolCallId)),
    [agentRecords],
  );
  /** Tools disk history has not surfaced at all yet; these append to the overlay. */
  const uncommittedLiveTools = useMemo(
    () => liveTools.filter((tool) => (
      !committedToolCallIds.has(tool.toolCallId)
      && !isCommittedByWatermark(tool.startedAt)
      // The stream saw this call start, or it is not a launch the session's history already has.
      && (tool.startedAt !== undefined || !earlierAgentLaunchIds.has(tool.toolCallId))
    )),
    [committedToolCallIds, earlierAgentLaunchIds, isCommittedByWatermark, liveTools],
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


  // Load history when the session, or the saved message being viewed, changes.
  const prevSessionRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prevSession = prevSessionRef.current;
    prevSessionRef.current = sessionId;
    setForkError(null);
    setUndoError(null);
    setUndoingEventId(null);
    setLoadMoreError(null);
    pendingSendsRef.current = [];
    setPendingSends([]);
    setCreating(false);
    setShowJumpToLatest(false);
    cancelFollowScroll();
    clearProgrammaticScroll();
    anchoredMessageKeyRef.current = null;
    latestMessageAnchorKeyRef.current = null;
    pendingLiveAnchorCarryRef.current = false;
    messageElementRefs.current.clear();
    loadingMoreRef.current = false;
    setLoadingMore(false);
    lastScrollTopRef.current = 0;
    if (prevSession !== sessionId) {
      // Arm the landing anchor per navigation only. Re-running this effect for the same session
      // (composer or callback identity churn) must not yank an established reading position.
      pendingInitialAnchorRef.current = sessionId !== null && !historicalMode;
      loadAnchoredMessageKeyRef.current = null;
    }
    if (!sessionId) {
      applyAgentRecords(NO_AGENT_RECORDS);
      applyHistory([], NO_HISTORY);
      setLoading(false);
      setRefreshingHistory(false);
      setWarming(false);
      return;
    }

    // A session starts out following output, wherever the previous one was scrolled to.
    stickToBottomRef.current = true;
    const controller = new AbortController();
    const navigatedAt = performance.now();
    let loadReported = false;
    let readId = 0;
    let visibleRefresh = false;
    const endRead = () => {
      setLoading(false);
      visibleRefresh = false;
      setRefreshingHistory(false);
    };

    // Disk is the sole authority for committed transcript ordering, so every read replaces what it covers.
    const read = async (
      mode: HistoryReadMode,
      { silent = false, reconnect: replaceStream = false }: HistoryRefresh = {},
    ): Promise<void> => {
      const id = ++readId;
      const superseded = () => controller.signal.aborted || id !== readId;
      if (mode === "load") {
        setLoading(true);
        setWarming(false);
        if (historicalMode) {
          setHistoricalUnavailable(false);
          setHistoricalLoadError(null);
        }
      }
      visibleRefresh = mode !== "load" && !silent;
      setRefreshingHistory(visibleRefresh);
      const loaded = Math.max(INITIAL_PAGE_SIZE, entriesRef.current.length);
      const limit = mode === "window"
        ? loaded
        : mode === "tail" ? Math.min(HISTORY_REFRESH_MAX_LIMIT, loaded) : INITIAL_PAGE_SIZE;
      try {
        const { messages: fetched, runState, total, warm, lastVisibleActivityAt, startOffset, hasNewer, agents } = await fetchMessagesFast(
          sessionId,
          targetSourceEventId ? { before: 50, after: 50, aroundEventId: targetSourceEventId } : { limit },
        );
        if (superseded()) return;
        // Before the entries, so the snapshot cached with them holds the agents they name.
        applyAgentRecords(agents ?? NO_AGENT_RECORDS);
        const windowStart = Math.max(0, total - fetched.length);
        // A refresh mostly returns what is already loaded; keeping those objects spares their rows a render.
        const msgs = mode === "load"
          ? fetched
          : keepLoadedEntries(entriesRef.current, firstItemIndex.current, fetched, windowStart);
        const busy = runState !== "idle";
        setHistoryRunBusy(busy);
        const disk = { ownerSessionId: sessionId, lastVisibleActivityAt: lastVisibleActivityAt ?? null };
        if (historicalMode) {
          const found = !targetSourceEventId || msgs.some((entry) => isChatMessageEntry(entry)
            && (entry.sourceEventId === targetSourceEventId || entry.id === targetSourceEventId));
          setHistoricalUnavailable(!found);
          setHistoricalHasNewer(Boolean(hasNewer));
          stickToBottomRef.current = false;
          applyHistory(found ? msgs : [], {
            ...disk,
            firstItemIndex: startOffset ?? windowStart,
            persistSnapshot: false,
            reportReadThrough: false,
          });
        } else if (mode === "live" || mode === "tail") {
          const merged = replaceHistoryWindow(entriesRef.current, firstItemIndex.current, msgs, total);
          // More arrived than this read covers; reach further back rather than show a hole.
          if (merged.hasGap) {
            return await read(mode === "live" ? "tail" : "window", { silent, reconnect: replaceStream });
          }
          applyHistory(merged.entries, { ...disk, firstItemIndex: merged.firstItemIndex, keepViewport: true });
        } else if (mode === "window" && entriesRef.current.length > limit) {
          // An older page went in above while this was read; replacing the window would drop it.
          return await read("window", { silent, reconnect: replaceStream });
        } else {
          applyHistory(msgs, { ...disk, firstItemIndex: windowStart, keepViewport: mode === "window" });
        }
        endRead();
        if (historicalMode) return;

        if (!loadReported) {
          // Time from navigation to fresh messages on screen.
          loadReported = true;
          reportTiming("page.sessionLoad", Math.round(performance.now() - navigatedAt), {
            sessionId,
            metadata: { messageCount: msgs.length, warm, busy },
          }).catch(() => {});
        }
        if (busy) {
          if (replaceStream) reconnect(sessionId);
          else ensureConnected(sessionId);
        } else if (!warm) {
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
      } catch (err) {
        if (superseded()) return;
        if (historicalMode) {
          applyHistory([], NO_HISTORY);
          if (targetSourceEventId && err instanceof ApiError && err.status === 404) {
            setHistoricalUnavailable(true);
          } else {
            setHistoricalLoadError(`Could not load this saved message: ${getErrorMessage(err)}`);
          }
        } else if (mode === "load") {
          applyHistory(
            [{ role: "assistant", content: `Error loading history: ${getErrorMessage(err)}` }],
            NO_HISTORY,
          );
        }
        endRead();
      }
    };

    // One read at a time, and refreshes no closer together than the throttle: whatever is asked
    // for in between collapses into the next read, which sees everything the skipped ones would.
    let queued: HistoryRefresh | null = null;
    let inFlight: Promise<void> | null = null;
    let lastRefreshAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const start = (mode: HistoryReadMode, request?: HistoryRefresh) => {
      const reading = read(mode, request).finally(() => {
        if (inFlight !== reading) return;
        inFlight = null;
        pump();
      });
      inFlight = reading;
    };
    const pump = () => {
      if (!queued || inFlight || timer != null || controller.signal.aborted) return;
      const wait = lastRefreshAt + HISTORY_REFRESH_THROTTLE_MS - Date.now();
      if (wait > 0) {
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, wait);
        return;
      }
      const request = queued;
      queued = null;
      lastRefreshAt = Date.now();
      start(request.reach ?? "tail", request);
    };
    const reader: HistoryReader = {
      load: () => start("load"),
      refresh: (request = {}) => {
        queued = queued
          ? {
              reach: deeperReach(queued.reach, request.reach),
              silent: queued.silent && request.silent,
              reconnect: queued.reconnect || request.reconnect,
            }
          : request;
        // A read that was in flight while the tab slept may never return, so waking does not wait on it.
        if (request.reconnect) inFlight = null;
        pump();
      },
      abandonVisibleRefresh: () => {
        if (!visibleRefresh) return;
        readId += 1;
        endRead();
      },
    };
    historyRef.current = reader;

    const cachedSnapshot = historicalMode ? null : getCachedChatSnapshot(queryClient, sessionId);
    if (cachedSnapshot && cachedSnapshot.entries.length > 0) {
      // A cached window is disk-derived, so it paints at once. Anything may have happened to the
      // session since it was cached, so the read behind it covers all of it.
      applyAgentRecords(cachedSnapshot.agents ?? NO_AGENT_RECORDS);
      applyHistory(cachedSnapshot.entries, {
        ownerSessionId: sessionId,
        firstItemIndex: cachedSnapshot.firstItemIndex,
        fetchedAt: cachedSnapshot.fetchedAt,
      });
      setLoading(false);
      setWarming(false);
      reader.refresh({ reach: "window" });
    } else {
      applyAgentRecords(NO_AGENT_RECORDS);
      applyHistory([], NO_HISTORY);
      reader.load();
    }

    // Close plan sheet when switching sessions (close is a stable callback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    planOverlay.close();

    // Reconnect when the tab wakes from sleep (mobile screen-off, etc.)
    const onVisible = () => {
      if (historicalMode || document.visibilityState !== "visible") return;
      reader.refresh({ silent: true, reconnect: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      if (timer != null) clearTimeout(timer);
      historyRef.current = NO_HISTORY_READER;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [
    applyAgentRecords,
    applyHistory,
    cancelFollowScroll,
    clearProgrammaticScroll,
    // Switching between two drafts changes nothing else here, and must still clear the first.
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
    if (action === "reconnect") historyRef.current.refresh();
  }, [busySignal, creating, historicalMode, isStreaming, loading, loadingMore, pendingOrigin, refreshingHistory, sessionId]);

  // The server truncated this session's history (an undo, or a quiet defer replacing its own
  // tail), so nothing that is loaded can be trusted, nor anything a finished run left on screen.
  useCounterAdvance(sessionId, historySignal, () => {
    if (historicalMode) return;
    dropFinishedRunOutput();
    historyRef.current.refresh({ reach: "window" });
  });
  // Committed history moved on disk. While the run goes on only its newest entries change, and
  // once it has finished a wider read picks up what the turn touched. Neither re-reads the whole
  // window, which costs more the further back the reader has scrolled.
  useCounterAdvance(sessionId, historyEpoch, () => {
    if (!historicalMode) historyRef.current.refresh({ silent: true, reach: isStreaming ? "live" : "tail" });
  });
  // An agent that changes state outside a run this view is streaming leaves nothing on the stream
  // to say so. The session list's counts move when it does, so history is read again then.
  const backgroundAgentCounts = backgroundAgents
    ? `${backgroundAgents.running}:${backgroundAgents.idle}:${backgroundAgents.failed}:${backgroundAgents.total}`
    : "";
  const seenBackgroundAgentCountsRef = useRef({ sessionId, counts: backgroundAgentCounts });
  useEffect(() => {
    const seen = seenBackgroundAgentCountsRef.current;
    seenBackgroundAgentCountsRef.current = { sessionId, counts: backgroundAgentCounts };
    if (historicalMode || !sessionId || seen.sessionId !== sessionId || seen.counts === backgroundAgentCounts) return;
    if (!isStreaming) historyRef.current.refresh({ silent: true, reach: "tail" });
  }, [backgroundAgentCounts, historicalMode, isStreaming, sessionId]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

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

  // Follow the bottom unless the reader is elsewhere; `ViewportKeeper` holds their place when
  // they are. useLayoutEffect runs before paint, preventing flash.
  useLayoutEffect(() => {
    keepViewportRef.current = false;
    // When a message is top-anchored, message-key changes handle the next scroll.
    if (stickToBottomRef.current && !anchoredMessageKeyRef.current) {
      scrollToLatest({ immediate: true });
    }
  }, [entries, scrollToLatest]);

  const shouldKeepViewport = useCallback(
    () => keepViewportRef.current && (!stickToBottomRef.current || anchoredMessageKeyRef.current !== null),
    [],
  );
  const shiftTranscript = useCallback((scroller: HTMLElement, delta: number) => {
    programmaticScrollRef.current = true;
    scroller.scrollTop = getSafeScrollTop(scroller) + delta;
    settleProgrammaticScroll();
  }, [settleProgrammaticScroll]);
  const transcriptAtRest = useCallback(() => {
    const { movedAt, touching } = scrollActivityRef.current;
    return !touching && Date.now() - movedAt >= SCROLL_REST_MS;
  }, []);

  const loadOlderMessages = useCallback(async () => {
    const before = firstItemIndex.current;
    if (!sessionId || historicalMode || before <= 0 || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    const requestSessionId = sessionId;
    const isStale = () => sessionIdRef.current !== requestSessionId || firstItemIndex.current !== before;
    try {
      // Only its entries are taken. It also carries the session's agents, but a read of the newest
      // page asked for later can be applied first, and this one would then put older records back.
      const { messages: older, total } = await fetchMessagesFast(requestSessionId, { limit: OLDER_PAGE_SIZE, before });
      await scrollerAtRest(scrollActivityRef.current);
      if (isStale()) return;
      if (total < before) {
        // History shrank under the loaded window, so its indexes no longer line up with disk.
        historyRef.current.refresh({ reach: "window", silent: true });
        return;
      }
      applyHistory([...older, ...entriesRef.current], {
        ownerSessionId: requestSessionId,
        firstItemIndex: before - older.length,
        keepViewport: true,
      });
    } catch (err) {
      if (!isStale()) setLoadMoreError(`Could not load older messages: ${getErrorMessage(err)}`);
    } finally {
      if (sessionIdRef.current === requestSessionId) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [applyHistory, historicalMode, sessionId]);

  const handleLoadOlderClick = useCallback(() => {
    handleUserScrollIntent();
    void loadOlderMessages();
  }, [handleUserScrollIntent, loadOlderMessages]);

  // Track bottom-following, and fetch the previous page once the reader is heading for the top
  // and within a screen of it, so it is usually in place before they get there.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    viewportKeeperRef.current?.moved();
    const top = getSafeScrollTop(el);
    const movedUp = top < lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    if (programmaticScrollRef.current) return;
    // A browser that anchors scrolling moves the view itself when content above it changes
    // height, and that is a scroll event too. The reader is still parked on the same reply.
    const parkedOn = anchoredMessageKeyRef.current;
    const parkedTop = parkedOn ? getMessageTopWithinScroller(parkedOn) : null;
    if (parkedTop != null && Math.abs(parkedTop - top) <= LATEST_MESSAGE_TOP_THRESHOLD_PX) return;
    scrollActivityRef.current.movedAt = Date.now();

    const following = getDistanceFromBottom(el) <= FOLLOW_BOTTOM_THRESHOLD_PX;
    stickToBottomRef.current = following;
    anchoredMessageKeyRef.current = null;
    if (following) {
      setShowJumpToLatest(false);
    } else if (isStreaming || creating || pendingInteractionCount > 0) {
      setShowJumpToLatest(true);
    }

    // Only moving up asks for older messages. A chat often opens near the top of what is loaded
    // (a long reply under a collapsed run), and reading down from there must not fetch anything.
    // A failed page waits for Retry instead of refiring on every scroll event.
    if (movedUp && !loadMoreError && top < el.clientHeight) void loadOlderMessages();
  }, [creating, getMessageTopWithinScroller, isStreaming, loadMoreError, loadOlderMessages, pendingInteractionCount]);

  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const activity = scrollActivityRef.current;
    activity.touching = true;
    // Listen on the touched node itself: once a render replaces it, its touchend no longer
    // reaches the scroller, and a finger that never seems to lift would hold older pages back.
    const lifted = new AbortController();
    const onLift = (end: Event) => {
      lifted.abort();
      activity.touching = (end as TouchEvent).touches.length > 0;
      activity.movedAt = Date.now();
    };
    event.target.addEventListener("touchend", onLift, { signal: lifted.signal });
    event.target.addEventListener("touchcancel", onLift, { signal: lifted.signal });
  }, []);

  // Neither a window too short to scroll nor a reader parked at its very top produces a scroll
  // event that could ask for more, so keep filling from the top.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || loading || loadMoreError || !(el.clientHeight > 0)) return;
    if (getMaxScrollTop(el) > 0 && getSafeScrollTop(el) > 0) return;
    void loadOlderMessages();
  }, [entries, loadMoreError, loadOlderMessages, loading]);

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
  // A queued one is kept by the server.
  const hasUndeliveredMessage = pendingSends.some((send) => send.delivery !== undefined && !send.delivery.queued);
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
      } else if (response?.mode === "queued") {
        updateOptimisticMessageDelivery(messageId, ownerSessionId, {
          failed: false,
          queued: true,
          ...(mode === undefined ? {} : { mode }),
        });
      } else {
        updateOptimisticMessageDelivery(messageId, ownerSessionId, undefined);
      }
      if (ownerSessionId === null && sessionIdRef.current) {
        historyRef.current.refresh({ reach: "window" });
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error).trim() || "Message could not be sent.";
      haptic("error");
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
    historyRef.current.abandonVisibleRefresh();
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
    // A sub-agent's call is in a turn of the agent's own, so the main agent's turn says nothing
    // about where it goes. Its time does: before or after what the main agent has said this turn,
    // which is the side of that text disk history will have it on.
    let currentTurnTextAt = Number.POSITIVE_INFINITY;
    for (const segment of uncommittedAssistantSegments) {
      if (bucketFor(segment.turnInstanceId) !== currentTurnEntries) continue;
      const at = segment.timestamp ? Date.parse(segment.timestamp) : Number.NaN;
      if (Number.isFinite(at)) currentTurnTextAt = Math.min(currentTurnTextAt, at);
    }
    const agentBucketFor = (startedAt?: string) => {
      const at = startedAt ? Date.parse(startedAt) : Number.NaN;
      return Number.isFinite(at) && at >= currentTurnTextAt ? currentTurnEntries : endedTurnEntries;
    };
    for (const tool of uncommittedLiveTools) {
      (tool.parentToolCallId ? agentBucketFor(tool.startedAt) : bucketFor(tool.turnInstanceId)).push({
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
    // A queued message is done waiting once the server starts its turn under the same id.
    const handedOff = (send: PendingSend) => (
      (send.delivery === undefined || send.delivery.queued === true) && projectedUserMessageIds.has(send.id)
    );
    if (!pendingSendsRef.current.some(handedOff)) return;
    updatePendingSends((current) => current.filter((send) => !handedOff(send)));
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
  // The same goes for an agent the records show working.
  const agentDirectory = useMemo(
    () => buildTranscriptAgentDirectory(runActive ? agentRecords : withoutWorkingAgents(agentRecords)),
    [agentRecords, runActive],
  );
  const agentAttachmentCache = useRef<AgentAttachmentCache>(new WeakMap()).current;
  const displayEntries = useMemo(
    () => attachTranscriptAgents(
      liveEntries.length > 0 ? [...committedEntries, ...liveEntries] : committedEntries,
      agentDirectory,
      agentAttachmentCache,
    ),
    [agentAttachmentCache, agentDirectory, committedEntries, liveEntries],
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
  // A step's agent is usually launched above the loaded window; a stand-in gives the step its row.
  const toolForest = useMemo(
    () => buildToolCallForest([...buildAgentPlaceholders(toolEntries, agentDirectory), ...toolEntries]),
    [agentDirectory, toolEntries],
  );
  const activeToolForest = useMemo(() => buildToolCallForest(activeToolCalls), [activeToolCalls]);
  const activeRootNodes = useMemo(() => getActiveToolCallRoots(activeToolForest.roots), [activeToolForest.roots]);
  const renderBlocks = useMemo(
    () => groupActivitySegments(segmentChatEntries(displayEntries), {
      includeUnfinishedQuestions: !runActive,
      agents: agentDirectory,
    }),
    [agentDirectory, displayEntries, runActive],
  );
  // Most changes to the transcript move no agent to another stretch; the rows that read this are
  // only told when one does.
  const latestAgentBlocksRef = useRef<ReadonlyMap<string, string>>(NO_AGENT_BLOCKS);
  const latestBlockByAgent = useMemo(() => {
    const latest = mapLatestAgentBlocks(renderBlocks, latestAgentBlocksRef.current);
    latestAgentBlocksRef.current = latest;
    return latest;
  }, [renderBlocks]);
  const transcriptAgents = useMemo<TranscriptAgentsContextValue>(
    () => ({ directory: agentDirectory, latestBlockByAgent }),
    [agentDirectory, latestBlockByAgent],
  );
  /**
   * The main agent has stopped and the run stays open for agents it launched. The line says how
   * many it is waiting on, not which of them took the last step.
   */
  const waitingOnAgents = useMemo(() => {
    if (!isStreaming || !mainAgentIdle) return undefined;
    const working = getWorkingAgents(agentDirectory);
    return working.length > 0 ? describeWaitingOnAgents(working) : undefined;
  }, [agentDirectory, isStreaming, mainAgentIdle]);
  /**
   * The newest step each agent has taken in this run, by the call that launched it, for the agents
   * list. The stream keeps an agent's calls until its next turn, so the step holds still between them.
   */
  const agentLatestSteps = useMemo(() => {
    const steps = new Map<string, string>();
    for (const tool of liveTools) {
      if (!tool.parentToolCallId) continue;
      const presentation = describeToolCall(
        tool,
        tool.completedAt ? (tool.success === false ? "failed" : "done") : "running",
      );
      steps.set(
        getTopLevelAgentToolCallId(tool.parentToolCallId, agentDirectory),
        describeToolCallBriefly(presentation),
      );
    }
    return steps;
  }, [agentDirectory, liveTools]);
  /** How many of each agent's steps are loaded, for the same list: a step shows there as it is taken. */
  const agentLoadedStepCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agentDirectory.all) {
      const loaded = toolForest.nodesById.get(agent.toolCallId)?.loadedChildCount;
      if (loaded) counts.set(agent.toolCallId, loaded);
    }
    return counts;
  }, [agentDirectory, toolForest]);
  /**
   * While the run is between steps, the block at the end of the transcript is where the next step
   * will land, so it carries the "still working" state instead of a separate indicator below it.
   */
  const autopilotRuns = useMemo(() => summarizeAutopilotRuns(renderBlocks), [renderBlocks]);
  /** The block at the end of the transcript, where a step still in flight is the run's current one. */
  const trailingActivityKey = useMemo(() => {
    const trailing = renderBlocks[renderBlocks.length - 1];
    return trailing?.type === "activity" ? trailing.key : null;
  }, [renderBlocks]);
  const liveActivityKey = isStreaming && !hasStreamingText ? trailingActivityKey : null;
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
          {waitingOnAgents ? (
            <LiveStatusLine
              label={waitingOnAgents.label}
              detail={waitingOnAgents.detail}
              description="The main agent has stopped and is waiting for these agents to report back."
              autopilot={runMode === "autopilot"}
            />
          ) : (
            <LiveStatusLine
              label={attaching ? "Thinking" : runHeaderState.label}
              detail={intentText || undefined}
              description={attaching ? undefined : `${runHeaderState.title}. ${runHeaderState.detail}`}
              autopilot={!attaching && runMode === "autopilot"}
            />
          )}
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
    runMode,
    runNotice,
    showStatusLine,
    waitingOnAgents,
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
  /** One object for every row, so a message's bubble only renders again when the message changes. */
  const messageActions = useMemo(
    () => ({ onCopy: handleCopySpecificMessage, onOpenMenu: openMessageActionsMenu }),
    [handleCopySpecificMessage, openMessageActionsMenu],
  );

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
      // A turn that just ran is on screen twice over: as history, and as what its run left behind.
      dropFinishedRunOutput();
      const boundaryIndex = entriesRef.current.findIndex(
        (entry) => isChatMessageEntry(entry) && entry.undoEventId === undoEventId,
      );
      if (boundaryIndex >= 0) {
        const nextEntries = entriesRef.current.slice(0, boundaryIndex);
        applyHistory(nextEntries, {
          lastVisibleActivityAt: getLatestEntryActivityTimestamp(nextEntries) ?? null,
        });
      }
      historyRef.current.refresh({ reach: "window" });
    } catch (error) {
      console.error("Failed to undo chat turn:", error);
      setUndoError(`Undo failed: ${getErrorMessage(error)}`);
    } finally {
      setUndoingEventId((current) => current === undoEventId ? null : current);
    }
  }, [applyHistory, dropFinishedRunOutput, sessionId]);

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
              latest={segment.key === trailingActivityKey}
              liveLabel={intentText}
              waiting={segment.key === liveActivityKey ? waitingOnAgents : undefined}
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
            <CompletionCard entry={entry} autopilot={autopilotRuns.get(entry)} />
          </div>,
        );
        return;
      }

      if (segment.type === "continuation-segment") {
        const { entry, count } = segment;
        result.push(
          <div
            key={entry.id ?? `continuation-${index}`}
            className={`${CHAT_RAIL_CLASS} pt-3`}
            data-autopilot-continuation={count}
          >
            <div
              className="flex items-center gap-2 text-xs"
              title="Autopilot started the next turn itself to keep working toward the task"
            >
              <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
              <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-agent">
                <AutopilotIcon size={12} />
                {count > 1 ? `Continued on its own ×${count}` : "Continued on its own"}
              </span>
              <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
            </div>
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
            actions={isLiveStreamingMessage || isSelectingText ? undefined : messageActions}
            messageKey={messageAnchorKey}
            copied={copiedMessageKey === messageAnchorKey}
            isStreaming={isLiveStreamingMessage}
            selectingText={isSelectingText}
            onFinishSelectingText={isSelectingText ? handleFinishSelectingMessageText : undefined}
            sessionId={sessionId ?? undefined}
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
    autopilotRuns,
    bindMessageMenu,
    copiedMessageKey,
    handleToggleActivity,
    intentText,
    latestMessageAnchorKey,
    liveActivityKey,
    messageAnchorKeys,
    renderBlocks,
    messageActions,
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
    trailingActivityKey,
    waitingOnAgents,
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
      {!historicalMode && (
        <SessionAgentsBar
          sessionId={sessionId}
          backgroundAgents={backgroundAgents}
          agents={agentDirectory}
          latestSteps={agentLatestSteps}
          loadedStepCounts={agentLoadedStepCounts}
          sheetOpen={showAgents}
          onOpenSheet={openAgentsSheet}
          onCloseSheet={planOverlay.close}
        />
      )}
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
            <Button onClick={() => historyRef.current.load()}>Retry</Button>
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
          onTouchStart={handleTouchStart}
          onTouchMove={handleUserScrollIntent}
        >
          {showHistorySync && (
            // Zero height: the strip lies over the transcript, so showing and hiding it moves nothing.
            <div className="sticky top-0 z-10 h-0">
              <div role="status" aria-live="polite" className="border-b border-border bg-bg-primary/90 backdrop-blur-sm">
                <div className="history-sync-bar" aria-hidden="true" />
                <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs">
                  <span className={cx("font-medium", DS.motion.live)}>Syncing chat history…</span>
                  <span className="hidden text-text-faint sm:inline">{historySyncDetail}</span>
                </div>
              </div>
            </div>
          )}
          {!historicalMode && (hasMore || loadMoreError) && (
            // One fixed-height row for every state, so switching between them never nudges the transcript.
            <div className="flex min-h-12 items-center justify-center gap-2 px-3 text-xs md:min-h-10">
              {loadMoreError ? (
                <>
                  <span role="alert" className="text-error">{loadMoreError}</span>
                  <Button variant="ghost" size="sm" onClick={handleLoadOlderClick}>Retry</Button>
                </>
              ) : loadingMore ? (
                <span role="status" className={cx("text-text-muted", DS.motion.live)}>Loading older messages…</span>
              ) : (
                <Button variant="ghost" size="sm" onClick={handleLoadOlderClick}>Load older messages</Button>
              )}
            </div>
          )}
          {/* Cached transcript dims and shimmers while the disk read is in flight; live content below stays crisp. */}
          <ChatRunActiveProvider value={runActive}>
            <TranscriptAgentsProvider value={transcriptAgents}>
              <ViewportKeeper
                ref={viewportKeeperRef}
                scrollerRef={scrollContainerRef}
                className={showHistorySync ? "history-syncing" : undefined}
                shouldKeep={shouldKeepViewport}
                atRest={transcriptAtRest}
                shift={shiftTranscript}
              >
                {renderedEntries}
              </ViewportKeeper>
            </TranscriptAgentsProvider>
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
      {!historicalMode && isStreaming && runMode === "autopilot" && (
        <AutopilotRunLine
          waitingForAnswer={pendingUserInputRequests.length > 0 || pendingElicitationRequests.length > 0}
        />
      )}
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
