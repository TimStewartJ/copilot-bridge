import type { VoiceSubmitMode } from "./voice-submit-mode";

export type VoiceRecorderPhase = "idle" | "starting" | "recording" | "finishing";
export type VoiceUiButtonState = "mic" | "stop" | "spinner";
export type VoiceUiTone = "muted" | "accent" | "success" | "error";

export interface VoiceUiJobState {
  status: "uploading" | "accepted" | "transcribing" | "sending";
  submitMode: VoiceSubmitMode;
  serverOwned?: boolean;
}

export interface VoiceUiStateContext {
  browserSupported: boolean;
  statusAvailable: boolean;
  statusError: string | null;
  voiceError: string | null;
  voiceJobError: string | null;
  showAcceptedConfirmation: boolean;
  recorderPhase: VoiceRecorderPhase;
  isCheckingStatus: boolean;
  activeVoiceJob: VoiceUiJobState | null;
  canAutoSendStoppedRecording: boolean;
}

export interface VoiceUiState {
  showButton: boolean;
  buttonDisabled: boolean;
  buttonState: VoiceUiButtonState;
  buttonTitle: string;
  message: string | null;
  tone: VoiceUiTone;
}

export function deriveVoiceUiState({
  browserSupported,
  statusAvailable,
  statusError,
  voiceError,
  voiceJobError,
  showAcceptedConfirmation,
  recorderPhase,
  isCheckingStatus,
  activeVoiceJob,
  canAutoSendStoppedRecording,
}: VoiceUiStateContext): VoiceUiState {
  const isStarting = recorderPhase === "starting";
  const isRecording = recorderPhase === "recording";
  const isFinishing = recorderPhase === "finishing";
  const hasActiveVoiceJob = activeVoiceJob !== null;
  const showButton = browserSupported && (
    statusAvailable
    || isStarting
    || isRecording
    || isFinishing
    || hasActiveVoiceJob
    || !!statusError
    || !!voiceError
    || !!voiceJobError
  );
  const buttonDisabled =
    !showButton
    || hasActiveVoiceJob
    || isStarting
    || isFinishing
    || (isCheckingStatus && !isRecording);
  const buttonState: VoiceUiButtonState = hasActiveVoiceJob || isStarting || isFinishing
    ? "spinner"
    : isRecording
      ? "stop"
      : "mic";

  let message: string | null = null;
  let tone: VoiceUiTone = "muted";

  if (voiceJobError) {
    message = voiceJobError;
    tone = "error";
  } else if (voiceError) {
    message = voiceError;
    tone = "error";
  } else if (showAcceptedConfirmation) {
    message = "Upload accepted. Safe to leave.";
    tone = "success";
  } else if (activeVoiceJob?.status === "uploading") {
    message = "Uploading… stay here.";
    tone = "accent";
  } else if (activeVoiceJob?.serverOwned && activeVoiceJob.status === "accepted") {
    message = "Uploaded. Transcribing…";
    tone = "accent";
  } else if (activeVoiceJob?.serverOwned && activeVoiceJob.status === "transcribing") {
    message = "Uploaded. Transcribing…";
    tone = "accent";
  } else if (activeVoiceJob?.serverOwned && activeVoiceJob.status === "sending") {
    message = "Uploaded. Sending…";
    tone = "accent";
  } else if (activeVoiceJob?.status === "sending") {
    message = "Sending…";
    tone = "accent";
  } else if (activeVoiceJob?.status === "transcribing") {
    message = "Transcribing…";
    tone = "accent";
  } else if (isFinishing) {
    message = "Finishing…";
    tone = "accent";
  } else if (isStarting) {
    message = "Starting mic…";
    tone = "accent";
  } else if (isRecording) {
    message = canAutoSendStoppedRecording
      ? "Recording… stop to send."
      : "Recording… stop to transcribe.";
    tone = "accent";
  } else if (statusError) {
    message = `Voice status check failed. Click the mic to retry. (${statusError})`;
    tone = "error";
  }

  let buttonTitle: string;
  if (!browserSupported) {
    buttonTitle = "Voice input is not supported in this browser";
  } else if (activeVoiceJob?.status === "uploading") {
    buttonTitle = "Uploading voice audio";
  } else if (activeVoiceJob?.serverOwned) {
    buttonTitle = "Voice message processing on the server";
  } else if (activeVoiceJob?.status === "sending") {
    buttonTitle = "Sending transcribed message";
  } else if (activeVoiceJob?.status === "transcribing") {
    buttonTitle = "Voice transcription in progress";
  } else if (isFinishing) {
    buttonTitle = "Preparing voice input";
  } else if (isStarting) {
    buttonTitle = "Starting microphone";
  } else if (isRecording) {
    buttonTitle = canAutoSendStoppedRecording
      ? "Stop recording, transcribe, and send automatically"
      : "Stop recording and transcribe";
  } else if (statusError) {
    buttonTitle = "Retry voice input status";
  } else {
    buttonTitle = "Record voice input";
  }

  return {
    showButton,
    buttonDisabled,
    buttonState,
    buttonTitle,
    message,
    tone,
  };
}
