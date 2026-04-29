import { randomUUID } from "node:crypto";
import type {
  NativeUserInputRequest,
  NativeUserInputResponse,
  PendingUserInputRequestView,
  UserInputCancelReason,
  UserInputRequestId,
} from "./user-input-types.js";

export type UserInputBrokerErrorCode =
  | "invalid_request"
  | "invalid_response"
  | "request_canceled"
  | "request_not_found";

interface UserInputBrokerErrorOptions {
  statusCode?: number;
  reason?: UserInputCancelReason;
}

export class UserInputBrokerError extends Error {
  readonly code: UserInputBrokerErrorCode;
  readonly statusCode: number;
  readonly reason?: UserInputCancelReason;

  constructor(code: UserInputBrokerErrorCode, message: string, options: UserInputBrokerErrorOptions = {}) {
    super(message);
    this.name = "UserInputBrokerError";
    this.code = code;
    this.statusCode = options.statusCode ?? 400;
    this.reason = options.reason;
  }
}

export type UserInputBrokerRequest = NativeUserInputRequest & {
  toolCallId?: string;
};

export interface UserInputBrokerEventHandlers {
  onRequestCreated?: (sessionId: string, request: PendingUserInputRequestView) => void;
  onRequestAnswered?: (
    sessionId: string,
    requestId: UserInputRequestId,
    response: NativeUserInputResponse,
    timestamp: string,
  ) => void;
  onRequestCanceled?: (
    sessionId: string,
    requestId: UserInputRequestId,
    reason: UserInputCancelReason,
    message: string | undefined,
    timestamp: string,
  ) => void;
}

export interface UserInputBrokerOptions extends UserInputBrokerEventHandlers {
  requestIdFactory?: () => UserInputRequestId;
  now?: () => Date;
}

interface PendingUserInputRecord {
  view: PendingUserInputRequestView;
  resolve: (response: NativeUserInputResponse) => void;
  reject: (error: UserInputBrokerError) => void;
}

const MAX_REQUEST_ID_ATTEMPTS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function makeError(
  code: UserInputBrokerErrorCode,
  message: string,
  options: UserInputBrokerErrorOptions = {},
): UserInputBrokerError {
  return new UserInputBrokerError(code, message, options);
}

function normalizeIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw makeError("invalid_request", `${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw makeError("invalid_request", `${fieldName} is required`);
  }
  return normalized;
}

function normalizeChoices(rawChoices: unknown): string[] | undefined {
  if (rawChoices === undefined) return undefined;
  if (!Array.isArray(rawChoices)) {
    throw makeError("invalid_request", "choices must be an array of strings");
  }

  const choices: string[] = [];
  const seen = new Set<string>();
  for (const rawChoice of rawChoices) {
    if (typeof rawChoice !== "string") {
      throw makeError("invalid_request", "choices must be an array of strings");
    }
    const choice = rawChoice.trim();
    if (!choice) {
      throw makeError("invalid_request", "choices cannot contain blank values");
    }
    if (seen.has(choice)) {
      throw makeError("invalid_request", "choices cannot contain duplicates after trimming");
    }
    seen.add(choice);
    choices.push(choice);
  }

  return choices.length > 0 ? choices : undefined;
}

function clonePendingView(view: PendingUserInputRequestView): PendingUserInputRequestView {
  const clone: PendingUserInputRequestView = { ...view };
  if (view.choices) clone.choices = [...view.choices];
  return clone;
}

export class UserInputBroker {
  private readonly pendingBySession = new Map<string, Map<UserInputRequestId, PendingUserInputRecord>>();
  private readonly requestIdFactory: () => UserInputRequestId;
  private readonly now: () => Date;
  private onRequestCreated: UserInputBrokerEventHandlers["onRequestCreated"];
  private onRequestAnswered: UserInputBrokerEventHandlers["onRequestAnswered"];
  private onRequestCanceled: UserInputBrokerEventHandlers["onRequestCanceled"];

  constructor(options: UserInputBrokerOptions = {}) {
    this.requestIdFactory = options.requestIdFactory ?? (() => `ui_${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
    this.onRequestCreated = options.onRequestCreated;
    this.onRequestAnswered = options.onRequestAnswered;
    this.onRequestCanceled = options.onRequestCanceled;
  }

  setEventHandlers(handlers: UserInputBrokerEventHandlers): void {
    this.onRequestCreated = handlers.onRequestCreated;
    this.onRequestAnswered = handlers.onRequestAnswered;
    this.onRequestCanceled = handlers.onRequestCanceled;
  }

  requestUserInput(sessionId: string, sdkRequest: UserInputBrokerRequest): Promise<NativeUserInputResponse> {
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    const requestId = this.createUniqueRequestId();
    const requestedAt = this.now().toISOString();
    const view = this.normalizeRequest(sdkRequest, requestId, requestedAt);

    let resolve!: (response: NativeUserInputResponse) => void;
    let reject!: (error: UserInputBrokerError) => void;
    const promise = new Promise<NativeUserInputResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.getOrCreateSessionRequests(normalizedSessionId).set(requestId, {
      view,
      resolve,
      reject,
    });
    this.notifyRequestCreated(normalizedSessionId, view);

    return promise;
  }

  submitUserInputResponse(
    sessionId: string,
    requestId: UserInputRequestId,
    payload: unknown,
  ): NativeUserInputResponse {
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    const normalizedRequestId = normalizeIdentifier(requestId, "requestId");
    const pending = this.pendingBySession.get(normalizedSessionId)?.get(normalizedRequestId);
    if (!pending) {
      throw makeError("request_not_found", "Pending user input request not found", { statusCode: 404 });
    }

    const response = this.validateResponse(pending.view, payload);
    this.removePendingRequest(normalizedSessionId, normalizedRequestId);
    this.notifyRequestAnswered(normalizedSessionId, normalizedRequestId, response);
    pending.resolve(response);
    return response;
  }

  cancelUserInputRequest(
    sessionId: string,
    requestId: UserInputRequestId,
    reason: UserInputCancelReason = "session_ended",
    message?: string,
  ): boolean {
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    const normalizedRequestId = normalizeIdentifier(requestId, "requestId");
    const pending = this.pendingBySession.get(normalizedSessionId)?.get(normalizedRequestId);
    if (!pending) return false;

    this.removePendingRequest(normalizedSessionId, normalizedRequestId);
    this.notifyRequestCanceled(normalizedSessionId, normalizedRequestId, reason, message);
    pending.reject(this.createCancellationError(reason, message));
    return true;
  }

  cancelSessionRequests(
    sessionId: string,
    reason: UserInputCancelReason = "session_ended",
    message?: string,
  ): number {
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    const sessionRequests = this.pendingBySession.get(normalizedSessionId);
    if (!sessionRequests) return 0;

    const pendingRequests = [...sessionRequests.entries()];
    this.pendingBySession.delete(normalizedSessionId);
    for (const [requestId, pending] of pendingRequests) {
      this.notifyRequestCanceled(normalizedSessionId, requestId, reason, message);
      pending.reject(this.createCancellationError(reason, message));
    }
    return pendingRequests.length;
  }

  cancelAllRequests(
    reason: UserInputCancelReason = "session_ended",
    message?: string,
  ): number {
    let canceled = 0;
    for (const sessionId of [...this.pendingBySession.keys()]) {
      canceled += this.cancelSessionRequests(sessionId, reason, message);
    }
    return canceled;
  }

  getPendingUserInput(
    sessionId: string,
    requestId: UserInputRequestId,
  ): PendingUserInputRequestView | undefined {
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    const normalizedRequestId = normalizeIdentifier(requestId, "requestId");
    const pending = this.pendingBySession.get(normalizedSessionId)?.get(normalizedRequestId);
    return pending ? clonePendingView(pending.view) : undefined;
  }

  listPendingUserInputs(sessionId: string): PendingUserInputRequestView[] {
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    const sessionRequests = this.pendingBySession.get(normalizedSessionId);
    if (!sessionRequests) return [];
    return [...sessionRequests.values()].map((pending) => clonePendingView(pending.view));
  }

  getPendingCount(sessionId?: string): number {
    if (sessionId !== undefined) {
      const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
      return this.pendingBySession.get(normalizedSessionId)?.size ?? 0;
    }

    let count = 0;
    for (const sessionRequests of this.pendingBySession.values()) {
      count += sessionRequests.size;
    }
    return count;
  }

  private getOrCreateSessionRequests(sessionId: string): Map<UserInputRequestId, PendingUserInputRecord> {
    let sessionRequests = this.pendingBySession.get(sessionId);
    if (!sessionRequests) {
      sessionRequests = new Map();
      this.pendingBySession.set(sessionId, sessionRequests);
    }
    return sessionRequests;
  }

  private createUniqueRequestId(): UserInputRequestId {
    for (let attempt = 0; attempt < MAX_REQUEST_ID_ATTEMPTS; attempt += 1) {
      const requestId = normalizeIdentifier(this.requestIdFactory(), "requestId");
      if (!this.hasPendingRequestId(requestId)) return requestId;
    }
    throw makeError("invalid_request", "Unable to generate a unique user input request ID");
  }

  private hasPendingRequestId(requestId: UserInputRequestId): boolean {
    for (const sessionRequests of this.pendingBySession.values()) {
      if (sessionRequests.has(requestId)) return true;
    }
    return false;
  }

  private normalizeRequest(
    sdkRequest: UserInputBrokerRequest,
    requestId: UserInputRequestId,
    requestedAt: string,
  ): PendingUserInputRequestView {
    if (!isRecord(sdkRequest)) {
      throw makeError("invalid_request", "User input request must be an object");
    }

    const question = normalizeIdentifier(sdkRequest.question, "question");
    const allowFreeform = sdkRequest.allowFreeform ?? true;
    if (typeof allowFreeform !== "boolean") {
      throw makeError("invalid_request", "allowFreeform must be a boolean");
    }

    const choices = normalizeChoices(sdkRequest.choices);
    if (!allowFreeform && !choices?.length) {
      throw makeError("invalid_request", "User input requests without choices must allow freeform answers");
    }

    const rawToolCallId = sdkRequest.toolCallId;
    const toolCallId = typeof rawToolCallId === "string" && rawToolCallId.trim()
      ? rawToolCallId.trim()
      : undefined;

    return {
      requestId,
      question,
      allowFreeform,
      choices,
      requestedAt,
      toolCallId,
    };
  }

  private validateResponse(view: PendingUserInputRequestView, payload: unknown): NativeUserInputResponse {
    if (!isRecord(payload)) {
      throw makeError("invalid_response", "User input response must be an object");
    }
    if (typeof payload.answer !== "string") {
      throw makeError("invalid_response", "Response answer must be a string");
    }
    if (!payload.answer.trim()) {
      throw makeError("invalid_response", "Response answer cannot be blank");
    }
    if (typeof payload.wasFreeform !== "boolean") {
      throw makeError("invalid_response", "Response wasFreeform must be a boolean");
    }

    const response: NativeUserInputResponse = {
      answer: payload.answer,
      wasFreeform: payload.wasFreeform,
    };
    const choices = view.choices ?? [];
    const hasChoices = choices.length > 0;
    const matchesChoice = hasChoices && choices.includes(response.answer);

    if (response.wasFreeform && !view.allowFreeform) {
      throw makeError("invalid_response", "Freeform answers are not allowed for this request");
    }
    if (hasChoices && !response.wasFreeform && !matchesChoice) {
      throw makeError("invalid_response", "Choice responses must match one of the request choices");
    }
    if (hasChoices && !view.allowFreeform && !matchesChoice) {
      throw makeError("invalid_response", "Response answer must match one of the request choices");
    }

    return response;
  }

  private removePendingRequest(sessionId: string, requestId: UserInputRequestId): void {
    const sessionRequests = this.pendingBySession.get(sessionId);
    if (!sessionRequests) return;
    sessionRequests.delete(requestId);
    if (sessionRequests.size === 0) {
      this.pendingBySession.delete(sessionId);
    }
  }

  private notifyRequestCreated(sessionId: string, view: PendingUserInputRequestView): void {
    try {
      this.onRequestCreated?.(sessionId, clonePendingView(view));
    } catch (err) {
      console.warn("[user-input] Failed to publish user input request:", err);
    }
  }

  private notifyRequestAnswered(
    sessionId: string,
    requestId: UserInputRequestId,
    response: NativeUserInputResponse,
  ): void {
    try {
      this.onRequestAnswered?.(sessionId, requestId, response, this.now().toISOString());
    } catch (err) {
      console.warn("[user-input] Failed to publish user input answer:", err);
    }
  }

  private notifyRequestCanceled(
    sessionId: string,
    requestId: UserInputRequestId,
    reason: UserInputCancelReason,
    message?: string,
  ): void {
    try {
      this.onRequestCanceled?.(sessionId, requestId, reason, message, this.now().toISOString());
    } catch (err) {
      console.warn("[user-input] Failed to publish user input cancellation:", err);
    }
  }

  private createCancellationError(reason: UserInputCancelReason, message?: string): UserInputBrokerError {
    return makeError(
      "request_canceled",
      message ?? `User input request canceled: ${reason}`,
      { reason, statusCode: 409 },
    );
  }
}

export function createUserInputBroker(options: UserInputBrokerOptions = {}): UserInputBroker {
  return new UserInputBroker(options);
}
