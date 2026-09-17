import { describe, expect, it } from "vitest";
import { encodeWav, SpeechResampler, TRANSCRIPTION_SAMPLE_RATE } from "./voice-recording-audio";

function tone(frequency: number, sampleRate: number, seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return samples;
}

function rms(samples: Float32Array, skip = 0): number {
  let sum = 0;
  for (let i = skip; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (samples.length - skip));
}

function zeroCrossings(samples: Float32Array, skip = 0): number {
  let crossings = 0;
  for (let i = skip + 1; i < samples.length; i++) {
    if ((samples[i - 1]! < 0) !== (samples[i]! < 0)) crossings++;
  }
  return crossings;
}

describe("SpeechResampler", () => {
  it("downsamples common browser rates to 16 kHz", () => {
    const from48k = new SpeechResampler(48_000);
    expect(from48k.outputRate).toBe(TRANSCRIPTION_SAMPLE_RATE);
    expect(from48k.push(new Float32Array(48_000))).toHaveLength(16_000);

    const from44k = new SpeechResampler(44_100);
    expect(Math.abs(from44k.push(new Float32Array(44_100)).length - 16_000)).toBeLessThanOrEqual(1);
  });

  it("keeps speech-band audio intact", () => {
    const output = new SpeechResampler(48_000).push(tone(440, 48_000, 1));
    expect(rms(output, 160)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(Math.abs(zeroCrossings(output) - 880)).toBeLessThanOrEqual(4);
  });

  it("filters out content above the 8 kHz limit instead of aliasing it", () => {
    const input = tone(12_000, 48_000, 1);
    const output = new SpeechResampler(48_000).push(input);
    expect(rms(output, 160)).toBeLessThan(0.2 * rms(input));
  });

  it("produces identical output whether audio arrives in chunks or all at once", () => {
    const input = tone(1_000, 48_000, 1);
    const oneShot = new SpeechResampler(48_000).push(input);
    const streaming = new SpeechResampler(48_000);
    const parts: Float32Array[] = [];
    for (let offset = 0; offset < input.length; offset += 4_096) parts.push(streaming.push(input.subarray(offset, offset + 4_096)));
    const joined = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
    let position = 0;
    for (const part of parts) {
      joined.set(part, position);
      position += part.length;
    }
    expect(Array.from(joined)).toEqual(Array.from(oneShot));
  });

  it("passes audio through unchanged at or below 16 kHz", () => {
    const input = tone(300, 8_000, 0.1);
    const resampler = new SpeechResampler(8_000);
    expect(resampler.outputRate).toBe(8_000);
    const output = resampler.push(input);
    expect(Array.from(output)).toEqual(Array.from(input));
    expect(output).not.toBe(input);
  });
});

describe("encodeWav", () => {
  it("writes a 16-bit mono PCM header for the given rate", async () => {
    const blob = encodeWav([new Float32Array([0, 0.5]), new Float32Array([-1, 2])], 16_000);
    expect(blob.type).toBe("audio/wav");
    const view = new DataView(await blob.arrayBuffer());
    expect(view.byteLength).toBe(44 + 8);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([44, 46, 48, 50].map((offset) => view.getInt16(offset, true))).toEqual([0, 16_383, -32_768, 32_767]);
  });

  it("rejects empty recordings", () => {
    expect(() => encodeWav([], 16_000)).toThrow("No audio captured.");
    expect(() => encodeWav([new Float32Array(0)], 16_000)).toThrow("No audio captured.");
  });
});
