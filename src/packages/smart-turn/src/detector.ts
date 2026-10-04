// Runs a Smart Turn v3 ONNX model on features from ./features.ts. ONNX Runtime is passed in, so
// this package depends on neither onnxruntime-node nor onnxruntime-web and works with both.

import { createSmartTurnFeatureExtractor, SMART_TURN_FRAMES, SMART_TURN_MEL_BINS } from "./features.js";

/** The part of an ONNX Runtime inference session the detector uses. */
export interface SmartTurnSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { readonly data: ArrayLike<unknown> }>>;
}

/** ONNX Runtime's tensor class: pass `ort.Tensor`. */
export type SmartTurnTensorConstructor = new (type: "float32", data: Float32Array, dims: number[]) => unknown;

export interface SmartTurnDetectorOptions {
  /** `Tensor` from the ONNX Runtime package that created `session`. */
  Tensor: SmartTurnTensorConstructor;
  /** An inference session for a Smart Turn v3 ONNX model. */
  session: SmartTurnSession;
  /** A turn counts as complete above this probability. Default 0.5, as in Smart Turn's own inference code. */
  threshold?: number;
}

export interface SmartTurnPrediction {
  /** The model's probability, 0 to 1, that the speaker has finished their turn. */
  probability: number;
  /** Whether `probability` is above the threshold. */
  complete: boolean;
}

export interface SmartTurnDetector {
  /**
   * Judges whether the speaker has finished. Pass the turn so far as 16 kHz mono samples in
   * [-1, 1], ending where the speaker went quiet. The last 8 seconds are used.
   */
  predict(samples: Float32Array): Promise<SmartTurnPrediction>;
}

export const SMART_TURN_DEFAULT_THRESHOLD = 0.5;

export function createSmartTurnDetector(options: SmartTurnDetectorOptions): SmartTurnDetector {
  const { Tensor, session } = options;
  const threshold = options.threshold ?? SMART_TURN_DEFAULT_THRESHOLD;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (inputName === undefined || outputName === undefined) {
    throw new Error("The Smart Turn session must have one input and one output.");
  }
  const extractor = createSmartTurnFeatureExtractor();

  return {
    async predict(samples) {
      const features = extractor.extract(samples);
      const outputs = await session.run({
        [inputName]: new Tensor("float32", features, [1, SMART_TURN_MEL_BINS, SMART_TURN_FRAMES]),
      });
      const probability = Number(outputs[outputName]?.data[0]);
      if (!Number.isFinite(probability)) throw new Error("The Smart Turn model returned no probability.");
      return { probability, complete: probability > threshold };
    },
  };
}
