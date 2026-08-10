import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Attachment, ChatEntry, ChatMessage, PendingUserInputRequestView } from "../api";
import type { SessionContextResponse } from "../../shared/session-context.js";
import type { SessionHistoryCoverage } from "../../shared/session-stream.js";
import {
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
const fetchMcpStatusMock = vi.hoisted(() => vi.fn());
const fetchSessionContextMock = vi.hoisted(() => vi.fn());
const warmSessionMock = vi.hoisted(() => vi.fn());
const reportTimingMock = vi.hoisted(() => vi.fn());
const undoSessionTurnMock = vi.hoisted(() => vi.fn());
const chatInputMock = vi.hoisted(() => vi.fn());
const mcpStatusBarMock = vi.hoisted(() => vi.fn());

vi.mock("../useSessionStream", () => ({
  useSessionStream: (...args: unknown[]) => useSessionStreamMock(...args),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchMessagesFast: (...args: unknown[]) => fetchMessagesFastMock(...args),
    fetchMcpStatus: (...args: unknown[]) => fetchMcpStatusMock(...args),
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

vi.mock("./MessageBubble", () => ({
  default: ({
    message,
    actionSlot,
    isStreaming,
    onRetry,
    selectingText,
    onFinishSelectingText,
  }: {
    message: ChatMessage;
    actionSlot?: ReactNode;
    isStreaming?: boolean;
    onRetry?: () => void;
    selectingText?: boolean;
    onFinishSelectingText?: () => void;
  }) => createElement(
    "div",
    {
      "data-testid": "message-bubble",
      "data-role": message.role,
      "data-streaming": isStreaming ? "true" : "false",
      "data-selecting-text": selectingText ? "true" : "false",
      "data-delivery-state": message.delivery
        ? message.delivery.failed ? "failed" : "sending"
        : "sent",
      "data-delivery-error": message.delivery?.error,
    },
    message.content,
    actionSlot,
    onRetry
      ? createElement("button", { "aria-label": "Retry sending message", onClick: onRetry }, "Retry")
      : null,
    onFinishSelectingText
      ? createElement("button", {
          "aria-label": "Finish selecting message text",
          onClick: onFinishSelectingText,
        }, "Done")
      : null,
  ),
}));

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
  busy: boolean;
  total: number;
  warm: boolean;
  hasMore?: boolean;
  lastVisibleActivityAt?: string;
  coverage?: SessionHistoryCoverage;
};

type RenderChatViewOptions = {
  activeSessionActivityAt?: string;
  busySignal?: number;
  composerKey?: string;
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
  ) => Promise<void>;
  onRenderedReadThrough?: (sessionId: string, readThroughActivityAt: string) => void;
  sessionId?: string | null;
  newWorkDisabled?: boolean;
  newWorkDisabledHint?: string;
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

function getMessageContent(entry: ChatEntry | undefined): string | undefined {
  if (!entry || entry.type === "tool" || entry.type === "visual" || entry.type === "completion") return undefined;
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
    total: entries.length,
    hasMore: false,
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
}, 30_000);

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
  const sendMessageMock = vi.fn();
  const abortSessionMock = vi.fn();
  const reconnectMock = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  options.seedQueryClient?.(queryClient);

  const fetchMessagesFastResult = options.fetchMessagesFastResult
    ?? { messages: [], busy: false, total: 0, warm: true, hasMore: false };
  const initialMessagesFastResult = fetchMessagesFastResult instanceof Promise
    ? fetchMessagesFastResult
    : Promise.resolve(fetchMessagesFastResult);
  // fetchMessagesFast serves both the initial/background load (no `before`) and
  // older-page pagination (`before` set). Route older pages to a dedicated mock so
  // tests can assert and stub older-page reads independently of the initial load.
  fetchMessagesFastMock.mockImplementation((sessionId: string, opts?: { before?: number }) => {
    if (opts?.before != null) return fetchOlderMessagesFastMock(sessionId, opts);
    return initialMessagesFastResult;
  });
  fetchOlderMessagesFastMock.mockResolvedValue({ messages: [], hasMore: false, total: 0 });
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
          null,
          createElement(ChatView, {
            composerKey: nextOptions.composerKey ?? "composer-1",
            sessionId: nextOptions.sessionId === undefined ? "session-1" : nextOptions.sessionId,
            onMessageSent: vi.fn(),
            onCreateAndSend: nextOptions.onCreateAndSend,
            onSubmitVoiceCapture: vi.fn(),
            busySignal: nextOptions.busySignal,
            activeSessionActivityAt: nextOptions.activeSessionActivityAt,
            onForkSession: nextOptions.onForkSession,
            onRenderedReadThrough: nextOptions.onRenderedReadThrough,
            newWorkDisabled: nextOptions.newWorkDisabled,
            newWorkDisabledHint: nextOptions.newWorkDisabledHint,
          }),
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

  return { dom, act: act as Act, cleanup, queryClient, render, reconnectMock, sendMessageMock };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as { confirm?: typeof window.confirm }).confirm;
  vi.clearAllMocks();
  resetCachedChatSnapshotState();
});

