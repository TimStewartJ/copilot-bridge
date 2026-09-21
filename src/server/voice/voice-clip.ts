// Pure helpers for transcribing recorded clips: WAV decoding and splitting speech into
// chunks the recognizer can handle without holding up live voice conversations.

export class WavDecodeError extends Error {}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Mono samples in [-1, 1]; multi-channel audio is averaged. */
  samples: Float32Array;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function ascii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i));
  return value;
}

export function decodeWav(buffer: Uint8Array): DecodedWav {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.byteLength < 12 || ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new WavDecodeError("Audio must be a WAV file.");
  }

  let format: number | undefined;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataOffset: number | undefined;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || start + 16 > buffer.byteLength) throw new WavDecodeError("WAV format chunk is invalid.");
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      blockAlign = view.getUint16(start + 12, true);
      bitsPerSample = view.getUint16(start + 14, true);
      // Extensible WAVs carry the real format tag in the first bytes of the sub-format GUID.
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 26 && start + 26 <= buffer.byteLength) {
        format = view.getUint16(start + 24, true);
      }
    } else if (id === "data") {
      dataOffset = start;
      dataBytes = Math.max(0, Math.min(size, buffer.byteLength - start));
    }
    offset = start + size + (size % 2);
  }

  if (format === undefined || dataOffset === undefined) throw new WavDecodeError("WAV file is missing audio data.");
  const bytesPerSample = bitsPerSample / 8;
  const supported = format === WAVE_FORMAT_PCM
    ? [8, 16, 24, 32].includes(bitsPerSample)
    : format === WAVE_FORMAT_IEEE_FLOAT && (bitsPerSample === 32 || bitsPerSample === 64);
  if (!supported || channels < 1 || sampleRate < 1 || blockAlign < channels * bytesPerSample) {
    throw new WavDecodeError(`Unsupported WAV encoding (format ${format}, ${bitsPerSample}-bit, ${channels} channel).`);
  }

  const frames = Math.floor(dataBytes / blockAlign);
  const samples = new Float32Array(frames);
  const readSample = (position: number): number => {
    if (format === WAVE_FORMAT_IEEE_FLOAT) {
      return bitsPerSample === 32 ? view.getFloat32(position, true) : view.getFloat64(position, true);
    }
    switch (bitsPerSample) {
      case 8:
        return (view.getUint8(position) - 128) / 128;
      case 16:
        return view.getInt16(position, true) / 32768;
      case 24: {
        const value = view.getUint8(position) | (view.getUint8(position + 1) << 8) | (view.getInt8(position + 2) << 16);
        return value / 8388608;
      }
      default:
        return view.getInt32(position, true) / 2147483648;
    }
  };
  for (let frame = 0; frame < frames; frame++) {
    const frameOffset = dataOffset + frame * blockAlign;
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += readSample(frameOffset + channel * bytesPerSample);
    samples[frame] = Math.max(-1, Math.min(1, sum / channels));
  }
  return { sampleRate, channels, samples };
}

export interface SampleRange {
  start: number;
  end: number;
}

export interface SpeechChunkPlanOptions {
  sampleRate: number;
  /** Longest chunk handed to the recognizer in one call. */
  maxChunkSeconds: number;
  /** Pauses shorter than this stay inside a chunk so sentences keep their context. */
  maxGapSeconds: number;
  /** Extra audio kept around each chunk so word edges are not clipped. */
  padSeconds: number;
  /** The audio being planned. With it, speech too long for one chunk is cut where it is quietest. */
  samples?: Float32Array;
}

export const CLIP_CHUNK_PLAN: Omit<SpeechChunkPlanOptions, "sampleRate" | "samples"> = {
  maxChunkSeconds: 20,
  maxGapSeconds: 1.5,
  padSeconds: 0.25,
};

const QUIET_WINDOW_SECONDS = 0.2;
const QUIET_HOP_SECONDS = 0.01;

