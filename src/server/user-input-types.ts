/**
 * Shared transport types for native Copilot user-input events and responses.
 *
 * These types intentionally model the SDK's ask_user flow, not elicitation forms.
 */

export type UserInputRequestId = string;
export type UserInputChoice = string;

export interface NativeUserInputRequest {
  question: string;
  /**
   * Optional predefined answers. Validation should reject empty choices and
   * duplicate choices after trimming so answer matching is unambiguous.
   */
  choices?: UserInputChoice[];
  /** Defaults to true when omitted by the SDK request. */
  allowFreeform?: boolean;
}

export interface NativeUserInputResponse {
  /** The selected choice or freeform answer. Validation should reject empty answers after trimming. */
  answer: string;
  /**
   * True only when the answer was typed freeform. Freeform answers are valid only
   * when the pending request allows freeform input. Choice answers are valid only
   * when choices exist and the answer matches exactly one normalized choice.
   */
  wasFreeform: boolean;
}

export interface PendingUserInputRequestView extends NativeUserInputRequest {
  requestId: UserInputRequestId;
  /** Normalized SDK default; bridge views should always expose an explicit value. */
  allowFreeform: boolean;
  /** ISO timestamp for ordering and stale-request handling. */
  requestedAt?: string;
  /** SDK tool call identifier when available for correlation/debugging. */
  toolCallId?: string;
}

export interface UserInputRequestedStreamEvent extends PendingUserInputRequestView {
  type: "user_input_requested";
  timestamp?: string;
}

export interface UserInputAnsweredStreamEvent extends NativeUserInputResponse {
  type: "user_input_answered";
  requestId: UserInputRequestId;
  timestamp?: string;
}

export type UserInputCancelReason = "answered_elsewhere" | "session_ended" | "superseded" | "error";

export interface UserInputCanceledStreamEvent {
  type: "user_input_canceled";
  requestId: UserInputRequestId;
  reason?: UserInputCancelReason;
  message?: string;
  timestamp?: string;
}

export type UserInputStreamEvent =
  | UserInputRequestedStreamEvent
  | UserInputAnsweredStreamEvent
  | UserInputCanceledStreamEvent;

export interface UserInputSnapshotState {
  /** Pending native user input requests only; answered/canceled requests must be removed. */
  pendingUserInputs: PendingUserInputRequestView[];
}

export type UserInputAnswerEndpointPayload = NativeUserInputResponse;
