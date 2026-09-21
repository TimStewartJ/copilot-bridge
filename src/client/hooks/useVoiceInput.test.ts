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

const createOpusRecordingEncoderMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/voice-recording-opus", () => ({
  createOpusRecordingEncoder: (sampleRate: number) => createOpusRecordingEncoderMock(sampleRate),
}));

describe("useVoiceInput recording limit", () => {
  const SAMPLE_RATE = 16_000;
  const WAV_HEADER_BYTES = 44;
  let harness: ReactDomHarness | null = null;
  let voice: ReturnType<typeof useVoiceInput> | null = null;
  let processor: { onaudioprocess: ((event: unknown) => void) | null; connect(): void; disconnect(): void };
  let getUserMedia: () => Promise<unknown>;
  let inputSampleRate = SAMPLE_RATE;

  async function mount(options: Partial<Parameters<typeof useVoiceInput>[0]>) {
    harness = await createReactDomHarness();
    processor = { onaudioprocess: null, connect() {}, disconnect() {} };
    Object.assign(globalThis.navigator, { mediaDevices: { getUserMedia: () => getUserMedia() } });
    Object.assign(globalThis.window, {
      AudioContext: class {
        sampleRate: number;
        constructor(options?: AudioContextOptions) {
          this.sampleRate = options?.sampleRate ?? SAMPLE_RATE;
          inputSampleRate = this.sampleRate;
        }
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
        inputBuffer: { getChannelData: () => new Float32Array(seconds * inputSampleRate).fill(0.25) },
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

  describe("compressed uploads", () => {
    const opusBlob = new Blob([new Uint8Array(900)], { type: "audio/ogg" });
    let pushed: number[];
    let encoder: { push: (samples: Float32Array) => void; finish: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      pushed = [];
      encoder = { push: (samples) => pushed.push(samples.length), finish: vi.fn(async () => opusBlob), cancel: vi.fn() };
      createOpusRecordingEncoderMock.mockResolvedValue(encoder);
      fetchTranscriptionStatusMock.mockResolvedValue({
        available: true,
        provider: "speech-engine",
        label: "Parakeet v3 (local)",
        maxDurationSeconds: 2,
        opusUploads: true,
      });
    });

    it("hands over the Opus encoding of exactly the audio that was kept", async () => {
      const onAudioCaptured = vi.fn(async (_capture: { audio: Blob; contextKey: string }) => {});
      await startRecording({ onAudioCaptured });
      expect(createOpusRecordingEncoderMock).toHaveBeenCalledWith(48_000);

      await hear(1.25);
      await hear(1.25);
      await waitUntilAct(harness!.act, () => onAudioCaptured.mock.calls.length === 1);

      expect(pushed).toEqual([1.25 * 48_000, 0.75 * 48_000]);
      expect(onAudioCaptured.mock.calls[0]![0].audio).toBe(opusBlob);
      expect(encoder.cancel).not.toHaveBeenCalled();
    });

    it("sends the WAV when the encoding cannot be trusted", async () => {
      encoder.finish.mockResolvedValue(null);
      const onAudioCaptured = vi.fn(async (_capture: { audio: Blob; contextKey: string }) => {});
      await startRecording({ onAudioCaptured });
      await hear(1);
      await harness!.act(async () => {
        await voice!.stopRecording();
      });

      const { audio } = onAudioCaptured.mock.calls[0]![0];
      expect(audio.type).toBe("audio/wav");
      expect(audio.size).toBe(WAV_HEADER_BYTES + SAMPLE_RATE * 2);
    });

    it("records plain WAV in a browser that cannot encode Opus", async () => {
      createOpusRecordingEncoderMock.mockResolvedValue(null);
      const onAudioCaptured = vi.fn(async (_capture: { audio: Blob; contextKey: string }) => {});
      await startRecording({ onAudioCaptured });
      await hear(1);
      await harness!.act(async () => {
        await voice!.stopRecording();
      });
      expect(onAudioCaptured.mock.calls[0]![0].audio.type).toBe("audio/wav");
    });

    it("keeps WAV capture working if the browser refuses the preferred capture rate", async () => {
      createOpusRecordingEncoderMock.mockResolvedValue(null);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onAudioCaptured = vi.fn(async (_capture: { audio: Blob; contextKey: string }) => {});
      await mount({ onAudioCaptured });
      Object.assign(globalThis.window, {
        AudioContext: class {
          sampleRate = SAMPLE_RATE;
          destination = {};
          constructor(options?: AudioContextOptions) {
            if (options?.sampleRate === 48_000) throw Object.assign(new Error("rate unsupported"), { name: "NotSupportedError" });
            inputSampleRate = SAMPLE_RATE;
          }
          resume = async () => {};
          close = async () => {};
          createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
          createScriptProcessor = () => processor;
        },
      });
      try {
        await harness!.act(async () => { await voice!.startRecording(); });
        await hear(1);
        await harness!.act(async () => { await voice!.stopRecording(); });
        expect(onAudioCaptured.mock.calls[0]![0].audio.type).toBe("audio/wav");
        expect(voice!.error).toBeNull();
        expect(warning).toHaveBeenCalledOnce();
      } finally {
        warning.mockRestore();
      }
    });

    it("lets go of the encoder when the microphone cannot be opened", async () => {
      getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
      await mount({});
      const realAudioContext = (globalThis.window as unknown as { AudioContext: new () => object }).AudioContext;
      Object.assign(globalThis.window, {
        AudioContext: class extends realAudioContext {
          createMediaStreamSource = () => {
            throw new Error("source failed");
          };
        },
      });
      await harness!.act(async () => {
        await voice!.startRecording();
      });
      expect(voice!.phase).toBe("idle");
      expect(voice!.error).toBe("source failed");
      expect(encoder.cancel).toHaveBeenCalledOnce();
    });
  });

  it("never asks for an encoder when the server does not take compressed recordings", async () => {
    await startRecording({});
    expect(createOpusRecordingEncoderMock).not.toHaveBeenCalled();
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
