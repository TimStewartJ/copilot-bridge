// Runs in a scratch project that has only the packed tarballs installed (npm run packages:verify).
// It proves the published build resolves by name and produces model input without Node's modules.
import assert from "node:assert/strict";
import {
  createSmartTurnDetector,
  createSmartTurnFeatureExtractor,
  SMART_TURN_FRAMES,
  SMART_TURN_MEL_BINS,
} from "smart-turn-js";

const samples = new Float32Array(16_000 * 3);
for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16_000);

const features = createSmartTurnFeatureExtractor().extract(samples);
assert.equal(features.length, SMART_TURN_MEL_BINS * SMART_TURN_FRAMES);
assert.ok(features.every(Number.isFinite));

class Tensor {
  constructor(type, data, dims) {
    Object.assign(this, { type, data, dims });
  }
}
const fed = [];
const session = {
  inputNames: ["input_features"],
  outputNames: ["logits"],
  run: async (feeds) => {
    fed.push(feeds);
    return { logits: { data: new Float32Array([0.75]) } };
  },
};
const prediction = await createSmartTurnDetector({ Tensor, session }).predict(samples);
assert.deepEqual(prediction, { probability: 0.75, complete: true });
assert.deepEqual(fed[0].input_features.dims, [1, 80, 800]);
assert.deepEqual([...fed[0].input_features.data.slice(0, 8)], [...features.slice(0, 8)]);
console.log("smart-turn-js smoke passed: features and a prediction from an installed build");
