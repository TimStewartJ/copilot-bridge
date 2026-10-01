import { createElement, Fragment, memo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Attachment, ChatEntry, ChatMessage, PendingUserInputRequestView, SessionRunState } from "../api";
import { ApiError } from "../api";
import type { SessionContextResponse } from "../../shared/session-context.js";
import type { SessionHistoryCoverage } from "../../shared/session-stream.js";
import type { BridgeSearchResponse } from "../../shared/search.js";
import {
  COMPONENT_IMPORT_WARMUP_TIMEOUT_MS,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  advanceTimersByTimeAct,
  waitTick,
  waitUntilAct,
  type Act,
} from "../test-react-harness";
import {
  getCachedChatSnapshot,
  resetCachedChatSnapshotState,
  setCachedChatSnapshot,
  type ChatHistorySnapshot,
} from "../chat-cache";

const useSessionStreamMock = vi.hoisted(() => vi.fn());
const submitUserInputResponseMock = vi.hoisted(() => vi.fn());
const fetchOlderMessagesFastMock = vi.hoisted(() => vi.fn());
const fetchMessagesFastMock = vi.hoisted(() => vi.fn());
const searchBridgeMock = vi.hoisted(() => vi.fn());
const fetchMcpStatusMock = vi.hoisted(() => vi.fn());
const fetchSessionContextMock = vi.hoisted(() => vi.fn());
const warmSessionMock = vi.hoisted(() => vi.fn());
const reportTimingMock = vi.hoisted(() => vi.fn());
const undoSessionTurnMock = vi.hoisted(() => vi.fn());
const chatInputMock = vi.hoisted(() => vi.fn());
const mcpStatusBarMock = vi.hoisted(() => vi.fn());
const useSessionUsageMetricsQueryMock = vi.hoisted(() => vi.fn());
/** Called with the message each time a bubble actually renders; the bubble is memoized like the real one. */
const messageBubbleRenderMock = vi.hoisted(() => vi.fn());

vi.mock("../useSessionStream", () => ({
  useSessionStream: (...args: unknown[]) => useSessionStreamMock(...args),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchMessagesFast: (...args: unknown[]) => fetchMessagesFastMock(...args),
    searchBridge: (...args: unknown[]) => searchBridgeMock(...args),
    fetchMcpStatus: (...args: unknown[]) => fetchMcpStatusMock(...args),
    fetchMcpStatusSnapshot: async (...args: unknown[]) => ({ servers: await fetchMcpStatusMock(...args), toolReadiness: null }),
    fetchSessionContext: (...args: unknown[]) => fetchSessionContextMock(...args),
    warmSession: (...args: unknown[]) => warmSessionMock(...args),
    reportTiming: (...args: unknown[]) => reportTimingMock(...args),
    submitUserInputResponse: (...args: unknown[]) => submitUserInputResponseMock(...args),
    undoSessionTurn: (...args: unknown[]) => undoSessionTurnMock(...args),
  };
});

vi.mock("./ChatInput", () => ({
  default: (props: unknown) => {
    chatInputMock(props);
    return null;
  },
}));

vi.mock("./McpStatusBar", () => ({
  default: (props: unknown) => {
    mcpStatusBarMock(props);
    return null;
  },
}));

vi.mock("../hooks/queries/useSessionUsageMetrics", () => ({
  useSessionUsageMetricsQuery: (...args: unknown[]) => useSessionUsageMetricsQueryMock(...args),
}));

vi.mock("./MessageBubble", async () => {
  const { MessageActionToolbar } = await import("./MessageActions");
  return {
    default: memo(({
      message,
      actions,
      messageKey,
      copied = false,
      isStreaming,
      onRetry,
      selectingText,
      onFinishSelectingText,
    }: {
      message: ChatMessage;
      actions?: {
        onCopy: (key: string, message: ChatMessage) => void;
        onOpenMenu: (x: number, y: number, key: string, message: ChatMessage) => void;
      };
      messageKey?: string;
      copied?: boolean;
      isStreaming?: boolean;
      onRetry?: () => void;
      selectingText?: boolean;
      onFinishSelectingText?: () => void;
    }) => {
      messageBubbleRenderMock(message);
      return createElement(
        "div",
        {
          "data-testid": "message-bubble",
          "data-role": message.role,
          "data-streaming": isStreaming ? "true" : "false",
          "data-selecting-text": selectingText ? "true" : "false",
          "data-delivery-state": message.delivery
            ? message.delivery.failed ? "failed" : message.delivery.queued ? "queued" : "sending"
            : "sent",
          "data-delivery-error": message.delivery?.error,
        },
        message.content,
        actions && messageKey !== undefined
          ? createElement(MessageActionToolbar, { messageKey, message, copied, ...actions })
          : null,
        onRetry
          ? createElement("button", { "aria-label": "Retry sending message", onClick: onRetry }, "Retry")
          : null,
        onFinishSelectingText
          ? createElement("button", {
              "aria-label": "Finish selecting message text",
              onClick: onFinishSelectingText,
            }, "Done")
          : null,
      );
    }),
  };
});

vi.mock("./ToolCallTree", () => ({
  default: () => null,
}));

vi.mock("./PlanSheet", () => ({
  default: () => null,
}));

vi.mock("./ContextMenu", () => ({
  default: ({ children }: { children: ReactNode }) => createElement("div", { "data-testid": "context-menu" }, children),
  CtxDivider: () => createElement("hr"),
  CtxItem: ({
    label,
    onClick,
    disabled,
    title,
  }: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    title?: string;
  }) => createElement("button", { disabled, onClick, title }, label),
}));

type FetchMessagesFastResult = {
  messages: ChatEntry[];
  runState: SessionRunState;
  total: number;
  warm: boolean;
  hasMore?: boolean;
  startOffset?: number;
  hasNewer?: boolean;
  lastVisibleActivityAt?: string;
  coverage?: SessionHistoryCoverage;
};

type RenderChatViewOptions = {
  busySignal?: number;
  historySignal?: number;
  composerKey?: string;
  externallyInUse?: boolean;
  fetchMessagesFastResult?: Promise<FetchMessagesFastResult> | FetchMessagesFastResult;
  fetchSessionContextError?: Error;
  fetchSessionContextResult?: Promise<SessionContextResponse> | SessionContextResponse;
  pendingUserInputs?: PendingUserInputRequestView[];
  seedQueryClient?: (queryClient: QueryClient) => void;
  streamOverrides?: Record<string, unknown>;
  waitForQuestion?: boolean;
  onForkSession?: (sessionId: string, opts?: { toEventId?: string }) => Promise<void> | void;
  onCreateAndSend?: (
    prompt: string,
    attachments?: Attachment[],
    mode?: "interactive" | "autopilot",
    clientMessageId?: string,
  ) => Promise<void>;
  onRenderedReadThrough?: (sessionId: string, readThroughActivityAt: string) => void;
  sessionId?: string | null;
  newWorkDisabled?: boolean;
  newWorkDisabledHint?: string;
  routeEntry?: string;
  searchBridgeResult?: BridgeSearchResponse;
  prepareDom?: () => void;
};

function createMessage(id: string, content = id): ChatEntry {
  return { id, role: "assistant", content };
}

function createEmptyContext(): SessionContextResponse {
  return {
    provider: "test",
    summary: null,
    turns: [],
    events: [],
    capabilities: {
      contextWindow: "unavailable",
      modelUsage: "unavailable",
      compaction: "unavailable",
      truncation: "unavailable",
    },
  };
}

function RouteLocationProbe() {
  const location = useLocation();
  return createElement("span", {
    "data-testid": "route-location",
    "data-location": `${location.pathname}${location.search}`,
  });
}

function getMessageContent(entry: ChatEntry | undefined): string | undefined {
  if (!entry || entry.type === "tool" || entry.type === "visual" || entry.type === "completion" || entry.type === "continuation") return undefined;
  return entry.content;
}

function findButtonByAriaLabel(root: any, label: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => (
    getReactProps(candidate)?.["aria-label"] === label
    || candidate.getAttribute?.("aria-label") === label
  ));
  if (!button) throw new Error(`Button not found with aria-label: ${label}`);
  return button;
}

