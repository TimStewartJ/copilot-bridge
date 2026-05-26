import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import ChatInput from "./ChatInput";

const useVoiceInputMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useVoiceInput", () => ({
  useVoiceInput: (...args: unknown[]) => useVoiceInputMock(...args),
}));

function findButtonByText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function findButtonByAriaLabel(root: any, label: string): any {
  const button = queryButtonByAriaLabel(root, label);
  if (!button) throw new Error(`Button not found with aria-label: ${label}`);
  return button;
}

function queryButtonByAriaLabel(root: any, label: string): any | undefined {
  return findAllByTag(root, "BUTTON").find((candidate) => (
    getReactProps(candidate)?.["aria-label"] === label
    || candidate.getAttribute?.("aria-label") === label
  ));
}

function findTextarea(root: any): any {
  const textarea = findAllByTag(root, "TEXTAREA")[0];
  if (!textarea) throw new Error("Textarea not found");
  return textarea;
}

describe("ChatInput voice retry", () => {
  let harness: ReactDomHarness | null = null;

  function getHarness() {
    if (!harness) throw new Error("ChatInput harness has not been initialized");
    return harness;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createReactDomHarness();
    (globalThis.window as any).matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    useVoiceInputMock.mockReturnValue({
      browserSupported: true,
      status: {
        available: true,
        provider: "whisper.cpp",
        label: "whisper.cpp",
        maxDurationSeconds: 120,
      },
      statusError: null,
      isCheckingStatus: false,
      phase: "idle",
      isRecording: false,
      isTranscribing: false,
      error: null,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      refreshStatus: vi.fn(),
    });
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function renderChatInput(props: Partial<ComponentProps<typeof ChatInput>> = {}) {
    await getHarness().render(createElement(ChatInput, {
      onSend: vi.fn(),
      composerKey: "session-1",
      sessionId: "session-1",
      onSubmitVoiceCapture: vi.fn(),
      ...props,
    }));
  }

  it("renders a retry action beside retryable voice upload errors", async () => {
    const retryVoiceJobUpload = vi.fn();
    await renderChatInput({
      voiceJob: {
        composerKey: "session-1",
        status: "error",
        submitMode: "autosend",
        error: "Network timeout",
        retryable: true,
      },
      onRetryVoiceJobUpload: retryVoiceJobUpload,
    });

    expect(getHarness().dom.container.textContent).toContain("Network timeout");
    const retryButton = findButtonByText(getHarness().dom.container, "Try again");

    await getHarness().act(async () => {
      getReactProps(retryButton)?.onClick();
    });

    expect(retryVoiceJobUpload).toHaveBeenCalledWith("session-1");
  });

  it("does not render retry action for non-retryable voice errors", async () => {
    await renderChatInput({
      voiceJob: {
        composerKey: "session-1",
        status: "error",
        submitMode: "autosend",
        error: "Auto-send failed after upload.",
      },
      onRetryVoiceJobUpload: vi.fn(),
    });

    expect(getHarness().dom.container.textContent).toContain("Auto-send failed after upload.");
    expect(findAllByTag(getHarness().dom.container, "BUTTON").some((button) => button.textContent === "Try again")).toBe(false);
  });

  it("switches the streaming action between stop and steering send", async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    await renderChatInput({ onSend, onAbort });

    const stopButton = findButtonByAriaLabel(getHarness().dom.container, "Stop generating");
    expect(queryButtonByAriaLabel(getHarness().dom.container, "Send steering note")).toBeUndefined();

    const textarea = findTextarea(getHarness().dom.container);
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "please adjust",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
    });

    const sendButton = findButtonByAriaLabel(getHarness().dom.container, "Send steering note");
    expect(queryButtonByAriaLabel(getHarness().dom.container, "Stop generating")).toBeUndefined();

    await getHarness().act(async () => {
      getReactProps(sendButton.parentNode)?.onClick?.();
    });

    expect(onSend).toHaveBeenCalledWith("please adjust", undefined);
    expect(onSend.mock.calls[0]).toHaveLength(2);
    expect(onAbort).not.toHaveBeenCalled();
    expect(stopButton).toBeDefined();
  });

  it("sends once with autopilot from the send button context menu", async () => {
    const onSend = vi.fn();
    await renderChatInput({ onSend });

    const textarea = findTextarea(getHarness().dom.container);
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "keep going",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
    });

    const sendButton = findButtonByAriaLabel(getHarness().dom.container, "Send message");
    const wrapper = sendButton.parentNode;
    if (!wrapper) throw new Error("Send button wrapper not found");
    const preventDefault = vi.fn();

    await getHarness().act(async () => {
      getReactProps(wrapper)?.onContextMenu?.({
        preventDefault,
        clientX: 10,
        clientY: 20,
      });
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(findAllByTag(getHarness().dom.container, "BUTTON").some((button) => button.textContent === "Send normally")).toBe(false);
    const autopilotItem = findButtonByText(getHarness().dom.container, "Send with Autopilot");

    await getHarness().act(async () => {
      getReactProps(autopilotItem)?.onClick?.();
    });

    expect(onSend).toHaveBeenCalledWith("keep going", undefined, "autopilot");
  });

  it("left-click sends in interactive mode by default", async () => {
    const onSend = vi.fn();
    await renderChatInput({ onSend });

    const textarea = findTextarea(getHarness().dom.container);
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "hello",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
    });

    const sendButton = findButtonByAriaLabel(getHarness().dom.container, "Send message");
    await getHarness().act(async () => {
      getReactProps(sendButton.parentNode)?.onClick?.();
    });

    expect(onSend).toHaveBeenCalledWith("hello", undefined, "interactive");
  });
});
