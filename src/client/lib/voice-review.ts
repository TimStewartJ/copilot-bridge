import { decideVoiceReview, type SpeechCoverage, type VoiceReviewReason } from "../../shared/chat-mic.js";

/** A transcript in the draft that needs a person's eye before it goes out. */
export interface VoiceReviewNotice {
  reason: VoiceReviewReason;
  /** The server job holding the recording, when it can be played back. */
  recordingJobId?: string;
  /** Where in the recording the possibly missing speech starts. */
  gapStartSeconds?: number;
}

const CLOSED_HELD_NOTICES_KEY = "bridge-voice-closed-held-notices";
const CLOSED_HELD_NOTICES_KEPT = 100;

function readClosedHeldNotices(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CLOSED_HELD_NOTICES_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** A held dictation stays held after its notice is closed, so the app has to remember not to raise it again. */
export function isHeldNoticeClosed(jobId: string): boolean {
  return readClosedHeldNotices().includes(jobId);
}

export function rememberHeldNoticeClosed(jobId: string): void {
  try {
    const kept = [...readClosedHeldNotices().filter((id) => id !== jobId), jobId].slice(-CLOSED_HELD_NOTICES_KEPT);
    localStorage.setItem(CLOSED_HELD_NOTICES_KEY, JSON.stringify(kept));
  } catch {
    // Without storage the notice comes back at the next start, which only costs another click.
  }
}

/** What the composer says about a dictation waiting for review. */
export function describeVoiceReview(reason: VoiceReviewReason): string {
  return reason === "coverage" ? "Not sent. Some speech may be missing." : "Not sent. Couldn't check for missing speech.";
}

/** A dictation transcribed in the browser goes out from the composer, so it is checked here first. */
export function reviewForInsertedTranscript(coverage: SpeechCoverage | null | undefined): VoiceReviewNotice | null {
  const reason = decideVoiceReview(coverage);
  return reason ? { reason, ...(coverage ? { gapStartSeconds: coverage.gapStartSeconds } : {}) } : null;
}
