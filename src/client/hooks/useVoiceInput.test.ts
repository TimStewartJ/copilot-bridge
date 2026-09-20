import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import { describeVoiceCaptureError, useVoiceInput } from "./useVoiceInput";

const fetchTranscriptionStatusMock = vi.hoisted(() => vi.fn());
const releaseCaptureMock = vi.hoisted(() => vi.fn());
const holdVoiceCaptureMock = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  fetchTranscriptionStatus: () => fetchTranscriptionStatusMock(),
}));

vi.mock("../lib/voice-capture-guard", () => ({
  holdVoiceCapture: () => holdVoiceCaptureMock(),
}));

describe("useVoiceInput recording limit", () => {
  const SAMPLE_RATE = 16_000;
  const WAV_HEADER_BYTES = 44;
  let harness: ReactDomHarness | null = null;
  let voice: ReturnType<typeof useVoiceInput> | null = null;
  let processor: { onaudioprocess: ((event: unknown) => void) | null; connect(): void; disconnect(): void };
  let getUserMedia: () => Promise<unknown>;

  async function mount(options: Partial<Parameters<typeof useVoiceInput>[0]>) {
    harness = await createReactDomHarness();
    processor = { onaudioprocess: null, connect() {}, disconnect() {} };
    Object.assign(globalThis.navigator, { mediaDevices: { getUserMedia: () => getUserMedia() } });
    Object.assign(globalThis.window, {
      AudioContext: class {
        sampleRate = SAMPLE_RATE;
        destination = {};
        resume = async () => {};
        close = async () => {};
        createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
        createScriptProcessor = () => processor;
      },
    });

    function Harness() {
      voice = useVoiceInput({ contextKey: "session-1", onAudioCaptured: async () => {}, ...options });
      return null;
    }
    await harness.render(createElement(Harness));
  }

  async function startRecording(options: Partial<Parameters<typeof useVoiceInput>[0]>) {
    await mount(options);
    await harness!.act(async () => {
      await voice!.startRecording();
    });
    expect(voice!.phase).toBe("recording");
  }

  async function hear(seconds: number) {
    await harness!.act(async () => {
      processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(seconds * SAMPLE_RATE).fill(0.25) },
      });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    holdVoiceCaptureMock.mockReturnValue(releaseCaptureMock);
    getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
    fetchTranscriptionStatusMock.mockResolvedValue({
      available: true,
      provider: "speech-engine",
      label: "Parakeet v3 (local)",
      maxDurationSeconds: 2,
    });
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    voice = null;
  });

  it("stops itself at the limit, keeps exactly that much audio, and guards it until it is stored", async () => {
    let finishStoring = () => {};
    const onAudioCaptured = vi.fn(() => new Promise<void>((resolve) => {
      finishStoring = resolve;
    }));
    await startRecording({ onAudioCaptured });

    await hear(1.25);
    expect(voice!.elapsedSeconds).toBe(1);
    expect(onAudioCaptured).not.toHaveBeenCalled();

    await hear(1.25);
    await waitUntilAct(harness!.act, () => onAudioCaptured.mock.calls.length === 1);
    const [{ audio, contextKey }] = onAudioCaptured.mock.calls[0] as unknown as [{ audio: Blob; contextKey: string }];
    expect(audio.size).toBe(WAV_HEADER_BYTES + 2 * SAMPLE_RATE * 2);
    expect(contextKey).toBe("session-1");
    expect(voice!.elapsedSeconds).toBe(2);
    expect(releaseCaptureMock).not.toHaveBeenCalled();

    finishStoring();
    await waitUntilAct(harness!.act, () => voice!.phase === "idle");
    expect(releaseCaptureMock).toHaveBeenCalledOnce();
  });

  it("lets the caller end a recording that reached the limit, and takes no more audio meanwhile", async () => {
    const onAudioCaptured = vi.fn(async (_capture: { audio: Blob; contextKey: string }) => {});
    const onMaxDurationReached = vi.fn();
    await startRecording({ onAudioCaptured, onMaxDurationReached });

    await hear(2.5);
    await hear(1);
    expect(onMaxDurationReached).toHaveBeenCalledOnce();
    expect(voice!.phase).toBe("recording");

    await harness!.act(async () => {
      await voice!.stopRecording();
    });
    expect(onAudioCaptured.mock.calls[0]![0].audio.size).toBe(WAV_HEADER_BYTES + 2 * SAMPLE_RATE * 2);
  });

  it("submits what it captured when the view goes away mid-recording", async () => {
    const onAudioCaptured = vi.fn(async (_capture: { audio: Blob; contextKey: string }) => {});
    await startRecording({ onAudioCaptured });
    await hear(1);

    await harness!.cleanup();
    await vi.waitFor(() => expect(releaseCaptureMock).toHaveBeenCalledOnce());
    expect(onAudioCaptured).toHaveBeenCalledOnce();
    expect(onAudioCaptured.mock.calls[0]![0]).toMatchObject({ contextKey: "session-1" });
    expect(onAudioCaptured.mock.calls[0]![0].audio.size).toBe(WAV_HEADER_BYTES + SAMPLE_RATE * 2);
  });

  it("leaves nothing running when the view goes away while the microphone is still opening", async () => {
    let openMicrophone = (_stream: unknown) => {};
    const stopTrack = vi.fn();
    getUserMedia = () => new Promise((resolve) => {
      openMicrophone = resolve;
    });
    await mount({});
    let starting: Promise<void> | undefined;
    await harness!.act(async () => {
      starting = voice!.startRecording();
    });

    await harness!.cleanup();
    openMicrophone({ getTracks: () => [{ stop: stopTrack }] });
    await starting;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(holdVoiceCaptureMock).not.toHaveBeenCalled();
  });
});

describe("describeVoiceCaptureError", () => {
  it("replaces Firefox and browser not-found mic errors with clearer guidance", () => {
    expect(describeVoiceCaptureError({
      name: "NotFoundError",
      message: "The object can not be found here.",
    })).toBe("No microphone was found. Check your browser and OS audio input settings, then try again.");

    expect(describeVoiceCaptureError({
      name: "DevicesNotFoundError",
      message: "No audio input",
    })).toBe("No microphone was found. Check your browser and OS audio input settings, then try again.");
  });

  it("maps denied permissions to a browser-specific mic access message", () => {
    expect(describeVoiceCaptureError({
      name: "NotAllowedError",
      message: "The request is not allowed by the user agent or the platform in the current context",
    })).toBe("Microphone access was denied. Allow microphone access in your browser settings and try again.");
  });

  it("maps device-busy failures to a microphone unavailable message", () => {
    expect(describeVoiceCaptureError({
      name: "NotReadableError",
      message: "Failed to allocate videosource",
    })).toBe("The microphone is unavailable right now. Close other apps or tabs that might be using it, then try again.");
  });

  it("falls back to the original error text for unknown failures", () => {
    expect(describeVoiceCaptureError(new Error("Unexpected failure"))).toBe("Unexpected failure");
  });
});
