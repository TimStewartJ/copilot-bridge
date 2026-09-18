// Pinned assets, voices and defaults for the local speech engine and hands-free voice.
import { join } from "node:path";
import type { RuntimePaths } from "../runtime-paths.js";

/** Bump when the on-disk layout or pinned asset set changes incompatibly. */
export const VOICE_ENGINE_LAYOUT_VERSION = 1;

export interface VoiceNpmPackageAsset {
  kind: "npm";
  id: string;
  name: string;
  version: string;
  /** npm registry `dist.integrity` (sha512, base64). */
  integrity: string;
  sizeBytes: number;
  /** `${process.platform}-${process.arch}` targets that need this package; omitted means all. */
  targets?: string[];
  /** Tarball members to extract; omitted extracts everything. */
  members?: (target: string) => string[];
}

export interface VoiceModelAsset {
  kind: "model";
  id: string;
  label: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  archive?: "tar.bz2";
  /** File name for single-file downloads, relative to the models directory. */
  fileName?: string;
  /** Files that must exist (relative to the models directory) once installed. */
  verifyFiles: string[];
}

export type VoiceAsset = VoiceNpmPackageAsset | VoiceModelAsset;

const ORT_TARGET_DIRS: Record<string, string> = {
  "win32-x64": "win32/x64",
  "win32-arm64": "win32/arm64",
  "linux-x64": "linux/x64",
  "linux-arm64": "linux/arm64",
  "darwin-arm64": "darwin/arm64",
};

export const VOICE_ENGINE_PACKAGES: VoiceNpmPackageAsset[] = [
  {
    kind: "npm",
    id: "sherpa-onnx-node",
    name: "sherpa-onnx-node",
    version: "1.13.8",
    integrity: "sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==",
    sizeBytes: 30_000,
  },
  {
    kind: "npm",
    id: "sherpa-onnx-win-x64",
    name: "sherpa-onnx-win-x64",
    version: "1.13.8",
    integrity: "sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==",
    sizeBytes: 9_000_000,
    targets: ["win32-x64"],
  },
  {
    kind: "npm",
    id: "sherpa-onnx-linux-x64",
    name: "sherpa-onnx-linux-x64",
    version: "1.13.8",
    integrity: "sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==",
    sizeBytes: 12_000_000,
    targets: ["linux-x64"],
  },
  {
    kind: "npm",
    id: "sherpa-onnx-linux-arm64",
    name: "sherpa-onnx-linux-arm64",
    version: "1.13.8",
    integrity: "sha512-Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==",
    sizeBytes: 14_000_000,
    targets: ["linux-arm64"],
  },
  {
    kind: "npm",
    id: "sherpa-onnx-darwin-arm64",
    name: "sherpa-onnx-darwin-arm64",
    version: "1.13.8",
    integrity: "sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==",
    sizeBytes: 12_000_000,
    targets: ["darwin-arm64"],
  },
  {
    kind: "npm",
    id: "onnxruntime-common",
    name: "onnxruntime-common",
    version: "1.30.0",
    integrity: "sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==",
    sizeBytes: 150_000,
  },
  {
    kind: "npm",
    id: "onnxruntime-node",
    name: "onnxruntime-node",
    version: "1.30.0",
    integrity: "sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==",
    sizeBytes: 110_000_000,
    // The package bundles binaries for every platform; extract only this host's.
    members: (target) => [
      "package/package.json",
      "package/dist",
      `package/bin/napi-v6/${ORT_TARGET_DIRS[target] ?? target.replace("-", "/")}`,
    ],
  },
];

export const VOICE_MODELS: VoiceModelAsset[] = [
  {
    kind: "model",
    id: "silero-vad",
    label: "Silero voice activity detector",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    sizeBytes: 643_854,
    fileName: "silero_vad.onnx",
    verifyFiles: ["silero_vad.onnx"],
  },
  {
    kind: "model",
    id: "smart-turn",
    label: "Smart Turn v3.2 end-of-turn detector",
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx",
    sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
    sizeBytes: 8_679_182,
    fileName: "smart-turn-v3.2-cpu.onnx",
    verifyFiles: ["smart-turn-v3.2-cpu.onnx"],
  },
  {
    kind: "model",
    id: "parakeet-v3",
    label: "Parakeet TDT 0.6B v3 speech recognition",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
    sizeBytes: 487_170_055,
    archive: "tar.bz2",
    verifyFiles: [
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx",
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/decoder.int8.onnx",
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/joiner.int8.onnx",
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tokens.txt",
    ],
  },
  {
    kind: "model",
    id: "kokoro",
    label: "Kokoro 82M voices",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
    sha256: "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298",
    sizeBytes: 349_906_910,
    archive: "tar.bz2",
    verifyFiles: [
      "kokoro-multi-lang-v1_0/model.onnx",
      "kokoro-multi-lang-v1_0/voices.bin",
      "kokoro-multi-lang-v1_0/tokens.txt",
      "kokoro-multi-lang-v1_0/lexicon-us-en.txt",
      "kokoro-multi-lang-v1_0/espeak-ng-data/phontab",
    ],
  },
];