/** Centre of the quietest stretch between two samples: far more often a pause than a word. */
function quietestPoint(samples: Float32Array, from: number, to: number, sampleRate: number): number {
  const hop = Math.max(1, Math.round(QUIET_HOP_SECONDS * sampleRate));
  const hopsPerWindow = Math.max(1, Math.round(QUIET_WINDOW_SECONDS / QUIET_HOP_SECONDS));
  const energies: number[] = [];
  for (let offset = from; offset + hop <= to; offset += hop) {
    let energy = 0;
    for (let i = offset; i < offset + hop; i++) energy += samples[i]! * samples[i]!;
    energies.push(energy);
  }
  if (energies.length < hopsPerWindow) return Math.floor((from + to) / 2);
  let quietest = 0;
  let quietestEnergy = Infinity;
  let windowEnergy = 0;
  for (let i = 0; i < energies.length; i++) {
    windowEnergy += energies[i]!;
    if (i >= hopsPerWindow) windowEnergy -= energies[i - hopsPerWindow]!;
    if (i >= hopsPerWindow - 1 && windowEnergy < quietestEnergy) {
      quietestEnergy = windowEnergy;
      quietest = i - hopsPerWindow + 1;
    }
  }
  return from + quietest * hop + Math.floor((hopsPerWindow * hop) / 2);
}

/**
 * Cuts speech that is too long for one chunk. Steady background noise hides pauses from the speech
 * detector, which then reports half a minute or more as a single segment, and the recognizer drops
 * whole sentences from input that long. The speech is cut into the fewest pieces that fit, each cut
 * at the quietest point within half a piece of an even split.
 */
function splitLongSegment(segment: SampleRange, maxChunk: number, options: SpeechChunkPlanOptions): SampleRange[] {
  const pieces: SampleRange[] = [];
  let start = segment.start;
  while (segment.end - start > maxChunk) {
    const remainingPieces = Math.ceil((segment.end - start) / maxChunk);
    const evenPiece = Math.ceil((segment.end - start) / remainingPieces);
    const slack = Math.floor(evenPiece / 2);
    const target = start + evenPiece;
    const earliest = Math.max(target - slack, segment.end - (remainingPieces - 1) * maxChunk);
    const cut = options.samples
      ? quietestPoint(options.samples, earliest, Math.min(target + slack, start + maxChunk), options.sampleRate)
      : target;
    pieces.push({ start, end: cut });
    start = cut;
  }
  pieces.push({ start, end: segment.end });
  return pieces;
}

/** Turns detected speech segments into padded, non-overlapping recognizer chunks, none longer than the maximum. */
export function planSpeechChunks(segments: readonly SampleRange[], totalSamples: number, options: SpeechChunkPlanOptions): SampleRange[] {
  const maxChunk = Math.round(options.maxChunkSeconds * options.sampleRate);
  const maxGap = Math.round(options.maxGapSeconds * options.sampleRate);
  const pad = Math.round(options.padSeconds * options.sampleRate);
  const sorted = segments
    .map((segment) => ({ start: Math.max(0, Math.floor(segment.start)), end: Math.min(totalSamples, Math.ceil(segment.end)) }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start)
    .flatMap((segment) => segment.end - segment.start > maxChunk ? splitLongSegment(segment, maxChunk, options) : [segment]);

  const merged: SampleRange[] = [];
  for (const segment of sorted) {
    const current = merged[merged.length - 1];
    if (current && segment.start - current.end <= maxGap && Math.max(current.end, segment.end) - current.start <= maxChunk) {
      current.end = Math.max(current.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }

  return merged.map((chunk, index) => {
    const previous = merged[index - 1];
    const next = merged[index + 1];
    const lowerBound = previous ? Math.floor((previous.end + chunk.start) / 2) : 0;
    const upperBound = next ? Math.ceil((chunk.end + next.start) / 2) : totalSamples;
    const paddingRoom = maxChunk - (chunk.end - chunk.start);
    const before = Math.min(pad, chunk.start - lowerBound, Math.floor(paddingRoom / 2));
    const after = Math.min(pad, upperBound - chunk.end, paddingRoom - before);
    return {
      start: chunk.start - before,
      end: chunk.end + after,
    };
  });
}

export function joinTranscripts(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
