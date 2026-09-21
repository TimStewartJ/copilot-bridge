// Audio helpers for chat mic recordings: downsample to the speech engine's 16 kHz while
// recording so uploads are a third of the size, then package the result as a WAV file.

/** Sample rate the local speech engine transcribes at; anything higher is wasted upload. */
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;

interface BiquadStage {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

function createLowPassStage(cutoffHz: number, sampleRate: number): BiquadStage {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

/**
 * Streaming downsampler: a 4th-order Butterworth low-pass (two biquads) against aliasing,
 * then linear interpolation. Matches the voice mode capture worklet so both features feed
 * the recognizer the same kind of audio. Never upsamples.
 */
export class SpeechResampler {
  readonly outputRate: number;
  private readonly ratio: number;
  private readonly stages: BiquadStage[];
  private t = 1;
  private previous = 0;

  constructor(readonly inputRate: number, targetRate = TRANSCRIPTION_SAMPLE_RATE) {
    this.outputRate = inputRate > targetRate ? targetRate : inputRate;
    this.ratio = inputRate / this.outputRate;
    this.stages = this.ratio > 1.05
      ? [0, 1].map(() => createLowPassStage(Math.min(targetRate * 0.4375, inputRate * 0.45), inputRate))
      : [];
  }

  /** Resamples one chunk; state carries across calls so chunked input matches one-shot input. */
  push(input: Float32Array): Float32Array<ArrayBuffer> {
    if (this.ratio === 1) return input.slice();
    const output = new Float32Array(Math.ceil(input.length / this.ratio) + 2);
    let count = 0;
    for (let i = 0; i < input.length; i++) {
      let y = input[i]!;
      for (const stage of this.stages) {
        const filtered = stage.b0 * y + stage.b1 * stage.x1 + stage.b2 * stage.x2 - stage.a1 * stage.y1 - stage.a2 * stage.y2;
        stage.x2 = stage.x1;
        stage.x1 = y;
        stage.y2 = stage.y1;
        stage.y1 = filtered;
        y = filtered;
      }
      while (this.t <= 1) {
        output[count++] = this.previous + (y - this.previous) * this.t;
        this.t += this.ratio;
      }
      this.t -= 1;
      this.previous = y;
    }
    return output.slice(0, count);
  }
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

/** Packages mono float chunks as a 16-bit PCM WAV. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  if (!sampleRate || chunks.length === 0) {
    throw new Error("No audio captured.");
  }

  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (sampleCount === 0) {
    throw new Error("No audio captured.");
  }

  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i]!));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}
