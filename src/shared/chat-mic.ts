/** The chat mic's settings and what it records about a dictation, shared by the server and the client. */

export const SPEECH_MODEL_IDS = ["parakeet-v3", "parakeet-unified-en"] as const;
export type SpeechModelId = (typeof SPEECH_MODEL_IDS)[number];
export const DEFAULT_SPEECH_MODEL_ID: SpeechModelId = "parakeet-unified-en";

export interface ChatMicSettings {
  /** Which recognizer the chat mic and hands-free use. Unset is the default model. */
  speechModel?: SpeechModelId;
  /** Keep the recordings of held dictations for the job's full 30 days instead of 2. */
  keepHeldRecordings?: boolean;
}

/** Detected speech with no words in it, for at least this long, holds a dictation for review. */
export const SPEECH_GAP_HOLD_SECONDS = 2;

/** The longest stretch of detected speech that the recognizer returned no words for. */
export interface SpeechCoverage {
  largestGapSeconds: number;
  gapStartSeconds: number;
}

/**
 * Why a dictation was held instead of sent. `coverage` means speech may be missing, and
 * `unchecked` means the recognizer gave no timing to check it against.
 */
export type VoiceReviewReason = "coverage" | "unchecked";

/** The review a dictation needs, or undefined when it may send. */
export function decideVoiceReview(coverage: SpeechCoverage | null | undefined): VoiceReviewReason | undefined {
  if (!coverage) return "unchecked";
  return coverage.largestGapSeconds >= SPEECH_GAP_HOLD_SECONDS ? "coverage" : undefined;
}
