// Messages exchanged between Bridge and the isolated speech engine child process.

export interface VoiceEngineInitOptions {
  engineDir: string;
  modelsDir: string;
  asrThreads: number;
  ttsThreads: number;
  turnThreads: number;
  audioRetentionSeconds: number;
}

/** Model groups the engine loads on demand: speech recognition, end-of-turn detection and the voice. */
export type VoiceEngineCapability = "asr" | "turn" | "tts";

export const VOICE_ENGINE_CAPABILITIES: readonly VoiceEngineCapability[] = ["asr", "turn", "tts"];

export type VoiceEngineRequest =
  | { type: "init"; id: number; options: VoiceEngineInitOptions }
  | { type: "load"; id: number; capabilities: VoiceEngineCapability[] }
  | { type: "open_stream"; id: number; streamId: string }
  | { type: "close_stream"; streamId: string }
  | { type: "audio"; streamId: string; pcm: Int16Array }
  | { type: "predict_turn"; id: number; streamId: string; fromSample: number; toSample: number }
  | { type: "transcribe"; id: number; streamId: string; fromSample: number; toSample: number }
  | { type: "transcribe_file"; id: number; filePath: string }
  | { type: "synthesize"; id: number; text: string; sid: number; speed: number; lang: string }
  | { type: "cancel_synthesis"; id: number };

export interface VoiceEngineReadyInfo {
  runtimeMs: number;
  sherpaVersion?: string;
  onnxruntimeVersion?: string;
  scheduling?: string;
}

export interface VoiceEngineLoadResult {
  loaded: VoiceEngineCapability[];
  loadMs: number;
  warmupMs: number;
}

export interface VoiceClipChunk {
  startSeconds: number;
  endSeconds: number;
  words: number;
}

export interface VoiceClipTranscription {
  text: string;
  audioSeconds: number;
  speechSeconds: number;
  chunks: number;
  /** Where each recognizer chunk sat in the recording and how many words it returned. */
  chunkDetails?: VoiceClipChunk[];
  ms: number;
  /** How the recording arrived: compressed by the browser, or the WAV every browser can send. */
  format: "wav" | "opus";
  /** Size of the uploaded recording. */
  bytes: number;
}

export type VoiceEngineResponse =
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "vad"; streamId: string; speech: boolean; sampleIndex: number }
  | { type: "tts_chunk"; id: number; pcm: Int16Array; sampleRate: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export function floatToInt16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]!;
    pcm[i] = value <= -1 ? -32768 : value >= 1 ? 32767 : Math.round(value * 32767);
  }
  return pcm;
}

export function int16ToFloat(pcm: Int16Array): Float32Array {
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768;
  return samples;
}
