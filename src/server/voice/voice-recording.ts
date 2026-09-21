// Decodes an uploaded chat mic recording. Browsers that can encode Opus send Ogg Opus, about an
// eighth the size of the WAV that every browser can fall back to.
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { demuxOggOpus, isOggOpus, oggOpusDurationSeconds, OPUS_CLOCK_RATE } from "../../shared/ogg-opus.js";
import { decodeWav, type DecodedWav } from "./voice-clip.js";

export type RecordingFormat = "wav" | "opus";

export interface DecodedRecording extends DecodedWav {
  format: RecordingFormat;
}

export class RecordingDecodeError extends Error {}

/** Rates Opus decodes to directly, which saves resampling when the recognizer wants one of them. */
const OPUS_OUTPUT_RATES = [8_000, 12_000, 16_000, 24_000, OPUS_CLOCK_RATE] as const;
type OpusOutputRate = (typeof OPUS_OUTPUT_RATES)[number];
/** Packets decoded before yielding: five seconds of audio, a few milliseconds of work. */
const PACKETS_PER_BATCH = 250;

async function decodeOggOpus(bytes: Uint8Array, preferredSampleRate: number): Promise<DecodedRecording> {
  const stream = demuxOggOpus(bytes);
  const sampleRate: OpusOutputRate = OPUS_OUTPUT_RATES.find((rate) => rate === preferredSampleRate) ?? OPUS_CLOCK_RATE;
  // The decoder loads its WebAssembly on first use, so WAV-only installs never pay for it.
  const { OpusDecoder } = await import("opus-decoder");
  const decoder = new OpusDecoder({
    sampleRate,
    channels: stream.channels,
    // The header counts the encoder's delay at 48 kHz; the decoder drops samples at its output rate.
    preSkip: Math.round((stream.preSkip * sampleRate) / OPUS_CLOCK_RATE),
  });
  try {
    await decoder.ready;
    const parts: Float32Array[] = [];
    const targetSamples = Math.round(oggOpusDurationSeconds(stream) * sampleRate);
    let total = 0;
    for (let index = 0; index < stream.packets.length && total < targetSamples; index += PACKETS_PER_BATCH) {
      const { channelData, samplesDecoded, errors } = decoder.decodeFrames(stream.packets.slice(index, index + PACKETS_PER_BATCH));
      if (errors.length) throw new RecordingDecodeError(`The Opus recording could not be decoded: ${errors[0]!.message}`);
      const mono = new Float32Array(samplesDecoded);
      for (const channel of channelData) {
        for (let i = 0; i < samplesDecoded; i++) mono[i]! += channel[i]! / channelData.length;
      }
      parts.push(mono);
      total += samplesDecoded;
      // A long recording must not hold up live conversation audio waiting on this process.
      await yieldToEventLoop();
    }
    if (total === 0) throw new RecordingDecodeError("The Opus recording contains no decodable audio.");
    if (total < targetSamples) throw new RecordingDecodeError("The Opus recording ended before all its audio was decoded.");
    // The encoder pads its last packet; the stream says where the recording really ends.
    const samples = new Float32Array(targetSamples);
    let offset = 0;
    for (const part of parts) {
      if (offset >= samples.length) break;
      samples.set(part.subarray(0, samples.length - offset), offset);
      offset += part.length;
    }
    return { format: "opus", sampleRate, channels: stream.channels, samples };
  } finally {
    decoder.free();
  }
}

/** Decodes a WAV or Ogg Opus recording to mono samples, at `preferredSampleRate` when the format allows it. */
export async function decodeRecording(bytes: Uint8Array, preferredSampleRate: number): Promise<DecodedRecording> {
  return isOggOpus(bytes) ? decodeOggOpus(bytes, preferredSampleRate) : { format: "wav", ...decodeWav(bytes) };
}
