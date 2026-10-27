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

// The test DOM has no canvas; the recording line is drawn by the browser alone.
vi.mock("./VoiceRecordingWave", () => ({
  VoiceRecordingWave: () => null,
}));

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

/** What useVoiceInput returns for an available recorder at rest, with `overrides` applied. */
function voiceInputState(overrides: Record<string, unknown> = {}) {
  return {
    browserSupported: true,
    status: {
      available: true,
      provider: "speech-engine",
      label: "Parakeet v3 (local)",
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
    cancelRecording: vi.fn(() => true),
    refreshStatus: vi.fn(),
    getLevel: () => 0,
    ...overrides,
  };
}

describe("ChatInput voice retry", () => {
  let harness: ReactDomHarness | null = null;
  let pointerFineMatches = true;
  let mobileMatches = false;

  function getHarness() {
    if (!harness) throw new Error("ChatInput harness has not been initialized");
    return harness;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    harness = await createReactDomHarness();
    pointerFineMatches = true;
    mobileMatches = false;
    (globalThis.window as any).matchMedia = vi.fn((query: string) => ({
      matches: query === "(pointer: fine)" ? pointerFineMatches : query === "(max-width: 767px)" ? mobileMatches : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    useVoiceInputMock.mockReturnValue(voiceInputState());
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    vi.unstubAllGlobals();
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

  it("takes focus when a focus request arrives on a fine-pointer device", async () => {
    await renderChatInput({ focusRequest: 0 });
    const textarea = findTextarea(getHarness().dom.container);
    textarea.blur?.();
    expect(document.activeElement).not.toBe(textarea);

    await renderChatInput({ focusRequest: 1 });
    expect(document.activeElement).toBe(textarea);
  });

  it("ignores focus requests on touch devices so the keyboard does not pop up", async () => {
    pointerFineMatches = false;
    await renderChatInput({ focusRequest: 0 });
    const textarea = findTextarea(getHarness().dom.container);

    await renderChatInput({ focusRequest: 1 });
    expect(document.activeElement).not.toBe(textarea);
  });

  function setVisualViewport(layoutHeight: number, visualHeight: number): void {
    Object.defineProperty(globalThis.document.documentElement, "clientHeight", {
      configurable: true,
      value: layoutHeight,
    });
    (globalThis.window as any).visualViewport = {
      height: visualHeight,
      scale: 1,
    };
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

  it("offers a discard action and blocks new recordings while audio is still unsent", async () => {
    const discardVoiceRecording = vi.fn();
    await renderChatInput({
      voiceJob: {
        composerKey: "session-1",
        status: "error",
        submitMode: "autosend",
        error: "Unsent voice recording saved from earlier.",
        retryable: true,
        restored: true,
      },
      onRetryVoiceJobUpload: vi.fn(),
      onDiscardVoiceRecording: discardVoiceRecording,
    });

    expect(getHarness().dom.container.textContent).toContain("Unsent voice recording saved from earlier.");

    const micButton = findButtonByAriaLabel(
      getHarness().dom.container,
      "Retry or discard the unsent voice recording first",
    );
    expect(getReactProps(micButton)?.disabled).toBe(true);

    const discardButton = findButtonByText(getHarness().dom.container, "Discard");
    await getHarness().act(async () => {
      getReactProps(discardButton)?.onClick();
    });

    expect(discardVoiceRecording).toHaveBeenCalledWith("session-1");
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

  it("folds the tools into one menu on a phone once there is text, but not while recording", async () => {
    mobileMatches = true;
    const onHandsFree = vi.fn();
    const extraTool = { label: "Hands-free", title: "Hands-free", icon: null, onSelect: onHandsFree };
    await renderChatInput({ extraTool });
    const root = getHarness().dom.container;
    expect(queryButtonByAriaLabel(root, "Attach file")).toBeDefined();
    expect(queryButtonByAriaLabel(root, "More tools")).toBeUndefined();

    await renderChatInput({ extraTool, draft: { text: "hello", attachments: [] } });
    expect(queryButtonByAriaLabel(root, "Attach file")).toBeUndefined();
    expect(queryButtonByAriaLabel(root, "Hands-free")).toBeUndefined();
    expect(queryButtonByAriaLabel(root, "Record voice input")).toBeUndefined();
    const more = findButtonByAriaLabel(root, "More tools");
    await getHarness().act(() => {
      getReactProps(more)?.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 500 }) } });
    });
    expect(findButtonByText(root, "Attach file")).toBeDefined();
    expect(findButtonByText(root, "Voice message")).toBeDefined();
    await getHarness().act(() => {
      getReactProps(findButtonByText(root, "Hands-free"))?.onClick();
    });
    expect(onHandsFree).toHaveBeenCalledOnce();

    useVoiceInputMock.mockReturnValue(voiceInputState({ phase: "recording", isRecording: true }));
    await renderChatInput({ extraTool, draft: { text: "hello", attachments: [] } });
    expect(findButtonByAriaLabel(root, "Stop recording and transcribe")).toBeDefined();
    expect(queryButtonByAriaLabel(root, "More tools")).toBeUndefined();
  });

  it("names composer icon buttons and reveals attachment removal on keyboard focus", async () => {
    await renderChatInput({
      draft: {
        text: "",
        attachments: [{
          type: "blob",
          data: "",
          mimeType: "text/plain",
          displayName: "notes.txt",
        }],
      },
    });

    expect(findButtonByAriaLabel(getHarness().dom.container, "Attach file")).toBeDefined();
    expect(findButtonByAriaLabel(getHarness().dom.container, "Record voice input")).toBeDefined();
    const removeButton = findButtonByAriaLabel(
      getHarness().dom.container,
      "Remove attachment notes.txt",
    );
    expect(getReactProps(removeButton)?.className).toContain("focus-visible:opacity-100");
    expect(getReactProps(removeButton)?.className).toContain("group-focus-within:opacity-100");

    useVoiceInputMock.mockReturnValue(voiceInputState({ phase: "recording", isRecording: true }));
    await renderChatInput({
      draft: {
        text: "",
        attachments: [{
          type: "blob",
          data: "",
          mimeType: "text/plain",
          displayName: "notes.txt",
        }],
      },
    });

    expect(findButtonByAriaLabel(
      getHarness().dom.container,
      "Stop recording and transcribe",
    )).toBeDefined();
  });

  it("shows the recording clock and ends a recording that reaches the limit like a press on stop", async () => {
    const stopRecording = vi.fn();
    useVoiceInputMock.mockReturnValue(voiceInputState({
      status: { ...voiceInputState().status, maxDurationSeconds: 300 },
      phase: "recording",
      isRecording: true,
      elapsedSeconds: 83,
      stopRecording,
    }));
    await renderChatInput();

    const container = getHarness().dom.container;
    expect(container.textContent).toContain("1:23");
    expect(container.textContent).not.toContain("1:23 / 5:00");
    const liveRegion = findAllByTag(container, "SPAN").find((span) => getReactProps(span)?.role === "status");
    expect(liveRegion.textContent).toBe("Recording… stop to transcribe.");

    const [{ onMaxDurationReached }] = useVoiceInputMock.mock.calls.at(-1) as [{ onMaxDurationReached: () => void }];
    await getHarness().act(async () => {
      onMaxDurationReached();
    });
    expect(stopRecording).toHaveBeenCalledOnce();
  });

  it("says when the microphone hears nothing, and why a recording it gave up on was cancelled", async () => {
    const cancelRecording = vi.fn(() => true);
    useVoiceInputMock.mockReturnValue(voiceInputState({ phase: "recording", isRecording: true, nothingHeard: true, cancelRecording }));
    await renderChatInput();
    expect(getHarness().dom.container.textContent).toContain("Can't hear you");

    const [{ onNothingHeard }] = useVoiceInputMock.mock.calls.at(-1) as [{ onNothingHeard: () => void }];
    await getHarness().act(async () => {
      onNothingHeard();
    });
    expect(cancelRecording).toHaveBeenCalledOnce();
    useVoiceInputMock.mockReturnValue(voiceInputState({ cancelRecording }));
    await renderChatInput();
    expect(getHarness().dom.container.textContent).toContain("Nothing heard. Recording cancelled.");
  });

  it.each(["starting", "recording"])("offers cancellation during %s without sending or changing the draft", async (phase) => {
    const state = useVoiceInputMock();
    const cancelRecording = vi.fn(() => true);
    useVoiceInputMock.mockReturnValue({ ...state, phase, cancelRecording, elapsedSeconds: 4 });
    const onSend = vi.fn();
    const onSubmitVoiceCapture = vi.fn();
    const onDraftChange = vi.fn();
    const props = {
      onSend, onSubmitVoiceCapture, onDraftChange,
      draft: {
        text: "Keep this draft",
        attachments: [{ type: "blob" as const, data: "", mimeType: "text/plain", displayName: "notes.txt" }],
      },
    };
    useVoiceInputMock.mockReturnValue({ ...state, phase: "idle", cancelRecording });
    await renderChatInput(props);
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Autopilot"))?.onClick?.();
    });
    useVoiceInputMock.mockReturnValue({ ...state, phase, cancelRecording, elapsedSeconds: 4 });
    await renderChatInput(props);
    // Only the recording line, Cancel and Finish remain while the microphone is open.
    expect(queryButtonByAriaLabel(getHarness().dom.container, "Autopilot")).toBeUndefined();
    expect(queryButtonByAriaLabel(getHarness().dom.container, "Attach file")).toBeUndefined();
    expect(queryButtonByAriaLabel(getHarness().dom.container, "Remove attachment notes.txt")).toBeUndefined();
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Cancel voice recording"))?.onClick?.();
    });
    expect(cancelRecording).toHaveBeenCalledOnce();
    expect(state.stopRecording).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onSubmitVoiceCapture).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(findTextarea(getHarness().dom.container).value).toBe("Keep this draft");

    useVoiceInputMock.mockReturnValue({ ...state, phase: "idle", cancelRecording });
    await renderChatInput(props);
    expect(findButtonByAriaLabel(getHarness().dom.container, "Remove attachment notes.txt")).toBeDefined();
    expect(getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Autopilot"))?.["aria-pressed"]).toBe(true);
    expect(getHarness().dom.container.textContent).toContain("Recording cancelled. Nothing sent.");
    expect(queryButtonByAriaLabel(getHarness().dom.container, "Cancel voice recording")).toBeUndefined();
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Record voice input"))?.onClick?.();
    });
    expect(getHarness().dom.container.textContent).not.toContain("Recording cancelled.");
  });

  it("handles Escape from both the status actions and composer, but not during IME composition", async () => {
    const cancelRecording = vi.fn(() => true);
    useVoiceInputMock.mockReturnValue({ ...useVoiceInputMock(), phase: "recording", cancelRecording });
    await renderChatInput();
    const container = getHarness().dom.container;
    const wrapper = findAllByTag(container, "DIV").find((element) => getReactProps(element)?.onKeyDown);
    const cancelButton = findButtonByAriaLabel(container, "Cancel voice recording");
    let parent = cancelButton.parentNode;
    while (parent && parent !== wrapper) parent = parent.parentNode;
    expect(parent).toBe(wrapper);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const onKeyDown = getReactProps(wrapper)?.onKeyDown;
    await getHarness().act(async () => {
      onKeyDown({ key: "Escape", nativeEvent: { isComposing: true }, preventDefault, stopPropagation });
    });
    expect(cancelRecording).not.toHaveBeenCalled();
    await getHarness().act(async () => {
      onKeyDown({ key: "Escape", nativeEvent: {}, preventDefault, stopPropagation });
    });
    expect(cancelRecording).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("moves keyboard focus into the recording row, onto Finish once it records, and back to the box after", async () => {
    const state = useVoiceInputMock();
    const render = async (phase: string) => {
      useVoiceInputMock.mockReturnValue({ ...state, phase, isRecording: phase === "recording", elapsedSeconds: 0 });
      await renderChatInput();
    };
    await render("idle");
    const container = getHarness().dom.container;
    findButtonByAriaLabel(container, "Record voice input").focus();

    await render("starting");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Voice recording");
    expect(getReactProps(findTextarea(container))?.className).toContain("hidden");

    await render("recording");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Stop recording/);

    await render("idle");
    expect(document.activeElement).toBe(findTextarea(container));
    expect(getReactProps(findTextarea(container))?.className).not.toContain("hidden");
  });

  it.each(["idle", "finishing"])("does not offer cancellation while %s", async (phase) => {
    useVoiceInputMock.mockReturnValue({ ...useVoiceInputMock(), phase });
    await renderChatInput();
    expect(queryButtonByAriaLabel(getHarness().dom.container, "Cancel voice recording")).toBeUndefined();
  });

  it("keeps the submission mode and shows no cancellation confirmation when Stop won the race", async () => {
    const state = useVoiceInputMock();
    let phase = "idle";
    const cancelRecording = vi.fn(() => false);
    useVoiceInputMock.mockImplementation(() => ({
      ...state,
      phase,
      startRecording: () => { phase = "recording"; },
      stopRecording: () => { phase = "finishing"; },
      cancelRecording,
    }));
    const onSubmitVoiceCapture = vi.fn();
    await renderChatInput({ onSubmitVoiceCapture });
    const container = getHarness().dom.container;
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(container, "Record voice input"))?.onClick?.();
    });
    await renderChatInput({ onSubmitVoiceCapture });
    const [{ onAudioCaptured }] = useVoiceInputMock.mock.calls.at(-1) as [{
      onAudioCaptured: (capture: { audio: Blob; contextKey: string }) => Promise<void>;
    }];
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(container, "Stop recording, transcribe, and send automatically"))?.onClick?.();
      getReactProps(findButtonByAriaLabel(container, "Cancel voice recording"))?.onClick?.();
      await onAudioCaptured({ audio: new Blob(["audio"]), contextKey: "session-1" });
    });
    expect(cancelRecording).toHaveBeenCalledOnce();
    expect(onSubmitVoiceCapture).toHaveBeenCalledWith(expect.objectContaining({ submitMode: "autosend" }));
    phase = "idle";
    await renderChatInput({ onSubmitVoiceCapture });
    expect(container.textContent).not.toContain("Recording cancelled.");
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

  it("uses the selected Autopilot mode for the primary draft send", async () => {
    const onSend = vi.fn();
    await renderChatInput({
      onSend,
      isDraft: true,
      defaultSendMode: "autopilot",
    });

    const textarea = findTextarea(getHarness().dom.container);
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "finish the task",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
    });

    const sendButton = findButtonByAriaLabel(getHarness().dom.container, "Start Autopilot");
    await getHarness().act(async () => {
      getReactProps(sendButton.parentNode)?.onClick?.();
    });

    expect(onSend).toHaveBeenCalledWith("finish the task", undefined, "autopilot");
  });

  it("turns Autopilot on for one message from the composer toggle", async () => {
    const onSend = vi.fn();
    await renderChatInput({ onSend });
    const container = getHarness().dom.container;

    const typeAndEnter = async (value: string) => {
      const textarea = findTextarea(getHarness().dom.container);
      await getHarness().act(async () => {
        getReactProps(textarea)?.onChange?.({ target: { value, style: { height: "" }, scrollHeight: 48 } });
      });
      await getHarness().act(async () => {
        getReactProps(findTextarea(getHarness().dom.container))?.onKeyDown?.({ key: "Enter", shiftKey: false, preventDefault: vi.fn() });
      });
    };

    const toggle = findButtonByAriaLabel(container, "Autopilot");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await getHarness().act(async () => {
      getReactProps(toggle)?.onClick?.();
    });
    expect(findButtonByAriaLabel(getHarness().dom.container, "Autopilot").getAttribute("aria-pressed")).toBe("true");
    expect(findButtonByAriaLabel(getHarness().dom.container, "Start Autopilot")).toBeDefined();
    // The toggle already shows Autopilot, so the send button keeps its arrow instead of repeating the mark.
    const sendIcons = findAllByTag(findButtonByAriaLabel(getHarness().dom.container, "Start Autopilot"), "svg")
      .map((svg) => svg.getAttribute("class") ?? "").join(" ");
    expect(sendIcons).toContain("lucide-arrow-up");
    expect(getHarness().dom.container.textContent).toContain("Questions still wait for you");

    await typeAndEnter("fix the flaky tests");
    expect(onSend).toHaveBeenLastCalledWith("fix the flaky tests", undefined, "autopilot");

    // The choice is for one message; the next one goes back to interactive.
    expect(findButtonByAriaLabel(getHarness().dom.container, "Autopilot").getAttribute("aria-pressed")).toBe("false");
    await typeAndEnter("and thanks");
    expect(onSend).toHaveBeenLastCalledWith("and thanks", undefined, "interactive");
  });

  it("auto-sends a recording made with Autopilot on and starts it in Autopilot", async () => {
    let phase: "idle" | "recording" = "idle";
    const startRecording = vi.fn(() => { phase = "recording"; });
    const stopRecording = vi.fn();
    const baseVoice = useVoiceInputMock();
    useVoiceInputMock.mockImplementation(() => ({
      ...baseVoice,
      phase,
      isRecording: phase === "recording",
      startRecording,
      stopRecording,
    }));
    const onSubmitVoiceCapture = vi.fn(async () => "autosend" as const);
    await renderChatInput({ onSubmitVoiceCapture });

    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Autopilot"))?.onClick?.();
    });
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Record voice input"))?.onClick?.();
    });
    expect(startRecording).toHaveBeenCalledOnce();
    const stopButton = findButtonByAriaLabel(getHarness().dom.container, "Stop recording, transcribe, and send automatically");
    await getHarness().act(async () => {
      getReactProps(stopButton)?.onClick?.();
    });
    expect(stopRecording).toHaveBeenCalledOnce();

    const audio = new Blob(["voice"], { type: "audio/wav" });
    const [{ onAudioCaptured }] = useVoiceInputMock.mock.calls.at(-1) as [{
      onAudioCaptured: (capture: { audio: Blob; contextKey: string }) => Promise<void>;
    }];
    phase = "idle";
    await getHarness().act(async () => {
      await onAudioCaptured({ audio, contextKey: "session-1" });
    });

    expect(onSubmitVoiceCapture).toHaveBeenCalledWith({
      composerKey: "session-1",
      audio,
      submitMode: "autosend",
      sendMode: "autopilot",
    });
    // Like a typed send, the Autopilot choice covered just that message.
    expect(findButtonByAriaLabel(getHarness().dom.container, "Autopilot").getAttribute("aria-pressed")).toBe("false");
  });

  it("auto-sends a recording started while the chat was still loading once loading has finished", async () => {
    let phase: "idle" | "recording" = "idle";
    const baseVoice = useVoiceInputMock();
    useVoiceInputMock.mockImplementation(() => ({
      ...baseVoice,
      phase,
      isRecording: phase === "recording",
      startRecording: vi.fn(() => { phase = "recording"; }),
    }));
    const onSubmitVoiceCapture = vi.fn(async () => "autosend" as const);
    await renderChatInput({ onSubmitVoiceCapture, disabled: true });

    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Record voice input"))?.onClick?.();
    });
    expect(() => findButtonByAriaLabel(getHarness().dom.container, "Stop recording and transcribe")).not.toThrow();

    await renderChatInput({ onSubmitVoiceCapture, disabled: false });
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Stop recording, transcribe, and send automatically"))?.onClick?.();
    });
    const [{ onAudioCaptured }] = useVoiceInputMock.mock.calls.at(-1) as [{
      onAudioCaptured: (capture: { audio: Blob; contextKey: string }) => Promise<void>;
    }];
    phase = "idle";
    await getHarness().act(async () => {
      await onAudioCaptured({ audio: new Blob(["voice"]), contextKey: "session-1" });
    });

    expect(onSubmitVoiceCapture).toHaveBeenCalledWith(expect.objectContaining({ submitMode: "autosend" }));
  });

  it("keeps Autopilot on when an Autopilot recording is put in the composer instead of sent", async () => {
    let phase: "idle" | "recording" = "idle";
    const baseVoice = useVoiceInputMock();
    useVoiceInputMock.mockImplementation(() => ({
      ...baseVoice,
      phase,
      isRecording: phase === "recording",
      startRecording: vi.fn(() => { phase = "recording"; }),
    }));
    const onSubmitVoiceCapture = vi.fn(async () => "insert" as const);
    await renderChatInput({ onSubmitVoiceCapture });

    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Autopilot"))?.onClick?.();
    });
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Record voice input"))?.onClick?.();
    });
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Stop recording, transcribe, and send automatically"))?.onClick?.();
    });
    const [{ onAudioCaptured }] = useVoiceInputMock.mock.calls.at(-1) as [{
      onAudioCaptured: (capture: { audio: Blob; contextKey: string }) => Promise<void>;
    }];
    phase = "idle";
    await getHarness().act(async () => {
      await onAudioCaptured({ audio: new Blob(["voice"]), contextKey: "session-1" });
    });
    await renderChatInput({ onSubmitVoiceCapture });

    expect(onSubmitVoiceCapture).toHaveBeenCalledWith(expect.objectContaining({ submitMode: "autosend", sendMode: "autopilot" }));
    expect(findButtonByAriaLabel(getHarness().dom.container, "Autopilot").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps a newer Autopilot choice made while an earlier recording was still being handed off", async () => {
    let phase: "idle" | "recording" | "finishing" = "idle";
    const baseVoice = useVoiceInputMock();
    useVoiceInputMock.mockImplementation(() => ({
      ...baseVoice,
      phase,
      isRecording: phase === "recording",
      startRecording: vi.fn(() => { phase = "recording"; }),
    }));
    const onSubmitVoiceCapture = vi.fn(async () => "autosend" as const);
    await renderChatInput({ onSubmitVoiceCapture });
    const clickAutopilot = async () => {
      await getHarness().act(async () => {
        getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Autopilot"))?.onClick?.();
      });
    };

    await clickAutopilot();
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Record voice input"))?.onClick?.();
    });
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(getHarness().dom.container, "Stop recording, transcribe, and send automatically"))?.onClick?.();
    });
    const [{ onAudioCaptured }] = useVoiceInputMock.mock.calls.at(-1) as [{
      onAudioCaptured: (capture: { audio: Blob; contextKey: string }) => Promise<void>;
    }];
    // The recorder stays in "finishing" until the capture has been handed off.
    phase = "finishing";
    await renderChatInput({ onSubmitVoiceCapture });
    await clickAutopilot();
    await clickAutopilot();
    await getHarness().act(async () => {
      await onAudioCaptured({ audio: new Blob(["voice"]), contextKey: "session-1" });
    });

    expect(onSubmitVoiceCapture).toHaveBeenCalledWith(expect.objectContaining({ sendMode: "autopilot" }));
    expect(findButtonByAriaLabel(getHarness().dom.container, "Autopilot").getAttribute("aria-pressed")).toBe("true");
  });

  it("hides the Autopilot toggle while steering and in a new chat", async () => {
    await renderChatInput({ onAbort: vi.fn() });
    expect(findAllByTag(getHarness().dom.container, "BUTTON").some((button) => button.getAttribute("aria-label") === "Autopilot")).toBe(false);

    await renderChatInput({ isDraft: true, defaultSendMode: "autopilot" });
    expect(findAllByTag(getHarness().dom.container, "BUTTON").some((button) => button.getAttribute("aria-label") === "Autopilot")).toBe(false);
  });

  it("uses the selected Autopilot mode when Enter submits the draft", async () => {
    const onSend = vi.fn();
    await renderChatInput({
      onSend,
      isDraft: true,
      defaultSendMode: "autopilot",
    });

    const textarea = findTextarea(getHarness().dom.container);
    const preventDefault = vi.fn();
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "run autonomously",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
      getReactProps(textarea)?.onKeyDown?.({
        key: "Enter",
        shiftKey: false,
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("run autonomously", undefined, "autopilot");
  });

  // How each key, modifier and device classifies is covered in lib/composer-enter.test.ts; these
  // cases prove the composer acts on that classification.
  it.each([
    { label: "new chat with the keyboard visible", visualHeight: 480, isDraft: true, steering: false },
    { label: "steering note without viewport shrink", visualHeight: 800, isDraft: false, steering: true },
  ])("keeps mobile Enter as a newline in a $label", async ({ visualHeight, isDraft, steering }) => {
    pointerFineMatches = false;
    setVisualViewport(800, visualHeight);
    const onSend = vi.fn();
    const onDraftChange = vi.fn();
    await renderChatInput({ onSend, onDraftChange, isDraft, onAbort: steering ? vi.fn() : undefined });

    const textarea = findTextarea(getHarness().dom.container);
    const preventDefault = vi.fn();
    expect(getReactProps(textarea)?.enterKeyHint).toBe("enter");
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "first line",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
      getReactProps(textarea)?.onKeyDown?.({
        key: "Enter",
        shiftKey: false,
        preventDefault,
      });
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "first line\nsecond line",
          style: { height: "" },
          scrollHeight: 72,
        },
      });
    });
    expect(textarea.value).toBe("first line\nsecond line");
    expect(onDraftChange).toHaveBeenLastCalledWith("first line\nsecond line", []);
    await getHarness().act(async () => {
      getReactProps(findButtonByAriaLabel(
        getHarness().dom.container,
        steering ? "Send steering note" : "Send message",
      ).parentNode)?.onClick?.({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    const sentArgs = ["first line\nsecond line", undefined];
    expect(onSend).toHaveBeenCalledWith(...(steering ? sentArgs : [...sentArgs, "interactive"]));
    expect(textarea.value).toBe("");
  });

  it.each([
    { code: "NumpadEnter", isDraft: true, steering: false, mode: "interactive" as const },
    { code: "Enter", isDraft: false, steering: true, mode: "interactive" as const },
  ])("sends hardware-style Enter with an unobscured touch viewport %j", async ({ code, isDraft, steering, mode }) => {
    pointerFineMatches = false;
    setVisualViewport(800, 800);
    const onSend = vi.fn();
    await renderChatInput({
      onSend,
      isDraft,
      defaultSendMode: mode,
      onAbort: steering ? vi.fn() : undefined,
      draft: { text: "hardware message", attachments: [] },
    });
    const textarea = findTextarea(getHarness().dom.container);
    const preventDefault = vi.fn();
    await getHarness().act(async () => {
      getReactProps(textarea)?.onKeyDown?.({ key: "Enter", code, shiftKey: false, preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    if (steering) expect(onSend).toHaveBeenCalledWith("hardware message", undefined);
    else expect(onSend).toHaveBeenCalledWith("hardware message", undefined, mode);
    expect(textarea.value).toBe("");
  });

  it("keeps composition Enter native until composition ends and resets on composer changes", async () => {
    const onSend = vi.fn();
    await renderChatInput({ onSend, draft: { text: "composing", attachments: [] } });
    const textarea = findTextarea(getHarness().dom.container);
    const preventDefault = vi.fn();
    await getHarness().act(async () => {
      getReactProps(textarea)?.onCompositionStart?.();
      getReactProps(textarea)?.onKeyDown?.({ key: "Enter", code: "Enter", preventDefault });
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    await getHarness().act(async () => {
      getReactProps(textarea)?.onCompositionEnd?.();
      getReactProps(textarea)?.onKeyDown?.({ key: "Enter", code: "Enter", preventDefault });
    });
    expect(onSend).toHaveBeenCalledOnce();

    await getHarness().act(async () => { getReactProps(textarea)?.onCompositionStart?.(); });
    await renderChatInput({ onSend, composerKey: "session-2", draft: { text: "new target", attachments: [] } });
    await getHarness().act(async () => {
      getReactProps(textarea)?.onKeyDown?.({ key: "Enter", code: "Enter", preventDefault });
    });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "mobile software keyboard", finePointer: false, code: "", completes: false },
    { label: "desktop", finePointer: true, code: "Enter", completes: true },
  ])("handles Enter in slash suggestions on $label", async ({ finePointer, code, completes }) => {
    pointerFineMatches = finePointer;
    setVisualViewport(800, 800);
    const onSend = vi.fn();
    await renderChatInput({
      onSend,
      draft: { text: "/go", attachments: [] },
      slashCommandsSupported: true,
      slashCommands: [{
        name: "goal",
        description: "Set an autopilot objective",
        kind: "builtin",
        allowDuringAgentExecution: true,
      }],
    });
    const textarea = findTextarea(getHarness().dom.container);
    const preventDefault = vi.fn();
    await getHarness().act(async () => {
      getReactProps(textarea)?.onKeyDown?.({
        key: "Enter",
        code,
        shiftKey: false,
        preventDefault,
      });
    });
    expect(preventDefault).toHaveBeenCalledTimes(completes ? 1 : 0);
    expect(textarea.value).toBe(completes ? "/goal " : "/go");
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each(["shiftKey", "ctrlKey"] as const)("preserves %s+Enter while slash suggestions are open", async (modifier) => {
    pointerFineMatches = false;
    setVisualViewport(800, 800);
    const onSend = vi.fn();
    await renderChatInput({
      onSend,
      draft: { text: "/go", attachments: [] },
      slashCommandsSupported: true,
      slashCommands: [{
        name: "goal", description: "Set an autopilot objective",
        kind: "builtin", allowDuringAgentExecution: true,
      }],
    });
    const textarea = findTextarea(getHarness().dom.container);
    const preventDefault = vi.fn();
    await getHarness().act(async () => {
      getReactProps(textarea)?.onKeyDown?.({ key: "Enter", code: "Enter", [modifier]: true, preventDefault });
    });
    if (modifier === "shiftKey") {
      expect(preventDefault).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      expect(textarea.value).toBe("/go");
    } else {
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(onSend).toHaveBeenCalledWith("/go", undefined, "interactive");
      expect(textarea.value).toBe("");
    }
  });

  it("shows slash command suggestions and inserts a selected command", async () => {    await renderChatInput({
      slashCommandsSupported: true,
      slashCommands: [{
        name: "goal",
        aliases: ["autopilot"],
        description: "Set an autopilot objective",
        kind: "builtin",
        input: { hint: "objective", preserveMultilineInput: true },
        allowDuringAgentExecution: true,
      }],
    });

    const textarea = findTextarea(getHarness().dom.container);
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "/go fix tests",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
    });

    expect(getHarness().dom.container.textContent).toContain("/goal");
    expect(getHarness().dom.container.textContent).toContain("Set an autopilot objective");

    const goalButton = findButtonContainingText(getHarness().dom.container, "/goal");
    await getHarness().act(async () => {
      getReactProps(goalButton)?.onClick?.();
    });

    expect(findTextarea(getHarness().dom.container).value).toBe("/goal fix tests");
  });

  it("shows argument hints after an exact slash command", async () => {
    await renderChatInput({
      slashCommandsSupported: true,
      slashCommands: [{
        name: "goal",
        description: "Set an autopilot objective",
        kind: "builtin",
        input: { hint: "objective", required: true },
        allowDuringAgentExecution: true,
      }],
    });

    const textarea = findTextarea(getHarness().dom.container);
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "/goal ",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
    });

    expect(getHarness().dom.container.textContent).toContain("Required: objective");
  });

  it("does not show slash suggestions for escaped literal slash prompts", async () => {
    await renderChatInput({
      slashCommandsSupported: true,
      slashCommands: [{
        name: "goal",
        description: "Set an autopilot objective",
        kind: "builtin",
        allowDuringAgentExecution: true,
      }],
    });

    const textarea = findTextarea(getHarness().dom.container);
    await getHarness().act(async () => {
      getReactProps(textarea)?.onChange?.({
        target: {
          value: "//goal literal",
          style: { height: "" },
          scrollHeight: 48,
        },
      });
    });

    expect(getHarness().dom.container.textContent).not.toContain("Set an autopilot objective");
  });
});
