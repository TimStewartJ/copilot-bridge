// Shell command prompt types; only the respond body carries the answer, which goes nowhere else.

export const MAX_SHELL_AUTH_VALUE_LENGTH = 4_096;
export const MAX_SHELL_AUTH_PROMPT_LENGTH = 2_000;
export const MAX_SHELL_AUTH_COMMAND_LENGTH = 10_000;
export const MAX_SHELL_AUTH_CWD_LENGTH = 4_096;
export const MAX_SHELL_AUTH_PROGRAM_LENGTH = 100;

export type ShellAuthRequestId = string;
/** `secret` is masked, `text` is visible, `confirm` is answered with "yes" or a cancel. */
export type ShellAuthInputKind = "secret" | "text" | "confirm";
export type ShellAuthAction = "accept" | "cancel";
/** `expired`: the command stopped waiting (it ended or its prompt timed out). */
export type ShellAuthCancelReason = "expired" | "session_ended";
/** What a confirm request is answered with. */
export const SHELL_AUTH_CONFIRM_VALUE = "yes";

export interface PendingShellAuthRequestView {
  requestId: ShellAuthRequestId;
  /** The program that asked, such as `sudo`, `ssh` or `git`. */
  program: string;
  prompt: string;
  inputKind: ShellAuthInputKind;
  command: string;
  cwd: string;
  requestedAt?: string;
}

export interface ShellAuthRequestedStreamEvent extends PendingShellAuthRequestView {
  type: "shell_auth_requested";
  timestamp?: string;
}

/** Carries the action only, never the answer. */
export interface ShellAuthResolvedStreamEvent {
  type: "shell_auth_resolved";
  requestId: ShellAuthRequestId;
  action: ShellAuthAction;
  timestamp?: string;
}

export interface ShellAuthCanceledStreamEvent {
  type: "shell_auth_canceled";
  requestId: ShellAuthRequestId;
  reason?: ShellAuthCancelReason;
  timestamp?: string;
}

export type ShellAuthStreamEvent =
  | ShellAuthRequestedStreamEvent
  | ShellAuthResolvedStreamEvent
  | ShellAuthCanceledStreamEvent;

export type ShellAuthResponseEndpointPayload =
  | { action: "accept"; value: string }
  | { action: "cancel" };

export interface SubmittedShellAuthResponse {
  requestId: ShellAuthRequestId;
  action: ShellAuthAction;
  timestamp: string;
}
