import { describe, expect, it } from "vitest";
import { CLIP_CHUNK_PLAN, decodeWav, joinTranscripts, planSpeechChunks, WavDecodeError } from "../voice-clip.js";

interface WavOptions {
  format?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  extensibleFormat?: number;
  extraChunk?: boolean;
}

function buildWav(frames: number[][], options: WavOptions = {}): Uint8Array {
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const sampleRate = options.sampleRate ?? 16_000;
  const format = options.format ?? 1;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const fmtSize = format === 0xfffe ? 40 : 16;
  const extra = options.extraChunk ? 8 + 3 + 1 : 0;
  const dataBytes = frames.length * blockAlign;
  const buffer = new ArrayBuffer(12 + 8 + fmtSize + extra + 8 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeAscii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  if (format === 0xfffe) {
    view.setUint16(36, 22, true);
    view.setUint16(38, bitsPerSample, true);
    view.setUint16(44, options.extensibleFormat ?? 1, true);
  }
  let offset = 20 + fmtSize;
  if (options.extraChunk) {
    writeAscii(offset, "LIST");
    view.setUint32(offset + 4, 3, true);
    offset += 8 + 3 + 1;
  }
  writeAscii(offset, "data");
  view.setUint32(offset + 4, dataBytes, true);
  offset += 8;
  for (const frame of frames) {
    for (const value of frame) {
      if (format === 3 || options.extensibleFormat === 3) {
        view.setFloat32(offset, value, true);
      } else if (bitsPerSample === 16) {
        view.setInt16(offset, Math.round(value * 32767), true);
      } else if (bitsPerSample === 24) {
        const int = Math.round(value * 8388607);
        view.setUint8(offset, int & 0xff);
        view.setUint8(offset + 1, (int >> 8) & 0xff);
        view.setInt8(offset + 2, int >> 16);
      } else if (bitsPerSample === 8) {
        view.setUint8(offset, Math.max(0, Math.min(255, Math.round(value * 128) + 128)));
      }
      offset += bytesPerSample;
    }
  }
  return new Uint8Array(buffer);
}

function expectSamples(actual: Float32Array, expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 3));
}

describe("decodeWav", () => {
  it("decodes 16-bit mono PCM and skips unrelated chunks", () => {
    const decoded = decodeWav(buildWav([[0.5], [-0.25], [0]], { sampleRate: 48_000, extraChunk: true }));
    expect(decoded).toMatchObject({ sampleRate: 48_000, channels: 1 });
    expectSamples(decoded.samples, [0.5, -0.25, 0]);
  });

  it("averages stereo channels into mono", () => {
    const decoded = decodeWav(buildWav([[0.5, -0.5], [0.25, 0.75]], { channels: 2 }));
    expectSamples(decoded.samples, [0, 0.5]);
  });

  it("decodes 8-bit, 24-bit and float encodings", () => {
    expectSamples(decodeWav(buildWav([[0.5], [-0.5]], { bitsPerSample: 8 })).samples, [0.5, -0.5]);
    expectSamples(decodeWav(buildWav([[0.75], [-0.75]], { bitsPerSample: 24 })).samples, [0.75, -0.75]);
    expectSamples(decodeWav(buildWav([[0.125], [-1]], { format: 3, bitsPerSample: 32 })).samples, [0.125, -1]);
    expectSamples(decodeWav(buildWav([[0.3]], { format: 0xfffe, extensibleFormat: 3, bitsPerSample: 32 })).samples, [0.3]);
  });

  it("rejects files that are not decodable PCM WAV", () => {
    expect(() => decodeWav(new TextEncoder().encode("not a wav file"))).toThrow(WavDecodeError);
    expect(() => decodeWav(buildWav([[0.1]], { format: 0x55 }))).toThrow("Unsupported WAV encoding");
    const header = buildWav([[0.1]]).slice(0, 36);
    expect(() => decodeWav(header)).toThrow("missing audio data");
  });
});