export const VOICE_MODEL_FILES = {
  vad: "silero_vad.onnx",
  smartTurn: "smart-turn-v3.2-cpu.onnx",
  asrDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  ttsDir: "kokoro-multi-lang-v1_0",
} as const;

export function currentVoiceTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function isVoiceTargetSupported(target = currentVoiceTarget()): boolean {
  return Object.hasOwn(ORT_TARGET_DIRS, target)
    && VOICE_ENGINE_PACKAGES.some((asset) => asset.targets?.includes(target) && asset.name.startsWith("sherpa-onnx-"));
}

export function selectVoiceEnginePackages(target = currentVoiceTarget()): VoiceNpmPackageAsset[] {
  return VOICE_ENGINE_PACKAGES.filter((asset) => !asset.targets || asset.targets.includes(target));
}

export interface KokoroVoice {
  sid: number;
  id: string;
  name: string;
  accent: "American" | "British";
  gender: "female" | "male";
  /** espeak-ng voice used for phonemization; `en` is British English in espeak-ng. */
  lang: "en-us" | "en";
}

const KOKORO_ENGLISH_VOICES: Array<[number, string]> = [
  [0, "af_alloy"], [1, "af_aoede"], [2, "af_bella"], [3, "af_heart"], [4, "af_jessica"], [5, "af_kore"],
  [6, "af_nicole"], [7, "af_nova"], [8, "af_river"], [9, "af_sarah"], [10, "af_sky"], [11, "am_adam"],
  [12, "am_echo"], [13, "am_eric"], [14, "am_fenrir"], [15, "am_liam"], [16, "am_michael"], [17, "am_onyx"],
  [18, "am_puck"], [20, "bf_alice"], [21, "bf_emma"], [22, "bf_isabella"], [23, "bf_lily"], [24, "bm_daniel"],
  [25, "bm_fable"], [26, "bm_george"], [27, "bm_lewis"],
];

export const KOKORO_VOICES: KokoroVoice[] = KOKORO_ENGLISH_VOICES.map(([sid, id]) => {
  const british = id.startsWith("b");
  const name = id.slice(3);
  return {
    sid,
    id,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    accent: british ? "British" : "American",
    gender: id.charAt(1) === "f" ? "female" : "male",
    lang: british ? "en" : "en-us",
  };
});

export function resolveKokoroVoice(voiceId: string | undefined): KokoroVoice {
  return KOKORO_VOICES.find((voice) => voice.id === voiceId)
    ?? KOKORO_VOICES.find((voice) => voice.id === DEFAULT_VOICE_SETTINGS.voice)!;
}

export type VoiceAnnounceMode = "watched" | "all" | "off";

export interface VoiceSettings {
  voice: string;
  speed: number;
  /** 0 = eager (answers quickly after a pause), 1 = patient (waits longer while you think). */
  patience: number;
  bargeIn: boolean;
  announce: VoiceAnnounceMode;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voice: "af_heart",
  speed: 1.05,
  patience: 0.5,
  bargeIn: true,
  announce: "watched",
};

export function normalizeVoiceSettings(input: unknown, previous: VoiceSettings = DEFAULT_VOICE_SETTINGS): VoiceSettings {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const next: VoiceSettings = { ...previous };
  if (typeof value.voice === "string" && KOKORO_VOICES.some((voice) => voice.id === value.voice)) {
    next.voice = value.voice;
  }
  if (typeof value.speed === "number" && Number.isFinite(value.speed)) {
    next.speed = Math.min(1.4, Math.max(0.75, value.speed));
  }
  if (typeof value.patience === "number" && Number.isFinite(value.patience)) {
    next.patience = Math.min(1, Math.max(0, value.patience));
  }
  if (typeof value.bargeIn === "boolean") next.bargeIn = value.bargeIn;
  if (value.announce === "watched" || value.announce === "all" || value.announce === "off") {
    next.announce = value.announce;
  }
  return next;
}

export interface VoicePaths {
  voiceDir: string;
  engineDir: string;
  modelsDir: string;
  downloadsDir: string;
  logsDir: string;
}

export function resolveVoicePaths(runtimePaths: Pick<RuntimePaths, "dataDir" | "env">): VoicePaths {
  const override = runtimePaths.env.BRIDGE_VOICE_DIR?.trim();
  const voiceDir = override || join(runtimePaths.dataDir, "voice");
  return {
    voiceDir,
    engineDir: join(voiceDir, "engine"),
    modelsDir: join(voiceDir, "models"),
    downloadsDir: join(voiceDir, "downloads"),
    logsDir: join(voiceDir, "logs"),
  };
}
