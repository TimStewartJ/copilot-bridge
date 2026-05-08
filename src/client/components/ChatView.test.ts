import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, PendingUserInputRequestView } from "../api";
import {
  getCachedChatSnapshot,
  resetCachedChatSnapshotState,
  setCachedChatSnapshot,
  type ChatHistorySnapshot,
} from "../chat-cache";
import { installDomShim } from "../test-dom-shim";

const useSessionStreamMock = vi.hoisted(() => vi.fn());
const submitUserInputResponseMock = vi.hoisted(() => vi.fn());
const fetchMessagesMock = vi.hoisted(() => vi.fn());
const fetchMessagesFastMock = vi.hoisted(() => vi.fn());
const fetchMcpStatusMock = vi.hoisted(() => vi.fn());
const warmSessionMock = vi.hoisted(() => vi.fn());
const reportTimingMock = vi.hoisted(() => vi.fn());

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
    warmSession: (...args: unknown[]) => warmSessionMock(...args),
    reportTiming: (...args: unknown[]) => reportTimingMock(...args),
    submitUserInputResponse: (...args: unknown[]) => submitUserInputResponseMock(...args),
  };
});

vi.mock("./ChatInput", () => ({
  default: () => null,
}));

vi.mock("./McpStatusBar", () => ({
  default: () => null,
}));

vi.mock("./MessageBubble", () => ({
  default: () => null,
}));

vi.mock("./ToolCallTree", () => ({
  default: () => null,
}));

vi.mock("./PlanSheet", () => ({
  default: () => null,
}));

type Act = (callback: () => void | Promise<void>) => Promise<void>;

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
  pendingUserInputs?: PendingUserInputRequestView[];
  seedQueryClient?: (queryClient: QueryClient) => void;
  streamOverrides?: Record<string, unknown>;
  waitForQuestion?: boolean;
};

const WAIT_FOR_CONDITION_TIMEOUT_MS = 5_000;

function createMessage(id: string, content = id): ChatEntry {
  return { id, role: "assistant", content };
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

function findAllByTag(root: any, tag: string): any[] {
  const results: any[] = [];
  if ((root.tagName ?? "").toUpperCase() === tag.toUpperCase()) results.push(root);
  for (const child of root.childNodes ?? []) {
    results.push(...findAllByTag(child, tag));
  }
  return results;
}

function getReactProps(el: any): Record<string, any> | null {
  if (!el) return null;
  const key = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? el[key] : null;
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

function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntilAct(
  act: Act,
  predicate: () => boolean,
  timeoutMs = WAIT_FOR_CONDITION_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await act(async () => {
      await waitTick();
    });
  }
  throw new Error("Timed out waiting for condition");
}

async function renderChatView(
  pendingUserInputsOrOptions: PendingUserInputRequestView[] | RenderChatViewOptions = [],
) {
  const options: RenderChatViewOptions = Array.isArray(pendingUserInputsOrOptions)
    ? { pendingUserInputs: pendingUserInputsOrOptions, waitForQuestion: true }
    : pendingUserInputsOrOptions;
  const pendingUserInputs = options.pendingUserInputs ?? [];
  const dom = installDomShim();
  const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const sendMessageMock = vi.fn();
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
  warmSessionMock.mockResolvedValue(undefined);
  reportTimingMock.mockResolvedValue(undefined);
  submitUserInputResponseMock.mockResolvedValue({
    requestId: pendingUserInputs[0]?.requestId ?? "request-1",
    answer: "ok",
    wasFreeform: false,
  });
  useSessionStreamMock.mockReturnValue({
    streamingContent: "",
    intentText: "",
    activeTools: [],
    isStreaming: true,
    streamStatus: "thinking",
    hadVisibleOutput: false,
    pendingOrigin: "message",
    pendingUserInputs,
    mcpServers: [],
    sendMessage: sendMessageMock,
    startFleet: vi.fn(),
    abortSession: vi.fn(),
    reconnect: vi.fn(),
    ...options.streamOverrides,
  });

  const [{ createRoot }, { act }, { default: ChatView }] = await Promise.all([
    import("react-dom/client"),
    import("react"),
    import("./ChatView"),
  ]);
  const root = createRoot(dom.container as unknown as Element);

  const render = async (overrideOptions: Partial<RenderChatViewOptions> = {}) => {
    const nextOptions = { ...options, ...overrideOptions };
    await act(async () => {
      root.render(
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
            }),
          ),
        ),
      );
    });
  };

  const cleanup = async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    await waitTick();
    if (previousActEnvironment === undefined) {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    } else {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    dom.cleanup();
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
  vi.clearAllMocks();
  resetCachedChatSnapshotState();
});

describe("ChatView cached resume loading state", () => {
  it("shows the newer-content skeleton for a stale cached resume while the fast refresh is pending", async () => {
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
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });

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
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });

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
      expect(cachedSnapshot?.entries[0]?.content).toBe("fresh-entry");
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
      expect(cachedSnapshot?.entries[0]?.content).toBe("fresh-entry-50");
    } finally {
      await cleanup();
    }
  });

  it("does not show the newer-content skeleton for a non-resume background refresh", async () => {
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
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });

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
      expect(refreshedSnapshot?.entries.at(-1)?.content).toBe("entry-150");
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
      expect(refreshedSnapshot?.entries.at(-1)?.content).toBe("updated-entry-149");
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
