import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demuxOggOpus, oggOpusDurationSeconds } from "../../shared/ogg-opus.js";
import { createOpusRecordingEncoder } from "./voice-recording-opus";

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960;

/** A 20 ms packet per frame plus encoder delay, delivered on flush. */
class FakeAudioEncoder {
  static supported = true;
  static failOnEncode = false;
  static throwOnEncode = false;
  static failConfiguration = false;
  static omitMetadata = false;
  static stallFlush = false;
  static packetDelta = 0;
  static packetsPerFrame = 1;
  static last: FakeAudioEncoder;
  static isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({ supported: FakeAudioEncoder.supported, config }));

  state = "unconfigured";
  config: AudioEncoderConfig | null = null;
  private samples = 0;
  private emitted = 0;

  constructor(private readonly init: { output: (chunk: unknown, metadata?: unknown) => void; error: (error: Error) => void }) {
    FakeAudioEncoder.last = this;
  }

  configure(config: AudioEncoderConfig) {
    if (FakeAudioEncoder.failConfiguration) throw new Error("configuration failed");
    this.config = config;
    this.state = "configured";
  }

  encode(data: { numberOfFrames: number }) {
    if (FakeAudioEncoder.throwOnEncode) throw new Error("encode failed");
    if (FakeAudioEncoder.failOnEncode) {
      this.init.error(new Error("encoder broke"));
      return;
    }
    this.samples += data.numberOfFrames;
  }

  async flush() {
    if (FakeAudioEncoder.stallFlush) await new Promise<void>(() => {});
    const frames = (Math.ceil(this.samples / FRAME_SAMPLES) + 1) * FakeAudioEncoder.packetsPerFrame + FakeAudioEncoder.packetDelta;
    for (; this.emitted < frames; this.emitted++) {
      const bytes = new Uint8Array([0x48, this.emitted & 0xff, 7]);
      const description = new Uint8Array(19);
      description.set(new TextEncoder().encode("OpusHead"), 0);
      description[8] = 1;
      description[9] = 1;
      new DataView(description.buffer).setUint16(10, 312, true);
      this.init.output(
        { byteLength: bytes.length, copyTo: (target: Uint8Array) => target.set(bytes) },
        this.emitted === 0 && !FakeAudioEncoder.omitMetadata ? { decoderConfig: { description } } : undefined,
      );
    }
  }

  close() {
    this.state = "closed";
  }
}

class FakeAudioData {
  static last: FakeAudioData;
  readonly numberOfFrames: number;
  readonly close = vi.fn();
  constructor(init: { numberOfFrames: number }) {
    FakeAudioData.last = this;
    this.numberOfFrames = init.numberOfFrames;
  }
}

