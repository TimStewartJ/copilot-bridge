import { createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomShim } from "../test-dom-shim";
import ChatInput from "./ChatInput";

const useVoiceInputMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useVoiceInput", () => ({
  useVoiceInput: (...args: unknown[]) => useVoiceInputMock(...args),
}));

function findAllByTag(root: any, tag: string): any[] {
  const results: any[] = [];
  if ((root.tagName ?? "").toUpperCase() === tag.toUpperCase()) results.push(root);
  for (const child of root.childNodes ?? []) {
    results.push(...findAllByTag(child, tag));
  }
  return results;
}

function findButtonByText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function getReactProps(el: any): Record<string, any> | null {
  if (!el) return null;
  const key = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? el[key] : null;
}

describe("ChatInput voice retry", () => {
  let dom: ReturnType<typeof installDomShim> | null = null;
  let root: Root | null = null;
  let previousActEnvironment: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    dom = installDomShim();
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
    root = createRoot(dom.container as unknown as Element);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    dom?.cleanup();
    if (previousActEnvironment === undefined) {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    } else {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    root = null;
    dom = null;
  });

  async function renderChatInput(props: Partial<ComponentProps<typeof ChatInput>> = {}) {
    await act(async () => {
      root?.render(createElement(ChatInput, {
        onSend: vi.fn(),
        composerKey: "session-1",
        sessionId: "session-1",
        onSubmitVoiceCapture: vi.fn(),
        ...props,
      }));
    });
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

    expect(dom?.container.textContent).toContain("Network timeout");
    const retryButton = findButtonByText(dom?.container, "Try again");

    await act(async () => {
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

    expect(dom?.container.textContent).toContain("Auto-send failed after upload.");
    expect(findAllByTag(dom?.container, "BUTTON").some((button) => button.textContent === "Try again")).toBe(false);
  });
});
