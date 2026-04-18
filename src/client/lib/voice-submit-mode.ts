export type VoiceSubmitMode = "insert" | "autosend";

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