describe("createOpusRecordingEncoder", () => {
  beforeEach(() => {
    FakeAudioEncoder.supported = true;
    FakeAudioEncoder.failOnEncode = false;
    FakeAudioEncoder.throwOnEncode = false;
    FakeAudioEncoder.failConfiguration = false;
    FakeAudioEncoder.omitMetadata = false;
    FakeAudioEncoder.stallFlush = false;
    FakeAudioEncoder.packetDelta = 0;
    FakeAudioEncoder.packetsPerFrame = 1;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
    vi.stubGlobal("AudioData", FakeAudioData);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("encodes speech-rate mono Opus and packages it as an Ogg recording", async () => {
    const encoder = await createOpusRecordingEncoder(SAMPLE_RATE);
    encoder!.push(new Float32Array(SAMPLE_RATE));
    encoder!.push(new Float32Array(0));
    encoder!.push(new Float32Array(SAMPLE_RATE / 2));
    const blob = await encoder!.finish();

    expect(FakeAudioEncoder.last.config).toEqual({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 32_000 });
    expect(blob!.type).toBe("audio/ogg");
    const stream = demuxOggOpus(new Uint8Array(await blob!.arrayBuffer()));
    // The encoder's own delay, read from the header it described its stream with.
    expect(stream).toMatchObject({ channels: 1, preSkip: 312, inputSampleRate: SAMPLE_RATE });
    expect(stream.packets.map((packet) => [...packet])).toEqual(Array.from({ length: 76 }, (_, index) => [0x48, index, 7]));
    // The encoder padded to a whole packet; the recording is still exactly the 1.5 s that was captured.
    expect(oggOpusDurationSeconds(stream)).toBe(1.5);
    expect(FakeAudioEncoder.last.state).toBe("closed");
  });

  it("reports no encoder when the browser has none or cannot do Opus at this rate", async () => {
    FakeAudioEncoder.supported = false;
    expect(await createOpusRecordingEncoder(SAMPLE_RATE)).toBeNull();

    vi.stubGlobal("AudioEncoder", undefined);
    expect(await createOpusRecordingEncoder(SAMPLE_RATE)).toBeNull();
  });

  it("gives up on the encoding, so the WAV is sent, when the encoder fails or returns the wrong amount of audio", async () => {
    FakeAudioEncoder.failOnEncode = true;
    const broken = await createOpusRecordingEncoder(SAMPLE_RATE);
    broken!.push(new Float32Array(SAMPLE_RATE));
    expect(await broken!.finish()).toBeNull();

    FakeAudioEncoder.failOnEncode = false;
    FakeAudioEncoder.packetsPerFrame = 2;
    const doubled = await createOpusRecordingEncoder(SAMPLE_RATE);
    doubled!.push(new Float32Array(SAMPLE_RATE * 2));
    expect(await doubled!.finish()).toBeNull();

    const unused = await createOpusRecordingEncoder(SAMPLE_RATE);
    expect(await unused!.finish()).toBeNull();
    expect(FakeAudioEncoder.last.state).toBe("closed");
  });

  it.each([-1, 1])("falls back rather than dropping audio or adding whole extra frames (%i)", async (packetDelta) => {
    FakeAudioEncoder.packetDelta = packetDelta;
    const encoder = await createOpusRecordingEncoder(SAMPLE_RATE);
    encoder!.push(new Float32Array(SAMPLE_RATE));
    expect(await encoder!.finish()).toBeNull();
    expect(console.warn).toHaveBeenCalled();
    expect(FakeAudioEncoder.last.state).toBe("closed");
  });

  it("does not guess an encoder delay when no header was provided", async () => {
    FakeAudioEncoder.omitMetadata = true;
    const encoder = await createOpusRecordingEncoder(SAMPLE_RATE);
    encoder!.push(new Float32Array(SAMPLE_RATE));
    expect(await encoder!.finish()).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("releases native resources after configuration and encoding errors", async () => {
    FakeAudioEncoder.failConfiguration = true;
    expect(await createOpusRecordingEncoder(SAMPLE_RATE)).toBeNull();
    expect(FakeAudioEncoder.last.state).toBe("closed");

    FakeAudioEncoder.failConfiguration = false;
    FakeAudioEncoder.throwOnEncode = true;
    const encoder = await createOpusRecordingEncoder(SAMPLE_RATE);
    encoder!.push(new Float32Array(SAMPLE_RATE));
    expect(FakeAudioData.last.close).toHaveBeenCalledOnce();
    expect(await encoder!.finish()).toBeNull();
    expect(FakeAudioEncoder.last.state).toBe("closed");
  });

  it("falls back to WAV if flushing the native encoder stalls", async () => {
    vi.useFakeTimers();
    FakeAudioEncoder.stallFlush = true;
    const encoder = await createOpusRecordingEncoder(SAMPLE_RATE);
    encoder!.push(new Float32Array(SAMPLE_RATE));
    const pending = encoder!.finish();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBeNull();
    expect(FakeAudioEncoder.last.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets go of the encoder when a recording is abandoned", async () => {
    const encoder = await createOpusRecordingEncoder(SAMPLE_RATE);
    encoder!.push(new Float32Array(SAMPLE_RATE));
    encoder!.cancel();
    encoder!.cancel();
    expect(FakeAudioEncoder.last.state).toBe("closed");
  });
});
