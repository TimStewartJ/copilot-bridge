// Chat mic transcription, backed by the local speech engine that also powers Helm's hands-free mode.
import type { VoiceClipTranscription } from "./voice/voice-engine-protocol.js";
import type { VoiceInstallStatus } from "./voice/voice-installer.js";

export const TRANSCRIPTION_PROVIDER = "speech-engine";

export interface TranscriptionStatus {
  available: boolean;
  provider: "disabled" | typeof TRANSCRIPTION_PROVIDER;
  label: string;
  reason?: string;
  maxDurationSeconds: number;
}

export interface TranscriptionResult {
  text: string;
  provider: typeof TRANSCRIPTION_PROVIDER;
}

export interface TranscriptionRequest {
  filePath: string;
}

export interface TranscriptionService {
  getStatus(): TranscriptionStatus;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface TranscriptionSpeechEngine {
  retain(): () => void;
  transcribeFile(filePath: string, options?: { timeoutMs?: number }): Promise<VoiceClipTranscription>;
}

export interface TranscriptionServiceDeps {
  installer: { getStatus(): VoiceInstallStatus };
  engine: TranscriptionSpeechEngine;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log">;
}

const DEFAULT_MAX_DURATION_SECONDS = 300;
const MIN_TIMEOUT_MS = 120_000;
const SETUP_HINT = "Set up the speech engine in Settings → Voice, or from Helm's hands-free mode.";

export const TRANSCRIPTION_LABEL = "Parakeet v3 (local)";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function describeTranscriptionUnavailable(install: VoiceInstallStatus): string | undefined {
  if (!install.supported) return `Local speech recognition isn't supported on ${install.target}.`;
  if (install.installed) return undefined;
  if (install.installing) {
    const percent = Math.round((install.progress?.overallFraction ?? 0) * 100);
    return `The speech engine is still installing (${percent}%).`;
  }
  if (install.error) return `Speech engine setup failed: ${install.error} ${SETUP_HINT}`;
  return SETUP_HINT;
}

export function createTranscriptionService({ installer, engine, env = process.env, logger }: TranscriptionServiceDeps): TranscriptionService {
  const maxDurationSeconds = parsePositiveInt(env.BRIDGE_TRANSCRIPTION_MAX_DURATION_SECONDS, DEFAULT_MAX_DURATION_SECONDS);
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, maxDurationSeconds * 5_000);

  const getStatus = (): TranscriptionStatus => {
    const reason = describeTranscriptionUnavailable(installer.getStatus());
    return reason
      ? { available: false, provider: "disabled", label: "Unavailable", reason, maxDurationSeconds }
      : { available: true, provider: TRANSCRIPTION_PROVIDER, label: TRANSCRIPTION_LABEL, maxDurationSeconds };
  };

  return {
    getStatus,
    async transcribe({ filePath }) {
      const status = getStatus();
      if (!status.available) throw new Error(status.reason ?? "Voice input is unavailable.");
      const release = engine.retain();
      try {
        const result = await engine.transcribeFile(filePath, { timeoutMs });
        logger?.log(`[transcription] ${result.audioSeconds}s clip (${result.speechSeconds}s speech, ${result.chunks} chunk${result.chunks === 1 ? "" : "s"}) in ${result.ms}ms`);
        const text = result.text.trim();
        if (!text) throw new Error("No speech was detected in the recording.");
        return { text, provider: TRANSCRIPTION_PROVIDER };
      } finally {
        release();
      }
    },
  };
}
