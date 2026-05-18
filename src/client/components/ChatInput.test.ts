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
});