describe("ChatView cached resume loading state", () => {
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
        busy: false,
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
        busy: false,
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
  }, 30_000);

  it("suppresses the newer-content skeleton when freshness matches or metadata is absent", async () => {
    const cases: [string, string, FetchMessagesFastResult][] = [
      // freshness matches: lastVisibleActivityAt equals activeSessionActivityAt
      ["freshness matches", "2026-04-29T12:00:00.000Z", {
        messages: [createMessage("entry-1")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      }],
      // freshness metadata missing or unknown: no lastVisibleActivityAt in result
      ["freshness metadata missing", "2026-04-29T12:05:00.000Z", {
        messages: [createMessage("entry-1")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
      }],
    ];
    for (const [label, activityAt, resolveResult] of cases) {
      vi.useFakeTimers();
      const deferred = createDeferred<FetchMessagesFastResult>();
      const { dom, act, cleanup } = await renderChatView({
        activeSessionActivityAt: activityAt,
        fetchMessagesFastResult: deferred.promise,
        seedQueryClient: (queryClient) => setCachedChatSnapshot(
          queryClient,
          createSnapshot("session-1", [createMessage("entry-1")]),
        ),
      });

      try {
        await waitUntilAct(act, () => dom.container.textContent?.includes("Refreshing history...") ?? false);
        await advanceTimersByTimeAct(act, 250);

        expect(dom.container.textContent, `case: ${label}`).toContain("Refreshing history...");
        expect(dom.container.textContent, `case: ${label}`).not.toContain("Loading newer chat content");
      } finally {
        deferred.resolve(resolveResult);
        await cleanup();
      }
    }
  });

  it("uses only the cold-load skeleton when there is no cached resume", async () => {
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:05:00.000Z",
      fetchMessagesFastResult: deferred.promise,
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Loading chat history") ?? false);

      expect(dom.container.textContent).toContain("Loading chat history");
      expect(dom.container.textContent).not.toContain("Loading newer chat content");
      expect(dom.container.textContent).not.toContain("Refreshing history...");
    } finally {
      deferred.resolve({
        messages: [],
        busy: false,
        total: 0,
        warm: true,
        hasMore: false,
      });
      await cleanup();
    }
  });

  it("does not show the newer-content skeleton for a non-resume background refresh", async () => {
    vi.useFakeTimers();
    fetchMessagesFastMock.mockResolvedValueOnce({
      messages: [createMessage("entry-1")],
      busy: false,
      total: 1,
      warm: true,
      hasMore: false,
      lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
    });
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup, render } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:00:00.000Z",
      fetchMessagesFastResult: deferred.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")]),
      ),
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      await waitUntilAct(act, () => !(dom.container.textContent?.includes("Refreshing history...") ?? false));

      await render({
        activeSessionActivityAt: "2026-04-29T12:05:00.000Z",
        busySignal: 1,
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("Refreshing history...") ?? false);
      await advanceTimersByTimeAct(act, 250);

      expect(dom.container.textContent).toContain("Refreshing history...");
      expect(dom.container.textContent).not.toContain("Loading newer chat content");

      await act(async () => {
        deferred.resolve({
          messages: [createMessage("entry-1")],
          busy: false,
          total: 1,
          warm: true,
          hasMore: false,
          lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
        });
        await waitTick();
      });
      await act(async () => {
        await waitTick();
      });
      expect(dom.container.textContent).not.toContain("Loading newer chat content");
    } finally {
      deferred.resolve({
        messages: [createMessage("entry-1"), createMessage("entry-2")],
        busy: false,
        total: 2,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
      });
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
      busy: boolean;
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
        busy: false,
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
  it("manual load-more leaves bottom-follow mode before prepending older messages", async () => {
    vi.useFakeTimers();
    const tailEntries = [
      createMessage("entry-3"),
      createMessage("entry-4"),
    ];
    const olderEntries = [
      createMessage("entry-0"),
      createMessage("entry-1"),
      createMessage("entry-2"),
    ];
    const olderMessages = createDeferred<{
      messages: ChatEntry[];
      hasMore: boolean;
      total: number;
      lastVisibleActivityAt?: string;
    }>();
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: tailEntries,
        busy: false,
        total: 5,
        warm: true,
        hasMore: true,
      },
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });
    fetchOlderMessagesFastMock.mockReturnValueOnce(olderMessages.promise);

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);
      const scrollContainer = findScrollContainer(dom.container);
      setScrollGeometry(scrollContainer, { scrollHeight: 300, clientHeight: 600, scrollTop: 0 });

      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Scroll up for more"));
        await waitTick();
      });

      expect(fetchOlderMessagesFastMock).toHaveBeenCalledWith("session-1", {
        limit: 200,
        before: 3,
      });
      // Older pages must go through the disk-backed fast reader, not the SDK-resume path.
      expect(fetchMessagesFastMock).toHaveBeenCalledWith("session-1", {
        limit: 200,
        before: 3,
      });

      setScrollGeometry(scrollContainer, {
        scrollHeight: 1200,
        clientHeight: 600,
        scrollTop: scrollContainer.scrollTop,
      });
      await act(async () => {
        olderMessages.resolve({
          messages: olderEntries,
          hasMore: false,
          total: 5,
        });
        await waitTick();
      });
      await waitUntilAct(act, () => dom.container.textContent?.includes("entry-0") ?? false);

      expect(scrollContainer.scrollTop).toBe(0);
    } finally {
      olderMessages.resolve({
        messages: olderEntries,
        hasMore: false,
        total: 5,
      });
      await cleanup();
    }
  });

  it("shows a load-more error when older history fails", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        busy: false,
        total: 2,
        warm: true,
        hasMore: true,
      },
      streamOverrides: { isStreaming: false, pendingOrigin: null },
    });
    fetchOlderMessagesFastMock.mockRejectedValueOnce(new Error("network unavailable"));

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);

      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Scroll up for more"));
        await waitTick();
      });

      await waitUntilAct(act, () => dom.container.textContent?.includes("Could not load older messages: network unavailable") ?? false);
    } finally {
      errorSpy.mockRestore();
      await cleanup();
    }
  });
});

