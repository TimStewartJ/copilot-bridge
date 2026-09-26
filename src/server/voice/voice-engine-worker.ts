// Speech engine child process. Loads the runtime-installed native speech packages
// (sherpa-onnx, onnxruntime) so a native crash or heavy CPU work never takes down Bridge.
// Model groups load on demand: the chat mic only needs speech recognition, voice mode needs all three.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { preferHighPerformanceScheduling } from "../platform.js";
import {
  floatToInt16,
  int16ToFloat,
  type VoiceClipChunk,
  type VoiceClipTranscription,
  type VoiceEngineCapability,
  type VoiceEngineInitOptions,
  type VoiceEngineLoadResult,
  type VoiceEngineReadyInfo,
  type VoiceEngineRequest,
  type VoiceEngineResponse,
} from "./voice-engine-protocol.js";
import { CLIP_CHUNK_PLAN, joinTranscripts, planSpeechChunks, type SampleRange } from "./voice-clip.js";
import { decodeRecording } from "./voice-recording.js";
import { VOICE_MODEL_FILES } from "./voice-catalog.js";
import { createSmartTurnFeatureExtractor, SMART_TURN_FRAMES, SMART_TURN_MEL_BINS } from "./smart-turn-features.js";

const SAMPLE_RATE = 16_000;
const VAD_WINDOW = 512;
/** A clip scan yields after this many windows: about two seconds of audio, a few milliseconds of work. */
const VAD_YIELD_WINDOWS = 64;
/** Clips this short are still decoded when the detector hears no speech, in case it missed quiet talking. */
const CLIP_FALLBACK_MAX_SAMPLES = 30 * SAMPLE_RATE;

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
  reset(): void;
}

interface SherpaOfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaRecognizer {
  createStream(): SherpaOfflineStream;
  decodeAsync(stream: SherpaOfflineStream): Promise<void>;
  getResult(stream: SherpaOfflineStream): { text: string };
}

interface SherpaTts {
  sampleRate: number;
  generateAsync(request: Record<string, unknown>): Promise<{ samples: Float32Array; sampleRate: number }>;
}

interface SherpaModule {
  version?: string;
  onnxruntimeVersion?: string;
  Vad: new (config: Record<string, unknown>, bufferSeconds: number) => SherpaVad;
  LinearResampler: new (inputSampleRate: number, outputSampleRate: number) => { flush(samples: Float32Array): Float32Array };
  OfflineRecognizer: { createAsync(config: Record<string, unknown>): Promise<SherpaRecognizer> };
  OfflineTts: { createAsync(config: Record<string, unknown>): Promise<SherpaTts> };
}

interface OrtTensor {
  data: ArrayLike<number>;
}

interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}

