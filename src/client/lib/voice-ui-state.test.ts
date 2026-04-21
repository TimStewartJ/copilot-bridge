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
  it("shows immediate feedback while starting and finishing the recorder", () => {
    expect(deriveVoiceUiState({
      ...baseState,
      recorderPhase: "starting",
    })).toMatchObject({
      buttonState: "spinner",
      buttonDisabled: true,
      message: "Starting mic…",
      tone: "accent",
    });

    expect(deriveVoiceUiState({
      ...baseState,
      recorderPhase: "finishing",
    })).toMatchObject({
      buttonState: "spinner",
      buttonDisabled: true,
      message: "Finishing…",
      tone: "accent",
    });
  });

  it("keeps the recording prompt concise and mode-aware", () => {
    expect(deriveVoiceUiState({
      ...baseState,
      recorderPhase: "recording",
      canAutoSendStoppedRecording: true,
    })).toMatchObject({
      buttonState: "stop",
      buttonDisabled: false,
      message: "Recording… stop to send.",
      tone: "accent",
    });

    expect(deriveVoiceUiState({
      ...baseState,
      recorderPhase: "recording",
      canAutoSendStoppedRecording: false,
    })).toMatchObject({
      message: "Recording… stop to transcribe.",
    });
  });

  it("distinguishes uploading from accepted and server processing states", () => {
    expect(deriveVoiceUiState({
      ...baseState,
      activeVoiceJob: { status: "uploading", submitMode: "autosend", serverOwned: true },
    })).toMatchObject({
      message: "Uploading… stay here.",
      buttonTitle: "Uploading voice audio",
    });

    expect(deriveVoiceUiState({
      ...baseState,
      activeVoiceJob: { status: "accepted", submitMode: "autosend", serverOwned: true },
    })).toMatchObject({
      message: "Uploaded. Transcribing…",
    });

    expect(deriveVoiceUiState({
      ...baseState,
      activeVoiceJob: { status: "transcribing", submitMode: "autosend", serverOwned: true },
    })).toMatchObject({
      message: "Uploaded. Transcribing…",
    });

    expect(deriveVoiceUiState({
      ...baseState,
      activeVoiceJob: { status: "sending", submitMode: "autosend", serverOwned: true },
    })).toMatchObject({
      message: "Uploaded. Sending…",
    });
  });

  it("shows a temporary green accepted confirmation ahead of later server states", () => {
    expect(deriveVoiceUiState({
      ...baseState,
      showAcceptedConfirmation: true,
      activeVoiceJob: { status: "transcribing", submitMode: "autosend", serverOwned: true },
    })).toMatchObject({
      message: "Upload accepted. Safe to leave.",
      tone: "success",
    });
  });

  it("falls back to local transcription copy for insert mode", () => {
    expect(deriveVoiceUiState({
      ...baseState,
      activeVoiceJob: { status: "transcribing", submitMode: "insert" },
    })).toMatchObject({
      message: "Transcribing…",
      tone: "accent",
    });
  });

  it("surfaces error states ahead of idle status messages", () => {
    expect(deriveVoiceUiState({
      ...baseState,
      voiceJobError: "Upload failed",
      statusError: "stale status error",
    })).toMatchObject({
      message: "Upload failed",
      tone: "error",
    });

    expect(deriveVoiceUiState({
      ...baseState,
      statusError: "Whisper unavailable",
      statusAvailable: false,
    })).toMatchObject({
      message: "Voice status check failed. Click the mic to retry. (Whisper unavailable)",
      tone: "error",
      showButton: true,
    });
  });
});
