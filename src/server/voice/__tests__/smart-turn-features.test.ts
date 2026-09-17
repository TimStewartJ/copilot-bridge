import { describe, expect, it } from "vitest";
import { createMelFilterBank, createSmartTurnFeatureExtractor, SMART_TURN_FRAMES } from "../smart-turn-features.js";

function deterministicSignal(): Float32Array {
  const signal = new Float32Array(40_000);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < signal.length; i++) {
    const t = i / 16000;
    signal[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * (300 + 900 * t) * t) + 0.05 * rand();
  }
  return signal;
}

describe("Smart Turn features", () => {
  it("matches the transformers WhisperFeatureExtractor reference", () => {
    const features = createSmartTurnFeatureExtractor().extract(deterministicSignal());
    expect(features.length).toBe(80 * SMART_TURN_FRAMES);

    let sum = 0;
    let sumSquares = 0;
    for (const value of features) {
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / features.length;
    const std = Math.sqrt(sumSquares / features.length - mean * mean);
    // Reference values from @huggingface/transformers 4.3.0 on the same input.
    expect(mean).toBeCloseTo(0.040216511713340876, 3);
    expect(std).toBeCloseTo(0.48850857682212173, 3);
    const reference: Array<[number, number, number]> = [
      [0, 0, -0.1311277151107788],
      [0, 799, 0.863357663154602],
      [10, 700, 0.6124283075332642],
      [40, 650, 0.7671031951904297],
      [79, 799, 0.6626700162887573],
      [5, 560, 1.7249109745025635],
      [60, 600, 0.60045325756073],
      [20, 0, -0.2729182243347168],
    ];
    for (const [mel, frame, expected] of reference) {
      expect(features[mel * SMART_TURN_FRAMES + frame]).toBeCloseTo(expected, 3);
    }
  });

  it("builds slaney-normalized filters", () => {
    const filters = createMelFilterBank();
    expect(filters).toHaveLength(80);
    expect(filters[0]).toHaveLength(201);
    expect(Math.max(...filters[0]!)).toBeGreaterThan(0);
  });

  it("handles audio longer than the 8 second window", () => {
    const extractor = createSmartTurnFeatureExtractor();
    const long = new Float32Array(16000 * 10);
    long.set(deterministicSignal(), long.length - 40_000);
    const short = extractor.extract(deterministicSignal());
    const truncated = extractor.extract(long);
    expect(truncated[40 * SMART_TURN_FRAMES + 650]).toBeCloseTo(short[40 * SMART_TURN_FRAMES + 650]!, 5);
  });
});