interface OrtModule {
  InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

interface StreamState {
  vad: SherpaVad;
  ring: Float32Array;
  total: number;
  frame: Float32Array;
  frameFill: number;
  speech: boolean;
}

type AsrPriority = "live" | "clip";

interface AsrJob {
  samples: Float32Array;
  resolve(text: string): void;
  reject(error: unknown): void;
}

function send(message: VoiceEngineResponse): void {
  process.send?.(message);
}

function log(level: "info" | "warn" | "error", message: string): void {
  send({ type: "log", level, message });
}

let options: VoiceEngineInitOptions | undefined;
let sherpa: SherpaModule | undefined;
let ort: OrtModule | undefined;
let turnSession: OrtSession | undefined;
let recognizer: SherpaRecognizer | undefined;
let tts: SherpaTts | undefined;
const featureExtractor = createSmartTurnFeatureExtractor();
const streams = new Map<string, StreamState>();
const cancelledSynthesis = new Set<number>();
const loading = new Map<VoiceEngineCapability, Promise<number>>();
const asrQueues: Record<AsrPriority, AsrJob[]> = { live: [], clip: [] };
let asrRunning = false;
let ttsChain: Promise<unknown> = Promise.resolve();

function modelPath(...segments: string[]): string {
  return join(options!.modelsDir, ...segments);
}

function runtime(): { sherpa: SherpaModule; ort: OrtModule } {
  if (!sherpa || !ort || !options) throw new Error("Speech engine is not initialized");
  return { sherpa, ort };
}

function createVad(overrides: { minSilenceDuration?: number; maxSpeechDuration?: number } = {}): SherpaVad {
  return new (runtime().sherpa.Vad)({
    sileroVad: {
      model: modelPath(VOICE_MODEL_FILES.vad),
      threshold: 0.5,
      minSilenceDuration: overrides.minSilenceDuration ?? 0.2,
      minSpeechDuration: 0.1,
      windowSize: VAD_WINDOW,
      maxSpeechDuration: overrides.maxSpeechDuration ?? 30,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: "cpu",
    debug: false,
  }, 60);
}

async function init(initOptions: VoiceEngineInitOptions): Promise<VoiceEngineReadyInfo> {
  const started = performance.now();
  options = initOptions;
  const scheduling = await preferHighPerformanceScheduling();
  const requireFromEngine = createRequire(join(initOptions.engineDir, "package.json"));
  // Both packages bundle an onnxruntime shared library under the same name. Windows reuses
  // whichever is loaded first, and onnxruntime-node's binding cannot bind to sherpa's
  // older copy, so onnxruntime-node must be required first even when Smart Turn is not needed yet.
  ort = requireFromEngine("onnxruntime-node") as OrtModule;
  sherpa = requireFromEngine("sherpa-onnx-node") as SherpaModule;
  return {
    runtimeMs: Math.round(performance.now() - started),
    sherpaVersion: sherpa.version,
    onnxruntimeVersion: sherpa.onnxruntimeVersion,
    scheduling: scheduling.detail,
  };
}

function isLoaded(capability: VoiceEngineCapability): boolean {
  return capability === "asr" ? !!recognizer : capability === "turn" ? !!turnSession : !!tts;
}

function loadedCapabilities(): VoiceEngineCapability[] {
  return (["asr", "turn", "tts"] as const).filter(isLoaded);
}

/** Loads one model group and warms it up; resolves with the warmup time. */
async function loadCapability(capability: VoiceEngineCapability): Promise<number> {
  const { sherpa: sherpaModule, ort: ortModule } = runtime();
  const settings = options!;
  switch (capability) {
    case "turn": {
      const session = await ortModule.InferenceSession.create(modelPath(VOICE_MODEL_FILES.smartTurn), {
        executionMode: "sequential",
        interOpNumThreads: 1,
        intraOpNumThreads: settings.turnThreads,
        graphOptimizationLevel: "all",
      });
      const warmupStarted = performance.now();
      turnSession = session;
      await predict(new Float32Array(SAMPLE_RATE));
      return performance.now() - warmupStarted;
    }
    case "asr": {
      const asrDir = VOICE_MODEL_FILES.asrDir;
      const created = await sherpaModule.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: modelPath(asrDir, "encoder.int8.onnx"),
            decoder: modelPath(asrDir, "decoder.int8.onnx"),
            joiner: modelPath(asrDir, "joiner.int8.onnx"),
          },
          tokens: modelPath(asrDir, "tokens.txt"),
          numThreads: settings.asrThreads,
          provider: "cpu",
          debug: 0,
          modelType: "nemo_transducer",
        },
      });
      const warmupStarted = performance.now();
      await decodeNow(created, new Float32Array(SAMPLE_RATE));
      recognizer = created;
      return performance.now() - warmupStarted;
    }
    case "tts": {
      const ttsDir = VOICE_MODEL_FILES.ttsDir;
      const created = await sherpaModule.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: modelPath(ttsDir, "model.onnx"),
            voices: modelPath(ttsDir, "voices.bin"),
            tokens: modelPath(ttsDir, "tokens.txt"),
            dataDir: modelPath(ttsDir, "espeak-ng-data"),
            lexicon: modelPath(ttsDir, "lexicon-us-en.txt"),
            lang: "en-us",
          },
          numThreads: settings.ttsThreads,
          provider: "cpu",
          debug: false,
        },
        maxNumSentences: 1,
      });
      const warmupStarted = performance.now();
      await created.generateAsync({ text: "Ready.", sid: 3, speed: 1 });
      tts = created;
      return performance.now() - warmupStarted;
    }
  }
}

async function load(capabilities: readonly VoiceEngineCapability[]): Promise<VoiceEngineLoadResult> {
  runtime();
  const started = performance.now();
  const warmups = await Promise.all([...new Set(capabilities)].map((capability) => {
    if (isLoaded(capability)) return 0;
    let pending = loading.get(capability);
    if (!pending) {
      pending = loadCapability(capability).finally(() => loading.delete(capability));
      loading.set(capability, pending);
    }
    return pending;
  }));
  return {
    loaded: loadedCapabilities(),
    loadMs: Math.round(performance.now() - started),
    warmupMs: Math.round(warmups.reduce((sum, value) => sum + value, 0)),
  };
}

function requireCapability(capability: VoiceEngineCapability): void {
  if (!isLoaded(capability)) throw new Error(`Speech engine models for "${capability}" are not loaded`);
}

function openStream(streamId: string): void {
  runtime();
  streams.get(streamId)?.vad.reset();
  streams.set(streamId, {
    vad: createVad(),
    ring: new Float32Array(Math.round((options?.audioRetentionSeconds ?? 90) * SAMPLE_RATE)),
    total: 0,
    frame: new Float32Array(VAD_WINDOW),
    frameFill: 0,
    speech: false,
  });
}

