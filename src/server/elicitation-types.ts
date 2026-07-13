import type { UserInputCancelReason } from "./user-input-types.js";

export const MAX_ELICITATION_FIELDS = 20;
export const MAX_ELICITATION_OPTIONS = 50;
export const MAX_ELICITATION_MESSAGE_LENGTH = 10_000;
export const MAX_ELICITATION_LABEL_LENGTH = 500;
export const MAX_ELICITATION_OPTION_LENGTH = 1_000;
export const MAX_ELICITATION_SCHEMA_LENGTH = 100_000;
export const MAX_ELICITATION_STRING_LENGTH = 20_000;
export const MAX_ELICITATION_URL_LENGTH = 4_096;

export type ElicitationRequestId = string;
export type ElicitationMode = "form" | "url";
export type ElicitationAction = "accept" | "decline" | "cancel";
export type ElicitationFormat = "email" | "uri" | "date" | "date-time";
export type ElicitationFieldValue = string | number | boolean | string[];
export type ElicitationCancelReason = UserInputCancelReason;

interface ElicitationFieldBase {
  title?: string;
  description?: string;
}

export interface ElicitationEnumField extends ElicitationFieldBase {
  type: "string";
  enum: string[];
  enumNames?: string[];
  default?: string;
}

export interface ElicitationTitledEnumField extends ElicitationFieldBase {
  type: "string";
  oneOf: Array<{ const: string; title: string }>;
  default?: string;
}

export interface ElicitationMultiSelectField extends ElicitationFieldBase {
  type: "array";
  minItems?: number;
  maxItems?: number;
  items:
    | { type: "string"; enum: string[] }
    | { anyOf: Array<{ const: string; title: string }> };
  default?: string[];
}

export interface ElicitationBooleanField extends ElicitationFieldBase {
  type: "boolean";
  default?: boolean;
}

export interface ElicitationTextField extends ElicitationFieldBase {
  type: "string";
  minLength?: number;
  maxLength?: number;
  format?: ElicitationFormat;
  default?: string;
}

export interface ElicitationNumberField extends ElicitationFieldBase {
  type: "number" | "integer";
  minimum?: number;
  maximum?: number;
  default?: number;
}

export type ElicitationSchemaField =
  | ElicitationEnumField
  | ElicitationTitledEnumField
  | ElicitationMultiSelectField
  | ElicitationBooleanField
  | ElicitationTextField
  | ElicitationNumberField;

export interface ElicitationSchema {
  type: "object";
  properties: Record<string, ElicitationSchemaField>;
  required?: string[];
}

export interface NativeElicitationRequest {
  sessionId: string;
  message: string;
  requestedSchema?: ElicitationSchema;
  mode?: ElicitationMode;
  elicitationSource?: string;
  url?: string;
}

export interface NativeElicitationResult {
  action: ElicitationAction;
  content?: Record<string, ElicitationFieldValue>;
}

export interface PendingElicitationRequestView {
  requestId: ElicitationRequestId;
  message: string;
  mode: ElicitationMode;
  requestedSchema?: ElicitationSchema;
  elicitationSource?: string;
  url?: string;
  requestedAt?: string;
}

export interface ElicitationRequestedStreamEvent extends PendingElicitationRequestView {
  type: "elicitation_requested";
  timestamp?: string;
}

export interface ElicitationResolvedStreamEvent {
  type: "elicitation_resolved";
  requestId: ElicitationRequestId;
  action: ElicitationAction;
  timestamp?: string;
}

export interface ElicitationCanceledStreamEvent {
  type: "elicitation_canceled";
  requestId: ElicitationRequestId;
  reason?: ElicitationCancelReason;
  message?: string;
  timestamp?: string;
}

export type ElicitationStreamEvent =
  | ElicitationRequestedStreamEvent
  | ElicitationResolvedStreamEvent
  | ElicitationCanceledStreamEvent;

export interface ElicitationSnapshotState {
  pendingElicitations: PendingElicitationRequestView[];
}

export type ElicitationResponseEndpointPayload = NativeElicitationResult;

export interface SubmittedElicitationResponse {
  requestId: ElicitationRequestId;
  action: ElicitationAction;
  timestamp: string;
}
