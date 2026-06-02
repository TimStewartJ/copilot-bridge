import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, PendingUserInputRequestView } from "../api";
import type { SessionContextResponse } from "../../shared/session-context.js";
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
const fetchMessagesMock = vi.hoisted(() => vi.fn());
const fetchMessagesFastMock = vi.hoisted(() => vi.fn());
const fetchMcpStatusMock = vi.hoisted(() => vi.fn());
const fetchSessionContextMock = vi.hoisted(() => vi.fn());
const warmSessionMock = vi.hoisted(() => vi.fn());
const reportTimingMock = vi.hoisted(() => vi.fn());
const chatInputMock = vi.hoisted(() => vi.fn());
const mcpStatusBarMock = vi.hoisted(() => vi.fn());

vi.mock("../useSessionStream", () => ({
  useSessionStream: (...args: unknown[]) => useSessionStreamMock(...args),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchMessages: (...args: unknown[]) => fetchMessagesMock(...args),
    fetchMessagesFast: (...args: unknown[]) => fetchMessagesFastMock(...args),
    fetchMcpStatus: (...args: unknown[]) => fetchMcpStatusMock(...args),
    fetchSessionContext: (...args: unknown[]) => fetchSessionContextMock(...args),
    warmSession: (...args: unknown[]) => warmSessionMock(...args),
    reportTiming: (...args: unknown[]) => reportTimingMock(...args),
    submitUserInputResponse: (...args: unknown[]) => submitUserInputResponseMock(...args),
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
  }: {
    message: { role: string; content: string };
    actionSlot?: ReactNode;
    isStreaming?: boolean;
  }) => createElement(
    "div",
    {
      "data-testid": "message-bubble",
      "data-role": message.role,
      "data-streaming": isStreaming ? "true" : "false",
    },
    message.content,
    actionSlot,
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
};

type RenderChatViewOptions = {
  activeSessionActivityAt?: string;
  busySignal?: number;
  fetchMessagesFastResult?: Promise<FetchMessagesFastResult> | FetchMessagesFastResult;
  fetchSessionContextResult?: Promise<SessionContextResponse> | SessionContextResponse;
  pendingUserInputs?: PendingUserInputRequestView[];
  seedQueryClient?: (queryClient: QueryClient) => void;
  streamOverrides?: Record<string, unknown>;
  waitForQuestion?: boolean;
  onForkSession?: (sessionId: string, opts?: { toEventId?: string }) => Promise<void> | void;
  onRenderedReadThrough?: (sessionId: string, readThroughActivityAt: string) => void;
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

function createSnapshot(
  sessionId: string,
  entries: ChatEntry[],
  lastVisibleActivityAt?: string,
): ChatHistorySnapshot {
  return {
    sessionId,
    entries,
    firstItemIndex: 0,
    total: entries.length,
    hasMore: false,
    fetchedAt: Date.now(),
    isCanonical: true,
    lastVisibleActivityAt,
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
  fetchMessagesFastMock.mockReturnValue(
    fetchMessagesFastResult instanceof Promise
      ? fetchMessagesFastResult
      : Promise.resolve(fetchMessagesFastResult),
  );
  fetchMessagesMock.mockResolvedValue({ messages: [], hasMore: false, total: 0 });
  fetchMcpStatusMock.mockResolvedValue([]);
  const fetchSessionContextResult = options.fetchSessionContextResult ?? createEmptyContext();
  fetchSessionContextMock.mockReturnValue(
    fetchSessionContextResult instanceof Promise
      ? fetchSessionContextResult
      : Promise.resolve(fetchSessionContextResult),
  );
  warmSessionMock.mockResolvedValue(undefined);
  reportTimingMock.mockResolvedValue(undefined);
  submitUserInputResponseMock.mockResolvedValue({
    requestId: pendingUserInputs[0]?.requestId ?? "request-1",
    answer: "ok",
    wasFreeform: false,
  });
  const buildStreamState = (nextOptions: RenderChatViewOptions) => ({
    streamingContent: "",
    intentText: "",
    activeTools: [],
    currentTurnTools: [],
    isStreaming: true,
    streamStatus: "thinking",
    hadVisibleOutput: false,
    pendingOrigin: "message",
    pendingUserInputs: nextOptions.pendingUserInputs ?? pendingUserInputs,
    mcpServers: [],
    contextSummary: null,
    sendMessage: sendMessageMock,
    abortSession: abortSessionMock,
    reconnect: reconnectMock,
    ...nextOptions.streamOverrides,
  });
  useSessionStreamMock.mockReturnValue(buildStreamState(options));

  const { default: ChatView } = await import("./ChatView");

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
            composerKey: "composer-1",
            sessionId: "session-1",
            onMessageSent: vi.fn(),
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

  return { dom, act: act as Act, cleanup, queryClient, render, sendMessageMock };
}

afterEach(() => {
  vi.useRealTimers();
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
      fetchSessionContextResult: Promise.reject(new Error("context offline")),
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

  it("reports the rendered read-through cursor from loaded history", async () => {
    const onRenderedReadThrough = vi.fn();
    const { act, cleanup } = await renderChatView({
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
      await waitUntilAct(act, () => onRenderedReadThrough.mock.calls.length > 0);
      expect(onRenderedReadThrough).toHaveBeenCalledWith(
        "session-1",
        "2026-05-07T21:00:00.000Z",
      );
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("does not report newer session-list activity until the rendered tail covers it", async () => {
    const onRenderedReadThrough = vi.fn();
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { act, cleanup } = await renderChatView({
      activeSessionActivityAt: "2026-05-07T21:05:00.000Z",
      onRenderedReadThrough,
      fetchMessagesFastResult: deferred.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")], "2026-05-07T21:00:00.000Z"),
      ),
    });

    try {
      await waitUntilAct(act, () => onRenderedReadThrough.mock.calls.length > 0);
      expect(onRenderedReadThrough).toHaveBeenCalledWith(
        "session-1",
        "2026-05-07T21:00:00.000Z",
      );
      expect(onRenderedReadThrough).not.toHaveBeenCalledWith(
        "session-1",
        "2026-05-07T21:05:00.000Z",
      );
    } finally {
      deferred.resolve({
        messages: [createMessage("entry-1")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-05-07T21:00:00.000Z",
      });
      await cleanup();
    }
  }, 30_000);

  it("reports live assistant message timestamps as rendered read-through cursors", async () => {
    const onRenderedReadThrough = vi.fn();
    const { act, cleanup } = await renderChatView({
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
      await waitUntilAct(act, () => onRenderedReadThrough.mock.calls.length > 0);
      const appendEntries = useSessionStreamMock.mock.calls[0][1] as (entries: ChatEntry[]) => void;
      await act(async () => {
        appendEntries([{
          role: "assistant",
          content: "Done",
          timestamp: "2026-05-07T21:05:00.000Z",
        }]);
        await waitTick();
      });
      await waitUntilAct(act, () => onRenderedReadThrough.mock.calls.some((call) => (
        call[0] === "session-1" && call[1] === "2026-05-07T21:05:00.000Z"
      )));
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("shows the newer-content skeleton for a stale cached resume while the fast refresh is pending", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:05:00.000Z",
      fetchMessagesFastResult: deferred.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")], "2026-04-29T12:00:00.000Z"),
      ),
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Refreshing history...") ?? false);
      await advanceTimersByTimeAct(act, 250);
      await waitUntilAct(act, () => dom.container.textContent?.includes("Loading newer chat content") ?? false);

      expect(dom.container.textContent).toContain("Refreshing history...");
      expect(dom.container.textContent).toContain("Loading newer chat content");
      expect(dom.container.textContent).not.toContain("Loading chat history");
    } finally {
      deferred.resolve({
        messages: [createMessage("entry-1")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      });
      await cleanup();
    }
  });

  it("suppresses the newer-content skeleton when cached resume freshness matches", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:00:00.000Z",
      fetchMessagesFastResult: deferred.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")], "2026-04-29T12:00:00.000Z"),
      ),
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Refreshing history...") ?? false);
      await advanceTimersByTimeAct(act, 250);

      expect(dom.container.textContent).toContain("Refreshing history...");
      expect(dom.container.textContent).not.toContain("Loading newer chat content");
      expect(dom.container.textContent).not.toContain("Loading chat history");
    } finally {
      deferred.resolve({
        messages: [createMessage("entry-1")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      });
      await cleanup();
    }
  });

  it("suppresses the newer-content skeleton when freshness metadata is missing or unknown", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:05:00.000Z",
      fetchMessagesFastResult: deferred.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")]),
      ),
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Refreshing history...") ?? false);
      await advanceTimersByTimeAct(act, 250);

      expect(dom.container.textContent).toContain("Refreshing history...");
      expect(dom.container.textContent).not.toContain("Loading newer chat content");
    } finally {
      deferred.resolve({
        messages: [createMessage("entry-1")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
      });
      await cleanup();
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

  it("does not overwrite a cached canonical snapshot when a resume refresh lacks active metadata", async () => {
    const { dom, act, cleanup, queryClient } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("stale-entry")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      },
      seedQueryClient: (client) => setCachedChatSnapshot(
        client,
        createSnapshot("session-1", [createMessage("fresh-entry")], "2026-04-29T12:05:00.000Z"),
      ),
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      await act(async () => {
        await waitTick();
      });
      await waitUntilAct(act, () => !(dom.container.textContent?.includes("Refreshing history...") ?? false));

      const cachedSnapshot = getCachedChatSnapshot(queryClient, "session-1");
      expect(cachedSnapshot?.lastVisibleActivityAt).toBe("2026-04-29T12:05:00.000Z");
      expect(getMessageContent(cachedSnapshot?.entries[0])).toBe("fresh-entry");
    } finally {
      await cleanup();
    }
  });

  it("does not cache a cold-load fast response as canonical when active metadata is newer", async () => {
    const { act, cleanup, queryClient } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:05:00.000Z",
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      },
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      expect(getCachedChatSnapshot(queryClient, "session-1")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("does not cache a cold-load fast response as canonical before active metadata is known", async () => {
    const { act, cleanup, queryClient } = await renderChatView({
      fetchMessagesFastResult: {
        messages: [createMessage("entry-1")],
        busy: false,
        total: 1,
        warm: true,
        hasMore: false,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      },
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      expect(getCachedChatSnapshot(queryClient, "session-1")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("does not canonicalize load-more history before active metadata is known", async () => {
    vi.useFakeTimers();
    const tailEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 50}`));
    const olderEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index}`));
    const { dom, act, cleanup, queryClient } = await renderChatView({
      fetchMessagesFastResult: {
        messages: tailEntries,
        busy: false,
        total: 100,
        warm: true,
        hasMore: true,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      },
    });

    fetchMessagesMock.mockResolvedValueOnce({
      messages: olderEntries,
      hasMore: false,
      total: 100,
      lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);
      expect(getCachedChatSnapshot(queryClient, "session-1")).toBeUndefined();

      await act(async () => {
        getReactProps(findButtonContainingText(dom.container, "Scroll up for more"))?.onClick?.();
        await waitTick();
      });
      await waitUntilAct(act, () => fetchMessagesMock.mock.calls.length === 1);

      expect(getCachedChatSnapshot(queryClient, "session-1")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("does not reuse stale cached freshness after a noncanonical resume refresh", async () => {
    vi.useFakeTimers();
    const cachedTailEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`fresh-entry-${index + 50}`));
    const staleTailEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`stale-entry-${index + 50}`));
    const olderEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index}`));
    const { dom, act, cleanup, queryClient, render } = await renderChatView({
      fetchMessagesFastResult: {
        messages: staleTailEntries,
        busy: false,
        total: 100,
        warm: true,
        hasMore: true,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      },
      seedQueryClient: (client) => setCachedChatSnapshot(client, {
        sessionId: "session-1",
        entries: cachedTailEntries,
        firstItemIndex: 50,
        total: 100,
        hasMore: true,
        fetchedAt: Date.now(),
        isCanonical: true,
        lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
      }),
    });

    fetchMessagesMock.mockResolvedValueOnce({
      messages: olderEntries,
      hasMore: false,
      total: 100,
      lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
    });

    try {
      await waitUntilAct(act, () => fetchMessagesFastMock.mock.calls.length === 1);
      await act(async () => {
        await waitTick();
      });
      await waitUntilAct(act, () => !(dom.container.textContent?.includes("Refreshing history...") ?? false));

      await render({ activeSessionActivityAt: "2026-04-29T12:05:00.000Z" });
      await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);
      await act(async () => {
        getReactProps(findButtonContainingText(dom.container, "Scroll up for more"))?.onClick?.();
        await waitTick();
      });
      await waitUntilAct(act, () => fetchMessagesMock.mock.calls.length === 1);

      const cachedSnapshot = getCachedChatSnapshot(queryClient, "session-1");
      expect(cachedSnapshot?.lastVisibleActivityAt).toBe("2026-04-29T12:05:00.000Z");
      expect(getMessageContent(cachedSnapshot?.entries[0])).toBe("fresh-entry-50");
    } finally {
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
        createSnapshot("session-1", [createMessage("entry-1")], "2026-04-29T12:00:00.000Z"),
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

  it("cleans up the newer-content skeleton after the fast refresh resolves", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<FetchMessagesFastResult>();
    const { dom, act, cleanup } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:05:00.000Z",
      fetchMessagesFastResult: deferred.promise,
      seedQueryClient: (queryClient) => setCachedChatSnapshot(
        queryClient,
        createSnapshot("session-1", [createMessage("entry-1")], "2026-04-29T12:00:00.000Z"),
      ),
    });

    try {
      await advanceTimersByTimeAct(act, 250);
      await waitUntilAct(act, () => dom.container.textContent?.includes("Loading newer chat content") ?? false);

      await act(async () => {
        deferred.resolve({
          messages: [createMessage("entry-1"), createMessage("entry-2")],
          busy: false,
          total: 2,
          warm: true,
          hasMore: false,
          lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
        });
        await waitTick();
      });
      await waitUntilAct(act, () => !(dom.container.textContent?.includes("Refreshing history...") ?? false));

      expect(dom.container.textContent).not.toContain("Refreshing history...");
      expect(dom.container.textContent).not.toContain("Loading newer chat content");
    } finally {
      await cleanup();
    }
  });

  it("keeps the pending tail refresh when loading older messages without the latest tail", async () => {
    vi.useFakeTimers();
    const backgroundRefresh = createDeferred<FetchMessagesFastResult>();
    const cachedEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 100}`));
    const olderEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 50}`));
    const latestTailEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 101}`));
    const { dom, act, cleanup, queryClient } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:00:00.000Z",
      fetchMessagesFastResult: backgroundRefresh.promise,
      seedQueryClient: (client) => setCachedChatSnapshot(client, {
        sessionId: "session-1",
        entries: cachedEntries,
        firstItemIndex: 100,
        total: 150,
        hasMore: true,
        fetchedAt: Date.now(),
        isCanonical: true,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      }),
    });

    fetchMessagesMock.mockResolvedValueOnce({
      messages: olderEntries,
      hasMore: true,
      total: 151,
      lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);

      await act(async () => {
        getReactProps(findButtonContainingText(dom.container, "Scroll up for more"))?.onClick?.();
        await waitTick();
      });
      await waitUntilAct(act, () => fetchMessagesMock.mock.calls.length === 1);

      const cachedSnapshot = getCachedChatSnapshot(queryClient, "session-1");
      expect(cachedSnapshot?.lastVisibleActivityAt).toBe("2026-04-29T12:00:00.000Z");
      expect(cachedSnapshot?.total).toBe(150);
      expect(cachedSnapshot?.entries).toHaveLength(50);

      await act(async () => {
        backgroundRefresh.resolve({
          messages: latestTailEntries,
          busy: false,
          total: 151,
          warm: true,
          hasMore: true,
          lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
        });
        await waitTick();
      });
      await waitUntilAct(act, () =>
        getCachedChatSnapshot(queryClient, "session-1")?.lastVisibleActivityAt === "2026-04-29T12:05:00.000Z");

      const refreshedSnapshot = getCachedChatSnapshot(queryClient, "session-1");
      expect(refreshedSnapshot?.firstItemIndex).toBe(50);
      expect(refreshedSnapshot?.total).toBe(151);
      expect(getMessageContent(refreshedSnapshot?.entries.at(-1))).toBe("entry-150");
    } finally {
      backgroundRefresh.resolve({
        messages: cachedEntries,
        busy: false,
        total: 150,
        warm: true,
        hasMore: true,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      });
      await cleanup();
    }
  });

  it("keeps the pending tail refresh when older messages return stale same-count activity", async () => {
    vi.useFakeTimers();
    const backgroundRefresh = createDeferred<FetchMessagesFastResult>();
    const cachedEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 100}`));
    const olderEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 50}`));
    const latestTailEntries = Array.from({ length: 50 }, (_, index) => {
      const entryIndex = index + 100;
      return createMessage(`entry-${entryIndex}`, entryIndex === 149 ? "updated-entry-149" : `entry-${entryIndex}`);
    });
    const { dom, act, cleanup, queryClient } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:05:00.000Z",
      fetchMessagesFastResult: backgroundRefresh.promise,
      seedQueryClient: (client) => setCachedChatSnapshot(client, {
        sessionId: "session-1",
        entries: cachedEntries,
        firstItemIndex: 100,
        total: 150,
        hasMore: true,
        fetchedAt: Date.now(),
        isCanonical: true,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      }),
    });

    fetchMessagesMock.mockResolvedValueOnce({
      messages: olderEntries,
      hasMore: true,
      total: 150,
      lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);

      await act(async () => {
        getReactProps(findButtonContainingText(dom.container, "Scroll up for more"))?.onClick?.();
        await waitTick();
      });
      await waitUntilAct(act, () => fetchMessagesMock.mock.calls.length === 1);

      expect(getCachedChatSnapshot(queryClient, "session-1")?.lastVisibleActivityAt)
        .toBe("2026-04-29T12:00:00.000Z");

      await act(async () => {
        backgroundRefresh.resolve({
          messages: latestTailEntries,
          busy: false,
          total: 150,
          warm: true,
          hasMore: true,
          lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
        });
        await waitTick();
      });
      await waitUntilAct(act, () =>
        getCachedChatSnapshot(queryClient, "session-1")?.lastVisibleActivityAt === "2026-04-29T12:05:00.000Z");

      const refreshedSnapshot = getCachedChatSnapshot(queryClient, "session-1");
      expect(refreshedSnapshot?.firstItemIndex).toBe(50);
      expect(refreshedSnapshot?.total).toBe(150);
      expect(getMessageContent(refreshedSnapshot?.entries.at(-1))).toBe("updated-entry-149");
    } finally {
      backgroundRefresh.resolve({
        messages: cachedEntries,
        busy: false,
        total: 150,
        warm: true,
        hasMore: true,
        lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
      });
      await cleanup();
    }
  });

  it("keeps the pending tail refresh when cached tail freshness metadata is missing", async () => {
    vi.useFakeTimers();
    const backgroundRefresh = createDeferred<FetchMessagesFastResult>();
    const cachedEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 100}`));
    const olderEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 50}`));
    const latestTailEntries = Array.from({ length: 50 }, (_, index) =>
      createMessage(`entry-${index + 100}`));
    const { dom, act, cleanup, queryClient } = await renderChatView({
      activeSessionActivityAt: "2026-04-29T12:05:00.000Z",
      fetchMessagesFastResult: backgroundRefresh.promise,
      seedQueryClient: (client) => setCachedChatSnapshot(client, {
        sessionId: "session-1",
        entries: cachedEntries,
        firstItemIndex: 100,
        total: 150,
        hasMore: true,
        fetchedAt: Date.now(),
        isCanonical: true,
      }),
    });

    fetchMessagesMock.mockResolvedValueOnce({
      messages: olderEntries,
      hasMore: true,
      total: 150,
      lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
    });

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);

      await act(async () => {
        getReactProps(findButtonContainingText(dom.container, "Scroll up for more"))?.onClick?.();
        await waitTick();
      });
      await waitUntilAct(act, () => fetchMessagesMock.mock.calls.length === 1);

      expect(getCachedChatSnapshot(queryClient, "session-1")?.lastVisibleActivityAt).toBeUndefined();

      await act(async () => {
        backgroundRefresh.resolve({
          messages: latestTailEntries,
          busy: false,
          total: 150,
          warm: true,
          hasMore: true,
          lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
        });
        await waitTick();
      });
      await waitUntilAct(act, () =>
        getCachedChatSnapshot(queryClient, "session-1")?.lastVisibleActivityAt === "2026-04-29T12:05:00.000Z");

      const refreshedSnapshot = getCachedChatSnapshot(queryClient, "session-1");
      expect(refreshedSnapshot?.firstItemIndex).toBe(50);
      expect(refreshedSnapshot?.total).toBe(150);
      expect(refreshedSnapshot?.entries).toHaveLength(100);
    } finally {
      backgroundRefresh.resolve({
        messages: cachedEntries,
        busy: false,
        total: 150,
        warm: true,
        hasMore: true,
      });
      await cleanup();
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
    fetchMessagesMock.mockReturnValueOnce(olderMessages.promise);

    try {
      await waitUntilAct(act, () => dom.container.textContent?.includes("Scroll up for more") ?? false);
      const scrollContainer = findScrollContainer(dom.container);
      setScrollGeometry(scrollContainer, { scrollHeight: 300, clientHeight: 600, scrollTop: 0 });

      await act(async () => {
        clickButton(findButtonContainingText(dom.container, "Scroll up for more"));
        await waitTick();
      });

      expect(fetchMessagesMock).toHaveBeenCalledWith("session-1", {
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
    fetchMessagesMock.mockRejectedValueOnce(new Error("network unavailable"));

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

describe("ChatView steering sends", () => {
  it("allows sending a steering message while the session is streaming", async () => {
    const { act, cleanup, sendMessageMock } = await renderChatView({
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
      expect(dom.container.textContent).not.toContain("Responding");
      expect(dom.container.textContent).not.toContain("Streaming response");
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
});

describe("ChatView user input question cards", () => {
  it("renders choices and freeform controls and submits choices through the user input API", async () => {
    const request: PendingUserInputRequestView = {
      requestId: "request-1",
      question: "Pick a deploy target",
      choices: ["staging", "production"],
      allowFreeform: true,
      requestedAt: "2026-04-29T12:00:00.000Z",
    };
    const { dom, act, cleanup, sendMessageMock } = await renderChatView([request]);

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
  });

  it("submits freeform answers through the user input API", async () => {
    const request: PendingUserInputRequestView = {
      requestId: "request-freeform",
      question: "What should Copilot do next?",
      allowFreeform: true,
    };
    const { dom, act, cleanup, sendMessageMock } = await renderChatView([request]);

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