function pushAudio(streamId: string, pcm: Int16Array): void {
  const stream = streams.get(streamId);
  if (!stream) return;
  const samples = int16ToFloat(pcm);
  const ringSize = stream.ring.length;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]!;
    stream.ring[(stream.total + i) % ringSize] = value;
    stream.frame[stream.frameFill++] = value;
    if (stream.frameFill === VAD_WINDOW) {
      stream.vad.acceptWaveform(stream.frame);
      stream.frameFill = 0;
      const speech = stream.vad.isDetected();
      while (!stream.vad.isEmpty()) stream.vad.pop();
      if (speech !== stream.speech) {
        stream.speech = speech;
        send({ type: "vad", streamId, speech, sampleIndex: stream.total + i + 1 });
      }
    }
  }
  stream.total += samples.length;
}

function extract(streamId: string, fromSample: number, toSample: number): Float32Array {
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Unknown audio stream ${streamId}`);
  const ringSize = stream.ring.length;
  const end = Math.min(Math.max(0, Math.floor(toSample)), stream.total);
  const start = Math.max(Math.max(0, Math.floor(fromSample)), end - ringSize, 0);
  const length = Math.max(0, end - start);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) output[i] = stream.ring[(start + i) % ringSize]!;
  return output;
}

async function predict(samples: Float32Array): Promise<number> {
  requireCapability("turn");
  const features = featureExtractor.extract(samples);
  const tensor = new ort!.Tensor("float32", features, [1, SMART_TURN_MEL_BINS, SMART_TURN_FRAMES]);
  const output = await turnSession!.run({ [turnSession!.inputNames[0]!]: tensor });
  return Number(output[turnSession!.outputNames[0]!]!.data[0]);
}

async function decodeNow(target: SherpaRecognizer, samples: Float32Array): Promise<string> {
  const stream = target.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  await target.decodeAsync(stream);
  return target.getResult(stream).text.trim();
}

/** One recognizer call at a time; live conversation turns go ahead of queued clip chunks. */
function decode(samples: Float32Array, priority: AsrPriority): Promise<string> {
  requireCapability("asr");
  return new Promise<string>((resolve, reject) => {
    asrQueues[priority].push({ samples, resolve, reject });
    void pumpAsr();
  });
}

async function pumpAsr(): Promise<void> {
  if (asrRunning) return;
  asrRunning = true;
  try {
    for (let job = asrQueues.live.shift() ?? asrQueues.clip.shift(); job; job = asrQueues.live.shift() ?? asrQueues.clip.shift()) {
      try {
        job.resolve(await decodeNow(recognizer!, job.samples));
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    asrRunning = false;
  }
}

/**
 * Transcribes speech of any length. The recognizer drops whole sentences from input much longer
 * than a chunk, so it only ever sees chunk-sized pieces, however long the speech ran without a pause.
 */
async function decodeSpeech(
  samples: Float32Array,
  speech: readonly SampleRange[],
  priority: AsrPriority,
): Promise<{ text: string; chunks: number; chunkDetails: VoiceClipChunk[] }> {
  const chunks = planSpeechChunks(speech, samples.length, { sampleRate: SAMPLE_RATE, ...CLIP_CHUNK_PLAN, samples });
  const parts: string[] = [];
  const chunkDetails: VoiceClipChunk[] = [];
  for (const chunk of chunks) {
    const part = await decode(samples.slice(chunk.start, chunk.end), priority);
    parts.push(part);
    chunkDetails.push({
      startSeconds: Math.round((chunk.start / SAMPLE_RATE) * 100) / 100,
      endSeconds: Math.round((chunk.end / SAMPLE_RATE) * 100) / 100,
      words: part.split(/\s+/).filter(Boolean).length,
    });
  }
  return { text: joinTranscripts(parts), chunks: chunks.length, chunkDetails };
}

async function detectSpeech(samples: Float32Array): Promise<SampleRange[]> {
  const vad = createVad({ minSilenceDuration: 0.3, maxSpeechDuration: CLIP_CHUNK_PLAN.maxChunkSeconds });
  const segments: SampleRange[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      segments.push({ start: segment.start, end: segment.start + segment.samples.length });
      vad.pop();
    }
  };
  const window = new Float32Array(VAD_WINDOW);
  for (let offset = 0, scanned = 1; offset < samples.length; offset += VAD_WINDOW, scanned++) {
    const part = samples.subarray(offset, Math.min(offset + VAD_WINDOW, samples.length));
    window.fill(0);
    window.set(part);
    vad.acceptWaveform(window);
    drain();
    // A long clip is thousands of windows; live conversation audio must not wait behind them all.
    if (scanned % VAD_YIELD_WINDOWS === 0) await yieldToEventLoop();
  }
  vad.flush();
  drain();
  return segments;
}

async function transcribeFile(filePath: string): Promise<VoiceClipTranscription> {
  requireCapability("asr");
  const started = performance.now();
  const file = await readFile(filePath);
  const recording = await decodeRecording(file, SAMPLE_RATE);
  const samples = recording.sampleRate === SAMPLE_RATE
    ? recording.samples
    : new (runtime().sherpa.LinearResampler)(recording.sampleRate, SAMPLE_RATE).flush(recording.samples);
  const segments = await detectSpeech(samples);
  let speech = await decodeSpeech(samples, segments, "clip");
  if (speech.chunks === 0 && samples.length >= SAMPLE_RATE / 10 && samples.length <= CLIP_FALLBACK_MAX_SAMPLES) {
    speech = await decodeSpeech(samples, [{ start: 0, end: samples.length }], "clip");
  }
  return {
    text: speech.text,
    audioSeconds: Math.round((samples.length / SAMPLE_RATE) * 100) / 100,
    speechSeconds: Math.round((segments.reduce((sum, segment) => sum + segment.end - segment.start, 0) / SAMPLE_RATE) * 100) / 100,
    chunks: speech.chunks,
    chunkDetails: speech.chunkDetails,
    ms: Math.round(performance.now() - started),
    format: recording.format,
    bytes: file.length,
  };
}

function synthesize(id: number, text: string, sid: number, speed: number, lang: string): Promise<{ firstChunkMs: number; totalMs: number }> {
  requireCapability("tts");
  const job = ttsChain.then(async () => {
    const started = performance.now();
    let firstChunkMs: number | undefined;
    if (cancelledSynthesis.delete(id)) return { firstChunkMs: 0, totalMs: 0 };
    let streamed = false;
    const audio = await tts!.generateAsync({
      text,
      sid,
      speed,
      generationConfig: { sid, speed, extra: { lang } },
      onProgress: ({ samples }: { samples: Float32Array }) => {
        if (cancelledSynthesis.has(id)) return false;
        if (samples?.length) {
          firstChunkMs ??= performance.now() - started;
          streamed = true;
          send({ type: "tts_chunk", id, pcm: floatToInt16(samples), sampleRate: tts!.sampleRate });
        }
        return true;
      },
    });
    if (!streamed && audio.samples.length > 0 && !cancelledSynthesis.has(id)) {
      firstChunkMs = performance.now() - started;
      send({ type: "tts_chunk", id, pcm: floatToInt16(audio.samples), sampleRate: audio.sampleRate });
    }
    cancelledSynthesis.delete(id);
    return { firstChunkMs: Math.round(firstChunkMs ?? 0), totalMs: Math.round(performance.now() - started) };
  });
  ttsChain = job.catch(() => undefined);
  return job;
}

async function handle(message: VoiceEngineRequest): Promise<void> {
  switch (message.type) {
    case "audio":
      pushAudio(message.streamId, message.pcm);
      return;
    case "close_stream":
      streams.delete(message.streamId);
      return;
    case "cancel_synthesis":
      cancelledSynthesis.add(message.id);
      return;
    default:
      break;
  }
  const id = message.id;
  try {
    let value: unknown;
    switch (message.type) {
      case "init":
        value = await init(message.options);
        break;
      case "load":
        value = await load(message.capabilities);
        break;
      case "open_stream":
        openStream(message.streamId);
        value = true;
        break;
      case "predict_turn": {
        const started = performance.now();
        const probability = await predict(extract(message.streamId, message.fromSample, message.toSample));
        value = { probability, ms: performance.now() - started };
        break;
      }
      case "transcribe": {
        const started = performance.now();
        const samples = extract(message.streamId, message.fromSample, message.toSample);
        const text = samples.length >= SAMPLE_RATE / 10
          ? (await decodeSpeech(samples, [{ start: 0, end: samples.length }], "live")).text
          : "";
        value = { text, ms: performance.now() - started };
        break;
      }
      case "transcribe_file":
        value = await transcribeFile(message.filePath);
        break;
      case "synthesize":
        value = await synthesize(message.id, message.text, message.sid, message.speed, message.lang);
        break;
    }
    send({ type: "result", id, ok: true, value });
  } catch (error) {
    send({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

process.on("message", (message: VoiceEngineRequest) => {
  void handle(message).catch((error) => log("error", `Unhandled engine error: ${String(error)}`));
});

// Exit with the parent: when Bridge stops or crashes the IPC channel closes.
process.on("disconnect", () => process.exit(0));
