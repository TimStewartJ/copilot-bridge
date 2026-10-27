import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceTimersByTimeAct, createReactDomHarness, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import { describeVoiceCaptureError, NOTHING_HEARD_CANCEL_MS, NOTHING_HEARD_WARNING_MS, useVoiceInput } from "./useVoiceInput";

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
  let analyser: { fftSize: number; smoothingTimeConstant: number; samples: number; getFloatTimeDomainData(data: Float32Array): void; connect(): void; disconnect(): void };
  let getUserMedia: () => Promise<unknown>;
  let closeAudioContext: () => Promise<void>;
  let resumeAudioContext: () => Promise<void>;
  let inputSampleRate = SAMPLE_RATE;

  async function mount(options: Partial<Parameters<typeof useVoiceInput>[0]>) {
    harness = await createReactDomHarness();
    processor = { onaudioprocess: null, connect() {}, disconnect() {} };
    analyser = {
      fftSize: 2_048,
      smoothingTimeConstant: 0.8,
      samples: 0,
      getFloatTimeDomainData(data) { data.fill(this.samples); },
      connect() {},
      disconnect() {},
    };
    Object.assign(globalThis.navigator, { mediaDevices: { getUserMedia: () => getUserMedia() } });
    Object.assign(globalThis.window, {
      AudioContext: class {
        sampleRate: number;
        constructor(options?: AudioContextOptions) {
          this.sampleRate = options?.sampleRate ?? SAMPLE_RATE;
          inputSampleRate = this.sampleRate;
        }
        destination = {};
        resume = () => resumeAudioContext();
        close = () => closeAudioContext();
        createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
        createScriptProcessor = () => processor;
        createAnalyser = () => analyser;
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
    closeAudioContext = async () => {};
    resumeAudioContext = async () => {};
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

  it("reports how loud the microphone is while recording, and nothing once it stops", async () => {
    await mount({});
    expect(voice!.getLevel()).toBe(0);
    await harness!.act(async () => {
      await voice!.startRecording();
    });
    analyser.samples = 0.25;
    expect(voice!.getLevel()).toBeCloseTo(0.25);

    await harness!.act(async () => { voice!.cancelRecording(); });
    expect(voice!.getLevel()).toBe(0);
  });

  it("discards recorded audio, stops capture, resets the clock, and never submits", async () => {
    const stopTrack = vi.fn();
    getUserMedia = async () => ({ getTracks: () => [{ stop: stopTrack }] });
    const onAudioCaptured = vi.fn();
    const onMaxDurationReached = vi.fn();
    await startRecording({ onAudioCaptured, onMaxDurationReached });
    await hear(1);
    const queuedAudioProcess = processor.onaudioprocess;

    await harness!.act(async () => { await voice!.cancelRecording(); });
    expect(voice!.phase).toBe("idle");
    expect(voice!.elapsedSeconds).toBe(0);
    expect(voice!.error).toBeNull();
    expect(processor.onaudioprocess).toBeNull();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(releaseCaptureMock).toHaveBeenCalledOnce();

    await harness!.act(async () => {
      queuedAudioProcess?.({ inputBuffer: { getChannelData: () => new Float32Array(2 * SAMPLE_RATE) } });
      await voice!.stopRecording();
      await voice!.cancelRecording();
    });
    await harness!.cleanup();
    expect(onAudioCaptured).not.toHaveBeenCalled();
    expect(onMaxDurationReached).not.toHaveBeenCalled();
    expect(releaseCaptureMock).toHaveBeenCalledOnce();
  });

  it("warns, then discards a recording whose microphone delivers nothing, and never submits it", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    getUserMedia = async () => ({ getTracks: () => [{ stop: stopTrack }] });
    const onAudioCaptured = vi.fn();
    await startRecording({ onAudioCaptured });
    const queuedAudioProcess = processor.onaudioprocess;

    await advanceTimersByTimeAct(harness!.act, NOTHING_HEARD_WARNING_MS - 1);
    expect(voice!.nothingHeard).toBe(false);
    await advanceTimersByTimeAct(harness!.act, 1);
    expect(voice!.nothingHeard).toBe(true);
    expect(voice!.phase).toBe("recording");

    await advanceTimersByTimeAct(harness!.act, NOTHING_HEARD_CANCEL_MS - NOTHING_HEARD_WARNING_MS);
    expect(voice!.phase).toBe("idle");
    expect(voice!.nothingHeard).toBe(false);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(releaseCaptureMock).toHaveBeenCalledOnce();

    await harness!.act(async () => {
      queuedAudioProcess?.({ inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_RATE).fill(0.25) } });
      await voice!.stopRecording();
    });
    await harness!.cleanup();
    expect(onAudioCaptured).not.toHaveBeenCalled();
  });

  it("drops the warning once it hears something, and then never gives up on the recording", async () => {
    vi.useFakeTimers();
    const onAudioCaptured = vi.fn(async (_capture: { audio: Blob; contextKey: string }) => {});
    const onNothingHeard = vi.fn();
    await startRecording({ onAudioCaptured, onNothingHeard });
    await harness!.act(async () => {
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_RATE) } });
    });
    await advanceTimersByTimeAct(harness!.act, NOTHING_HEARD_WARNING_MS);
    expect(voice!.nothingHeard).toBe(true);

    await hear(0.5);
    expect(voice!.nothingHeard).toBe(false);
    await advanceTimersByTimeAct(harness!.act, 10 * NOTHING_HEARD_CANCEL_MS);
    expect(onNothingHeard).not.toHaveBeenCalled();
    expect(voice!.phase).toBe("recording");

    await harness!.act(async () => { await voice!.stopRecording(); });
    expect(onAudioCaptured).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"])("ignores a cancelled microphone opening that later %ss after a restart", async (outcome) => {
    let openMicrophone = (_stream: unknown) => {};
    let rejectMicrophone = (_error: Error) => {};
    getUserMedia = () => new Promise((resolve, reject) => {
      openMicrophone = resolve;
      rejectMicrophone = reject;
    });
    const onAudioCaptured = vi.fn();
    await mount({ onAudioCaptured });
    let starting: Promise<void> | undefined;
    await harness!.act(async () => { starting = voice!.startRecording(); });
    expect(voice!.phase).toBe("starting");
    await harness!.act(async () => { await voice!.cancelRecording(); });

    const stopOldTrack = vi.fn();
    const stopNewTrack = vi.fn();
    getUserMedia = async () => ({ getTracks: () => [{ stop: stopNewTrack }] });
    await harness!.act(async () => { await voice!.startRecording(); });
    await hear(1);
    await harness!.act(async () => {
      if (outcome === "resolve") openMicrophone({ getTracks: () => [{ stop: stopOldTrack }] });
      else rejectMicrophone(new Error("old permission denied"));
      await starting;
    });
    expect(stopOldTrack).toHaveBeenCalledTimes(outcome === "resolve" ? 1 : 0);
    expect(stopNewTrack).not.toHaveBeenCalled();
    expect(voice!.phase).toBe("recording");
    expect(voice!.elapsedSeconds).toBe(1);
    expect(voice!.error).toBeNull();
    await harness!.act(async () => { await voice!.cancelRecording(); });
    expect(onAudioCaptured).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("allows retry while a cancelled status request is pending and ignores its late %s", async (outcome) => {
    fetchTranscriptionStatusMock.mockResolvedValueOnce({ available: false, reason: "Check again" });
    await mount({});
    let resolveStatus = (_status: unknown) => {};
    let rejectStatus = (_error: Error) => {};
    fetchTranscriptionStatusMock.mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveStatus = resolve;
      rejectStatus = reject;
    }));
    let starting: Promise<void> | undefined;
    await harness!.act(async () => { starting = voice!.startRecording(); });
    expect(voice!.isCheckingStatus).toBe(true);
    await harness!.act(async () => { await voice!.cancelRecording(); });
    expect(voice!.isCheckingStatus).toBe(false);
    await harness!.act(async () => { await voice!.startRecording(); });
    expect(voice!.phase).toBe("recording");
    await harness!.act(async () => {
      if (outcome === "resolve") resolveStatus({ available: false, reason: "Stale result" });
      else rejectStatus(new Error("Stale failure"));
      await starting;
    });
    expect(voice!.phase).toBe("recording");
    expect(voice!.status?.available).toBe(true);
    expect(voice!.statusError).toBeNull();
    expect(voice!.error).toBeNull();
    await harness!.act(async () => { await voice!.cancelRecording(); });
  });

  it("does not clear a fresh recording when a cancelled audio context finishes closing", async () => {
    let finishClosing = () => {};
    closeAudioContext = () => new Promise((resolve) => { finishClosing = resolve; });
    const onAudioCaptured = vi.fn();
    await startRecording({ onAudioCaptured });
    await harness!.act(async () => { expect(voice!.cancelRecording()).toBe(true); });
    expect(voice!.phase).toBe("idle");
    closeAudioContext = async () => {};
    await harness!.act(async () => { await voice!.startRecording(); });
    await hear(1);
    await harness!.act(async () => {
      finishClosing();
      await voice!.stopRecording();
    });
    expect(onAudioCaptured).toHaveBeenCalledOnce();
    expect(onAudioCaptured.mock.calls[0]![0].audio.size).toBe(WAV_HEADER_BYTES + SAMPLE_RATE * 2);
  });

  it("does not affect a fresh recording when a cancelled audio context resumes late", async () => {
    let finishResuming = () => {};
    resumeAudioContext = () => new Promise((resolve) => { finishResuming = resolve; });
    await mount({});
    let starting: Promise<void> | undefined;
    await harness!.act(async () => { starting = voice!.startRecording(); });
    expect(voice!.phase).toBe("starting");
    await harness!.act(async () => { expect(voice!.cancelRecording()).toBe(true); });
    resumeAudioContext = async () => {};
    await harness!.act(async () => { await voice!.startRecording(); });
    await harness!.act(async () => {
      finishResuming();
      await starting;
    });
    expect(voice!.phase).toBe("recording");
    expect(voice!.error).toBeNull();
    expect(holdVoiceCaptureMock).toHaveBeenCalledOnce();
    await harness!.act(async () => { voice!.cancelRecording(); });
    expect(releaseCaptureMock).toHaveBeenCalledOnce();
  });

  it("does not cancel an audio capture already being handed off", async () => {
    let finishStoring = () => {};
    const onAudioCaptured = vi.fn(() => new Promise<void>((resolve) => { finishStoring = resolve; }));
    await startRecording({ onAudioCaptured });
    await hear(1);
    let stopping: Promise<void> | undefined;
    await harness!.act(async () => {
      stopping = voice!.stopRecording();
      expect(voice!.cancelRecording()).toBe(false);
    });
    expect(voice!.phase).toBe("finishing");
    expect(releaseCaptureMock).not.toHaveBeenCalled();
    await harness!.act(async () => {
      finishStoring();
      await stopping;
    });
    expect(onAudioCaptured).toHaveBeenCalledOnce();
    expect(releaseCaptureMock).toHaveBeenCalledOnce();
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

    it("cancels the encoder without finishing or submitting audio", async () => {
      const onAudioCaptured = vi.fn();
      await startRecording({ onAudioCaptured });
      await hear(1);
      await harness!.act(async () => { await voice!.cancelRecording(); });
      expect(encoder.cancel).toHaveBeenCalledOnce();
      expect(encoder.finish).not.toHaveBeenCalled();
      expect(onAudioCaptured).not.toHaveBeenCalled();
    });

    it("cancels a late encoder without affecting a fresh recording", async () => {
      let openEncoder = (_encoder: typeof encoder) => {};
      createOpusRecordingEncoderMock.mockImplementationOnce(() => new Promise((resolve) => { openEncoder = resolve; }));
      await mount({});
      let starting: Promise<void> | undefined;
      await harness!.act(async () => { starting = voice!.startRecording(); });
      await harness!.act(async () => { await voice!.cancelRecording(); });
      const freshEncoder = { push: vi.fn(), finish: vi.fn(async () => opusBlob), cancel: vi.fn() };
      createOpusRecordingEncoderMock.mockResolvedValueOnce(freshEncoder);
      await harness!.act(async () => { await voice!.startRecording(); });
      await harness!.act(async () => {
        openEncoder(encoder);
        await starting;
      });
      expect(encoder.cancel).toHaveBeenCalledOnce();
      expect(freshEncoder.cancel).not.toHaveBeenCalled();
      expect(voice!.phase).toBe("recording");
      await harness!.act(async () => { await voice!.cancelRecording(); });
      expect(freshEncoder.cancel).toHaveBeenCalledOnce();
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
          createAnalyser = () => analyser;
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
    })).toBe("No microphone found. Check your browser and system audio input.");

    expect(describeVoiceCaptureError({
      name: "DevicesNotFoundError",
      message: "No audio input",
    })).toBe("No microphone found. Check your browser and system audio input.");
  });

  it("maps denied permissions to a browser-specific mic access message", () => {
    expect(describeVoiceCaptureError({
      name: "NotAllowedError",
      message: "The request is not allowed by the user agent or the platform in the current context",
    })).toBe("Microphone access was denied. Allow it in browser settings, then retry.");
  });

  it("maps device-busy failures to a microphone unavailable message", () => {
    expect(describeVoiceCaptureError({
      name: "NotReadableError",
      message: "Failed to allocate videosource",
    })).toBe("Microphone unavailable. Close other apps or tabs using it, then retry.");
  });

  it("falls back to the original error text for unknown failures", () => {
    expect(describeVoiceCaptureError(new Error("Unexpected failure"))).toBe("Unexpected failure");
  });
});
