import { describe, expect, it } from "vitest";
import { deriveVoiceUiState } from "./voice-ui-state";

const baseState = {
  browserSupported: true,
  statusAvailable: true,
  statusError: null,
  voiceError: null,
  voiceJobError: null,
  showAcceptedConfirmation: false,
  recorderPhase: "idle" as const,
  isCheckingStatus: false,
  activeVoiceJob: null,
  canAutoSendStoppedRecording: false,
};

describe("deriveVoiceUiState", () => {
  it("derives button state and message across recorder and server job phases", () => {
    // starting/finishing → spinner + disabled
    expect(deriveVoiceUiState({ ...baseState, recorderPhase: "starting" })).toMatchObject({
      buttonState: "spinner", buttonDisabled: true, message: "Starting mic…", tone: "accent",
    });
    expect(deriveVoiceUiState({ ...baseState, recorderPhase: "finishing" })).toMatchObject({
      buttonState: "spinner", buttonDisabled: true, message: "Finishing…", tone: "accent",
    });

    // recording — message differs by auto-send eligibility
    expect(deriveVoiceUiState({ ...baseState, recorderPhase: "recording", canAutoSendStoppedRecording: true })).toMatchObject({
      buttonState: "stop", buttonDisabled: false, message: "Recording… stop to send.", tone: "accent",
    });
    expect(deriveVoiceUiState({ ...baseState, recorderPhase: "recording", canAutoSendStoppedRecording: false })).toMatchObject({
      message: "Recording… stop to transcribe.",
    });

    // server job phases
    expect(deriveVoiceUiState({ ...baseState, activeVoiceJob: { status: "uploading", submitMode: "autosend", serverOwned: true } })).toMatchObject({
      message: "Uploading… stay here.", buttonTitle: "Uploading voice audio",
    });
    expect(deriveVoiceUiState({ ...baseState, activeVoiceJob: { status: "accepted", submitMode: "autosend", serverOwned: true } })).toMatchObject({
      message: "Uploaded. Transcribing…",
    });
    expect(deriveVoiceUiState({ ...baseState, activeVoiceJob: { status: "transcribing", submitMode: "autosend", serverOwned: true } })).toMatchObject({
      message: "Uploaded. Transcribing…",
    });
    expect(deriveVoiceUiState({ ...baseState, activeVoiceJob: { status: "sending", submitMode: "autosend", serverOwned: true } })).toMatchObject({
      message: "Uploaded. Sending…",
    });

    // accepted confirmation flash takes priority over later server state
    expect(deriveVoiceUiState({ ...baseState, showAcceptedConfirmation: true, activeVoiceJob: { status: "transcribing", submitMode: "autosend", serverOwned: true } })).toMatchObject({
      message: "Upload accepted. Safe to leave.", tone: "success",
    });
  });

  it("falls back to local transcription copy for insert mode and surfaces errors ahead of idle", () => {
    // insert mode → local transcription label
    expect(deriveVoiceUiState({ ...baseState, activeVoiceJob: { status: "transcribing", submitMode: "insert" } })).toMatchObject({
      message: "Transcribing…", tone: "accent",
    });

    // job error takes priority over status error
    expect(deriveVoiceUiState({ ...baseState, voiceJobError: "Upload failed", statusError: "stale status error" })).toMatchObject({
      message: "Upload failed", tone: "error",
    });

    // status error with unavailable status
    expect(deriveVoiceUiState({ ...baseState, statusError: "Whisper unavailable", statusAvailable: false })).toMatchObject({
      message: "Voice status check failed. Click the mic to retry. (Whisper unavailable)",
      tone: "error",
      showButton: true,
    });
  });
});
