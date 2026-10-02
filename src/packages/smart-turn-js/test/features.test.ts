import { describe, expect, it } from "vitest";
import {
  createMelFilterBank,
  createSmartTurnFeatureExtractor,
  SMART_TURN_FRAMES,
  SMART_TURN_MEL_BINS,
} from "../src/index.js";
import { deterministicSignal } from "./signal.js";

// Reference values: WhisperFeatureExtractor from @huggingface/transformers 4.3.0 on
// deterministicSignal(), prepared the way Smart Turn's inference.py prepares audio (the last
// 8 seconds, padded with silence at the start, zero mean and unit variance over the window).
const REFERENCE_MEAN = 0.040216511713340876;
const REFERENCE_STD = 0.48850857682212173;
const REFERENCE_POINTS: Array<[mel: number, frame: number, value: number]> = [
  [0, 0, -0.1311277151107788],
  [0, 799, 0.863357663154602],
  [10, 700, 0.6124283075332642],
  [40, 650, 0.7671031951904297],
  [79, 799, 0.6626700162887573],
  [5, 560, 1.7249109745025635],
  [60, 600, 0.60045325756073],
  [20, 0, -0.2729182243347168],
];
/** The mean over all 800 frames of each of the 80 mel bands. */
const REFERENCE_BAND_MEANS = [
  0.10286, 0.042069, 0.108306, 0.234551, 0.340069, 0.352454, 0.329096, 0.225738, 0.10552, 0.050251,
  0.028546, 0.023685, 0.018132, 0.008022, 0.006823, 0.004049, 0.002735, 0.008334, 0.013977, 0.017321,
  0.017318, 0.019575, 0.019799, 0.020074, 0.016473, 0.012019, 0.013303, 0.015103, 0.013157, 0.015378,
  0.019684, 0.019587, 0.016027, 0.022687, 0.016428, 0.010204, 0.015421, 0.013036, 0.02035, 0.015433,
  0.027652, 0.027685, 0.019796, 0.014798, 0.016106, 0.01977, 0.025334, 0.025925, 0.018368, 0.017098,
  0.024958, 0.027304, 0.024704, 0.022017, 0.02831, 0.026852, 0.025686, 0.027008, 0.033443, 0.030755,
  0.030582, 0.033134, 0.033998, 0.032752, 0.032993, 0.030897, 0.030236, 0.02, 0.013262, 0.012825,
  0.007907, 0.006991, 0.011616, 0.012201, 0.010995, 0.011208, 0.013246, 0.012373, 0.011014, 0.011928,
];

describe("Smart Turn features", () => {
  it("matches the transformers WhisperFeatureExtractor reference", () => {
    const features = createSmartTurnFeatureExtractor().extract(deterministicSignal());
    expect(features.length).toBe(SMART_TURN_MEL_BINS * SMART_TURN_FRAMES);

    let sum = 0;
    let sumSquares = 0;
    for (const value of features) {
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / features.length;
    const std = Math.sqrt(sumSquares / features.length - mean * mean);
    expect(mean).toBeCloseTo(REFERENCE_MEAN, 4);
    expect(std).toBeCloseTo(REFERENCE_STD, 4);
    for (const [mel, frame, expected] of REFERENCE_POINTS) {
      expect(features[mel * SMART_TURN_FRAMES + frame], `mel ${mel}, frame ${frame}`).toBeCloseTo(expected, 4);
    }
  });

  it("matches the reference in every mel band", () => {
    const features = createSmartTurnFeatureExtractor().extract(deterministicSignal());
    expect(REFERENCE_BAND_MEANS).toHaveLength(SMART_TURN_MEL_BINS);
    for (let mel = 0; mel < SMART_TURN_MEL_BINS; mel++) {
      let sum = 0;
      for (let frame = 0; frame < SMART_TURN_FRAMES; frame++) sum += features[mel * SMART_TURN_FRAMES + frame]!;
      expect(sum / SMART_TURN_FRAMES, `mel ${mel}`).toBeCloseTo(REFERENCE_BAND_MEANS[mel]!, 4);
    }
  });

  it("builds slaney-normalized filters", () => {
    const filters = createMelFilterBank();
    expect(filters).toHaveLength(80);
    expect(filters[0]).toHaveLength(201);
    expect(Math.max(...filters[0]!)).toBeGreaterThan(0);
  });

  it("uses only the last 8 seconds of longer audio", () => {
    const extractor = createSmartTurnFeatureExtractor();
    const long = new Float32Array(16000 * 10);
    long.set(deterministicSignal(), long.length - 40_000);
    const short = extractor.extract(deterministicSignal());
    const truncated = extractor.extract(long);
    expect(truncated[40 * SMART_TURN_FRAMES + 650]).toBeCloseTo(short[40 * SMART_TURN_FRAMES + 650]!, 5);
  });

  it("returns a new array from every call and accepts silence", () => {
    const extractor = createSmartTurnFeatureExtractor();
    const first = extractor.extract(deterministicSignal());
    const copy = Float32Array.from(first);
    const silence = extractor.extract(new Float32Array(16_000));
    expect(silence).not.toBe(first);
    expect([...first]).toEqual([...copy]);
    expect(silence.every(Number.isFinite)).toBe(true);
  });
});
