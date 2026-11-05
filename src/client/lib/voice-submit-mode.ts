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
  /** The composer cannot send yet, such as while the chat loads. */
  sendBlocked?: boolean;
  uploadingCount?: number;
}

/**
 * How a finished recording reaches the agent; it always does. Alone in a ready composer it goes as
 * a server job, safe to leave. Otherwise it joins the composer first and is sent from there.
 */
export function resolveVoiceSubmitMode({
  text,
  attachmentCount,
  sendBlocked = false,
  uploadingCount = 0,
}: VoiceSubmitModeContext): VoiceSubmitMode {
  return text.trim().length === 0 && attachmentCount === 0 && !sendBlocked && uploadingCount === 0
    ? "autosend"
    : "insert";
}
