import type { EventBusRegistry } from "./event-bus.js";
import {
  createElicitationBroker,
  type ElicitationBroker,
} from "./elicitation-broker.js";
import type {
  ElicitationCancelReason,
  ElicitationRequestId,
  NativeElicitationRequest,
  NativeElicitationResult,
} from "./elicitation-types.js";

export interface SessionElicitationControllerDeps {
  broker?: ElicitationBroker;
  eventBusRegistry: EventBusRegistry;
  touchActivity(sessionId: string, timestamp?: string): void;
  emitPendingStatus(sessionId: string): void;
}

export class SessionElicitationController {
  private readonly broker: ElicitationBroker;

  constructor(private readonly deps: SessionElicitationControllerDeps) {
    this.broker = deps.broker ?? createElicitationBroker();
    this.broker.setEventHandlers({
      onRequestCreated: (sessionId, request) => {
        deps.touchActivity(sessionId, request.requestedAt);
        deps.eventBusRegistry.getOrCreateBus(sessionId).emitElicitationRequested(
          request,
          request.requestedAt,
        );
        deps.emitPendingStatus(sessionId);
      },
      onRequestResolved: (sessionId, requestId, action, timestamp) => {
        deps.touchActivity(sessionId, timestamp);
        deps.eventBusRegistry.getBus(sessionId)?.emitElicitationResolved(
          requestId,
          action,
          timestamp,
        );
        deps.emitPendingStatus(sessionId);
      },
      onRequestCanceled: (sessionId, requestId, reason, message, timestamp) => {
        deps.touchActivity(sessionId, timestamp);
        deps.eventBusRegistry.getBus(sessionId)?.emitElicitationCanceled(requestId, {
          reason,
          message,
          timestamp,
        });
        deps.emitPendingStatus(sessionId);
      },
    });
  }

  requestElicitation(request: NativeElicitationRequest): Promise<NativeElicitationResult> {
    return this.broker.requestElicitation(request);
  }

  submitResponse(
    sessionId: string,
    requestId: ElicitationRequestId,
    payload: unknown,
  ): NativeElicitationResult {
    return this.broker.submitResponse(sessionId, requestId, payload);
  }

  cancelPendingSessionRequests(
    sessionId: string,
    reason: ElicitationCancelReason,
    message?: string,
  ): void {
    try {
      const canceled = this.broker.cancelSessionRequests(sessionId, reason, message);
      if (canceled > 0) {
        console.log(
          `[sdk] [${sessionId.slice(0, 8)}] Canceled ${canceled} pending elicitation request(s): ${reason}`,
        );
      }
    } catch (error) {
      console.warn(
        `[sdk] [${sessionId.slice(0, 8)}] Failed to cancel pending elicitation request(s):`,
        error,
      );
    }
  }

  cancelAllPendingRequests(reason: ElicitationCancelReason, message?: string): void {
    try {
      const canceled = this.broker.cancelAllRequests(reason, message);
      if (canceled > 0) {
        console.log(`[sdk] Canceled ${canceled} pending elicitation request(s): ${reason}`);
      }
    } catch (error) {
      console.warn("[sdk] Failed to cancel pending elicitation request(s):", error);
    }
  }

  getPendingCount(sessionId?: string): number {
    return this.broker.getPendingCount(sessionId);
  }
}
