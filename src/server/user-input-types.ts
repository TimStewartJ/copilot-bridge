// Transport types for the SDK's ask_user flow, not elicitation forms.

export type UserInputRequestId = string;
export type UserInputChoice = string;

export interface NativeUserInputRequest {
  question: string;
  /** Predefined answers; reject empty or duplicate (trimmed) ones so matching is unambiguous. */
  choices?: UserInputChoice[];
  /** Defaults to true when omitted by the SDK request. */
  allowFreeform?: boolean;
}

export interface NativeUserInputResponse {
  /** The chosen or freeform answer; reject it when empty after trimming. */
  answer: string;
  /** True only for a typed answer, valid only when the request allows freeform. */
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
