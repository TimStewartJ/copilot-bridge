// Whisper-style log-mel features for the Smart Turn end-of-turn model.
// Mirrors smart-turn's inference.py: keep the last 8 s of 16 kHz audio (left-padded with
// zeros), zero-mean/unit-variance normalize the window, then WhisperFeatureExtractor
// (n_fft 400, hop 160, 80 slaney mel bins, log10, clamp to max-8, (x+4)/4).

export const SMART_TURN_SAMPLE_RATE = 16_000;
export const SMART_TURN_WINDOW_SAMPLES = 8 * SMART_TURN_SAMPLE_RATE;
export const SMART_TURN_MEL_BINS = 80;
export const SMART_TURN_FRAMES = 800;

const N_FFT = 400;
const HOP = 160;
const NUM_FREQ_BINS = N_FFT / 2 + 1;

function hertzToMelSlaney(freq: number): number {
  const minLogHertz = 1000;
  const minLogMel = 15;
  const logStep = 27 / Math.log(6.4);
  return freq >= minLogHertz
    ? minLogMel + Math.log(freq / minLogHertz) * logStep
    : (3 * freq) / 200;
}

function melToHertzSlaney(mels: number): number {
  const minLogHertz = 1000;
  const minLogMel = 15;
  const logStep = Math.log(6.4) / 27;
  return mels >= minLogMel
    ? minLogHertz * Math.exp(logStep * (mels - minLogMel))
    : (200 * mels) / 3;
}

/** Slaney-normalized triangular mel filter bank, shape [melBins][freqBins]. */
export function createMelFilterBank(melBins = SMART_TURN_MEL_BINS): Float64Array[] {
  const melMin = hertzToMelSlaney(0);
  const melMax = hertzToMelSlaney(SMART_TURN_SAMPLE_RATE / 2);
  const filterFreqs = new Float64Array(melBins + 2);
  for (let i = 0; i < melBins + 2; i++) {
    filterFreqs[i] = melToHertzSlaney(melMin + ((melMax - melMin) * i) / (melBins + 1));
  }
  const fftFreqs = new Float64Array(NUM_FREQ_BINS);
  for (let i = 0; i < NUM_FREQ_BINS; i++) {
    fftFreqs[i] = ((SMART_TURN_SAMPLE_RATE / 2) * i) / (NUM_FREQ_BINS - 1);
  }
  const filters: Float64Array[] = [];
  for (let m = 0; m < melBins; m++) {
    const row = new Float64Array(NUM_FREQ_BINS);
    const lower = filterFreqs[m]!;
    const center = filterFreqs[m + 1]!;
    const upper = filterFreqs[m + 2]!;
    const enorm = 2 / (upper - lower);
    for (let k = 0; k < NUM_FREQ_BINS; k++) {
      const down = (fftFreqs[k]! - lower) / (center - lower);
      const up = (upper - fftFreqs[k]!) / (upper - center);
      row[k] = Math.max(0, Math.min(down, up)) * enorm;
    }
    filters.push(row);
  }
  return filters;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result <<= 1;
  return result;
}

/** In-place iterative radix-2 FFT over separate real/imaginary buffers. */
class Fft {
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(readonly size: number) {
    this.cosTable = new Float64Array(size / 2);
    this.sinTable = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let reversed = 0;
      for (let b = 0; b < bits; b++) reversed |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = reversed;
    }
  }

  transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverse[i]!;
      if (j > i) {
        const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
        const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
      }
    }
    const sign = inverse ? -1 : 1;
    for (let length = 2; length <= n; length <<= 1) {
      const half = length >> 1;
      const step = n / length;
      for (let start = 0; start < n; start += length) {
        for (let k = 0; k < half; k++) {
          const cos = this.cosTable[k * step]!;
          const sin = sign * this.sinTable[k * step]!;
          const a = start + k;
          const b = a + half;
          const tre = re[b]! * cos + im[b]! * sin;
          const tim = -re[b]! * sin + im[b]! * cos;
          re[b] = re[a]! - tre;
          im[b] = im[a]! - tim;
          re[a] = re[a]! + tre;
          im[a] = im[a]! + tim;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] = re[i]! / n;
        im[i] = im[i]! / n;
      }
    }
  }
}

/** Power spectrum of an exact length-400 DFT via Bluestein's algorithm (matches numpy rfft). */
class BluesteinPowerSpectrum {
  private readonly fft: Fft;
  private readonly chirpRe = new Float64Array(N_FFT);
  private readonly chirpIm = new Float64Array(N_FFT);
  private readonly kernelRe: Float64Array;
  private readonly kernelIm: Float64Array;
  private readonly workRe: Float64Array;
  private readonly workIm: Float64Array;

