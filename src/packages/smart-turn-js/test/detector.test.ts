import { describe, expect, it } from "vitest";
import {
  createSmartTurnDetector,
  createSmartTurnFeatureExtractor,
  SMART_TURN_FRAMES,
  SMART_TURN_MEL_BINS,
  type SmartTurnSession,
} from "../src/index.js";
import { deterministicSignal } from "./signal.js";

class FakeTensor {
  constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {}
}

function fakeSession(output: ArrayLike<unknown>, names = { input: "input_features", output: "logits" }) {
  const feeds: Array<Record<string, unknown>> = [];
  const session: SmartTurnSession = {
    inputNames: [names.input],
    outputNames: [names.output],
    run: async (feed) => {
      feeds.push(feed);
      return { [names.output]: { data: output } };
    },
  };
  return { session, feeds };
}

describe("Smart Turn detector", () => {
  it("feeds the model one [1, 80, 800] float tensor under the session's own input name", async () => {
    const { session, feeds } = fakeSession(new Float32Array([0.9]), { input: "audio_features", output: "probability" });
    const detector = createSmartTurnDetector({ Tensor: FakeTensor, session });

    await detector.predict(deterministicSignal());

    expect(Object.keys(feeds[0]!)).toEqual(["audio_features"]);
    const tensor = feeds[0]!.audio_features as FakeTensor;
    expect(tensor.type).toBe("float32");
    expect(tensor.dims).toEqual([1, SMART_TURN_MEL_BINS, SMART_TURN_FRAMES]);
    expect([...tensor.data]).toEqual([...createSmartTurnFeatureExtractor().extract(deterministicSignal())]);
  });

  it("calls a turn complete only above the threshold", async () => {
    const predict = async (probability: number, threshold?: number) =>
      createSmartTurnDetector({ Tensor: FakeTensor, session: fakeSession(new Float32Array([probability])).session, threshold })
        .predict(new Float32Array(16_000));

    expect(await predict(0.75)).toEqual({ probability: 0.75, complete: true });
    expect(await predict(0.25)).toEqual({ probability: 0.25, complete: false });
    expect(await predict(0.5)).toEqual({ probability: 0.5, complete: false });
    expect(await predict(0.75, 0.875)).toEqual({ probability: 0.75, complete: false });
  });

  it("fails instead of guessing when the model returns no probability", async () => {
    const empty = createSmartTurnDetector({ Tensor: FakeTensor, session: fakeSession(new Float32Array(0)).session });
    await expect(empty.predict(new Float32Array(16_000))).rejects.toThrow("returned no probability");

    const unusable = createSmartTurnDetector({ Tensor: FakeTensor, session: fakeSession([Number.NaN]).session });
    await expect(unusable.predict(new Float32Array(16_000))).rejects.toThrow("returned no probability");
  });

  it("refuses a session that has no input or output", () => {
    const { session } = fakeSession(new Float32Array([0.5]));
    expect(() => createSmartTurnDetector({ Tensor: FakeTensor, session: { ...session, inputNames: [] } }))
      .toThrow("one input and one output");
  });
});