function clickButton(button: any) {
  getReactProps(button)?.onClick?.({
    currentTarget: button,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
}

function stubWindowConfirm(result: boolean) {
  const confirm = vi.fn(() => result);
  Object.defineProperty(window, "confirm", {
    configurable: true,
    writable: true,
    value: confirm,
  });
  return confirm;
}

function createSnapshot(
  sessionId: string,
  entries: ChatEntry[],
): ChatHistorySnapshot {
  return {
    sessionId,
    entries,
    firstItemIndex: 0,
    fetchedAt: Date.now(),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

let ChatView: typeof import("./ChatView").default;

beforeAll(async () => {
  // Warm the large component graph outside the first test timeout while
  // preserving the DOM-before-React-DOM import ordering required by the harness.
  const harness = await createReactDomHarness();
  try {
    ({ default: ChatView } = await import("./ChatView"));
  } finally {
    await harness.cleanup();
  }
}, COMPONENT_IMPORT_WARMUP_TIMEOUT_MS);

function findButtonByText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function findButtonContainingText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button not found containing: ${text}`);
  return button;
}

/**
 * Work between two replies renders as one collapsed line. Open every block, then every row inside
 * it, so a test can read what the timeline holds.
 */
async function expandActivity(root: any, act: Act): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    const collapsed = findAllByTag(root, "BUTTON").filter((candidate) => {
      if (candidate.getAttribute?.("aria-expanded") !== "false") return false;
      let node = candidate.parentNode;
      while (node) {
        if (node.getAttribute?.("data-activity-block")) return true;
        node = node.parentNode;
      }
      return false;
    });
    if (collapsed.length === 0) return;
    await act(async () => {
      for (const button of collapsed) clickButton(button);
    });
  }
}

function findInputByPlaceholder(root: any, placeholder: string): any {
  const input = findAllByTag(root, "INPUT").find((candidate) => (
    getReactProps(candidate)?.placeholder === placeholder
  ));
  if (!input) throw new Error(`Input not found: ${placeholder}`);
  return input;
}

function findScrollContainer(root: any): any {
  const container = findAllByTag(root, "DIV").find((candidate) => {
    const props = getReactProps(candidate);
    return typeof props?.onScroll === "function"
      && typeof props?.className === "string"
      && props.className.includes("overflow-y-auto");
  });
  if (!container) throw new Error("Scroll container not found");
  return container;
}

function setScrollGeometry(
  element: any,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: geometry.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: geometry.clientHeight });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: geometry.scrollTop });
}

function setElementTop(element: any, top: number) {
  element.getBoundingClientRect = () => ({
    x: 0,
    y: top,
    width: 0,
    height: 0,
    top,
    left: 0,
    right: 0,
    bottom: top,
    toJSON: () => ({}),
  });
}

/** Stands in for the browser's ResizeObserver. `notify(element)` reports that the element changed size. */
function stubResizeObserver() {
  const observers: Array<{ callback: () => void; elements: unknown[] }> = [];
  vi.stubGlobal("ResizeObserver", class {
    private readonly observer: { callback: () => void; elements: unknown[] };
    constructor(callback: () => void) {
      this.observer = { callback, elements: [] };
      observers.push(this.observer);
    }
    observe(element: unknown) { this.observer.elements.push(element); }
    disconnect() { this.observer.elements.length = 0; }
  });
  return {
    observed: () => observers.flatMap((observer) => observer.elements),
    notify: (element: unknown) => {
      for (const observer of observers) {
        if (observer.elements.includes(element)) observer.callback();
      }
    },
  };
}

function findMessageWrapperByAnchorKey(root: any, key: string): any {
  const wrapper = findAllByTag(root, "DIV").find((candidate) => (
    candidate.getAttribute?.("data-chat-message-key") === key
  ));
  if (!wrapper) throw new Error(`Message wrapper not found for key: ${key}`);
  return wrapper;
}

function findMessageBubble(root: any, streaming: boolean): any {
  const bubble = findAllByTag(root, "DIV").find((candidate) => (
    candidate.getAttribute?.("data-testid") === "message-bubble"
    && candidate.getAttribute?.("data-streaming") === (streaming ? "true" : "false")
  ));
  if (!bubble) throw new Error(`Message bubble not found for streaming=${streaming}`);
  return bubble;
}

async function renderChatView(
  pendingUserInputsOrOptions: PendingUserInputRequestView[] | RenderChatViewOptions = [],
) {
  const options: RenderChatViewOptions = Array.isArray(pendingUserInputsOrOptions)
    ? { pendingUserInputs: pendingUserInputsOrOptions, waitForQuestion: true }
    : pendingUserInputsOrOptions;
  const pendingUserInputs = options.pendingUserInputs ?? [];
  const harness = await createReactDomHarness();
  const { dom, act } = harness;
  options.prepareDom?.();
  const sendMessageMock = vi.fn();
  const abortSessionMock = vi.fn();
  const reconnectMock = vi.fn();
  const ensureConnectedMock = vi.fn();
  const dropFinishedRunOutputMock = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  options.seedQueryClient?.(queryClient);

  const fetchMessagesFastResult = options.fetchMessagesFastResult
    ?? { messages: [], runState: "idle", total: 0, warm: true, hasMore: false };
  const initialMessagesFastResult = fetchMessagesFastResult instanceof Promise
    ? fetchMessagesFastResult
    : Promise.resolve(fetchMessagesFastResult);
  // fetchMessagesFast serves both the initial/background load (no `before`) and
  // older-page pagination (`before` set). Route older pages to a dedicated mock so
  // tests can assert and stub older-page reads independently of the initial load.
  fetchMessagesFastMock.mockImplementation((sessionId: string, opts?: { before?: number; aroundEventId?: string }) => {
    if (opts?.before != null && !opts.aroundEventId) return fetchOlderMessagesFastMock(sessionId, opts);
    return initialMessagesFastResult;
  });
  fetchOlderMessagesFastMock.mockResolvedValue({ messages: [], hasMore: false, total: 0 });
  const initialSearchMessages = fetchMessagesFastResult instanceof Promise
    ? []
    : fetchMessagesFastResult.messages.flatMap((entry) => {
        if (entry.type === "tool" || entry.type === "visual" || entry.type === "completion" || entry.type === "skill" || entry.type === "reasoning" || entry.type === "continuation") return [];
        const sourceEventId = entry.sourceEventId ?? entry.id;
        return sourceEventId ? [{
          sourceEventId,
          role: entry.role,
          snippet: entry.content,
        }] : [];
      });
  searchBridgeMock.mockResolvedValue(options.searchBridgeResult ?? {
    chats: {
      total: initialSearchMessages.length > 0 ? 1 : 0,
      items: initialSearchMessages.length > 0 ? [{
        sessionId: options.sessionId ?? "session-1",
        title: "Session",
        archived: false,
        matches: initialSearchMessages,
        matchCount: initialSearchMessages.length,
      }] : [],
    },
    tasks: { items: [], total: 0 },
    docs: { items: [], total: 0 },
    coverage: { state: "ready", indexedSessions: 1, totalSessions: 1, errors: [] },
  });
  fetchMcpStatusMock.mockResolvedValue([]);
  if (options.fetchSessionContextError) {
    fetchSessionContextMock.mockRejectedValue(options.fetchSessionContextError);
  } else {
    const fetchSessionContextResult = options.fetchSessionContextResult ?? createEmptyContext();
    fetchSessionContextMock.mockReturnValue(
      fetchSessionContextResult instanceof Promise
        ? fetchSessionContextResult
        : Promise.resolve(fetchSessionContextResult),
    );
  }
  warmSessionMock.mockResolvedValue(undefined);
  reportTimingMock.mockResolvedValue(undefined);
  undoSessionTurnMock.mockResolvedValue({ eventsRemoved: 1 });
  useSessionUsageMetricsQueryMock.mockReturnValue({
    data: undefined,
    isLoading: false,
  });
  submitUserInputResponseMock.mockResolvedValue({
    requestId: pendingUserInputs[0]?.requestId ?? "request-1",
    answer: "ok",
    wasFreeform: false,
  });
  const buildStreamState = (nextOptions: RenderChatViewOptions) => ({
    streamingContent: "",
    liveAssistantSegments: [],
    pendingUserMessages: [],
    runNotice: null,
    historyEpoch: 0,
    intentText: "",
    liveTools: [],
    liveVisuals: [],
    liveCompletion: null,
    isStreaming: true,
    streamStatus: "thinking",
    hadVisibleOutput: false,
    pendingOrigin: "message",
    pendingUserInputs: nextOptions.pendingUserInputs ?? pendingUserInputs,
    pendingElicitations: [],
    elicitationCancellation: null,
    mcpServers: [],
    contextSummary: null,
    sendMessage: sendMessageMock,
    abortSession: abortSessionMock,
    reconnect: reconnectMock,
    ensureConnected: ensureConnectedMock,
    dropFinishedRunOutput: dropFinishedRunOutputMock,
    ...nextOptions.streamOverrides,
  });
  useSessionStreamMock.mockReturnValue(buildStreamState(options));

  const render = async (overrideOptions: Partial<RenderChatViewOptions> = {}) => {
    const nextOptions = {
      ...options,
      ...overrideOptions,
      streamOverrides: {
        ...(options.streamOverrides ?? {}),
        ...(overrideOptions.streamOverrides ?? {}),
      },
    };
    useSessionStreamMock.mockReturnValue(buildStreamState(nextOptions));
    await harness.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          { initialEntries: [nextOptions.routeEntry ?? "/sessions/session-1"] },
          createElement(Fragment, null,
            createElement(ChatView, {
              composerKey: nextOptions.composerKey ?? "composer-1",
              sessionId: nextOptions.sessionId === undefined ? "session-1" : nextOptions.sessionId,
              onMessageSent: vi.fn(),
              onCreateAndSend: nextOptions.onCreateAndSend,
              onSubmitVoiceCapture: vi.fn(),
              busySignal: nextOptions.busySignal,
              historySignal: nextOptions.historySignal,
              externallyInUse: nextOptions.externallyInUse,
              onForkSession: nextOptions.onForkSession,
              onRenderedReadThrough: nextOptions.onRenderedReadThrough,
              newWorkDisabled: nextOptions.newWorkDisabled,
              newWorkDisabledHint: nextOptions.newWorkDisabledHint,
            }),
            createElement(RouteLocationProbe),
          ),
        ),
      ),
    );
  };

  const cleanup = async () => {
    queryClient.clear();
    await harness.cleanup();
  };

  await render();
  if (options.waitForQuestion ?? false) {
    try {
      await waitUntilAct(act as Act, () => dom.container.textContent?.includes("Question") ?? false);
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  return {
    dom,
    act: act as Act,
    cleanup,
    queryClient,
    render,
    reconnectMock,
    ensureConnectedMock,
    dropFinishedRunOutputMock,
    sendMessageMock,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as { confirm?: typeof window.confirm }).confirm;
  vi.clearAllMocks();
  resetCachedChatSnapshotState();
});

describe("ChatView exact-message history", () => {
  it("opens a title-only conversation as read-only saved suffix history without warm or resume", async () => {
    warmSessionMock.mockClear();
    useSessionStreamMock.mockClear();
    chatInputMock.mockClear();
    const { act, dom, cleanup, reconnectMock, ensureConnectedMock } = await renderChatView({
      routeEntry: "/sessions/session-1?history=1&from=%2Fsearch",
      streamOverrides: { isStreaming: false, pendingOrigin: null },
      fetchMessagesFastResult: {
        messages: [{ id: "saved-1", sourceEventId: "event-1", role: "assistant", content: "Saved conversation history" }],
        runState: "idle",
        total: 75,
        hasMore: true,
        warm: false,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Saved conversation history") ?? false);
      expect(fetchMessagesFastMock).toHaveBeenCalledWith("session-1", { limit: 50 });
      expect(useSessionStreamMock.mock.calls.at(-1)?.[0]).toBeNull();
      expect(useSessionUsageMetricsQueryMock.mock.calls.at(-1)?.[0]).toBeNull();
      expect(warmSessionMock).not.toHaveBeenCalled();
      expect(reconnectMock).not.toHaveBeenCalled();
      expect(ensureConnectedMock).not.toHaveBeenCalled();
      expect(chatInputMock).not.toHaveBeenCalled();
      expect(dom.container.textContent).toContain("latest saved history for this conversation");
      expect(dom.container.textContent).not.toContain("Copy link");
    } finally {
      await cleanup();
    }
  });

  it("loads a bounded around-message window without warming or resuming the session", async () => {
    warmSessionMock.mockClear();
    useSessionStreamMock.mockClear();
    fetchSessionContextMock.mockClear();
    chatInputMock.mockClear();
    const { act, dom, cleanup, reconnectMock, ensureConnectedMock } = await renderChatView({
      routeEntry: "/sessions/session-1?message=event-77&search=needle&from=%2Fsearch%3Fq%3Dneedle",
      streamOverrides: { isStreaming: false, pendingOrigin: null },
      fetchMessagesFastResult: {
        messages: [
          { id: "entry-1", sourceEventId: "event-76", role: "user", content: "another needle" },
          { id: "entry-2", sourceEventId: "event-77", role: "assistant", content: "target needle" },
        ],
        runState: "idle",
        total: 120,
        startOffset: 40,
        hasMore: true,
        hasNewer: true,
        warm: false,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("target needle") ?? false);
      expect(fetchMessagesFastMock).toHaveBeenCalledWith("session-1", {
        before: 50,
        after: 50,
        aroundEventId: "event-77",
      });
      expect(useSessionStreamMock.mock.calls.at(-1)?.[0]).toBeNull();
      expect(useSessionUsageMetricsQueryMock.mock.calls.at(-1)?.[0]).toBeNull();
      expect(warmSessionMock).not.toHaveBeenCalled();
      expect(reconnectMock).not.toHaveBeenCalled();
      expect(ensureConnectedMock).not.toHaveBeenCalled();
      expect(fetchSessionContextMock).not.toHaveBeenCalled();
      expect(chatInputMock).not.toHaveBeenCalled();
      expect(dom.container.textContent).toContain("does not resume the chat");
      expect(dom.container.textContent).toContain("Back to results");
      expect(dom.container.textContent).toContain("Previous match");
      expect(dom.container.textContent).toContain("Next match");
      expect(dom.container.textContent).toContain("Jump to latest");
    } finally {
      await cleanup();
    }
  });

  it("does not substitute the latest window when the exact event is missing", async () => {
    warmSessionMock.mockClear();
    const { act, dom, cleanup } = await renderChatView({
      routeEntry: "/sessions/session-1?message=removed-event&from=%2Fsearch",
      streamOverrides: { isStreaming: false, pendingOrigin: null },
      fetchMessagesFastResult: {
        messages: [{ id: "latest", sourceEventId: "latest-event", role: "assistant", content: "latest reply" }],
        runState: "idle",
        total: 1,
        startOffset: 0,
        hasMore: false,
        hasNewer: false,
        warm: false,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("saved message is unavailable") ?? false);
      expect(dom.container.textContent).not.toContain("latest reply");
      expect(warmSessionMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("maps a missing-target 404 to the explicit unavailable state without fallback or warm", async () => {
    warmSessionMock.mockClear();
    const { act, dom, cleanup } = await renderChatView({
      routeEntry: "/sessions/session-1?message=removed-event&from=%2Fsearch",
      streamOverrides: { isStreaming: false, pendingOrigin: null },
      fetchMessagesFastResult: Promise.reject(new ApiError("Message not found", 404)),
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("saved message is unavailable") ?? false);
      expect(dom.container.textContent).not.toContain("Error loading history");
      expect(warmSessionMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("pages whole-chat matches when next navigation crosses a search page boundary", async () => {
    const firstPageMatches = Array.from({ length: 20 }, (_, index) => ({
      sourceEventId: `event-${index}`,
      role: "assistant" as const,
      snippet: `needle ${index}`,
    }));
    const { act, dom, cleanup } = await renderChatView({
      routeEntry: "/sessions/session-1?message=event-18&search=needle&matchOffset=0",
      streamOverrides: { isStreaming: false, pendingOrigin: null },
      fetchMessagesFastResult: {
        messages: [{ id: "entry-18", sourceEventId: "event-18", role: "assistant", content: "needle 18" }],
        runState: "idle",
        total: 100,
        startOffset: 50,
        hasMore: true,
        hasNewer: true,
        warm: true,
      },
      searchBridgeResult: {
        chats: {
          total: 1,
          items: [{
            sessionId: "session-1",
            title: "Session",
            archived: false,
            matches: firstPageMatches,
            matchCount: 21,
          }],
        },
        tasks: { items: [], total: 0 },
        docs: { items: [], total: 0 },
        coverage: { state: "ready", indexedSessions: 1, totalSessions: 1, errors: [] },
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("19 of 21") ?? false);
      searchBridgeMock.mockImplementation((request: { offset?: number }) => Promise.resolve({
        chats: {
          total: 1,
          items: [{
            sessionId: "session-1",
            title: "Session",
            archived: false,
            matches: request.offset === 20
              ? [{ sourceEventId: "event-20", role: "assistant", snippet: "needle 20" }]
              : firstPageMatches,
            matchCount: 21,
          }],
        },
        tasks: { items: [], total: 0 },
        docs: { items: [], total: 0 },
        coverage: { state: "ready", indexedSessions: 1, totalSessions: 1, errors: [] },
      }));
      fetchMessagesFastMock.mockImplementation((_sessionId: string, opts?: { aroundEventId?: string }) => Promise.resolve({
        messages: opts?.aroundEventId === "event-20"
          ? [{ id: "entry-20", sourceEventId: "event-20", role: "assistant", content: "needle 20" }]
          : opts?.aroundEventId === "event-18"
            ? [{ id: "entry-18", sourceEventId: "event-18", role: "assistant", content: "needle 18" }]
            : [{ id: "entry-19", sourceEventId: "event-19", role: "assistant", content: "needle 19" }],
        runState: "idle",
        total: 100,
        startOffset: opts?.aroundEventId === "event-20" ? 52 : opts?.aroundEventId === "event-19" ? 51 : 50,
        hasMore: true,
        hasNewer: true,
        warm: true,
      }));

      await act(async () => {
        getReactProps(findButtonByText(dom.container, "Next match"))?.onClick?.();
      });
      await waitUntilAct(act, () => findAllByTag(dom.container, "SPAN").some((span) => (
        getReactProps(span)?.["data-location"]?.includes("message=event-19")
      )));
      expect(dom.container.textContent).toContain("20 of 21");

      await act(async () => {
        getReactProps(findButtonByText(dom.container, "Next match"))?.onClick?.();
      });
      await waitUntilAct(act, () => searchBridgeMock.mock.calls.some((call) => (
        (call[0] as { offset?: number } | undefined)?.offset === 20
      )));
      await waitUntilAct(act, () => findAllByTag(dom.container, "SPAN").some((span) => (
        getReactProps(span)?.["data-location"]?.includes("message=event-20")
      )));
      expect(searchBridgeMock).toHaveBeenCalledWith(expect.objectContaining({
        scope: "session",
        offset: 20,
        limit: 20,
      }));

      await act(async () => {
        getReactProps(findButtonByText(dom.container, "Previous match"))?.onClick?.();
      });
      await waitUntilAct(act, () => findAllByTag(dom.container, "SPAN").some((span) => (
        getReactProps(span)?.["data-location"]?.includes("message=event-19")
        && getReactProps(span)?.["data-location"]?.includes("matchOffset=0")
      )));
      expect(dom.container.textContent).toContain("20 of 21");
    } finally {
      await cleanup();
    }
  });

  it("keeps historical reading inert across busy and visibility refresh signals", async () => {
    let visibilityHandler: (() => void) | undefined;
    const { act, cleanup, render, reconnectMock, ensureConnectedMock } = await renderChatView({
      routeEntry: "/sessions/session-1?message=event-1",
      busySignal: 0,
      streamOverrides: { isStreaming: false, pendingOrigin: null },
      fetchMessagesFastResult: {
        messages: [{ id: "entry-1", sourceEventId: "event-1", role: "assistant", content: "target" }],
        runState: "idle",
        total: 1,
        startOffset: 0,
        hasMore: false,
        hasNewer: false,
        warm: false,
      },
      prepareDom: () => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
          if (type === "visibilitychange" && typeof listener === "function") {
            visibilityHandler = listener as () => void;
          }
        });
        document.removeEventListener = vi.fn();
      },
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      await render({ busySignal: 1 });
      await act(async () => {
        visibilityHandler?.();
        await waitTick();
      });
      expect(fetchMessagesFastMock).toHaveBeenCalledTimes(1);
      expect(warmSessionMock).not.toHaveBeenCalled();
      expect(reconnectMock).not.toHaveBeenCalled();
      expect(ensureConnectedMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});

describe("ChatView external session use", () => {
  it("attaches to a busy session's stream without replacing a healthy one on history refreshes", async () => {
    vi.useFakeTimers();
    let visibilityHandler: (() => void) | undefined;
    const { act, cleanup, render, reconnectMock, ensureConnectedMock } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{ id: "entry-1", sourceEventId: "event-1", role: "assistant", content: "working on it" }],
        runState: "busy",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { historyEpoch: 0 },
      prepareDom: () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
          if (type === "visibilitychange" && typeof listener === "function") {
            visibilityHandler = listener as () => void;
          }
        });
        document.removeEventListener = vi.fn();
      },
    });

    try {
      await waitUntilAct(act, () => ensureConnectedMock.mock.calls.length === 1);
      expect(ensureConnectedMock).toHaveBeenCalledWith("session-1");

      // The server announced committed history mid-run. Re-reading disk is right; tearing the
      // stream down and rebuilding it for every tool call is what made the run flicker.
      await render({ streamOverrides: { historyEpoch: 1 } });
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 2);
      await waitUntilAct(act, () => ensureConnectedMock.mock.calls.length === 2);
      expect(reconnectMock).not.toHaveBeenCalled();

      // A tab that slept may hold a stream that died unnoticed, so waking replaces it. The read
      // that finds out takes its turn after the one that just ran.
      await act(async () => {
        visibilityHandler?.();
        await waitTick();
      });
      expect(reconnectMock).not.toHaveBeenCalled();
      await advanceTimersByTimeAct(act, 250);
      await waitUntilAct(act, () => reconnectMock.mock.calls.length === 1);
      expect(reconnectMock).toHaveBeenCalledWith("session-1");
      expect(fetchMessagesFastMock).toHaveBeenCalledTimes(3);
    } finally {
      await cleanup();
    }
  });

  it("shows a non-blocking notice when another Copilot client holds the session", async () => {
    const { dom, cleanup } = await renderChatView({
      externallyInUse: true,
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });

    try {
      expect(dom.container.textContent).toContain("This session is open in another Copilot client.");
      expect(dom.container.textContent).toContain("Sending here is still allowed.");
    } finally {
      await cleanup();
    }
  });
});

describe("ChatView cached resume loading state", () => {
  it("passes failed session-cost reads to the status bar without replacing the reading", async () => {
    const { cleanup, render } = await renderChatView({ streamOverrides: { isStreaming: false } });
    try {
      useSessionUsageMetricsQueryMock.mockReturnValue({ data: { costUsd: 0.0025 }, isLoading: false, error: new Error("Metering offline") });
      await render();
      expect(mcpStatusBarMock.mock.calls.at(-1)?.[0]).toMatchObject({ sessionCostUsd: 0.0025, sessionCostError: "Metering offline" });
      useSessionUsageMetricsQueryMock.mockReturnValue({ data: { costUsd: null }, isLoading: false, error: null });
      await render();
      expect(mcpStatusBarMock.mock.calls.at(-1)?.[0]).toMatchObject({ sessionCostUsd: null, sessionCostError: undefined });
    } finally { await cleanup(); }
  });

  it("uses MCP stream events to refresh the endpoint instead of overwriting it with pending placeholders", async () => {
    const { act, cleanup } = await renderChatView({
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });

    try {
      const onMcpStatus = useSessionStreamMock.mock.calls.at(-1)?.[3] as
        | ((servers: Array<{ name: string; status: string }>) => void)
        | undefined;
      fetchMcpStatusMock.mockResolvedValue([{ name: "demo", status: "connected" }]);
      const fetchCount = fetchMcpStatusMock.mock.calls.length;
      await act(async () => onMcpStatus?.([{ name: "demo", status: "pending" }]));
      await waitUntilAct(act, () => mcpStatusBarMock.mock.calls.some((call) => (
        (call[0] as { servers?: Array<{ name: string; status: string }> }).servers?.[0]?.name === "demo"
      )));
      expect(fetchMcpStatusMock.mock.calls.length).toBeGreaterThan(fetchCount);
      expect(mcpStatusBarMock.mock.calls.at(-1)?.[0]).toMatchObject({
        servers: [{ name: "demo", status: "connected" }],
      });
      expect(useSessionUsageMetricsQueryMock.mock.calls.at(-1)?.[0]).toBe("session-1");
    } finally {
      await cleanup();
    }
  });

  it("passes restart cutover disabled state to the composer", async () => {
    const hint = "Bridge is restarting; new messages and chats will resume after reconnect.";
    const { cleanup } = await renderChatView({
      newWorkDisabled: true,
      newWorkDisabledHint: hint,
      streamOverrides: { isStreaming: false },
    });

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { disabled?: boolean; disabledHint?: string };
      expect(props.disabled).toBe(true);
      expect(props.disabledHint).toBe(hint);
    } finally {
      await cleanup();
    }
  });

  it("keeps rendering chat when session context fetch fails", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1", "visible history")],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      fetchSessionContextError: new Error("context offline"),
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("visible history") ?? false);
      await waitUntilAct(act, () => mcpStatusBarMock.mock.calls.some((call) => (
        (call[0] as { contextError?: string }).contextError === "context offline"
      )));
      expect(dom.container.textContent).toContain("visible history");
    } finally {
      await cleanup();
    }
  });

  it("reports read-through cursors from loaded history and live assistant timestamps", async () => {
    const onRenderedReadThrough = vi.fn();
    const { act, cleanup, render } = await renderChatView({
      onRenderedReadThrough,
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-05-07T21:00:00.000Z",
      },
    });

    try {
      // Reports cursor from loaded history
      await waitUntilAct(act, () => onRenderedReadThrough.mock.calls.length > 0);
      expect(onRenderedReadThrough).toHaveBeenCalledWith(
        "session-1",
        "2026-05-07T21:00:00.000Z",
      );

      // Reports live assistant message timestamp as rendered read-through cursor
      await render({
        streamOverrides: {
          liveAssistantSegments: [{
            id: "terminal-1",
            sourceEventId: "terminal-1",
            turnId: "provider-turn-1",
            content: "Done",
            timestamp: "2026-05-07T21:05:00.000Z",
          }],
          isStreaming: false,
          streamStatus: "idle",
        },
      });
      await act(async () => {
        await waitTick();
      });
      await waitUntilAct(act, () => onRenderedReadThrough.mock.calls.some((call) => (
        call[0] === "session-1" && call[1] === "2026-05-07T21:05:00.000Z"
      )));
    } finally {
      await cleanup();
    }
  });

  it("shows the history sync strip with the cache age once a cached resume outlasts the flash window", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: deferred.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(queryClient, {
        ...createSnapshot("session-1", [createMessage("entry-1")]),
        fetchedAt: Date.now() - 5 * 60_000,
      }),
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-1") ?? false);
      expect(dom.container.textContent).not.toContain("Syncing chat history");

      await advanceTimersByTimeAct(act, 150);
      expect(dom.container.textContent).toContain("Syncing chat history");
      expect(dom.container.textContent).toContain("Showing messages from 5m ago while checking for new ones");
      const findDimmedTranscript = () => findAllByTag(dom.container, "DIV").find((candidate) => (
        getReactProps(candidate)?.className === "history-syncing"
      ));
      expect(findDimmedTranscript()?.textContent).toContain("entry-1");

      await act(async () => {
        deferred.resolve({
          messages: [createMessage("entry-1"), createMessage("entry-2")],
          runState: "idle",
          total: 2,
          warm: true,
          hasMore: false,
        });
        await waitTick();
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-2") ?? false);
      expect(dom.container.textContent).not.toContain("Syncing chat history");
      expect(findDimmedTranscript()).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("never flashes the sync strip when a cached resume refresh lands quickly", async () => {
    vi.useFakeTimers();
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")]),
      ),
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      await advanceTimersByTimeAct(act, 300);
      expect(dom.container.textContent).not.toContain("Syncing chat history");
    } finally {
      await cleanup();
    }
  });

  it("stops waiting on a cached resume's refresh once the reader sends a message", async () => {
    vi.useFakeTimers();
    const refresh = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: refresh.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")]),
      ),
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-1") ?? false);
      await advanceTimersByTimeAct(act, 150);
      expect(dom.container.textContent).toContain("Syncing chat history");

      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      await act(async () => {
        await props.onSend("next question");
        await waitTick();
      });
      expect(dom.container.textContent).not.toContain("Syncing chat history");

      // The read predates the send, so neither its entries nor its idle-and-cold verdict apply.
      await act(async () => {
        refresh.resolve({ messages: [createMessage("stale-entry")], runState: "idle", total: 1, warm: false });
        await waitTick();
      });
      expect(dom.container.textContent).not.toContain("stale-entry");
      expect(warmSessionMock).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("uses only the cold-load skeleton when there is no cached resume", async () => {
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: deferred.promise,
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Loading chat history") ?? false);

      expect(dom.container.textContent).toContain("Loading chat history");
      expect(dom.container.textContent).not.toContain("Syncing chat history");
    } finally {
      deferred.resolve({
        messages: [],
        runState: "idle",
        total: 0,
        warm: true,
        hasMore: false,
      });
      await cleanup();
    }
  });

  it("shows the sync strip for an external busy refresh and clears it when the read lands", async () => {
    vi.useFakeTimers();
    fetchMessagesFastMock.mockResolvedValueOnce({
      messages: [createMessage("entry-1")],
      runState: "idle",
      total: 1,
      warm: true,
      hasMore: false,
      lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
    });
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup, render } = await renderChatView({
      fetchMessagesFastResult: deferred.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")]),
      ),
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      await advanceTimersByTimeAct(act, 300);
      expect(dom.container.textContent).not.toContain("Syncing chat history");

      await render({
        busySignal: 1,
      });
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 2);
      await advanceTimersByTimeAct(act, 150);

      expect(dom.container.textContent).toContain("Syncing chat history");
      expect(dom.container.textContent).toContain("Showing cached messages while checking for new ones");

      await act(async () => {
        deferred.resolve({
          messages: [createMessage("entry-1"), createMessage("entry-2")],
          runState: "idle",
          total: 2,
          warm: true,
          hasMore: false,
          lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
        });
        await waitTick();
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-2") ?? false);
      expect(dom.container.textContent).not.toContain("Syncing chat history");
    } finally {
      await cleanup();
    }
  });

});

describe("ChatView navigation landing position", () => {
  const SCROLL_HEIGHT = 2000;
  const CLIENT_HEIGHT = 400;
  const BOTTOM_SCROLL_TOP = SCROLL_HEIGHT - CLIENT_HEIGHT;

  /**
   * Landing position is measured inside the layout effect of the commit that first paints history,
   * so geometry has to exist before that element is created. Stub it at creation time and key
   * message rects off the anchor attribute the transcript already renders.
   */
  function stubChatGeometry(messageTops: Record<string, number>) {
    const doc = globalThis.document as any;
    const originalCreateElement = doc.createElement;
    doc.createElement = (tag: string) => {
      const element = originalCreateElement(tag);
      Object.defineProperty(element, "scrollHeight", { configurable: true, value: SCROLL_HEIGHT });
      Object.defineProperty(element, "clientHeight", { configurable: true, value: CLIENT_HEIGHT });
      Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: 0 });
      element.getBoundingClientRect = () => {
        const key = element.getAttribute?.("data-chat-message-key");
        const top = (key != null ? messageTops[key] : undefined) ?? 0;
        return {
          x: 0,
          y: top,
          width: 0,
          height: 0,
          top,
          left: 0,
          right: 0,
          bottom: top,
          toJSON: () => ({}),
        };
      };
      return element;
    };
    return () => {
      doc.createElement = originalCreateElement;
    };
  }

  async function renderSettledSession(options: {
    messages: ChatEntry[];
    messageTops: Record<string, number>;
  }) {
    const history = createDeferred<{
      messages: ChatEntry[];
      runState: SessionRunState;
      total: number;
      warm: boolean;
      hasMore: boolean;
    }>();
    // The DOM shim restores document properties on install, so stub after the harness mounts and
    // before history paints the scroll container.
    const view = await renderChatView({
      fetchMessagesFastResult: history.promise,
      streamOverrides: { isStreaming: false, streamStatus: null, pendingOrigin: null },
    });
    const restoreGeometry = stubChatGeometry(options.messageTops);    await view.act(async () => {
      history.resolve({
        messages: options.messages,
        runState: "idle",
        total: options.messages.length,
        warm: true,
        hasMore: false,
      });
      await waitTick();
    });
    await waitUntilAct(view.act, () => (
      view.dom.container.textContent?.includes("newest-entry") ?? false
    ));
    return { ...view, restoreGeometry, scrollContainer: findScrollContainer(view.dom.container) };
  }

  it("lands on the top of the newest assistant reply when it overflows the viewport", async () => {
    // Measured while the transcript is jammed to the bottom, so a top of -700 means the reply
    // starts 700px above the viewport, i.e. at content offset 900.
    const view = await renderSettledSession({
      messages: [createMessage("older-entry"), createMessage("newest-entry")],
      messageTops: { "newest-entry": -700 },
    });

    try {
      expect(view.scrollContainer.scrollTop).toBe(900);
    } finally {
      view.restoreGeometry();
      await view.cleanup();
    }
  });

  it("stays at the bottom when the newest assistant reply fits above the fold", async () => {
    const view = await renderSettledSession({
      messages: [createMessage("older-entry"), createMessage("newest-entry")],
      messageTops: { "newest-entry": 100 },
    });

    try {
      expect(view.scrollContainer.scrollTop).toBe(BOTTOM_SCROLL_TOP);
    } finally {
      view.restoreGeometry();
      await view.cleanup();
    }
  });

  it("stays at the bottom when the transcript ends with a user message", async () => {
    const view = await renderSettledSession({
      messages: [
        createMessage("older-entry"),
        { id: "newest-entry", role: "user", content: "newest-entry" },
      ],
      messageTops: { "newest-entry": -700 },
    });

    try {
      expect(view.scrollContainer.scrollTop).toBe(BOTTOM_SCROLL_TOP);
    } finally {
      view.restoreGeometry();
      await view.cleanup();
    }
  });

  it("releases the landing anchor when new work starts so live output stays visible", async () => {
    const view = await renderSettledSession({
      messages: [createMessage("older-entry"), createMessage("newest-entry")],
      messageTops: { "newest-entry": -700 },
    });

    try {
      expect(view.scrollContainer.scrollTop).toBe(900);

      await view.render({
        streamOverrides: {
          isStreaming: true,
          streamStatus: "thinking",
          streamingContent: "",
          pendingOrigin: "message",
        },
      });

      await waitUntilAct(view.act, () => view.scrollContainer.scrollTop === BOTTOM_SCROLL_TOP);
      expect(view.scrollContainer.scrollTop).toBe(BOTTOM_SCROLL_TOP);
    } finally {
      view.restoreGeometry();
      await view.cleanup();
    }
  });

  describe("a scroll event while parked on the newest reply", () => {
    const newWork = {
      streamOverrides: { isStreaming: true, streamStatus: "thinking", streamingContent: "", pendingOrigin: "message" },
    } as const;

    /** Lands on the reply at 900, then reports the view at `scrollTop` with the reply `replyTop` below its top edge. */
    async function renderParkedThenScrolled(scrollTop: number, replyTop: number) {
      const messageTops = { "newest-entry": -700 };
      const view = await renderSettledSession({
        messages: [createMessage("older-entry"), createMessage("newest-entry")],
        messageTops,
      });
      expect(view.scrollContainer.scrollTop).toBe(900);
      messageTops["newest-entry"] = replyTop;
      view.scrollContainer.scrollTop = scrollTop;
      await view.act(async () => {
        getReactProps(view.scrollContainer)!.onScroll();
        await waitTick();
      });
      return view;
    }

    it("still shows new work when the browser moved the view to hold the reply in place", async () => {
      // Images above the reply loaded and grew by 300px. A browser that anchors scrolling scrolls
      // by as much, so the reply has not moved for the reader.
      const view = await renderParkedThenScrolled(1200, 0);

      try {
        await view.render(newWork);

        await waitUntilAct(view.act, () => view.scrollContainer.scrollTop === BOTTOM_SCROLL_TOP);
        expect(view.scrollContainer.scrollTop).toBe(BOTTOM_SCROLL_TOP);
      } finally {
        view.restoreGeometry();
        await view.cleanup();
      }
    });

    it("leaves the reader where they are once they have moved off the reply", async () => {
      // Dragging the scrollbar down 200px puts the top of the reply 200px above the view.
      const view = await renderParkedThenScrolled(1100, -200);

      try {
        await view.render(newWork);
        // A follow would have started moving the view on the first of these.
        for (let tick = 0; tick < 5; tick += 1) await view.act(waitTick);

        expect(view.scrollContainer.scrollTop).toBe(1100);
      } finally {
        view.restoreGeometry();
        await view.cleanup();
      }
    });
  });

  it("lands on the newest reply when switching to a cached session with the same message ids", async () => {
    // Message ids are per-session, so two sessions routinely share the newest anchor key. Cached
    // navigation must still re-run the landing effect instead of leaving the reader at the tail.
    const view = await renderSettledSession({
      messages: [createMessage("older-entry"), createMessage("newest-entry")],
      messageTops: { "newest-entry": -700 },
    });

    try {
      expect(view.scrollContainer.scrollTop).toBe(900);
      setCachedChatSnapshot(
        view.queryClient,
        createSnapshot("session-2", [createMessage("older-entry"), createMessage("newest-entry")]),
      );

      await view.render({ sessionId: "session-2" });

      await waitUntilAct(view.act, () => view.scrollContainer.scrollTop === 900);
      expect(view.scrollContainer.scrollTop).toBe(900);
    } finally {
      view.restoreGeometry();
      await view.cleanup();
    }
  });
});

describe("ChatView history pagination", () => {
  function createMessages(from: number, to: number): ChatEntry[] {
    return Array.from({ length: to - from }, (_, index) => createMessage(`entry-${from + index}`));
  }

  /** A rect whose top follows the scroller, so tests can move content by changing its layout top. */
  function placeInScroller(element: any, scroller: any, layoutTop: () => number, height: number) {
    element.getBoundingClientRect = () => {
      const top = layoutTop() - scroller.scrollTop;
      return { x: 0, y: top, width: 0, height, top, left: 0, right: 0, bottom: top + height, toJSON: () => ({}) };
    };
  }

  function scroll(scroller: any) {
    getReactProps(scroller)!.onScroll();
  }

  /** Requests for the newest history, in order: every disk read except an older page. */
  function newestReads() {
    return fetchMessagesFastMock.mock.calls
      .map(([, request]) => request as { limit?: number; before?: number })
      .filter((request) => request.before == null);
  }

  async function renderPaginatedSession(tail: ChatEntry[], total: number, running = false) {
    const view = await renderChatView({
      fetchMessagesFastResult: { messages: tail, runState: running ? "busy" : "idle", total, warm: true, hasMore: true },
      streamOverrides: running
        ? { isStreaming: true, streamStatus: "streaming" }
        : { isStreaming: false, pendingOrigin: null },
    });
    await waitUntilAct(view.act, () => view.dom.container.textContent?.includes("Load older messages") ?? false);
    return { ...view, scrollContainer: findScrollContainer(view.dom.container) };
  }

  /** A chat of 300 entries whose reader paged back once, so entries 50 to 299 are loaded. */
  async function renderPagedBackSession(tail = createMessages(250, 300), running = false) {
    const view = await renderPaginatedSession(tail, 300, running);
    fetchOlderMessagesFastMock.mockResolvedValueOnce({ messages: createMessages(50, 250), hasMore: true, total: 300 });
    await view.act(async () => {
      clickButton(findButtonContainingText(view.dom.container, "Load older messages"));
      await waitTick();
    });
    await waitUntilAct(view.act, () => view.dom.container.textContent?.includes("entry-50") ?? false);
    fetchMessagesFastMock.mockClear();
    return view;
  }

  it("keeps the first visible message in place when older messages are prepended", async () => {
    const olderMessages = createDeferred<{ messages: ChatEntry[]; hasMore: boolean; total: number }>();
    const view = await renderPaginatedSession(createMessages(3, 5), 5);
    fetchOlderMessagesFastMock.mockReturnValueOnce(olderMessages.promise);

    try {
      const { scrollContainer, dom, act } = view;
      setScrollGeometry(scrollContainer, { scrollHeight: 1000, clientHeight: 600, scrollTop: 50 });
      // Once the older page renders it sits above the message being read and pushes it 700px down.
      const olderPageRendered = () => dom.container.textContent?.includes("entry-0") ?? false;
      placeInScroller(
        findMessageWrapperByAnchorKey(dom.container, "entry-4"),
        scrollContainer,
        () => 170 + (olderPageRendered() ? 700 : 0),
        300,
      );

      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Load older messages"));
        await waitTick();
      });
      expect(fetchOlderMessagesFastMock).toHaveBeenCalledWith("session-1", { limit: 200, before: 3 });
      expect(dom.container.textContent).toContain("Loading older messages");

      await act(async () => {
        setScrollGeometry(scrollContainer, { scrollHeight: 1700, clientHeight: 600, scrollTop: scrollContainer.scrollTop });
        olderMessages.resolve({ messages: createMessages(0, 3), hasMore: false, total: 5 });
        await waitTick();
      });
      await waitUntilAct(act, olderPageRendered);

      expect(scrollContainer.scrollTop).toBe(750);
      expect(dom.container.textContent).not.toContain("Load older messages");
    } finally {
      olderMessages.resolve({ messages: [], hasMore: false, total: 5 });
      await view.cleanup();
    }
  });

  it("holds the reader's place when the reply they are reading is not a message", async () => {
    // A finished run's summary is a completion card, and the reader is partway down a long one:
    // nothing in or below their view is a message.
    const view = await renderPaginatedSession([
      createMessage("entry-3"),
      {
        id: "entry-4",
        type: "completion",
        content: "All done",
        completion: { content: "All done", title: "Task complete", status: "success", sourceEventType: "session.task_complete" },
      },
    ], 5);
    fetchOlderMessagesFastMock.mockResolvedValueOnce({ messages: createMessages(0, 3), hasMore: false, total: 5 });

    try {
      const { scrollContainer, dom, act } = view;
      const olderPageRendered = () => dom.container.textContent?.includes("entry-0") ?? false;
      const card = findMessageWrapperByAnchorKey(dom.container, "entry-3").parentNode.childNodes.at(-1);
      placeInScroller(card, scrollContainer, () => 170 + (olderPageRendered() ? 700 : 0), 3000);
      setScrollGeometry(scrollContainer, { scrollHeight: 3200, clientHeight: 600, scrollTop: 400 });

      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Load older messages"));
        await waitTick();
      });
      await waitUntilAct(act, olderPageRendered);

      expect(scrollContainer.scrollTop).toBe(1100);
    } finally {
      await view.cleanup();
    }
  });

  describe("an older page that brings earlier steps of the run in view", () => {
    /** A window that starts partway through a run: its later step, then the reply. */
    async function renderRunInView(turnOf: (toolCallId: string) => string | undefined) {
      const step = (toolCallId: string): ChatEntry => ({
        id: `entry-${toolCallId}`,
        type: "tool",
        turnInstanceId: turnOf(toolCallId),
        toolCall: { toolCallId, name: "view", result: "done", success: true, completedAt: "2026-07-25T22:00:09.000Z" },
      });
      const view = await renderPaginatedSession([step("later"), createMessage("entry-2")], 3);
      fetchOlderMessagesFastMock.mockResolvedValueOnce({ messages: [step("earlier")], hasMore: false, total: 3 });
      const reply = findMessageWrapperByAnchorKey(view.dom.container, "entry-2");
      const rows = reply.parentNode;
      const steps = rows.childNodes[0];
      // The row that offers older messages goes once the first of them is in.
      const pageIn = () => !view.dom.container.textContent?.includes("older messages");
      const loadOlder = async () => {
        await view.act(async () => {
          clickButton(findButtonContainingText(view.dom.container, "Load older messages"));
          await waitTick();
        });
        await waitUntilAct(view.act, pageIn);
      };
      return { ...view, reply, steps, stepsKept: () => rows.contains(steps), pageIn, loadOlder };
    }

    it("measures against the reply when the run's block is rebuilt", async () => {
      // The earlier step is from another turn, and a block is keyed by the turn that opens it.
      const view = await renderRunInView((toolCallId) => `turn-${toolCallId}`);

      try {
        const { scrollContainer, reply, steps, stepsKept, pageIn, loadOlder } = view;
        placeInScroller(steps, scrollContainer, () => 100, 40);
        placeInScroller(reply, scrollContainer, () => 140 + (pageIn() ? 300 : 0), 300);
        setScrollGeometry(scrollContainer, { scrollHeight: 1000, clientHeight: 600, scrollTop: 50 });

        await loadOlder();

        expect(stepsKept()).toBe(false);
        expect(scrollContainer.scrollTop).toBe(350);
      } finally {
        await view.cleanup();
      }
    });

    it("measures against the reply when the block grows above what is on screen", async () => {
      // Same turn, so the block stays, and the viewport top cuts through it: the earlier step
      // lands inside it, above the reader, and its own top does not move.
      const view = await renderRunInView(() => "turn-1");

      try {
        const { scrollContainer, reply, steps, stepsKept, pageIn, loadOlder } = view;
        placeInScroller(steps, scrollContainer, () => 100, 400);
        placeInScroller(reply, scrollContainer, () => 500 + (pageIn() ? 60 : 0), 300);
        setScrollGeometry(scrollContainer, { scrollHeight: 1000, clientHeight: 600, scrollTop: 200 });

        await loadOlder();

        expect(stepsKept()).toBe(true);
        expect(scrollContainer.scrollTop).toBe(260);
      } finally {
        await view.cleanup();
      }
    });
  });

  it("leaves a row the viewport top cuts through alone once the browser has held a line in it", async () => {
    // Deep in one long reply, the only row in view. The page puts 700px above it and it grows 60px
    // itself, above the view. A browser that anchors scrolling follows the line being read: 760px.
    const view = await renderPaginatedSession(createMessages(4, 5), 5);
    fetchOlderMessagesFastMock.mockResolvedValueOnce({ messages: createMessages(0, 4), hasMore: false, total: 5 });

    try {
      const { scrollContainer, dom, act } = view;
      const olderPageRendered = () => dom.container.textContent?.includes("entry-0") ?? false;
      let anchored = false;
      placeInScroller(findMessageWrapperByAnchorKey(dom.container, "entry-4"), scrollContainer, () => {
        if (olderPageRendered() && !anchored) {
          anchored = true;
          scrollContainer.scrollTop += 760;
        }
        return olderPageRendered() ? 700 : 0;
      }, 2000);
      setScrollGeometry(scrollContainer, { scrollHeight: 2100, clientHeight: 600, scrollTop: 400 });

      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Load older messages"));
        await waitTick();
      });
      await waitUntilAct(act, olderPageRendered);

      // The reply's own top moved 60px less than the line did. Following it would undo the browser.
      expect(scrollContainer.scrollTop).toBe(1160);
    } finally {
      await view.cleanup();
    }
  });

  describe("content above the reader that changes height long after it rendered", () => {
    /**
     * Six rows of 150px, the reader at the top of the fifth, in a browser that does not anchor
     * scrolling. `grow` makes one row taller, as an image in it finishing loading would, which
     * pushes the rows after it down.
     */
    async function renderSixRows({ growingRow = 2, anchoring = false } = {}) {
      vi.useFakeTimers();
      if (anchoring) vi.stubGlobal("CSS", { supports: () => true });
      const resizes = stubResizeObserver();
      const view = await renderPaginatedSession(createMessages(1, 7), 7);
      const { scrollContainer, dom } = view;
      let grown = 0;
      const rowOf = (index: number) => findMessageWrapperByAnchorKey(dom.container, `entry-${index}`);
      for (let index = 1; index <= 6; index += 1) {
        placeInScroller(rowOf(index), scrollContainer, () => (index - 1) * 150 + (index > growingRow ? grown : 0), 150);
      }
      setScrollGeometry(scrollContainer, { scrollHeight: 3000, clientHeight: 600, scrollTop: 600 });
      const rows = rowOf(1).parentNode;
      return {
        ...view,
        rows,
        resizes,
        /** The row is taller, and the browser has not said so yet. */
        grow: (by: number) => { grown += by; },
        /** The browser reports that the rows changed size. */
        reportResize: () => view.act(async () => resizes.notify(rows)),
        /** The reader scrolls to where the view is now. */
        scrollHere: () => view.act(async () => {
          scroll(scrollContainer);
          await waitTick();
        }),
      };
    }

    it("holds the row the reader is on when an image above it finishes loading", async () => {
      const view = await renderSixRows();

      try {
        // Rendering settles the view, as opening a chat does.
        await view.render();
        view.grow(463);
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(1063);

        // A second image, measured from where the first one left the view.
        view.grow(100);
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(1163);
      } finally {
        await view.cleanup();
      }
    });

    it("measures from where the reader stopped scrolling", async () => {
      const view = await renderSixRows();

      try {
        await view.scrollHere();
        await advanceTimersByTimeAct(view.act, 120);
        view.grow(463);
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(1063);
      } finally {
        await view.cleanup();
      }
    });

    it("is not thrown off by a scroll event that did not move the view", async () => {
      const view = await renderSixRows();

      try {
        await view.render();
        view.grow(463);
        // The event for a move made from code arrives a frame late: this time after the image.
        await view.scrollHere();
        await advanceTimersByTimeAct(view.act, 120);
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(1063);
      } finally {
        await view.cleanup();
      }
    });

    it("does not take a move of the view for a change in height", async () => {
      const view = await renderSixRows();

      try {
        await view.render();
        // Following live output scrolls from code, and the scroll event for it is still on its way.
        view.scrollContainer.scrollTop = 900;
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(900);
      } finally {
        await view.cleanup();
      }
    });

    it("moves nothing while the reader is scrolling, and does not make up for it later", async () => {
      const view = await renderSixRows();

      try {
        await view.scrollHere();
        await advanceTimersByTimeAct(view.act, 100);
        view.grow(463);
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(600);

        // They have seen the jump by now; moving the view again would be a second one.
        await advanceTimersByTimeAct(view.act, 500);
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(600);
      } finally {
        await view.cleanup();
      }
    });

    it("holds it when the transcript renders again before the browser has reported the change", async () => {
      const view = await renderSixRows();

      try {
        await view.render();
        view.grow(463);
        // A streamed chunk, say. Settling after it would take the image's shift for granted.
        await view.render();
        expect(view.scrollContainer.scrollTop).toBe(1063);
      } finally {
        await view.cleanup();
      }
    });

    it("does not follow something that grows in view", async () => {
      // The fifth row is the one at the top of the view: opening something in it pushes the sixth down.
      const view = await renderSixRows({ growingRow: 5 });

      try {
        await view.render();
        view.grow(300);
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(600);
      } finally {
        await view.cleanup();
      }
    });

    it("leaves it to a browser that anchors scrolling itself", async () => {
      const view = await renderSixRows({ anchoring: true });

      try {
        await view.render();
        expect(view.resizes.observed()).not.toContain(view.rows);
        view.grow(463);
        await view.reportResize();
        expect(view.scrollContainer.scrollTop).toBe(600);
      } finally {
        await view.cleanup();
      }
    });
  });

  it("prefetches the previous page once the reader scrolls within a screen of the top", async () => {
    const view = await renderPaginatedSession(createMessages(3, 5), 5);

    try {
      const { scrollContainer, act } = view;
      setScrollGeometry(scrollContainer, { scrollHeight: 3000, clientHeight: 600, scrollTop: 900 });
      await act(async () => {
        scroll(scrollContainer);
        await waitTick();
      });
      expect(fetchOlderMessagesFastMock).not.toHaveBeenCalled();

      scrollContainer.scrollTop = 500;
      await act(async () => {
        scroll(scrollContainer);
        await waitTick();
      });
      expect(fetchOlderMessagesFastMock).toHaveBeenCalledWith("session-1", { limit: 200, before: 3 });
    } finally {
      await view.cleanup();
    }
  });

  it("does not fetch older messages when the reader scrolls down from near the top", async () => {
    // A long reply under a collapsed run opens with the reader almost at the top of what is loaded.
    const view = await renderPaginatedSession(createMessages(3, 5), 5);

    try {
      const { scrollContainer, act } = view;
      setScrollGeometry(scrollContainer, { scrollHeight: 3000, clientHeight: 600, scrollTop: 90 });
      for (const scrollTop of [90, 300]) {
        scrollContainer.scrollTop = scrollTop;
        await act(async () => {
          scroll(scrollContainer);
          await waitTick();
        });
      }
      expect(fetchOlderMessagesFastMock).not.toHaveBeenCalled();

      scrollContainer.scrollTop = 250;
      await act(async () => {
        scroll(scrollContainer);
        await waitTick();
      });
      expect(fetchOlderMessagesFastMock).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it("keeps filling when a page adds nothing above a reader parked at the very top", async () => {
    // A page of steps that all fold into a run already on screen changes no heights, so the
    // reader is still at the top with nothing new to scroll to.
    const view = await renderPaginatedSession(createMessages(6, 8), 8);
    fetchOlderMessagesFastMock
      .mockResolvedValueOnce({ messages: createMessages(3, 6), hasMore: true, total: 8 })
      .mockResolvedValueOnce({ messages: createMessages(0, 3), hasMore: false, total: 8 });

    try {
      const { scrollContainer, dom, act } = view;
      setScrollGeometry(scrollContainer, { scrollHeight: 1000, clientHeight: 600, scrollTop: 0 });
      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Load older messages"));
        await waitTick();
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-0") ?? false);

      expect(fetchOlderMessagesFastMock).toHaveBeenCalledTimes(2);
    } finally {
      await view.cleanup();
    }
  });

  describe("an older page that arrives while the reader is scrolling", () => {
    async function renderWithOlderPageReady() {
      vi.useFakeTimers();
      const view = await renderPaginatedSession(createMessages(3, 5), 5);
      fetchOlderMessagesFastMock.mockResolvedValueOnce({ messages: createMessages(0, 3), hasMore: false, total: 5 });
      setScrollGeometry(view.scrollContainer, { scrollHeight: 3000, clientHeight: 600, scrollTop: 900 });
      const scrollTo = async (scrollTop: number) => {
        view.scrollContainer.scrollTop = scrollTop;
        await view.act(async () => {
          scroll(view.scrollContainer);
          await waitTick();
        });
      };
      await scrollTo(900);
      return { ...view, scrollTo, inserted: () => view.dom.container.textContent?.includes("entry-0") ?? false };
    }

    it("goes in only once they have stopped", async () => {
      const { act, cleanup, dom, scrollTo, inserted } = await renderWithOlderPageReady();

      try {
        // Moving up within a screen of the top fetches the page, which is back at once.
        await scrollTo(500);
        expect(fetchOlderMessagesFastMock).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAct(act, 100);
        await scrollTo(300);
        await advanceTimersByTimeAct(act, 100);
        // Inserting it now would mean moving the scroller mid-gesture.
        expect(inserted()).toBe(false);
        expect(dom.container.textContent).toContain("Loading older messages");

        await advanceTimersByTimeAct(act, 20);
        await waitUntilAct(act, inserted);
      } finally {
        await cleanup();
      }
    });

    it("waits for a finger resting on the transcript to lift", async () => {
      const { act, cleanup, scrollContainer, scrollTo, inserted } = await renderWithOlderPageReady();

      try {
        const lift: Record<string, (event: { touches: unknown[] }) => void> = {};
        await act(async () => {
          getReactProps(scrollContainer)!.onTouchStart({
            target: { addEventListener: (type: string, listener: (event: { touches: unknown[] }) => void) => { lift[type] = listener; } },
          });
        });
        await scrollTo(500);
        await advanceTimersByTimeAct(act, 1000);
        expect(inserted()).toBe(false);

        await act(async () => lift.touchend({ touches: [] }));
        await advanceTimersByTimeAct(act, 120);
        await waitUntilAct(act, inserted);
      } finally {
        await cleanup();
      }
    });

    it("goes in after five seconds even if the touch never seems to end", async () => {
      const { act, cleanup, scrollContainer, scrollTo, inserted } = await renderWithOlderPageReady();

      try {
        // The touched node was replaced mid-touch and nothing reported the finger lifting.
        await act(async () => {
          getReactProps(scrollContainer)!.onTouchStart({ target: { addEventListener() {} } });
        });
        await scrollTo(500);
        await advanceTimersByTimeAct(act, 4_900);
        expect(inserted()).toBe(false);

        await advanceTimersByTimeAct(act, 200);
        await waitUntilAct(act, inserted);
      } finally {
        await cleanup();
      }
    });

    it("does not hold up a refresh while it waits", async () => {
      const { act, cleanup, render, scrollContainer, scrollTo, inserted } = await renderWithOlderPageReady();

      try {
        await act(async () => {
          getReactProps(scrollContainer)!.onTouchStart({ target: { addEventListener() {} } });
        });
        await scrollTo(500);
        fetchMessagesFastMock.mockClear();
        await render({ streamOverrides: { historyEpoch: 1, isStreaming: false, pendingOrigin: null } });
        await advanceTimersByTimeAct(act, 1000);

        expect(inserted()).toBe(false);
        expect(newestReads()).toEqual([{ limit: 50 }]);
      } finally {
        await cleanup();
      }
    });
  });

  it("leaves alone the scrolling a reader does while a refresh renders", async () => {
    const view = await renderPaginatedSession(createMessages(3, 5), 5);

    try {
      const { scrollContainer, dom, act, render } = view;
      // Reading entry-4, well above the bottom, when one more reply is committed.
      setScrollGeometry(scrollContainer, { scrollHeight: 3000, clientHeight: 600, scrollTop: 400 });
      placeInScroller(findMessageWrapperByAnchorKey(dom.container, "entry-4"), scrollContainer, () => 500, 300);
      await act(async () => {
        scroll(scrollContainer);
        await waitTick();
      });
      fetchMessagesFastMock.mockResolvedValueOnce({
        messages: createMessages(3, 6),
        runState: "idle",
        total: 6,
        warm: true,
        hasMore: true,
      });
      // The compositor keeps scrolling while React renders; by the commit they are 60px further on.
      messageBubbleRenderMock.mockImplementation((message: ChatMessage) => {
        if (message.id === "entry-5") scrollContainer.scrollTop = 460;
      });

      await render({ streamOverrides: { historyEpoch: 1 } });
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-5") ?? false);

      // Nothing above them changed height, so there is nothing to put back.
      expect(scrollContainer.scrollTop).toBe(460);
    } finally {
      messageBubbleRenderMock.mockReset();
      await view.cleanup();
    }
  });

  it("reads only the newest page while the run is still going", async () => {
    const view = await renderPagedBackSession(undefined, true);

    try {
      await view.render({ streamOverrides: { historyEpoch: 1 } });
      await waitUntilAct(view.act, () => newestReads().length > 0);
      // A run in flight only rewrites its newest entries, however far back the reader has loaded.
      expect(newestReads()).toEqual([{ limit: 50 }]);
    } finally {
      await view.cleanup();
    }
  });

  it("reaches further back when more arrived than the newest page covers", async () => {
    const view = await renderPagedBackSession(undefined, true);

    try {
      const { dom, act, render } = view;
      // 110 entries were committed since the last read, so the newest 50 leave a hole after entry-299.
      fetchMessagesFastMock.mockImplementation((_sessionId: string, request: { limit: number }) => Promise.resolve({
        messages: createMessages(410 - request.limit, 410),
        runState: "busy",
        total: 410,
        warm: true,
      }));

      await render({ streamOverrides: { historyEpoch: 1 } });
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-409") ?? false);

      expect(newestReads()).toEqual([{ limit: 50 }, { limit: 200 }]);
      expect(dom.container.textContent).toContain("entry-300");
      expect(dom.container.textContent).toContain("entry-50");
    } finally {
      await view.cleanup();
    }
  });

  it("waits for Retry after an older page fails instead of refetching on every scroll", async () => {
    const view = await renderPaginatedSession([createMessage("entry-1")], 2);
    fetchOlderMessagesFastMock.mockRejectedValueOnce(new Error("network unavailable"));

    try {
      const { scrollContainer, dom, act } = view;
      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Load older messages"));
        await waitTick();
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("Could not load older messages: network unavailable") ?? false);

      setScrollGeometry(scrollContainer, { scrollHeight: 1000, clientHeight: 600, scrollTop: 0 });
      await act(async () => {
        scroll(scrollContainer);
        await waitTick();
      });
      expect(fetchOlderMessagesFastMock).toHaveBeenCalledTimes(1);

      fetchOlderMessagesFastMock.mockResolvedValueOnce({ messages: [createMessage("entry-0")], hasMore: false, total: 2 });
      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Retry"));
        await waitTick();
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-0") ?? false);
      expect(dom.container.textContent).not.toContain("Could not load older messages");
    } finally {
      await view.cleanup();
    }
  });

  it("reads only the newest entries, once, when a run finishes on a long loaded window", async () => {
    vi.useFakeTimers();
    const view = await renderPagedBackSession(undefined, true);

    try {
      const { dom, act, render } = view;
      // Hold responses back like a real network would, so every read the run's end triggers is
      // issued before any of them lands.
      const reads: Array<{ limit: number; respond: () => void }> = [];
      fetchMessagesFastMock.mockImplementation((_sessionId: string, request: { limit: number }) => {
        const response = createDeferred<FetchMessagesFastResult>();
        reads.push({
          limit: request.limit,
          respond: () => response.resolve({
            messages: createMessages(300 - request.limit, 300),
            runState: "idle",
            total: 300,
            warm: true,
          }),
        });
        return response.promise;
      });

      // What the stream hook does on a terminal event: report the run settled, go idle, advance the epoch.
      const onSettled = useSessionStreamMock.mock.calls.at(-1)?.[1] as () => void;
      await act(async () => {
        onSettled();
      });
      await render({
        streamOverrides: { isStreaming: false, streamStatus: "idle", pendingOrigin: null, historyEpoch: 1 },
      });
      await advanceTimersByTimeAct(act, 1000);
      await act(async () => {
        for (const read of reads) read.respond();
        await waitTick();
      });
      await advanceTimersByTimeAct(act, 1000);

      // Re-reading all 250 loaded entries would cost more the further back the reader had paged.
      expect(reads.map((read) => read.limit)).toEqual([200]);
      expect(dom.container.textContent).toContain("entry-50");
    } finally {
      await view.cleanup();
    }
  });

  it("replaces a cached window with what disk holds now instead of trusting any of it", async () => {
    // Cached at 170 entries; the session has 200 by the time the reader comes back.
    const view = await renderChatView({
      fetchMessagesFastResult: { messages: createMessages(80, 200), runState: "idle", total: 200, warm: true, hasMore: true },
      seedQueryClient: (queryClient) => setCachedChatSnapshot(queryClient, {
        ...createSnapshot("session-1", createMessages(50, 170)),
        firstItemIndex: 50,
      }),
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });

    try {
      const { dom, act } = view;
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-199") ?? false);
      expect(newestReads()).toEqual([{ limit: 120 }]);
      // Anything may have happened to the session since it was cached, so entries the read did
      // not cover are dropped rather than kept above it.
      expect(() => findMessageWrapperByAnchorKey(dom.container, "entry-79")).toThrow();
      expect(findMessageWrapperByAnchorKey(dom.container, "entry-80")).toBeDefined();
    } finally {
      await view.cleanup();
    }
  });

  it("re-reads the whole loaded window when the server truncates history", async () => {
    const view = await renderPagedBackSession();

    try {
      await view.render({ historySignal: 1 });
      await waitUntilAct(view.act, () => newestReads().length > 0);
      // The cut may fall anywhere in the window, so the newest entries alone cannot confirm it.
      expect(newestReads()).toEqual([{ limit: 250 }]);
      // Output a finished run left on screen may be part of what was cut, and no read removes it.
      expect(view.dropFinishedRunOutputMock).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it("reads the window again when an older page went in above while it was being read", async () => {
    const view = await renderPaginatedSession(createMessages(250, 300), 300);
    const windowRead = createDeferred<FetchMessagesFastResult>();
    const newest = (from: number) => ({ messages: createMessages(from, 300), runState: "idle" as const, total: 300, warm: true });

    try {
      const { dom, act, render } = view;
      fetchMessagesFastMock.mockClear();
      fetchMessagesFastMock.mockReturnValueOnce(windowRead.promise);
      await render({ historySignal: 1 });
      await waitUntilAct(act, () => newestReads().length === 1);

      fetchOlderMessagesFastMock.mockResolvedValueOnce({ messages: createMessages(50, 250), hasMore: true, total: 300 });
      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Load older messages"));
        await waitTick();
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-50") ?? false);

      // The read that was out covers only the 50 entries loaded when it began.
      fetchMessagesFastMock.mockResolvedValueOnce(newest(50));
      await act(async () => {
        windowRead.resolve(newest(250));
        await waitTick();
      });
      await waitUntilAct(act, () => newestReads().length === 2);

      expect(newestReads()).toEqual([{ limit: 50 }, { limit: 250 }]);
      expect(dom.container.textContent).toContain("entry-50");
    } finally {
      windowRead.resolve(newest(250));
      await view.cleanup();
    }
  });

  it("re-reads the whole loaded window after an undo", async () => {
    const view = await renderPagedBackSession([
      ...createMessages(250, 298),
      { id: "entry-298", role: "user", content: "entry-298", undoEventId: "undo-1" },
      { id: "entry-299", role: "assistant", content: "entry-299", undoEventId: "undo-1" },
    ]);
    stubWindowConfirm(true);

    try {
      const { dom, act } = view;
      const menuButton = findAllByTag(findMessageWrapperByAnchorKey(dom.container, "entry-299"), "BUTTON")
        .find((button) => getReactProps(button)?.["aria-label"] === "Open message actions");
      await act(async () => {
        clickButton(menuButton);
      });
      await act(async () => {
        clickButton(findButtonByText(dom.container, "Undo turn from here"));
        await waitTick();
      });
      await waitUntilAct(act, () => newestReads().length > 0);

      // The undone turn's two entries are already gone from the window; the other 248 are re-read.
      expect(newestReads()).toEqual([{ limit: 248 }]);
    } finally {
      await view.cleanup();
    }
  });

  it("keeps paginated history when a refresh window starts after the loaded window", async () => {
    vi.useFakeTimers();
    try {
      const { dom, act, cleanup, render } = await renderPaginatedSession(
        [createMessage("entry-2", "newest"), createMessage("entry-3", "newer")],
        4,
      );

      try {
        fetchOlderMessagesFastMock.mockResolvedValue({
          messages: [createMessage("entry-0", "oldest"), createMessage("entry-1", "older")],
          hasMore: false,
          total: 4,
        });
        await act(async () => {
          clickButton(findButtonContainingText(dom.container, "Load older messages"));
          await waitTick();
        });
        await waitUntilAct(act, () => dom.container.textContent?.includes("oldest") ?? false);

        // A tail refresh that only covers the newest entries must not drop the paginated prefix.
        await render({ streamOverrides: { historyEpoch: 1, isStreaming: false, pendingOrigin: null } });
        await advanceTimersByTimeAct(act, 300);
        await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length > 2);

        const renderedText = dom.container.textContent ?? "";
        expect(renderedText).toContain("oldest");
        expect(renderedText).toContain("newest");
      } finally {
        await cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ChatView draft materialization", () => {
  it("loads the created session when delivery resolves before the route transition commits", async () => {
    const delivery = createDeferred<void>();
    const onCreateAndSend = vi.fn(() => delivery.promise);
    const { dom, act, cleanup, reconnectMock, ensureConnectedMock, render } = await renderChatView({
      composerKey: "draft:quickchat",
      sessionId: null,
      onCreateAndSend,
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      let sendPromise!: Promise<void>;
      await act(async () => {
        sendPromise = props.onSend("first message");
        await waitTick();
      });

      const pendingBubble = findAllByTag(dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("first message")
      ));
      expect(pendingBubble?.getAttribute("data-delivery-state")).toBe("sending");
      expect(onCreateAndSend).toHaveBeenCalledWith(
        "first message",
        undefined,
        "interactive",
        expect.stringMatching(/^client-/),
      );

      await act(async () => {
        delivery.resolve();
        await sendPromise;
        await waitTick();
      });
      fetchMessagesFastMock.mockResolvedValueOnce({
        messages: [createMessage("created-response", "created response")],
        runState: "idle",
        total: 1,
        warm: true,
      });
      await render({
        composerKey: "created-session",
        sessionId: "created-session",
      });

      await waitUntilAct(act, () => dom.container.textContent?.includes("created response") ?? false);
      expect(fetchMessagesFastMock).toHaveBeenCalledWith("created-session", { limit: 50 });
      expect(reconnectMock).not.toHaveBeenCalledWith("created-session");
      expect(ensureConnectedMock).not.toHaveBeenCalledWith("created-session");
    } finally {
      delivery.resolve();
      await cleanup();
    }
  });

  it("refreshes created-session history after delivery if the first route load races empty", async () => {
    const delivery = createDeferred<void>();
    const onCreateAndSend = vi.fn(() => delivery.promise);
    const { dom, act, cleanup, render } = await renderChatView({
      composerKey: "draft:quickchat",
      sessionId: null,
      onCreateAndSend,
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      let sendPromise!: Promise<void>;
      await act(async () => {
        sendPromise = props.onSend("first message");
        await waitTick();
      });
      fetchMessagesFastMock
        .mockResolvedValueOnce({
          messages: [],
          runState: "idle",
          total: 0,
          warm: true,
        })
        .mockResolvedValueOnce({
          messages: [createMessage("delivered-response", "delivered response")],
          runState: "idle",
          total: 1,
          warm: true,
        });
      await render({
        composerKey: "created-session",
        sessionId: "created-session",
      });

      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      await act(async () => {
        delivery.resolve();
        await sendPromise;
        await waitTick();
      });

      await waitUntilAct(act, () => dom.container.textContent?.includes("delivered response") ?? false);
      expect(fetchMessagesFastMock).toHaveBeenCalledTimes(2);
    } finally {
      delivery.resolve();
      await cleanup();
    }
  });

  it("refreshes history when a materialized session stream requests resync", async () => {
    const { dom, act, cleanup, render } = await renderChatView({
      composerKey: "draft:quickchat",
      sessionId: null,
      onCreateAndSend: vi.fn(),
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });

    try {
      fetchMessagesFastMock
        .mockResolvedValueOnce({
          messages: [],
          runState: "idle",
          total: 0,
          warm: true,
        })
        .mockResolvedValueOnce({
          messages: [createMessage("resynced-response", "resynced response")],
          runState: "idle",
          total: 1,
          warm: true,
        });
      await render({
        composerKey: "created-session",
        sessionId: "created-session",
      });
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);

      // A resync request settles the stream and advances its history epoch.
      await render({
        composerKey: "created-session",
        sessionId: "created-session",
        streamOverrides: { historyEpoch: 1 },
      });

      await waitUntilAct(act, () => dom.container.textContent?.includes("resynced response") ?? false);
      expect(fetchMessagesFastMock).toHaveBeenCalledTimes(2);
    } finally {
      await cleanup();
    }
  });

  it("loads an unrelated session normally while a draft send is pending", async () => {
    const delivery = createDeferred<void>();
    const onCreateAndSend = vi.fn(() => delivery.promise);
    const { act, cleanup, reconnectMock, ensureConnectedMock, render } = await renderChatView({
      composerKey: "draft:quickchat",
      sessionId: null,
      onCreateAndSend,
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      await act(async () => {
        void props.onSend("first message");
        await waitTick();
      });
      await render({
        composerKey: "existing-session",
        sessionId: "existing-session",
      });

      expect(reconnectMock).not.toHaveBeenCalledWith("existing-session");

      expect(ensureConnectedMock).not.toHaveBeenCalledWith("existing-session");
      expect(fetchMessagesFastMock).toHaveBeenCalledWith("existing-session", { limit: 50 });
    } finally {
      delivery.resolve();
      await cleanup();
    }
  });

  it("clears draft creation state and retains the failed message when creation is rejected", async () => {
    const onCreateAndSend = vi.fn().mockRejectedValue(new Error("creation rejected"));
    const { dom, act, cleanup } = await renderChatView({
      composerKey: "draft:quickchat",
      sessionId: null,
      onCreateAndSend,
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      await act(async () => {
        await props.onSend("failed first message");
        await waitTick();
      });

      const failedBubble = findAllByTag(dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("failed first message")
      ));
      expect(failedBubble?.getAttribute("data-delivery-state")).toBe("failed");
      expect(failedBubble?.getAttribute("data-delivery-error")).toBe("creation rejected");
      expect(dom.container.textContent).not.toContain("Creating session");
    } finally {
      await cleanup();
    }
  });
});

describe("ChatView steering sends", () => {
  it("renders an idle-session send gray until acceptance and hands it off without flicker", async () => {
    const sendAccepted = createDeferred<{ status: "accepted" }>();
    const { dom, act, cleanup, render, sendMessageMock } = await renderChatView({
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });
    sendMessageMock.mockReturnValueOnce(sendAccepted.promise);

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      let sendPromise!: Promise<void>;
      await act(async () => {
        sendPromise = props.onSend("waiting for server");
        await waitTick();
      });

      const findBubbles = () => findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("waiting for server")
      ));
      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("sending");
      expect(sendMessageMock).toHaveBeenCalledWith(
        "waiting for server",
        undefined,
        "interactive",
        expect.stringMatching(/^client-/),
      );
      const clientMessageId = sendMessageMock.mock.calls[0]?.[3] as string;

      await act(async () => {
        sendAccepted.resolve({ status: "accepted" });
        await sendPromise;
        await waitTick();
      });
      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("sent");

      await render({
        streamOverrides: {
          pendingUserMessages: [{
            id: clientMessageId,
            content: "waiting for server",
          }],
          isStreaming: true,
          streamStatus: "thinking",
        },
      });

      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("sent");
    } finally {
      sendAccepted.resolve({ status: "accepted" });
      await cleanup();
    }
  });

  it("retains a failed optimistic message and retries the original payload", async () => {
    const retryAccepted = createDeferred<void>();
    const attachment: Attachment = {
      type: "blob",
      mimeType: "text/plain",
      data: "cmV0cnk=",
      displayName: "retry.txt",
    };
    const { dom, act, cleanup, render, sendMessageMock } = await renderChatView({
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });
    sendMessageMock
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockReturnValueOnce(retryAccepted.promise);

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as {
        onSend: (prompt: string, attachments?: Attachment[], mode?: "interactive" | "autopilot") => Promise<void>;
      };
      await act(async () => {
        await props.onSend("please retry", [attachment], "autopilot");
        await waitTick();
      });

      const findOptimisticBubble = () => findAllByTag(dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("please retry")
      ));
      expect(findOptimisticBubble()?.getAttribute("data-delivery-state")).toBe("failed");
      expect(findOptimisticBubble()?.getAttribute("data-delivery-error")).toBe("network unavailable");
      expect(dom.container.textContent).not.toContain("⚠️ Error:");
      const clientMessageId = sendMessageMock.mock.calls[0]?.[3] as string;
      expect(sendMessageMock).toHaveBeenNthCalledWith(
        1,
        "please retry",
        [attachment],
        "autopilot",
        clientMessageId,
      );

      await act(async () => {
        const retryButton = findButtonByAriaLabel(dom.container, "Retry sending message");
        clickButton(retryButton);
        clickButton(retryButton);
        await waitTick();
      });
      expect(findOptimisticBubble()?.getAttribute("data-delivery-state")).toBe("sending");
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendMessageMock).toHaveBeenNthCalledWith(
        2,
        "please retry",
        [attachment],
        "autopilot",
        clientMessageId,
      );

      await act(async () => {
        retryAccepted.resolve();
        await waitTick();
      });
      expect(findOptimisticBubble()?.getAttribute("data-delivery-state")).toBe("sent");

      await render({
        streamOverrides: {
          pendingUserMessages: [{
            id: clientMessageId,
            content: "please retry",
            attachments: [attachment],
            sourceEventId: "retry-user-event-1",
          }],
          isStreaming: true,
          streamStatus: "thinking",
        },
      });
      const acceptedBubbles = findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("please retry")
      ));
      expect(acceptedBubbles).toHaveLength(1);
      expect(acceptedBubbles[0]?.getAttribute("data-delivery-state")).toBe("sent");
    } finally {
      retryAccepted.resolve();
      await cleanup();
    }
  });

  it("keeps a busy-session steering message gray until the server accepts it", async () => {
    vi.useFakeTimers();
    const sendAccepted = createDeferred<{ status: "accepted"; mode: "steered" }>();
    const { dom, act, cleanup, render, sendMessageMock } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        runState: "busy",
        total: 1,
        warm: true,
        hasMore: false,
      },
    });
    sendMessageMock.mockReturnValueOnce(sendAccepted.promise);

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      let sendPromise!: Promise<void>;
      await act(async () => {
        sendPromise = props.onSend("please adjust");
        await waitTick();
      });

      const clientMessageId = sendMessageMock.mock.calls[0]?.[3] as string;
      const findBubbles = () => findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("please adjust")
      ));
      expect(sendMessageMock).toHaveBeenCalledWith(
        "please adjust",
        undefined,
        undefined,
        clientMessageId,
      );
      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("sending");

      await render({
        streamOverrides: {
          pendingUserMessages: [{
            id: clientMessageId,
            content: "please adjust",
          }],
          isStreaming: true,
          streamStatus: "streaming",
        },
      });
      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("sending");

      fetchMessagesFastMock.mockResolvedValue({
        messages: [
          createMessage("entry-1"),
          {
            id: "canonical-before-acceptance",
            role: "user",
            content: "please adjust",
            sourceEventId: "steered-user-event-1",
          },
          createMessage("disk-refresh-marker"),
        ],
        runState: "busy",
        total: 3,
        warm: true,
        hasMore: false,
        coverage: {},
      });
      await render({
        streamOverrides: {
          pendingUserMessages: [{
            id: clientMessageId,
            content: "please adjust",
            sourceEventId: "steered-user-event-1",
          }],
          historyEpoch: 1,
          isStreaming: true,
          streamStatus: "streaming",
        },
      });
      await advanceTimersByTimeAct(act, 300);
      expect(dom.container.textContent).toContain("disk-refresh-marker");
      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("sending");

      await act(async () => {
        sendAccepted.resolve({ status: "accepted", mode: "steered" });
        await sendPromise;
        await waitTick();
      });
      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("sent");
    } finally {
      sendAccepted.resolve({ status: "accepted", mode: "steered" });
      await cleanup();
      vi.useRealTimers();
    }
  });

  it("shows a queued message as waiting until the server starts its turn", async () => {
    const { dom, act, cleanup, render, sendMessageMock } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        runState: "busy",
        total: 1,
        warm: true,
        hasMore: false,
      },
    });
    sendMessageMock.mockResolvedValueOnce({ status: "accepted", mode: "queued" });

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      await act(async () => {
        await props.onSend("where do we stand?");
        await waitTick();
      });

      const clientMessageId = sendMessageMock.mock.calls[0]?.[3] as string;
      const findBubbles = () => findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("where do we stand?")
      ));
      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("queued");

      await render({
        streamOverrides: {
          pendingUserMessages: [{ id: clientMessageId, content: "where do we stand?" }],
          isStreaming: true,
          streamStatus: "streaming",
        },
      });
      expect(findBubbles()).toHaveLength(1);
      expect(findBubbles()[0]?.getAttribute("data-delivery-state")).toBe("sent");
    } finally {
      await cleanup();
    }
  });

  it("retries a failed steering message without adding a mode or dispatching twice", async () => {
    const retryAccepted = createDeferred<void>();
    const { dom, act, cleanup, render, sendMessageMock } = await renderChatView({});
    sendMessageMock
      .mockRejectedValueOnce(new Error("steering request rejected"))
      .mockReturnValueOnce(retryAccepted.promise);

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as {
        onSend: (prompt: string) => Promise<void>;
      };
      await act(async () => {
        await props.onSend("retry steering");
        await waitTick();
      });

      const retryButton = findButtonByAriaLabel(dom.container, "Retry sending message");
      await act(async () => {
        clickButton(retryButton);
        clickButton(retryButton);
        await waitTick();
      });
      const findRetryBubble = () => findAllByTag(dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("retry steering")
      ));
      expect(findRetryBubble()?.getAttribute("data-delivery-state")).toBe("sending");
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      const clientMessageId = sendMessageMock.mock.calls[0]?.[3] as string;
      expect(sendMessageMock.mock.calls[0]).toEqual([
        "retry steering",
        undefined,
        undefined,
        clientMessageId,
      ]);
      expect(sendMessageMock.mock.calls[1]).toEqual([
        "retry steering",
        undefined,
        undefined,
        clientMessageId,
      ]);

      await act(async () => {
        retryAccepted.resolve();
        await waitTick();
      });
      expect(findRetryBubble()?.getAttribute("data-delivery-state")).toBe("sent");

      await render({
        streamOverrides: {
          pendingUserMessages: [{
            id: clientMessageId,
            content: "retry steering",
            sourceEventId: "steering-retry-event-1",
          }],
          isStreaming: true,
          streamStatus: "streaming",
        },
      });
      expect(findRetryBubble()?.getAttribute("data-delivery-state")).toBe("sent");
    } finally {
      retryAccepted.resolve();
      await cleanup();
    }
  });

  it("does not carry an unresolved optimistic send into another chat", async () => {
    const sendAccepted = createDeferred<void>();
    const { dom, act, cleanup, render, sendMessageMock } = await renderChatView({
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });
    sendMessageMock.mockReturnValueOnce(sendAccepted.promise);

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      let sendPromise!: Promise<void>;
      await act(async () => {
        sendPromise = props.onSend("stay in the original chat");
        await waitTick();
      });
      expect(dom.container.textContent).toContain("stay in the original chat");

      await render({
        sessionId: "session-2",
        composerKey: "composer-2",
        streamOverrides: {
          isStreaming: false,
          streamStatus: "idle",
          pendingOrigin: null,
        },
      });
      expect(dom.container.textContent).not.toContain("stay in the original chat");

      await act(async () => {
        sendAccepted.resolve();
        await sendPromise;
        await waitTick();
      });
      expect(dom.container.textContent).not.toContain("stay in the original chat");
    } finally {
      sendAccepted.resolve();
      await cleanup();
    }
  });

  it("replaces a streamed user bubble with its canonical message without duplication", async () => {
    const { dom, act, cleanup, render, sendMessageMock } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        runState: "busy",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        isStreaming: true,
        streamStatus: "streaming",
      },
    });

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      await act(async () => {
        await props.onSend("please adjust");
        await waitTick();
      });

      expect(findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent === "please adjust"
      ))).toHaveLength(1);
      const clientMessageId = sendMessageMock.mock.calls[0]?.[3] as string;

      const streamedUser = {
        id: clientMessageId,
        content: "please adjust",
        sourceEventId: "canonical-user-event-1",
      };
      await render({
        streamOverrides: {
          pendingUserMessages: [streamedUser],
          isStreaming: true,
          streamStatus: "streaming",
        },
      });
      expect(findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent === "please adjust"
      ))).toHaveLength(1);

      fetchMessagesFastMock.mockResolvedValue({
        messages: [
          createMessage("entry-1"),
          {
            id: "canonical-user-1",
            role: "user",
            content: "please adjust",
            sourceEventId: "canonical-user-event-1",
          },
        ],
        runState: "idle",
        total: 2,
        warm: true,
        hasMore: false,
        coverage: {},
      });
      await render({
        streamOverrides: {
          pendingUserMessages: [streamedUser],
          isStreaming: false,
          streamStatus: "idle",
          historyEpoch: 1,
        },
      });
      await waitUntilAct(act, () => {
        try {
          findMessageWrapperByAnchorKey(dom.container, "canonical-user-1");
          return true;
        } catch {
          return false;
        }
      });

      expect(findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent === "please adjust"
      ))).toHaveLength(1);
      expect(findMessageWrapperByAnchorKey(dom.container, "canonical-user-1")).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("reconciles canonical and live entries by exact identity", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          {
            id: "canonical-assistant",
            role: "assistant",
            content: "canonical assistant",
            sourceEventId: "assistant-event-1",
          },
          {
            id: "canonical-tool",
            type: "tool",
            sourceEventId: "tool-event-1",
            toolCall: {
              toolCallId: "tool-call-1",
              name: "canonical_tool",
              result: "done",
              success: true,
            },
          },
        ],
        runState: "busy",
        total: 2,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        liveAssistantSegments: [{
          id: "assistant-event-1",
          content: "duplicate live assistant",
          sourceEventId: "assistant-event-1",
        }],
        liveTools: [{ toolCallId: "tool-call-1", name: "duplicate_live_tool" }],
        isStreaming: true,
        streamStatus: "streaming",
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("canonical assistant") ?? false);
      expect(dom.container.textContent).not.toContain("duplicate live assistant");
      await expandActivity(dom.container, act);
      expect(dom.container.textContent).toContain("canonical_tool");
      expect(dom.container.textContent).not.toContain("duplicate_live_tool");
    } finally {
      await cleanup();
    }
  });

  it("does not let a stale live sub-agent launch result overwrite the committed response", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          {
            id: "canonical-agent",
            type: "tool",
            toolCall: {
              toolCallId: "agent-call-1",
              name: "🤖 Explore Agent",
              isSubAgent: true,
              result: "Committed final response",
              success: true,
              completedAt: "2026-07-25T22:00:10.000Z",
            },
          },
          {
            id: "canonical-child",
            type: "tool",
            toolCall: {
              toolCallId: "child-call-1",
              name: "rg",
              parentToolCallId: "agent-call-1",
              result: "done",
              success: true,
              completedAt: "2026-07-25T22:00:09.000Z",
            },
          },
        ],
        runState: "busy",
        total: 2,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        liveTools: [{
          toolCallId: "agent-call-1",
          name: "🤖 Explore Agent",
          isSubAgent: true,
          result: "Agent started in background",
          success: true,
          completedAt: "2026-07-25T22:00:01.000Z",
        }],
        isStreaming: true,
        streamStatus: "streaming",
      },
    });

    try {
      await waitUntilAct(act, () => findAllByTag(dom.container, "BUTTON").some((button) => (
        button.getAttribute?.("aria-expanded") === "false"
      )));
      await expandActivity(dom.container, act);
      expect(dom.container.textContent).toContain("Committed final response");
      expect(dom.container.textContent).not.toContain("Agent started in background");
    } finally {
      await cleanup();
    }
  });

  it("does not append older snapshot entries after the canonical tail", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          {
            id: "canonical-boundary",
            role: "assistant",
            content: "canonical boundary",
            sourceEventId: "assistant-event-2",
            timestamp: "2026-07-25T22:00:00.000Z",
          },
          {
            id: "canonical-latest",
            role: "assistant",
            content: "canonical latest",
            sourceEventId: "assistant-event-3",
            timestamp: "2026-07-25T22:01:00.000Z",
          },
        ],
        runState: "busy",
        total: 50,
        warm: true,
        hasMore: true,
      },
      streamOverrides: {
        liveAssistantSegments: [
          {
            // Committed, but its disk entry sits above the loaded window — the watermark must
            // retire it rather than letting it re-render below the canonical tail.
            id: "assistant-event-1",
            content: "older snapshot message",
            sourceEventId: "assistant-event-1",
            timestamp: "2026-07-25T21:00:00.000Z",
          },
          {
            id: "assistant-event-2",
            content: "duplicate boundary",
            sourceEventId: "assistant-event-2",
            timestamp: "2026-07-25T22:00:00.000Z",
          },
          {
            id: "assistant-event-3",
            content: "duplicate latest",
            sourceEventId: "assistant-event-3",
            timestamp: "2026-07-25T22:01:00.000Z",
          },
          {
            id: "assistant-event-4",
            content: "new live message",
            sourceEventId: "assistant-event-4",
            timestamp: "2026-07-25T22:02:00.000Z",
          },
        ],
        isStreaming: true,
        streamStatus: "streaming",
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("new live message") ?? false);
      const messages = findAllByTag(dom.container, "DIV")
        .filter((candidate) => candidate.getAttribute?.("data-testid") === "message-bubble")
        .map((candidate) => candidate.textContent);

      expect(messages).toEqual(["canonical boundary", "canonical latest", "new live message"]);
      expect(dom.container.textContent).not.toContain("older snapshot message");
    } finally {
      await cleanup();
    }
  });

  it("reconciles a projected final assistant entry when delayed disk history reaches its source event", async () => {
    const onRenderedReadThrough = vi.fn();
    const { dom, act, cleanup, render } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "canonical-user",
          role: "user",
          content: "Question",
          sourceEventId: "user-message-event",
        }],
        runState: "busy",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        liveAssistantSegments: [{
          id: "assistant-message-event",
          content: "Final answer",
          sourceEventId: "assistant-message-event",
          timestamp: "2026-07-23T16:00:00.000Z",
        }],
        isStreaming: false,
        streamStatus: "idle",
      },
      onRenderedReadThrough,
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Final answer") ?? false);
      expect(findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent === "Final answer"
      ))).toHaveLength(1);
      expect(onRenderedReadThrough).toHaveBeenCalledWith(
        "session-1",
        "2026-07-23T16:00:00.000Z",
      );

      fetchMessagesFastMock.mockResolvedValue({
        messages: [
          {
            id: "canonical-user",
            role: "user",
            content: "Question",
            sourceEventId: "user-message-event",
          },
          {
            id: "canonical-final",
            role: "assistant",
            content: "Final answer",
            sourceEventId: "assistant-message-event",
            timestamp: "2026-07-23T15:59:59.000Z",
          },
        ],
        runState: "idle",
        total: 2,
        warm: true,
        hasMore: false,
      });
      // The delayed commit reaches disk and the stream announces it.
      await render({ streamOverrides: { historyEpoch: 1 } });
      await waitUntilAct(act, () => {
        try {
          findMessageWrapperByAnchorKey(dom.container, "canonical-final");
          return true;
        } catch {
          return false;
        }
      });

      expect(findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent === "Final answer"
      ))).toHaveLength(1);
      expect(findMessageWrapperByAnchorKey(dom.container, "canonical-final")).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("keeps prior history visible when provider turn IDs restart", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          {
            id: "historical-assistant",
            role: "assistant",
            content: "previous reply",
            turnId: "1",
            sourceEventId: "old-assistant-event",
          },
          {
            id: "historical-tool",
            type: "tool",
            turnId: "1",
            sourceEventId: "old-tool-event",
            toolCall: {
              toolCallId: "old-tool-call",
              name: "old_tool",
              result: "done",
              success: true,
            },
          },
        ],
        runState: "busy",
        total: 2,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        pendingUserMessages: [{
          id: "user-current",
          content: "current question",
          sourceEventId: "current-user-event",
        }],
        liveAssistantSegments: [{
          id: "current",
          content: "current reply",
          turnId: "1",
          sourceEventId: "current-assistant-event",
        }],
        activeTurnId: "1",
        isStreaming: false,
        streamStatus: "idle",
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("current reply") ?? false);
      expect(dom.container.textContent).toContain("previous reply");
      // A finished block holding one tool call reads as that call.
      expect(dom.container.textContent).toContain("Old tool");
      expect(dom.container.textContent).toContain("current question");

      // Disk history keeps its own ordering; the live overlay is appended after it, even when
      // provider turn ids repeat across runs.
      const renderedText = dom.container.textContent ?? "";
      expect(renderedText.indexOf("Old tool")).toBeGreaterThan(renderedText.indexOf("previous reply"));
      expect(renderedText.indexOf("current question")).toBeGreaterThan(renderedText.indexOf("Old tool"));
      expect(renderedText.indexOf("current reply")).toBeGreaterThan(renderedText.indexOf("current question"));

      const historicalMessage = findMessageWrapperByAnchorKey(dom.container, "historical-assistant");
      const currentMessage = findMessageWrapperByAnchorKey(dom.container, "live-assistant-current");
      expect(historicalMessage.getAttribute("data-latest-chat-message")).not.toBe("true");
      expect(currentMessage.getAttribute("data-latest-chat-message")).toBe("true");
    } finally {
      await cleanup();
    }
  });

  it("keeps tool cards ordered when provider turn IDs restart within one interaction", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          {
            id: "assistant-first",
            role: "assistant",
            content: "First pass",
            turnId: "0",
            turnInstanceId: "turn-start-a",
          },
          {
            id: "tool-first",
            type: "tool",
            turnId: "0",
            turnInstanceId: "turn-start-a",
            toolCall: {
              toolCallId: "tool-first-call",
              name: "first_tool",
              result: "done",
              success: true,
            },
          },
          {
            id: "assistant-middle",
            role: "assistant",
            content: "Middle pass",
            turnId: "1",
            turnInstanceId: "turn-start-b",
          },
          {
            id: "tool-middle",
            type: "tool",
            turnId: "1",
            turnInstanceId: "turn-start-b",
            toolCall: {
              toolCallId: "tool-middle-call",
              name: "middle_tool",
              result: "done",
              success: true,
            },
          },
          {
            id: "assistant-resumed",
            role: "assistant",
            content: "Resumed pass",
            turnId: "0",
            turnInstanceId: "turn-start-c",
          },
          {
            id: "tool-resumed",
            type: "tool",
            turnId: "0",
            turnInstanceId: "turn-start-c",
            toolCall: {
              toolCallId: "tool-resumed-call",
              name: "resumed_tool",
              result: "done",
              success: true,
            },
          },
          {
            id: "assistant-finished",
            role: "assistant",
            content: "Finished",
            turnId: "0",
            turnInstanceId: "turn-start-c",
          },
        ],
        runState: "idle",
        total: 7,
        warm: true,
        hasMore: false,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Resumed tool") ?? false);
      const renderedText = dom.container.textContent ?? "";
      expect(renderedText.indexOf("First tool")).toBeGreaterThan(renderedText.indexOf("First pass"));
      expect(renderedText.indexOf("Middle pass")).toBeGreaterThan(renderedText.indexOf("First tool"));
      expect(renderedText.indexOf("Middle tool")).toBeGreaterThan(renderedText.indexOf("Middle pass"));
      expect(renderedText.indexOf("Resumed pass")).toBeGreaterThan(renderedText.indexOf("Middle tool"));
      expect(renderedText.indexOf("Resumed tool")).toBeGreaterThan(renderedText.indexOf("Resumed pass"));
      expect(renderedText.indexOf("Finished")).toBeGreaterThan(renderedText.indexOf("Resumed tool"));
    } finally {
      await cleanup();
    }
  });
});

describe("ChatView live streaming UX", () => {
  it("renders streamed assistant text as the normal assistant bubble without the old status card", async () => {
    const { dom, act, cleanup } = await renderChatView({
      streamOverrides: {
        streamingContent: "Hello **there**",
        streamStatus: "streaming",
        hadVisibleOutput: true,
        intentText: "Streaming response",
      },
    });

    try {
      await waitUntilAct(act, () => {
        try {
          return findMessageBubble(dom.container, true).textContent?.includes("Hello **there**") ?? false;
        } catch {
          return false;
        }
      });

      const bubble = findMessageBubble(dom.container, true);
      expect(bubble.getAttribute("data-role")).toBe("assistant");
      expect(findMessageWrapperByAnchorKey(dom.container, "live-assistant-stream").getAttribute("data-latest-chat-message")).toBe("true");
    } finally {
      await cleanup();
    }
  });

  it("shows a compact status before the first streamed text arrives", async () => {
    const { dom, act, cleanup } = await renderChatView({
      streamOverrides: {
        streamingContent: "",
        streamStatus: "thinking",
        intentText: "Planning the response",
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Planning the response") ?? false);
      expect(() => findMessageBubble(dom.container, true)).toThrow();
      expect(dom.container.textContent).not.toContain("The assistant is working before any text or tool activity is visible.");
    } finally {
      await cleanup();
    }
  });

  it("streams the model's thinking in place of the waiting status, collapsed until it is opened", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{ id: "user-1", role: "user", content: "How many sheep?", sourceEventId: "user-event-1" }],
        runState: "busy",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        streamStatus: "thinking",
        activeTurnInstanceId: "turn-start-1",
        liveReasoning: [{
          id: "r-1",
          content: "All but nine run away, so nine remain.",
          startedAt: "2026-09-20T08:00:01.000Z",
          turnInstanceId: "turn-start-1",
        }],
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("so nine remain.") ?? false);
      const block = findAllByTag(dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-activity-block") === "activity:turn-start-1:0"
      ));
      expect(block?.getAttribute("data-activity-state")).toBe("active");
      expect(block?.textContent).toContain("Thinking");
      // The block is the run's indicator now; a second one underneath would only repeat it.
      expect(findAllByTag(dom.container, "DIV").some((candidate) => candidate.getAttribute?.("data-live-status"))).toBe(false);
      expect(findButtonContainingText(dom.container, "Thinking").getAttribute("aria-expanded")).toBe("false");

      await expandActivity(dom.container, act);
      expect(findAllByTag(dom.container, "DIV").some((candidate) => (
        candidate.getAttribute?.("data-thought-state") === "streaming"
      ))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("hands committed thinking off to disk history instead of showing it twice", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          {
            id: "entry-0",
            type: "reasoning",
            turnInstanceId: "turn-start-1",
            content: "DISK-THOUGHT nine remain, then doubled.",
            timestamp: "2026-09-20T08:00:03.000Z",
            reasoning: { messageEventId: "assistant-message-1", startedAt: "2026-09-20T08:00:00.000Z" },
          },
          {
            id: "entry-1",
            role: "assistant",
            content: "Eighteen sheep.",
            turnInstanceId: "turn-start-1",
            sourceEventId: "assistant-message-1",
            timestamp: "2026-09-20T08:00:03.000Z",
          },
        ],
        runState: "idle",
        total: 2,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        liveReasoning: [{
          id: "r-1",
          content: "LIVE-THOUGHT nine remain, then doubled.",
          sourceEventId: "assistant-message-1",
          completedAt: "2026-09-20T08:00:02.000Z",
          committedAt: "2026-09-20T08:00:03.000Z",
          turnInstanceId: "turn-start-1",
        }],
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Eighteen sheep.") ?? false);
      const blocks = findAllByTag(dom.container, "DIV").filter((candidate) => candidate.getAttribute?.("data-activity-block"));
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.getAttribute("data-activity-state")).toBe("done");
      // Thinking sits above the reply it led to.
      const text = dom.container.textContent ?? "";
      expect(text.indexOf("Thought")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Thought")).toBeLessThan(text.indexOf("Eighteen sheep."));

      await expandActivity(dom.container, act);
      expect(dom.container.textContent).toContain("DISK-THOUGHT");
      expect(dom.container.textContent).not.toContain("LIVE-THOUGHT");
    } finally {
      await cleanup();
    }
  });

  it("keeps the working state on the block the run is writing into rather than beneath it", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          { id: "entry-0", role: "user", content: "Check the repo", sourceEventId: "user-event-1" },
          {
            id: "entry-1",
            type: "tool",
            turnInstanceId: "turn-start-1",
            toolCall: {
              toolCallId: "tool-1",
              name: "view",
              args: { path: "/repo/README.md" },
              startedAt: "2026-09-20T08:00:01.000Z",
              completedAt: "2026-09-20T08:00:02.000Z",
              success: true,
            },
          },
        ],
        runState: "busy",
        total: 2,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        streamStatus: "thinking",
        hadVisibleOutput: true,
        intentText: "Exploring the repository",
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Exploring the repository") ?? false);
      const block = findAllByTag(dom.container, "DIV").find((candidate) => candidate.getAttribute?.("data-activity-block"));
      expect(block?.getAttribute("data-activity-state")).toBe("active");
      expect(block?.textContent).toContain("Exploring the repository");
      expect(findAllByTag(dom.container, "DIV").some((candidate) => candidate.getAttribute?.("data-live-status"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("hangs a reply's hover actions in the margin only while the chat column is wide enough", async () => {
    const resizes = stubResizeObserver();
    const { dom, act, cleanup } = await renderChatView({
      streamOverrides: { isStreaming: false, streamStatus: "idle", pendingOrigin: null },
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1", "a reply")],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("a reply") ?? false);
      const root = findAllByTag(dom.container, "DIV").find((candidate) => (
        String(getReactProps(candidate)?.className ?? "").includes("chat-ui")
      ));
      if (!root) throw new Error("Chat root not found");
      expect(resizes.observed()).toContain(root);
      // No measurable width (or a narrow column): the actions keep to the reply's own corner.
      expect(root.getAttribute("data-action-gutter")).not.toBe("true");

      Object.defineProperty(root, "clientWidth", { configurable: true, value: 1200 });
      await act(async () => resizes.notify(root));
      expect(root.getAttribute("data-action-gutter")).toBe("true");

      // The task rail opening, or a side panel, narrows the column without changing the viewport.
      Object.defineProperty(root, "clientWidth", { configurable: true, value: 900 });
      await act(async () => resizes.notify(root));
      expect(root.getAttribute("data-action-gutter")).not.toBe("true");
    } finally {
      await cleanup();
    }
  });

  it("pauses follow mode and offers jump to latest when the user scrolls away during streaming", async () => {
    const { dom, act, cleanup } = await renderChatView({
      streamOverrides: {
        streamingContent: "A longer streamed response",
        streamStatus: "streaming",
        hadVisibleOutput: true,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("A longer streamed response") ?? false);
      const scrollContainer = findScrollContainer(dom.container);
      setScrollGeometry(scrollContainer, { scrollHeight: 1000, clientHeight: 400, scrollTop: 200 });

      await act(async () => {
        const props = getReactProps(scrollContainer);
        props?.onWheel?.();
        props?.onScroll?.();
        await waitTick();
      });

      expect(dom.container.textContent).toContain("Jump to latest");

      await act(async () => {
        clickButton(findButtonByAriaLabel(dom.container, "Jump to latest"));
        await waitTick();
      });

      expect(dom.container.textContent).not.toContain("Jump to latest");
    } finally {
      await cleanup();
    }
  });

  it("stops following the bottom once the live message top reaches the viewport top", async () => {
    const { dom, act, cleanup, render } = await renderChatView({
      streamOverrides: {
        streamingContent: "A streamed response",
        streamStatus: "streaming",
        hadVisibleOutput: true,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("A streamed response") ?? false);
      const scrollContainer = findScrollContainer(dom.container);
      const liveMessage = findMessageWrapperByAnchorKey(dom.container, "live-assistant-stream");
      setElementTop(scrollContainer, 0);
      setElementTop(liveMessage, 5);
      setScrollGeometry(scrollContainer, { scrollHeight: 1000, clientHeight: 400, scrollTop: 500 });

      await render({
        streamOverrides: {
          streamingContent: "A streamed response with a little more text",
          streamStatus: "streaming",
          hadVisibleOutput: true,
        },
      });
      await waitUntilAct(act, () => scrollContainer.scrollTop === 505);

      setElementTop(liveMessage, 0);
      setScrollGeometry(scrollContainer, { scrollHeight: 1400, clientHeight: 400, scrollTop: scrollContainer.scrollTop });

      await render({
        streamOverrides: {
          streamingContent: "A streamed response with enough extra text to keep growing below the viewport",
          streamStatus: "streaming",
          hadVisibleOutput: true,
        },
      });
      await act(async () => {
        await waitTick();
      });

      expect(scrollContainer.scrollTop).toBe(505);
    } finally {
      await cleanup();
    }
  });
});

describe("ChatView message actions", () => {
  it("reconciles completed live turns from disk so undo boundaries appear without navigation", async () => {
    const { dom, act, cleanup, render } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [],
        runState: "busy",
        total: 0,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: true },
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length >= 1);
      fetchMessagesFastMock.mockResolvedValue({
        messages: [
          { id: "user-1", role: "user", content: "first", undoEventId: "user-event-1" },
          { id: "assistant-1", role: "assistant", content: "reply one", undoEventId: "user-event-1" },
        ],
        runState: "idle",
        total: 2,
        warm: true,
        hasMore: false,
      });

      await render({ streamOverrides: { isStreaming: false, historyEpoch: 1 } });
      await waitUntilAct(act, () => dom.container.textContent?.includes("reply one") ?? false);

      const wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-1");
      const menuButton = findAllByTag(wrapper, "BUTTON").find((button) => (
        getReactProps(button)?.["aria-label"] === "Open message actions"
      ));
      await act(async () => {
        clickButton(menuButton);
      });

      expect(dom.container.textContent).toContain("Undo turn from here");
    } finally {
      await cleanup();
    }
  });

  it("shows timestamp, copy, and bounded fork actions for assistant messages", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onForkSession = vi.fn().mockResolvedValue(undefined);
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "assistant-1",
          role: "assistant",
          content: "assistant reply",
          timestamp: "2026-04-29T12:00:00.000Z",
          forkBoundaryEventId: "event-after-assistant-1",
        }],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
      onForkSession,
    });

    try {
      (globalThis.navigator as unknown as { clipboard?: { writeText: typeof writeText } }).clipboard = { writeText };
      await waitUntilAct(act, () => {
        try {
          findButtonByAriaLabel(dom.container, "Open message actions");
          return true;
        } catch {
          return false;
        }
      });

      await act(async () => {
        clickButton(findButtonByAriaLabel(dom.container, "Open message actions"));
      });

      expect(dom.container.textContent).toContain("Timestamp");
      expect(dom.container.textContent).toContain("Copy message");
      expect(dom.container.textContent).toContain("Fork from here");

      await act(async () => {
        clickButton(findButtonByText(dom.container, "Copy message"));
        await waitTick();
      });
      expect(writeText).toHaveBeenCalledWith("assistant reply");

      await act(async () => {
        clickButton(findButtonByAriaLabel(dom.container, "Open message actions"));
      });
      await act(async () => {
        clickButton(findButtonByText(dom.container, "Fork from here"));
        await waitTick();
      });
      expect(onForkSession).toHaveBeenCalledWith("session-1", { toEventId: "event-after-assistant-1" });
    } finally {
      await cleanup();
    }
  });

  it("uses actions-first message bindings and offers an explicit text-selection mode", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "assistant-1",
          role: "assistant",
          content: "Select any part of this reply",
          timestamp: "2026-04-29T12:00:00.000Z",
        }],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Select any part") ?? false);
      let wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-1");
      expect(wrapper.getAttribute("data-message-actions-trigger")).toBe("true");
      expect(wrapper.getAttribute("data-message-text-selection")).toBeNull();

      await act(async () => {
        clickButton(findButtonByAriaLabel(wrapper, "Open message actions"));
      });
      expect(dom.container.textContent).toContain("Select text");

      await act(async () => {
        clickButton(findButtonByText(dom.container, "Select text"));
      });

      wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-1");
      const bubble = findMessageBubble(wrapper, false);
      expect(wrapper.getAttribute("data-message-actions-trigger")).toBeNull();
      expect(wrapper.getAttribute("data-message-text-selection")).toBe("true");
      expect(getReactProps(wrapper)?.onTouchStart).toBeUndefined();
      expect(getReactProps(wrapper)?.onContextMenu).toBeUndefined();
      expect(bubble.getAttribute("data-selecting-text")).toBe("true");

      await act(async () => {
        clickButton(findButtonByAriaLabel(wrapper, "Finish selecting message text"));
      });

      wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-1");
      expect(wrapper.getAttribute("data-message-actions-trigger")).toBe("true");
      expect(wrapper.getAttribute("data-message-text-selection")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("opens message actions from a long-press or an unselected desktop right-click", async () => {
    vi.useFakeTimers();
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "assistant-1",
          role: "assistant",
          content: "Open my message actions",
        }],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Open my message") ?? false);
      let wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-1");
      await act(async () => {
        getReactProps(wrapper)?.onTouchStart?.({
          target: wrapper,
          touches: [{ clientX: 24, clientY: 32 }],
        });
      });
      await advanceTimersByTimeAct(act, 500);
      expect(dom.container.textContent).toContain("Select text");

      await act(async () => {
        clickButton(findButtonByText(dom.container, "Select text"));
      });
      await act(async () => {
        clickButton(findButtonByAriaLabel(dom.container, "Finish selecting message text"));
      });

      wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-1");
      const preventDefault = vi.fn();
      await act(async () => {
        getReactProps(wrapper)?.onContextMenu?.({
          currentTarget: wrapper,
          target: wrapper,
          clientX: 40,
          clientY: 52,
          preventDefault,
        });
      });
      expect(preventDefault).toHaveBeenCalled();
      expect(dom.container.textContent).toContain("Copy message");
    } finally {
      await cleanup();
    }
  });

  it("leaves the native desktop context menu available for selected message text", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "assistant-1",
          role: "assistant",
          content: "Keep this selection native",
        }],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Keep this selection") ?? false);
      const wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-1");
      Object.defineProperty(window, "getSelection", {
        configurable: true,
        value: () => ({
          anchorNode: wrapper,
          focusNode: wrapper,
          isCollapsed: false,
          rangeCount: 1,
          toString: () => "this selection",
          getRangeAt: () => ({ intersectsNode: (node: unknown) => node === wrapper }),
          removeAllRanges: vi.fn(),
        }),
      });
      const preventDefault = vi.fn();

      await act(async () => {
        getReactProps(wrapper)?.onContextMenu?.({
          currentTarget: wrapper,
          target: wrapper,
          clientX: 40,
          clientY: 52,
          preventDefault,
        });
      });

      expect(preventDefault).not.toHaveBeenCalled();
      expect(dom.container.textContent).not.toContain("Timestamp");
    } finally {
      delete (window as unknown as { getSelection?: unknown }).getSelection;
      await cleanup();
    }
  });

  it("preserves native link menus and ignores long-presses on nested controls", async () => {
    vi.useFakeTimers();
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "assistant-1",
          role: "assistant",
          content: "Interactive message content",
        }],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Interactive message") ?? false);
      const wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-1");
      const nativeTarget = { closest: () => ({}) };
      const preventDefault = vi.fn();

      await act(async () => {
        getReactProps(wrapper)?.onContextMenu?.({
          currentTarget: wrapper,
          target: nativeTarget,
          clientX: 40,
          clientY: 52,
          preventDefault,
        });
      });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(dom.container.textContent).not.toContain("Timestamp");

      await act(async () => {
        getReactProps(wrapper)?.onTouchStart?.({
          target: nativeTarget,
          touches: [{ clientX: 24, clientY: 32 }],
        });
      });
      await advanceTimersByTimeAct(act, 500);
      expect(dom.container.textContent).not.toContain("Select text");
    } finally {
      await cleanup();
    }
  });

  it("surfaces bounded fork failures instead of silently closing the menu", async () => {
    const onForkSession = vi.fn().mockRejectedValue(new Error("Session not found: fork-session"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "assistant-1",
          role: "assistant",
          content: "assistant reply",
          timestamp: "2026-04-29T12:00:00.000Z",
          forkBoundaryEventId: "event-after-assistant-1",
        }],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
      onForkSession,
    });

    try {
      await waitUntilAct(act, () => {
        try {
          findButtonByAriaLabel(dom.container, "Open message actions");
          return true;
        } catch {
          return false;
        }
      });

      await act(async () => {
        clickButton(findButtonByAriaLabel(dom.container, "Open message actions"));
      });
      await act(async () => {
        clickButton(findButtonByText(dom.container, "Fork from here"));
        await waitTick();
      });

      await waitUntilAct(act, () => dom.container.textContent?.includes("Fork failed: Session not found: fork-session") ?? false);
      expect(onForkSession).toHaveBeenCalledWith("session-1", { toEventId: "event-after-assistant-1" });
    } finally {
      errorSpy.mockRestore();
      await cleanup();
    }
  });

  it("offers undo on assistant messages and optimistically removes that turn and later history", async () => {
    const { dom, act, cleanup, dropFinishedRunOutputMock } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          { id: "user-1", role: "user", content: "first", undoEventId: "user-event-1" },
          { id: "assistant-1", role: "assistant", content: "reply one", undoEventId: "user-event-1" },
          { id: "user-2", role: "user", content: "second", undoEventId: "user-event-2" },
          { id: "assistant-2", role: "assistant", content: "reply two", undoEventId: "user-event-2" },
        ],
        runState: "idle",
        total: 4,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
    });
    const confirm = stubWindowConfirm(true);
    const refresh = createDeferred<FetchMessagesFastResult>();

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("reply two") ?? false);
      fetchMessagesFastMock.mockImplementation(() => refresh.promise);
      const wrapper = findMessageWrapperByAnchorKey(dom.container, "assistant-2");
      const menuButton = findAllByTag(wrapper, "BUTTON").find((button) => (
        getReactProps(button)?.["aria-label"] === "Open message actions"
      ));
      expect(menuButton).toBeDefined();

      await act(async () => {
        clickButton(menuButton);
      });
      expect(dom.container.textContent).toContain("Undo turn from here");

      await act(async () => {
        clickButton(findButtonByText(dom.container, "Undo turn from here"));
        await waitTick();
      });

      expect(confirm).toHaveBeenCalled();
      expect(undoSessionTurnMock).toHaveBeenCalledWith("session-1", "user-event-2");
      expect(dom.container.textContent).toContain("reply one");
      expect(dom.container.textContent).not.toContain("second");
      expect(dom.container.textContent).not.toContain("reply two");
      // A turn that just ran is also on screen as output its run left behind.
      expect(dropFinishedRunOutputMock).toHaveBeenCalledTimes(1);
    } finally {
      refresh.resolve({
        messages: [],
        runState: "idle",
        total: 0,
        warm: true,
        hasMore: false,
      });
      await cleanup();
    }
  });

  it("offers undo on user messages but does not call the API when confirmation is canceled", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          { id: "user-1", role: "user", content: "first", undoEventId: "user-event-1" },
        ],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
    });
    const confirm = stubWindowConfirm(false);

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("first") ?? false);
      const wrapper = findMessageWrapperByAnchorKey(dom.container, "user-1");
      const menuButton = findAllByTag(wrapper, "BUTTON").find((button) => (
        getReactProps(button)?.["aria-label"] === "Open message actions"
      ));

      await act(async () => {
        clickButton(menuButton);
      });
      await act(async () => {
        clickButton(findButtonByText(dom.container, "Undo turn from here"));
      });

      expect(confirm).toHaveBeenCalled();
      expect(undoSessionTurnMock).not.toHaveBeenCalled();
      expect(dom.container.textContent).toContain("first");
    } finally {
      await cleanup();
    }
  });

  it("surfaces undo failures without mutating the visible transcript", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    undoSessionTurnMock.mockRejectedValueOnce(new Error("This turn is no longer available to undo."));
    const { dom, act, cleanup, dropFinishedRunOutputMock } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          { id: "user-1", role: "user", content: "first", undoEventId: "user-event-1" },
        ],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { isStreaming: false },
    });
    const confirm = stubWindowConfirm(true);

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("first") ?? false);
      const wrapper = findMessageWrapperByAnchorKey(dom.container, "user-1");
      const menuButton = findAllByTag(wrapper, "BUTTON").find((button) => (
        getReactProps(button)?.["aria-label"] === "Open message actions"
      ));
      await act(async () => {
        clickButton(menuButton);
      });
      await act(async () => {
        clickButton(findButtonByText(dom.container, "Undo turn from here"));
        await waitTick();
      });

      expect(dom.container.textContent).toContain("Undo failed: This turn is no longer available to undo.");
      expect(dom.container.textContent).toContain("first");
      expect(dropFinishedRunOutputMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await cleanup();
    }
  });
});

describe("ChatView user input question cards", () => {
  it("renders choice and freeform controls and submits through the user input API", async () => {
    // Case 1: choice submission
    const choiceRequest: PendingUserInputRequestView = {
      requestId: "request-1",
      question: "Pick a deploy target",
      choices: ["staging", "production"],
      allowFreeform: true,
      requestedAt: "2026-04-29T12:00:00.000Z",
    };
    {
      const { dom, act, cleanup, sendMessageMock } = await renderChatView([choiceRequest]);
      try {
        expect(dom.container.textContent).toContain("Pick a deploy target");
        expect(findInputByPlaceholder(dom.container, "Or type a response...")).toBeDefined();

        await act(async () => {
          getReactProps(findButtonByText(dom.container, "staging"))?.onClick?.();
        });
        await waitUntilAct(act, () => submitUserInputResponseMock.mock.calls.length === 1);

        expect(submitUserInputResponseMock).toHaveBeenCalledWith(
          "session-1",
          "request-1",
          { answer: "staging", wasFreeform: false },
        );
        expect(sendMessageMock).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    }

    submitUserInputResponseMock.mockReset();
    submitUserInputResponseMock.mockResolvedValue(undefined);

    // Case 2: freeform submission
    const freeformRequest: PendingUserInputRequestView = {
      requestId: "request-freeform",
      question: "What should Copilot do next?",
      allowFreeform: true,
    };
    {
      const { dom, act, cleanup, sendMessageMock } = await renderChatView([freeformRequest]);
      try {
        const input = findInputByPlaceholder(dom.container, "Type a response...");
        const form = findAllByTag(dom.container, "FORM")[0];

        await act(async () => {
          getReactProps(input)?.onChange?.({ target: { value: "Run the focused tests" } });
        });
        await act(async () => {
          getReactProps(form)?.onSubmit?.({ preventDefault: vi.fn() });
        });
        await waitUntilAct(act, () => submitUserInputResponseMock.mock.calls.length === 1);

        expect(submitUserInputResponseMock).toHaveBeenCalledWith(
          "session-1",
          "request-freeform",
          { answer: "Run the focused tests", wasFreeform: true },
        );
        expect(sendMessageMock).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    }
  });

  it("shows inline validation and submission errors", async () => {
    const request: PendingUserInputRequestView = {
      requestId: "request-error",
      question: "Explain the change",
      allowFreeform: true,
    };
    const { dom, act, cleanup } = await renderChatView([request]);

    try {
      const input = findInputByPlaceholder(dom.container, "Type a response...");
      const form = findAllByTag(dom.container, "FORM")[0];

      await act(async () => {
        getReactProps(form)?.onSubmit?.({ preventDefault: vi.fn() });
      });
      expect(dom.container.textContent).toContain("Enter a response before submitting.");
      expect(submitUserInputResponseMock).not.toHaveBeenCalled();

      submitUserInputResponseMock.mockRejectedValueOnce(new Error("Server rejected answer"));
      await act(async () => {
        getReactProps(input)?.onChange?.({ target: { value: "Try this answer" } });
      });
      await act(async () => {
        getReactProps(form)?.onSubmit?.({ preventDefault: vi.fn() });
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("Server rejected answer") ?? false);

      expect(dom.container.textContent).toContain("Server rejected answer");
    } finally {
      await cleanup();
    }
  });
});

describe("ChatView disk-authoritative synchronization", () => {
  describe("with replies already on screen", () => {
    const loaded = () => [createMessage("entry-1", "first reply"), createMessage("entry-2", "second reply")];
    const renderedMessageIds = () => messageBubbleRenderMock.mock.calls.map(([message]) => (message as ChatMessage).id);

    // Rendering a reply means parsing its markdown again, so both of these keep a long chat cheap.
    it("renders streamed text without rendering them again", async () => {
      vi.useFakeTimers();
      const streaming = { isStreaming: true, streamStatus: "streaming", streamingContent: "one" };
      const { dom, act, cleanup, render } = await renderChatView({
        fetchMessagesFastResult: { messages: loaded(), runState: "busy", total: 2, warm: true },
        streamOverrides: streaming,
      });

      try {
        await waitUntilAct(act, () => dom.container.textContent?.includes("second reply") ?? false);
        await advanceTimersByTimeAct(act, 200);
        messageBubbleRenderMock.mockClear();

        await render({ streamOverrides: { ...streaming, streamingContent: "one two three" } });
        await advanceTimersByTimeAct(act, 200);

        expect(dom.container.textContent).toContain("one two three");
        expect(renderedMessageIds()).not.toContain("entry-1");
        expect(renderedMessageIds()).not.toContain("entry-2");
      } finally {
        await cleanup();
      }
    });

    it("renders only what a refresh changed", async () => {
      const { dom, act, cleanup, render } = await renderChatView({
        fetchMessagesFastResult: { messages: loaded(), runState: "idle", total: 2, warm: true },
        streamOverrides: { isStreaming: false, pendingOrigin: null },
      });

      try {
        await waitUntilAct(act, () => dom.container.textContent?.includes("second reply") ?? false);
        messageBubbleRenderMock.mockClear();
        // A read returns fresh copies of everything, including what did not change.
        fetchMessagesFastMock.mockResolvedValueOnce({
          messages: [...loaded(), createMessage("entry-3", "third reply")],
          runState: "idle",
          total: 3,
          warm: true,
        });

        await render({ streamOverrides: { historyEpoch: 1 } });
        await waitUntilAct(act, () => dom.container.textContent?.includes("third reply") ?? false);

        expect(renderedMessageIds()).toEqual(["entry-3"]);
      } finally {
        await cleanup();
      }
    });
  });

  it("re-reads the disk window when the server reports committed history advanced", async () => {
    vi.useFakeTimers();
    try {
      const { act, cleanup, render } = await renderChatView({
        fetchMessagesFastResult: {
          messages: [createMessage("entry-1", "first reply")],
          runState: "busy",
          total: 1,
          warm: true,
          hasMore: false,
        },
        streamOverrides: { historyEpoch: 0 },
      });

      try {
        await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length > 0);
        const callsBefore = fetchMessagesFastMock.mock.calls.length;

        await render({ streamOverrides: { historyEpoch: 1 } });
        await advanceTimersByTimeAct(act, 300);

        expect(fetchMessagesFastMock.mock.calls.length).toBeGreaterThan(callsBefore);
      } finally {
        await cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of history advances into a single refresh", async () => {
    vi.useFakeTimers();
    try {
      const { act, cleanup, render } = await renderChatView({
        fetchMessagesFastResult: {
          messages: [createMessage("entry-1", "first reply")],
          runState: "busy",
          total: 1,
          warm: true,
          hasMore: false,
        },
        streamOverrides: { historyEpoch: 0 },
      });

      try {
        await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length > 0);
        const callsBefore = fetchMessagesFastMock.mock.calls.length;

        // A long autopilot run emits an advance per committed event; the view must not storm
        // the disk reader with one refresh per event.
        for (let seq = 1; seq <= 25; seq += 1) {
          await render({ streamOverrides: { historyEpoch: seq } });
          await advanceTimersByTimeAct(act, 5);
        }
        await advanceTimersByTimeAct(act, 300);

        const refreshes = fetchMessagesFastMock.mock.calls.length - callsBefore;
        expect(refreshes).toBeGreaterThan(0);
        expect(refreshes).toBeLessThan(5);
      } finally {
        await cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  describe("while a refresh is in flight", () => {
    const busyHistory: FetchMessagesFastResult = {
      messages: [createMessage("entry-1", "first reply")],
      runState: "busy",
      total: 1,
      warm: true,
    };

    /** A busy chat whose first refresh has been issued and has not come back. */
    async function renderWithRefreshInFlight() {
      vi.useFakeTimers();
      let wake: (() => void) | undefined;
      const view = await renderChatView({
        fetchMessagesFastResult: busyHistory,
        streamOverrides: { historyEpoch: 0 },
        prepareDom: () => {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
          document.addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === "visibilitychange" && typeof listener === "function") wake = listener as () => void;
          });
          document.removeEventListener = vi.fn();
        },
      });
      await waitUntilAct(view.act, () => view.ensureConnectedMock.mock.calls.length === 1);
      const inFlight = createDeferred<FetchMessagesFastResult>();
      fetchMessagesFastMock.mockImplementationOnce(() => inFlight.promise);
      await view.render({ streamOverrides: { historyEpoch: 1 } });
      expect(fetchMessagesFastMock).toHaveBeenCalledTimes(2);
      return { ...view, inFlight, wake: () => view.act(async () => wake?.()) };
    }

    it("folds what is announced meanwhile into one read after it", async () => {
      const { act, cleanup, render, inFlight } = await renderWithRefreshInFlight();

      try {
        for (const historyEpoch of [2, 3, 4]) await render({ streamOverrides: { historyEpoch } });
        await advanceTimersByTimeAct(act, 1000);
        expect(fetchMessagesFastMock).toHaveBeenCalledTimes(2);

        await act(async () => {
          inFlight.resolve(busyHistory);
          await waitTick();
        });
        await advanceTimersByTimeAct(act, 1000);
        expect(fetchMessagesFastMock).toHaveBeenCalledTimes(3);
      } finally {
        await cleanup();
      }
    });

    it("does not make a waking tab wait on a read that may never come back", async () => {
      const { act, cleanup, render, inFlight, wake, reconnectMock, ensureConnectedMock } = await renderWithRefreshInFlight();

      try {
        await wake();
        await render({ streamOverrides: { historyEpoch: 2 } });
        await advanceTimersByTimeAct(act, 250);

        // One read serves the wake-up and the announcement, and still replaces the stream.
        expect(fetchMessagesFastMock).toHaveBeenCalledTimes(3);
        expect(reconnectMock).toHaveBeenCalledTimes(1);

        await act(async () => {
          inFlight.resolve(busyHistory);
          await waitTick();
        });
        await advanceTimersByTimeAct(act, 1000);
        expect(fetchMessagesFastMock).toHaveBeenCalledTimes(3);
        expect(ensureConnectedMock).toHaveBeenCalledTimes(1);
      } finally {
        await cleanup();
      }
    });
  });

  it("loads a chat once when the chat before it was still running", async () => {
    vi.useFakeTimers();
    const { act, cleanup, render } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1", "first reply")],
        runState: "idle",
        total: 1,
        warm: true,
      },
      streamOverrides: { isStreaming: true, streamStatus: "streaming", historyEpoch: 4 },
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      fetchMessagesFastMock.mockClear();

      // The stream hook resets one render after the session changes, so the next chat's first
      // render still carries the previous chat's run.
      await render({ sessionId: "session-2", composerKey: "session-2" });
      await render({
        sessionId: "session-2",
        composerKey: "session-2",
        streamOverrides: { isStreaming: false, streamStatus: "idle", pendingOrigin: null, historyEpoch: 0 },
      });
      await advanceTimersByTimeAct(act, 1000);

      expect(fetchMessagesFastMock.mock.calls).toEqual([["session-2", { limit: 50 }]]);
    } finally {
      await cleanup();
    }
  });

  it("does not show the history sync strip during routine disk-tail syncs", async () => {
    vi.useFakeTimers();
    try {
      const { dom, act, cleanup, render } = await renderChatView({
        fetchMessagesFastResult: {
          messages: [createMessage("entry-1", "assistant reply")],
          runState: "busy",
          total: 1,
          warm: true,
          hasMore: false,
        },
        streamOverrides: { historyEpoch: 0, isStreaming: true, streamStatus: "streaming" },
      });

      try {
        await waitUntilAct(act, () => dom.container.textContent?.includes("assistant reply") ?? false);

        // A busy run emits an advance per committed event; the transcript must stay quiet.
        for (let epoch = 1; epoch <= 6; epoch += 1) {
          await render({ streamOverrides: { historyEpoch: epoch, isStreaming: true, streamStatus: "streaming" } });
          await advanceTimersByTimeAct(act, 260);
          expect(dom.container.textContent).not.toContain("Syncing chat history");
        }
      } finally {
        await cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a tool result immediately without waiting for the disk window", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "committed-tool",
          type: "tool",
          sourceEventId: "tool-event-1",
          // Disk still shows it running: the completion has not been read back yet.
          toolCall: { toolCallId: "tc-shared", name: "shared_tool" },
        }],
        runState: "busy",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        liveTools: [{
          toolCallId: "tc-shared",
          name: "shared_tool",
          completedAt: "2026-07-26T10:00:00.000Z",
          success: true,
          result: "RESULT-VISIBLE-NOW",
        }],
        isStreaming: true,
        streamStatus: "streaming",
      },
    });

    try {
      await waitUntilAct(act, () => findAllByTag(dom.container, "BUTTON").some((button) => (
        button.getAttribute?.("aria-expanded") === "false"
      )));
      await expandActivity(dom.container, act);
      // Substituted onto the disk entry, not appended beside it: one row, already carrying the result.
      const text = dom.container.textContent ?? "";
      expect(text).toContain("RESULT-VISIBLE-NOW");
      expect(text.indexOf("Shared tool")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Shared tool")).toBe(text.lastIndexOf("Shared tool"));
    } finally {
      await cleanup();
    }
  });

  it("renders a published visual before disk history carries it, then defers to disk", async () => {
    const visual = {
      artifactId: "artifact-1",
      kind: "mermaid" as const,
      title: "Live Diagram",
      displayName: "d.mmd",
      mimeType: "text/vnd.mermaid",
      size: 10,
      url: "/api/v",
      downloadUrl: "/api/v/download",
    };
    const { dom, act, cleanup, render } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1", "assistant reply")],
        runState: "busy",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: { liveVisuals: [visual], isStreaming: true, streamStatus: "streaming" },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Live Diagram") ?? false);

      // Once disk carries the same artifactId the overlay copy must retire, not duplicate.
      fetchMessagesFastMock.mockResolvedValue({
        messages: [
          createMessage("entry-1", "assistant reply"),
          { id: "committed-visual", type: "visual", sourceEventId: "visual-event-1", visual },
        ],
        runState: "busy",
        total: 2,
        warm: true,
        hasMore: false,
      });
      await render({ streamOverrides: { liveVisuals: [visual], historyEpoch: 1, isStreaming: true, streamStatus: "streaming" } });
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length > 1);

      const text = dom.container.textContent ?? "";
      expect(text.indexOf("Live Diagram")).toBe(text.lastIndexOf("Live Diagram"));
    } finally {
      await cleanup();
    }
  });

  it("renders a completion card immediately and retires it once disk carries it", async () => {
    const completion = {
      content: "Task wrapped up",
      title: "Task complete",
      status: "success" as const,
      sourceEventType: "session.task_complete",
    };
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1", "assistant reply")],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        liveCompletion: { completion, sourceEventId: "terminal-1" },
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Task wrapped up") ?? false);
      const text = dom.container.textContent ?? "";
      expect(text.indexOf("Task wrapped up")).toBe(text.lastIndexOf("Task wrapped up"));
    } finally {
      await cleanup();
    }
  });

  it("renders a bridge-native run notice below the transcript instead of inside it", async () => {
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1", "assistant reply")],
        runState: "idle",
        total: 1,
        warm: true,
        hasMore: false,
      },
      streamOverrides: {
        isStreaming: false,
        streamStatus: "idle",
        pendingOrigin: null,
        runNotice: { kind: "error", message: "run blew up" },
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("run blew up") ?? false);
      const renderedText = dom.container.textContent ?? "";
      expect(renderedText).toContain("Run failed");
      // The notice is not a transcript message bubble.
      expect(findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("run blew up")
      ))).toHaveLength(0);
      expect(renderedText.indexOf("run blew up")).toBeGreaterThan(renderedText.indexOf("assistant reply"));
    } finally {
      await cleanup();
    }
  });

});
