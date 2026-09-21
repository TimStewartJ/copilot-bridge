import { describe, expect, it } from "vitest";
import { demuxOggOpus, muxOggOpus } from "../../../shared/ogg-opus.js";
import { OGG_OPUS_TONE_SECONDS, oggOpusToneFixture } from "../../../test-support/ogg-opus-fixture.js";
import { decodeRecording } from "../voice-recording.js";

function wavTone(seconds: number, sampleRate = 16_000): Uint8Array {
  const samples = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + samples * 2, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16_000), true);
  return bytes;
}

/** Strength of one frequency in a signal, relative to the signal's overall level. */
function toneShare(samples: Float32Array, sampleRate: number, hz: number): number {
  let sine = 0;
  let cosine = 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    sine += samples[i]! * Math.sin((2 * Math.PI * hz * i) / sampleRate);
    cosine += samples[i]! * Math.cos((2 * Math.PI * hz * i) / sampleRate);
    energy += samples[i]! * samples[i]!;
  }
  return (2 * (sine * sine + cosine * cosine)) / (samples.length * energy);
}

describe("decodeRecording", () => {
  it("decodes an Ogg Opus recording straight to the recognizer's rate", async () => {
    const recording = await decodeRecording(oggOpusToneFixture(), 16_000);

    expect(recording).toMatchObject({ format: "opus", sampleRate: 16_000, channels: 1 });
    expect(recording.samples.length / 16_000).toBeCloseTo(OGG_OPUS_TONE_SECONDS, 1);
    // What comes out is the 440 Hz tone that went in, not merely something of the right length.
    const settled = recording.samples.subarray(1_600);
    expect(toneShare(settled, 16_000, 440)).toBeGreaterThan(0.9);
    expect(toneShare(settled, 16_000, 1_000)).toBeLessThan(0.05);
  });

  it("drops the padding after the point where the stream says the recording ends", async () => {
    const stream = demuxOggOpus(oggOpusToneFixture());
    const quarterSecond = muxOggOpus({ ...stream, endSample: stream.preSkip + 12_000 });
    expect((await decodeRecording(quarterSecond, 16_000)).samples).toHaveLength(4_000);
  });

  it("falls back to 48 kHz for a rate Opus cannot decode to", async () => {
    const recording = await decodeRecording(oggOpusToneFixture(), 22_050);
    expect(recording.sampleRate).toBe(48_000);
    expect(recording.samples.length / 48_000).toBeCloseTo(OGG_OPUS_TONE_SECONDS, 1);
  });

  it("still decodes the WAV every browser can send", async () => {
    const recording = await decodeRecording(wavTone(0.25), 16_000);
    expect(recording).toMatchObject({ format: "wav", sampleRate: 16_000, channels: 1 });
    expect(recording.samples).toHaveLength(4_000);
  });

  it("fails explicitly instead of accepting decoder errors as a partial recording", async () => {
    const damaged = muxOggOpus({ channels: 1, preSkip: 0, inputSampleRate: 48_000,
      packets: [new Uint8Array([0x49, 0xff])] });
    await expect(decodeRecording(damaged, 16_000)).rejects.toThrow("could not be decoded");
  });

  it("refuses an Opus recording with nothing in it", async () => {
    const empty = muxOggOpus({ channels: 1, preSkip: 312, inputSampleRate: 16_000, packets: [] });
    await expect(decodeRecording(empty, 16_000)).rejects.toThrow("no decodable audio");
  });
});
