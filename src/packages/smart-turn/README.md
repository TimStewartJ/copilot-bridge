# @timstewartj/smart-turn

Run [Smart Turn v3](https://github.com/pipecat-ai/smart-turn), Pipecat's open end-of-turn detection
model, from JavaScript.

Smart Turn listens to the last few seconds of someone speaking and judges whether they have
finished or only paused. A voice agent uses it to wait through "so I was thinking, um..." and
still answer promptly after "what's the weather tomorrow?". The model is an ONNX file, but its
reference preprocessing is Python: Whisper's feature extractor from `transformers`. This package is
that preprocessing in dependency-free TypeScript, with a small wrapper that runs the model on
whichever ONNX Runtime you already use.

This is an independent implementation. It is not affiliated with Pipecat or Daily.

```ts
import * as ort from "onnxruntime-node";
import { createSmartTurnDetector } from "@timstewartj/smart-turn";

const session = await ort.InferenceSession.create("smart-turn-v3.2-cpu.onnx");
const detector = createSmartTurnDetector({ Tensor: ort.Tensor, session });

// When your voice activity detector reports silence, pass the turn so far:
// 16 kHz mono samples in [-1, 1].
const { probability, complete } = await detector.predict(samples);
```

## Install

```sh
npm install @timstewartj/smart-turn
```

ESM only. No dependencies, and nothing from Node.js: bring `onnxruntime-node` or `onnxruntime-web`
yourself. The model files are on Hugging Face at
[pipecat-ai/smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3). Pipecat publishes them
under the BSD 2-Clause license; they are not part of this package.

## API

### `createSmartTurnDetector({ Tensor, session, threshold? })`

- `Tensor`: the `Tensor` class of the ONNX Runtime package that created the session.
- `session`: an inference session for a Smart Turn v3 model. The detector uses the session's first
  input and first output, whatever they are named.
- `threshold`: a turn counts as complete above this probability. Default `0.5`, as in Smart Turn's
  own inference code.

`detector.predict(samples)` resolves with `{ probability, complete }`. It rejects if the model
returns no number, so a broken session cannot pass for "not finished".

### `createSmartTurnFeatureExtractor()`

For running the model yourself. `extractor.extract(samples)` returns a `Float32Array` of 80 x 800
values, the model's input as a tensor of shape `[1, 80, 800]`. It does what Smart Turn's
`inference.py` does:

1. Keep the last 8 seconds; pad shorter audio with silence at the start.
2. Normalize the window to zero mean and unit variance.
3. Compute Whisper's log-mel spectrogram: 400-sample Hann window, hop of 160, 80 mel bands on the
   Slaney scale, `log10`, clamped to 8 below the maximum, then `(x + 4) / 4`.

The constants `SMART_TURN_SAMPLE_RATE` (16000), `SMART_TURN_WINDOW_SECONDS` (8),
`SMART_TURN_MEL_BINS` (80) and `SMART_TURN_FRAMES` (800) are exported, and so is
`createMelFilterBank()`.

## Using it in a voice loop

- Feed it 16 kHz mono audio, which is what the model expects. Resample anything else first.
- Ask when your voice activity detector reports that speech stopped, and pass the audio of the
  current turn up to that point.
- If the turn is not complete, keep listening. A common pattern is to ask again as the silence
  grows, with a time limit after which you answer anyway: the model gives a judgement, not a
  guarantee.

## How closely it matches the reference

The features were compared with `WhisperFeatureExtractor` from `@huggingface/transformers` 4.3.0,
fed audio prepared as in step 1 and 2 above. Over six inputs (tones, noise at several lengths and
levels, and a recorded sentence; 384,000 values) the largest difference was 4.7e-6. The unit tests
pin sampled values and the mean of every mel band from that reference.

End to end, with `onnxruntime-node` 1.30 and `smart-turn-v3.2-cpu.onnx`, a recorded 3.9 second
English sentence scored 0.96 when whole and 0.01 when cut off at 60 percent.

## Performance

On a Core i7-12700K, `extract` takes about 35 ms on a performance core and 70 ms or more on an
efficiency core. A whole `predict` with the 8 MB CPU model took 70 to 100 ms. Most of `extract` is
an exact 400-point Fourier transform per frame, done with Bluestein's algorithm; a mixed-radix
transform would be faster and is not implemented.

## Limits

- The Node.js path is tested with `onnxruntime-node`. The package compiles against
  `onnxruntime-web`'s types and uses no Node.js API, but it has not been run in a browser.
- Only the 8 second, 80 band input of Smart Turn v3 is supported.

## License

MIT
