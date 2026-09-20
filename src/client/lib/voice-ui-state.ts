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
  /** An unsent recording is still stored for this composer and must be retried or discarded. */
  hasPendingRecording?: boolean;
  /** Set when the recording could not be written to durable client storage. */
  persistWarning?: string | null;
  /** Whole seconds captured by the recording in progress. */
  recordingSeconds?: number;
  /** Longest recording the server accepts; the recorder stops itself there. */
  maxRecordingSeconds?: number;
  /** Whole percent of the recording uploaded so far. */
  uploadPercent?: number;
}

export interface VoiceUiState {
  showButton: boolean;
  buttonDisabled: boolean;
  buttonState: VoiceUiButtonState;
  buttonTitle: string;
  message: string | null;
  /** A fast-changing figure (recording clock, upload percent) shown beside the message, outside its live region. */
  detail: string | null;
  tone: VoiceUiTone;
}

/** The recorder says what will happen at the limit once this little time is left. */
const LIMIT_NOTICE_SECONDS = 30;

function formatClock(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/** "5 minutes", "90 seconds": the recording limit in words. */
export function describeRecordingLimit(seconds: number): string {
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  return seconds === 60 ? "1 minute" : `${seconds / 60} minutes`;
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
  hasPendingRecording = false,
  persistWarning = null,
  recordingSeconds,
  maxRecordingSeconds,
  uploadPercent,
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
    // Only one recording can be pending per composer; overwriting it would destroy unsent audio.
    || (hasPendingRecording && !isRecording)
    || (isCheckingStatus && !isRecording);
  const buttonState: VoiceUiButtonState = hasActiveVoiceJob || isStarting || isFinishing
    ? "spinner"
    : isRecording
      ? "stop"
      : "mic";

  let message: string | null = null;
  let detail: string | null = null;
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
    if (uploadPercent !== undefined) detail = `${uploadPercent}%`;
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
    const limit = maxRecordingSeconds === undefined ? null : formatClock(maxRecordingSeconds);
    const secondsLeft = maxRecordingSeconds === undefined ? Infinity : maxRecordingSeconds - (recordingSeconds ?? 0);
    if (secondsLeft <= LIMIT_NOTICE_SECONDS) {
      message = `Recording… stops and ${canAutoSendStoppedRecording ? "sends" : "transcribes"} at ${limit}.`;
    } else {
      message = canAutoSendStoppedRecording
        ? "Recording… stop to send."
        : "Recording… stop to transcribe.";
    }
    if (recordingSeconds !== undefined) {
      detail = limit ? `${formatClock(recordingSeconds)} / ${limit}` : formatClock(recordingSeconds);
    }
    tone = "accent";
  } else if (statusError) {
    message = `Voice status check failed. Click the mic to retry. (${statusError})`;
    tone = "error";
  }

  // The storage warning must survive an error message: that is exactly when it matters most.
  if (persistWarning && message) {
    message = `${message} ${persistWarning}`;
  } else if (persistWarning) {
    message = persistWarning;
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
  } else if (hasPendingRecording) {
    buttonTitle = "Retry or discard the unsent voice recording first";
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
    detail,
    tone,
  };
}