describe("ChatView draft materialization", () => {
  it("loads the created session when delivery resolves before the route transition commits", async () => {
    const delivery = createDeferred<void>();
    const onCreateAndSend = vi.fn(() => delivery.promise);
    const { dom, act, cleanup, reconnectMock, render } = await renderChatView({
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

      await act(async () => {
        delivery.resolve();
        await sendPromise;
        await waitTick();
      });
      fetchMessagesFastMock.mockResolvedValueOnce({
        messages: [createMessage("created-response", "created response")],
        busy: false,
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
          busy: false,
          total: 0,
          warm: true,
        })
        .mockResolvedValueOnce({
          messages: [createMessage("delivered-response", "delivered response")],
          busy: false,
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
          busy: false,
          total: 0,
          warm: true,
        })
        .mockResolvedValueOnce({
          messages: [createMessage("resynced-response", "resynced response")],
          busy: false,
          total: 1,
          warm: true,
        });
      await render({
        composerKey: "created-session",
        sessionId: "created-session",
      });
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);

      const onSettled = useSessionStreamMock.mock.calls.at(-1)?.[1] as (() => void) | undefined;
      expect(onSettled).toBeTypeOf("function");
      await act(async () => {
        onSettled?.();
        await waitTick();
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
    const { act, cleanup, reconnectMock, render } = await renderChatView({
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
  it("waits for the authoritative stream before rendering a sent user message", async () => {
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
        sendPromise = props.onSend("waiting for server");
        await waitTick();
      });

      expect(findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("waiting for server")
      ))).toHaveLength(0);
      expect(sendMessageMock).toHaveBeenCalledWith("waiting for server", undefined, "interactive");

      await act(async () => {
        sendAccepted.resolve();
        await sendPromise;
        await waitTick();
      });
      await render({
        streamOverrides: {
          pendingUserMessages: [{
            id: "user-1",
            content: "waiting for server",
          }],
          isStreaming: true,
          streamStatus: "thinking",
        },
      });

      const streamedBubble = findAllByTag(dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("waiting for server")
      ));
      expect(streamedBubble?.getAttribute("data-delivery-state")).toBe("sent");
    } finally {
      sendAccepted.resolve();
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
      expect(sendMessageMock).toHaveBeenNthCalledWith(1, "please retry", [attachment], "autopilot");

      await act(async () => {
        const retryButton = findButtonByAriaLabel(dom.container, "Retry sending message");
        clickButton(retryButton);
        clickButton(retryButton);
        await waitTick();
      });
      expect(findOptimisticBubble()?.getAttribute("data-delivery-state")).toBe("sending");
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendMessageMock).toHaveBeenNthCalledWith(2, "please retry", [attachment], "autopilot");

      await act(async () => {
        retryAccepted.resolve();
        await waitTick();
      });
      await waitUntilAct(act, () => (
        findOptimisticBubble() === undefined
      ));

      await render({
        streamOverrides: {
          pendingUserMessages: [{
            id: "retry-user-1",
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

  it("allows sending a steering message while the session is streaming", async () => {
    const { dom, act, cleanup, sendMessageMock } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        busy: true,
        total: 1,
        warm: true,
        hasMore: false,
      },
    });

    try {
      const props = chatInputMock.mock.calls.at(-1)?.[0] as { onSend: (prompt: string) => Promise<void> };
      await act(async () => {
        await props.onSend("please adjust");
        await waitTick();
      });

      expect(sendMessageMock).toHaveBeenCalledWith("please adjust", undefined);
      expect(findAllByTag(dom.container, "DIV").filter((candidate) => (
        candidate.getAttribute?.("data-testid") === "message-bubble"
        && candidate.textContent?.includes("please adjust")
      ))).toHaveLength(0);
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
      expect(sendMessageMock.mock.calls[0]).toEqual(["retry steering", undefined]);
      expect(sendMessageMock.mock.calls[1]).toEqual(["retry steering", undefined]);

      await act(async () => {
        retryAccepted.resolve();
        await waitTick();
      });
      await waitUntilAct(act, () => (
        findRetryBubble() === undefined
      ));

      await render({
        streamOverrides: {
          pendingUserMessages: [{
            id: "steering-retry-1",
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

  it("replaces a streamed user bubble with its canonical message without duplication", async () => {
    const { dom, act, cleanup, render } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        busy: true,
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
      ))).toHaveLength(0);

      const streamedUser = {
        id: "user-1",
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
        busy: false,
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
        busy: true,
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
      expect(dom.container.textContent).toContain("canonical_tool");
      expect(dom.container.textContent).not.toContain("duplicate_live_tool");
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
        busy: true,
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
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [{
          id: "canonical-user",
          role: "user",
          content: "Question",
          sourceEventId: "user-message-event",
        }],
        busy: true,
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
        busy: false,
        total: 2,
        warm: true,
        hasMore: false,
      });
      const onSettled = useSessionStreamMock.mock.calls.at(-1)?.[1] as (() => void) | undefined;
      if (!onSettled) throw new Error("Stream settled callback is unavailable");
      await act(async () => {
        onSettled();
      });
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
        busy: true,
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
      expect(dom.container.textContent).toContain("old_tool");
      expect(dom.container.textContent).toContain("current question");

      // Disk history keeps its own ordering; the live overlay is appended after it, even when
      // provider turn ids repeat across runs.
      const renderedText = dom.container.textContent ?? "";
      expect(renderedText.indexOf("old_tool")).toBeGreaterThan(renderedText.indexOf("previous reply"));
      expect(renderedText.indexOf("current question")).toBeGreaterThan(renderedText.indexOf("old_tool"));
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
        busy: false,
        total: 7,
        warm: true,
        hasMore: false,
      },
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("resumed_tool") ?? false);
      const renderedText = dom.container.textContent ?? "";
      expect(renderedText.indexOf("first_tool")).toBeGreaterThan(renderedText.indexOf("First pass"));
      expect(renderedText.indexOf("Middle pass")).toBeGreaterThan(renderedText.indexOf("first_tool"));
      expect(renderedText.indexOf("middle_tool")).toBeGreaterThan(renderedText.indexOf("Middle pass"));
      expect(renderedText.indexOf("Resumed pass")).toBeGreaterThan(renderedText.indexOf("middle_tool"));
      expect(renderedText.indexOf("resumed_tool")).toBeGreaterThan(renderedText.indexOf("Resumed pass"));
      expect(renderedText.indexOf("Finished")).toBeGreaterThan(renderedText.indexOf("resumed_tool"));
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
        busy: true,
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
        busy: false,
        total: 2,
        warm: true,
        hasMore: false,
      });

      await render({ streamOverrides: { isStreaming: false } });
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
        busy: false,
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
        busy: false,
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
        busy: false,
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
        busy: false,
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
        busy: false,
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
        busy: false,
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
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          { id: "user-1", role: "user", content: "first", undoEventId: "user-event-1" },
          { id: "assistant-1", role: "assistant", content: "reply one", undoEventId: "user-event-1" },
          { id: "user-2", role: "user", content: "second", undoEventId: "user-event-2" },
          { id: "assistant-2", role: "assistant", content: "reply two", undoEventId: "user-event-2" },
        ],
        busy: false,
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
    } finally {
      refresh.resolve({
        messages: [],
        busy: false,
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
        busy: false,
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
    const { dom, act, cleanup } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [
          { id: "user-1", role: "user", content: "first", undoEventId: "user-event-1" },
        ],
        busy: false,
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
  it("re-reads the disk window when the server reports committed history advanced", async () => {
    vi.useFakeTimers();
    try {
      const { act, cleanup, render } = await renderChatView({
        fetchMessagesFastResult: {
          messages: [createMessage("entry-1", "first reply")],
          busy: true,
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
          busy: true,
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

  it("does not show the refreshing-history pill during routine disk-tail syncs", async () => {
    vi.useFakeTimers();
    try {
      const { dom, act, cleanup, render } = await renderChatView({
        fetchMessagesFastResult: {
          messages: [createMessage("entry-1", "assistant reply")],
          busy: true,
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
          expect(dom.container.textContent).not.toContain("Refreshing history");
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
        busy: true,
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
      await waitUntilAct(act, () => dom.container.textContent?.includes("shared_tool") ?? false);
      // Substituted onto the disk entry, not appended beside it.
      const text = dom.container.textContent ?? "";
      expect(text.indexOf("shared_tool")).toBe(text.lastIndexOf("shared_tool"));
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
        busy: true,
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
        busy: true,
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
        busy: false,
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
        busy: false,
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

  it("keeps paginated history when a refresh window starts after the loaded window", async () => {
    vi.useFakeTimers();
    try {
      const { dom, act, cleanup, render } = await renderChatView({
        fetchMessagesFastResult: {
          messages: [createMessage("entry-2", "newest"), createMessage("entry-3", "newer")],
          busy: false,
          total: 4,
          warm: true,
          hasMore: true,
        },
      });

      try {
        await waitUntilAct(act, () => dom.container.textContent?.includes("newest") ?? false);
        fetchOlderMessagesFastMock.mockResolvedValue({
          messages: [createMessage("entry-0", "oldest"), createMessage("entry-1", "older")],
          hasMore: false,
          total: 4,
        });

        await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);
        await act(async () => {
          clickButton(findButtonContainingText(dom.container, "Scroll up for more"));
          await waitTick();
        });
        await waitUntilAct(act, () => dom.container.textContent?.includes("oldest") ?? false);

        // A tail refresh that only covers the newest entries must not drop the paginated prefix.
        await render({ streamOverrides: { historyEpoch: 1 } });
        await advanceTimersByTimeAct(act, 300);
        await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length > 1);

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