  constructor() {
    const size = nextPowerOfTwo(2 * N_FFT - 1);
    this.fft = new Fft(size);
    for (let n = 0; n < N_FFT; n++) {
      const angle = (-Math.PI * n * n) / N_FFT;
      this.chirpRe[n] = Math.cos(angle);
      this.chirpIm[n] = Math.sin(angle);
    }
    this.kernelRe = new Float64Array(size);
    this.kernelIm = new Float64Array(size);
    this.kernelRe[0] = this.chirpRe[0]!;
    this.kernelIm[0] = -this.chirpIm[0]!;
    for (let n = 1; n < N_FFT; n++) {
      this.kernelRe[n] = this.chirpRe[n]!;
      this.kernelIm[n] = -this.chirpIm[n]!;
      this.kernelRe[size - n] = this.chirpRe[n]!;
      this.kernelIm[size - n] = -this.chirpIm[n]!;
    }
    this.fft.transform(this.kernelRe, this.kernelIm, false);
    this.workRe = new Float64Array(size);
    this.workIm = new Float64Array(size);
  }

  compute(frame: Float64Array, out: Float64Array): void {
    const re = this.workRe;
    const im = this.workIm;
    re.fill(0);
    im.fill(0);
    for (let n = 0; n < N_FFT; n++) {
      re[n] = frame[n]! * this.chirpRe[n]!;
      im[n] = frame[n]! * this.chirpIm[n]!;
    }
    this.fft.transform(re, im, false);
    for (let i = 0; i < re.length; i++) {
      const r = re[i]! * this.kernelRe[i]! - im[i]! * this.kernelIm[i]!;
      const m = re[i]! * this.kernelIm[i]! + im[i]! * this.kernelRe[i]!;
      re[i] = r;
      im[i] = m;
    }
    this.fft.transform(re, im, true);
    for (let k = 0; k < NUM_FREQ_BINS; k++) {
      const r = re[k]! * this.chirpRe[k]! - im[k]! * this.chirpIm[k]!;
      const m = re[k]! * this.chirpIm[k]! + im[k]! * this.chirpRe[k]!;
      out[k] = r * r + m * m;
    }
  }
}

export interface SmartTurnFeatureExtractor {
  /** Returns a [1, 80, 800] Float32Array (row-major: mel bin, then frame). */
  extract(samples: Float32Array): Float32Array;
}

export function createSmartTurnFeatureExtractor(): SmartTurnFeatureExtractor {
  const melFilters = createMelFilterBank();
  const spectrum = new BluesteinPowerSpectrum();
  const window = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const padded = new Float64Array(SMART_TURN_WINDOW_SAMPLES + N_FFT);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(NUM_FREQ_BINS);
  const logMel = new Float64Array(SMART_TURN_MEL_BINS * SMART_TURN_FRAMES);

  return {
    extract(samples) {
      const n = SMART_TURN_WINDOW_SAMPLES;
      const offset = Math.max(0, samples.length - n);
      const used = samples.length - offset;
      const leadingZeros = n - used;
      let sum = 0;
      for (let i = offset; i < samples.length; i++) sum += samples[i]!;
      const mean = sum / n;
      let variance = 0;
      for (let i = 0; i < n; i++) {
        const value = (i < leadingZeros ? 0 : samples[offset + i - leadingZeros]!) - mean;
        variance += value * value;
      }
      const std = Math.sqrt(variance / n + 1e-7);

      const half = N_FFT / 2;
      for (let i = 0; i < n; i++) {
        const raw = i < leadingZeros ? 0 : samples[offset + i - leadingZeros]!;
        padded[half + i] = (raw - mean) / std;
      }
      for (let i = 1; i <= half; i++) {
        padded[half - i] = padded[half + i]!;
        padded[half + n - 1 + i] = padded[half + n - 1 - i]!;
      }

      let maxValue = -Infinity;
      for (let t = 0; t < SMART_TURN_FRAMES; t++) {
        const start = t * HOP;
        for (let i = 0; i < N_FFT; i++) frame[i] = padded[start + i]! * window[i]!;
        spectrum.compute(frame, power);
        for (let m = 0; m < SMART_TURN_MEL_BINS; m++) {
          const filter = melFilters[m]!;
          let energy = 0;
          for (let k = 0; k < NUM_FREQ_BINS; k++) energy += filter[k]! * power[k]!;
          const value = Math.log10(Math.max(energy, 1e-10));
          logMel[m * SMART_TURN_FRAMES + t] = value;
          if (value > maxValue) maxValue = value;
        }
      }

      const floor = maxValue - 8;
      const features = new Float32Array(SMART_TURN_MEL_BINS * SMART_TURN_FRAMES);
      for (let i = 0; i < features.length; i++) {
        features[i] = (Math.max(logMel[i]!, floor) + 4) / 4;
      }
      return features;
    },
  };
}