describe("planSpeechChunks", () => {
  const sampleRate = 100;
  const options = { sampleRate, maxChunkSeconds: 10, maxGapSeconds: 1, padSeconds: 0.5 };

  it("merges segments separated by short pauses and pads the result", () => {
    expect(planSpeechChunks([{ start: 200, end: 400 }, { start: 450, end: 600 }], 2_000, options)).toEqual([{ start: 150, end: 650 }]);
  });

  it("starts a new chunk after a long pause and keeps padding from overlapping", () => {
    const chunks = planSpeechChunks([{ start: 100, end: 300 }, { start: 420, end: 500 }], 1_000, { ...options, maxGapSeconds: 1 });
    expect(chunks).toEqual([{ start: 50, end: 350 }, { start: 370, end: 550 }]);
    const tight = planSpeechChunks([{ start: 0, end: 300 }, { start: 950, end: 1_400 }], 1_450, { ...options, maxChunkSeconds: 5, maxGapSeconds: 10 });
    expect(tight).toEqual([{ start: 0, end: 350 }, { start: 925, end: 1_425 }]);
    expect(tight[0]!.end).toBeLessThanOrEqual(tight[1]!.start);
  });

  it("never lets merged chunks exceed the maximum length", () => {
    const segments = Array.from({ length: 6 }, (_, index) => ({ start: index * 300, end: index * 300 + 250 }));
    const chunks = planSpeechChunks(segments, 2_000, { ...options, padSeconds: 0 });
    expect(chunks).toEqual([{ start: 0, end: 850 }, { start: 900, end: 1_750 }]);
  });

  it("ignores empty or out-of-range segments and sorts input", () => {
    expect(planSpeechChunks([{ start: 700, end: 690 }, { start: 500, end: 900 }, { start: -50, end: 100 }], 800, { ...options, padSeconds: 0 }))
      .toEqual([{ start: 0, end: 100 }, { start: 500, end: 800 }]);
  });

  it("uses recognizer-friendly defaults", () => {
    expect(CLIP_CHUNK_PLAN).toEqual({ maxChunkSeconds: 20, maxGapSeconds: 1.5, padSeconds: 0.25 });
  });

  describe("speech that ran longer than a chunk without a detectable pause", () => {
    const lengths = (chunks: Array<{ start: number; end: number }>) => chunks.map((chunk) => chunk.end - chunk.start);

    it("cuts it into the fewest even pieces when there is no audio to look at", () => {
      const chunks = planSpeechChunks([{ start: 0, end: 4_500 }], 4_500, { ...options, padSeconds: 0 });
      expect(lengths(chunks)).toEqual([900, 900, 900, 900, 900]);
      expect(chunks[0]!.start).toBe(0);
      expect(chunks.at(-1)!.end).toBe(4_500);
    });

    it("cuts it at the quietest points, so a pause is cut rather than a word", () => {
      const samples = new Float32Array(3_000).fill(0.5);
      const pauses = [{ start: 800, end: 840 }, { start: 1_600, end: 1_640 }];
      for (const pause of pauses) samples.fill(0.01, pause.start, pause.end);

      const chunks = planSpeechChunks([{ start: 0, end: 2_500 }], 3_000, { ...options, samples });

      expect(chunks).toHaveLength(3);
      for (const length of lengths(chunks)) expect(length).toBeLessThanOrEqual(options.maxChunkSeconds * sampleRate);
      // The pieces tile the speech: padding is only added at its outer edges, never across a cut.
      expect(chunks[0]!.start).toBe(0);
      expect(chunks.at(-1)!.end).toBe(2_550);
      for (const [index, pause] of pauses.entries()) {
        expect(chunks[index]!.end).toBe(chunks[index + 1]!.start);
        expect(chunks[index]!.end).toBeGreaterThanOrEqual(pause.start);
        expect(chunks[index]!.end).toBeLessThanOrEqual(pause.end);
      }
    });

    it("bounds a long stretch between shorter segments without disturbing them", () => {
      const chunks = planSpeechChunks([{ start: 0, end: 300 }, { start: 600, end: 3_100 }, { start: 3_500, end: 3_700 }], 4_000, { ...options, padSeconds: 0, maxGapSeconds: 0.5 });
      expect(chunks[0]).toEqual({ start: 0, end: 300 });
      expect(chunks.at(-1)).toEqual({ start: 3_500, end: 3_700 });
      const middle = chunks.slice(1, -1);
      expect(middle[0]!.start).toBe(600);
      expect(middle.at(-1)!.end).toBe(3_100);
      for (const length of lengths(middle)) expect(length).toBeLessThanOrEqual(1_000);
    });

    it("uses the fewest pieces even when all candidate cuts are equally quiet", () => {
      const samples = new Float32Array(4_500).fill(0.5);
      const chunks = planSpeechChunks([{ start: 0, end: samples.length }], samples.length, { ...options, samples });
      expect(chunks).toHaveLength(5);
      expect(chunks[0]!.start).toBe(0);
      expect(chunks.at(-1)!.end).toBe(samples.length);
      for (const length of lengths(chunks)) expect(length).toBeLessThanOrEqual(1_000);
      for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
    });

    it("includes padding in the cap without cutting speech", () => {
      const chunks = planSpeechChunks([{ start: 100, end: 1_100 }], 1_300, options);
      expect(chunks).toEqual([{ start: 100, end: 1_100 }]);
    });

    it("leaves speech that fits in one chunk alone", () => {
      expect(planSpeechChunks([{ start: 0, end: 1_000 }], 1_000, { ...options, samples: new Float32Array(1_000) })).toEqual([{ start: 0, end: 1_000 }]);
    });
  });
});

describe("joinTranscripts", () => {
  it("joins non-empty parts with single spaces", () => {
    expect(joinTranscripts([" Hello there. ", "", "  How are\nyou? "])).toBe("Hello there. How are you?");
  });
});
