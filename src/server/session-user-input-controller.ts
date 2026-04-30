import { createUserInputBroker, type UserInputBroker } from "./user-input-broker.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { GlobalBus } from "./global-bus.js";
import type {
  NativeUserInputRequest,
  NativeUserInputResponse,
  UserInputCancelReason,
  UserInputRequestId,
} from "./user-input-types.js";

export interface SessionUserInputControllerDeps {
  broker?: UserInputBroker;
  eventBusRegistry: EventBusRegistry;
  globalBus: GlobalBus;
  touchActivity(sessionId: string, timestamp?: string): void;
}

export class SessionUserInputController {
  private readonly broker: UserInputBroker;

  constructor(private readonly deps: SessionUserInputControllerDeps) {
    this.broker = deps.broker ?? createUserInputBroker();
    this.broker.setEventHandlers({
      onRequestCreated: (sessionId, request) => {
        deps.touchActivity(sessionId, request.requestedAt);
        deps.eventBusRegistry.getOrCreateBus(sessionId).emitUserInputRequested(request, request.requestedAt);
        this.emitPendingStatus(sessionId);
      },
      onRequestAnswered: (sessionId, requestId, response, timestamp) => {
        deps.touchActivity(sessionId, timestamp);
        deps.eventBusRegistry.getBus(sessionId)?.emitUserInputAnswered(requestId, response, timestamp);
        this.emitPendingStatus(sessionId);
      },
      onRequestCanceled: (sessionId, requestId, reason, message, timestamp) => {
        deps.touchActivity(sessionId, timestamp);
        deps.eventBusRegistry.getBus(sessionId)?.emitUserInputCanceled(requestId, { reason, message, timestamp });
        this.emitPendingStatus(sessionId);
      },
    });
  }

  requestUserInput(
    sessionId: string,
    request: NativeUserInputRequest,
  ): Promise<NativeUserInputResponse> {
    return this.broker.requestUserInput(sessionId, request);
  }

  submitUserInputResponse(
    sessionId: string,
    requestId: UserInputRequestId,
    payload: unknown,
  ): NativeUserInputResponse {
    return this.broker.submitUserInputResponse(sessionId, requestId, payload);
  }

  cancelPendingSessionRequests(
    sessionId: string,
    reason: UserInputCancelReason,
    message?: string,
  ): void {
    try {
      const canceled = this.broker.cancelSessionRequests(sessionId, reason, message);
      if (canceled > 0) {
        console.log(`[sdk] [${sessionId.slice(0, 8)}] Canceled ${canceled} pending user input request(s): ${reason}`);
      }
    } catch (err) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] Failed to cancel pending user input request(s):`, err);
    }
  }

  cancelAllPendingRequests(reason: UserInputCancelReason, message?: string): void {
    try {
      const canceled = this.broker.cancelAllRequests(reason, message);
      if (canceled > 0) {
        console.log(`[sdk] Canceled ${canceled} pending user input request(s): ${reason}`);
      }
    } catch (err) {
      console.warn("[sdk] Failed to cancel pending user input request(s):", err);
    }
  }

  getPendingCount(sessionId?: string): number {
    return this.broker.getPendingCount(sessionId);
  }

  emitPendingStatus(sessionId: string): void {
    const pendingUserInputCount = this.getPendingCount(sessionId);
    this.deps.globalBus.emit({
      type: "session:user-input",
      sessionId,
      pendingUserInputCount,
      needsUserInput: pendingUserInputCount > 0,
    });
  }
}
