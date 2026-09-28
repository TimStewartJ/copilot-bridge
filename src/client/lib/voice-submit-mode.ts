import type { SendMode } from "../../shared/send-mode.js";

export type VoiceSubmitMode = "insert" | "autosend";

/** A finished recording handed from the composer to background delivery. */
export interface VoiceCaptureSubmission {
  composerKey: string;
  audio: Blob;
  submitMode: VoiceSubmitMode;
  /** The composer's send mode when recording stopped; applies only to an auto-sent transcript. */
  sendMode?: SendMode;
}

/** Resolves to how the recording is delivered, or null/undefined when that is not known. */
export type SubmitVoiceCapture = (capture: VoiceCaptureSubmission) => Promise<VoiceSubmitMode | null | void>;

export interface VoiceSubmitModeContext {
  text: string;
  attachmentCount: number;
  sendBlocked?: boolean;
  uploadingCount?: number;
}

export function canAutoSendVoiceTranscript({
  text,
  attachmentCount,
  sendBlocked = false,
  uploadingCount = 0,
}: VoiceSubmitModeContext): boolean {
  return text.trim().length === 0 && attachmentCount === 0 && !sendBlocked && uploadingCount === 0;
}

export function resolveVoiceSubmitMode(context: VoiceSubmitModeContext): VoiceSubmitMode {
  return canAutoSendVoiceTranscript(context) ? "autosend" : "insert";
}

export function resolveVoiceSubmitModeAfterRecording(
  startedMode: VoiceSubmitMode | null,
  context: VoiceSubmitModeContext,
): VoiceSubmitMode {
  return startedMode === "autosend" && canAutoSendVoiceTranscript(context) ? "autosend" : "insert";
}
