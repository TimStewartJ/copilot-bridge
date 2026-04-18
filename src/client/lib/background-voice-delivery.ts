import type { VoiceSubmitMode } from "./voice-submit-mode";

export interface BackgroundVoiceDeliveryContext {
  submitMode: VoiceSubmitMode;
  hasDraftContent: boolean;
  targetBusy: boolean;
}

export function resolveBackgroundVoiceSubmitMode({
  submitMode,
  hasDraftContent,
  targetBusy,
}: BackgroundVoiceDeliveryContext): VoiceSubmitMode {
  return submitMode === "autosend" && !hasDraftContent && !targetBusy ? "autosend" : "insert";
}
