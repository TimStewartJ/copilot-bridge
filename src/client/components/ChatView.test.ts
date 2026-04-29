import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingUserInputRequestView } from "../api";
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await waitTick();
  }
  throw new Error("Timed out waiting for condition");
}

async function waitUntilAct(act: Act, predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await act(async () => {
      await waitTick();
    });
  }
  throw new Error("Timed out waiting for condition");
}

async function renderChatView(pendingUserInputs: PendingUserInputRequestView[]) {
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

  fetchMessagesFastMock.mockResolvedValue({ messages: [], busy: false, total: 0, warm: true });
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
  });

  const [{ createRoot }, { act }, { default: ChatView }] = await Promise.all([
    import("react-dom/client"),
    import("react"),
    import("./ChatView"),
  ]);
  const root = createRoot(dom.container as unknown as Element);

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
          }),
        ),
      ),
    );
  });
  await waitUntilAct(act as Act, () => dom.container.textContent?.includes("Question") ?? false);

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

  return { dom, act: act as Act, cleanup, sendMessageMock };
}

afterEach(() => {
  vi.clearAllMocks();
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
