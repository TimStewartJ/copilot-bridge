import type { SessionEventBus } from "./event-bus.js";
import { normalizePendingShellAuthRequest, PendingInteractionError, validateShellAuthResponse } from "./pending-interaction-validation.js";
import type {
  PendingShellAuthRequestView,
  ShellAuthCancelReason,
  ShellAuthRequestId,
  SubmittedShellAuthResponse,
} from "./shell-auth-types.js";

/** What the Copilot SDK's `onShellAuthenticationRequest` handler answers. */
export type ShellAuthHandlerResponse = { action: "accept"; value: string } | { action: "cancel" };
export type ShellAuthHandler = (
  request: unknown,
  invocation: { sessionId: string; signal: AbortSignal },
) => Promise<ShellAuthHandlerResponse>;

export interface ShellAuthRequestsDeps {
  /** The bus of the chat's run in progress; undefined when no run is open to show the prompt. */
  getLiveBus(sessionId: string): SessionEventBus | undefined;
  /** A prompt was shown to, or taken away from, the chat's user. */
  onPendingChange(sessionId: string, state: "requested" | "completed", at?: string): void;
  logger?: Pick<Console, "log" | "warn">;
}

interface PendingShellAuth {
  view: PendingShellAuthRequestView;
  bus: SessionEventBus;
  settle(response: ShellAuthHandlerResponse): void;
}

const CANCEL: ShellAuthHandlerResponse = { action: "cancel" };

/** Holds shell prompts until answered; answers go only to the runtime, never logs or the bus. */
export class ShellAuthRequests {
  private readonly pending = new Map<string, Map<ShellAuthRequestId, PendingShellAuth>>();
  private readonly logger: Pick<Console, "log" | "warn">;

  constructor(private readonly deps: ShellAuthRequestsDeps) {
    this.logger = deps.logger ?? console;
  }

  readonly handler: ShellAuthHandler = (request, { sessionId, signal }) => {
    const label = `[sdk] [${sessionId.slice(0, 8)}]`;
    if (signal.aborted) return Promise.resolve(CANCEL);
    let view: PendingShellAuthRequestView;
    try {
      view = normalizePendingShellAuthRequest(request, new Date().toISOString());
    } catch (error) {
      this.logger.warn(`${label} Declined an invalid shell authentication request:`, error instanceof Error ? error.message : error);
      return Promise.resolve(CANCEL);
    }
    const bus = this.deps.getLiveBus(sessionId);
    if (!bus) {
      this.logger.warn(`${label} Declined ${view.program} authentication ${view.requestId}: no run is open to ask in`);
      return Promise.resolve(CANCEL);
    }
    const forSession = this.pending.get(sessionId) ?? new Map<ShellAuthRequestId, PendingShellAuth>();
    if (forSession.has(view.requestId)) return Promise.resolve(CANCEL);
    this.pending.set(sessionId, forSession);

    return new Promise<ShellAuthHandlerResponse>((resolve) => {
      const onAbort = () => this.cancel(sessionId, view.requestId, "expired");
      forSession.set(view.requestId, {
        view,
        bus,
        settle: (response) => {
          signal.removeEventListener("abort", onAbort);
          resolve(response);
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.logger.log(`${label} ${view.program} asked for ${view.inputKind} input (${view.requestId})`);
      bus.emitShellAuthRequested(view);
      this.deps.onPendingChange(sessionId, "requested", view.requestedAt);
    });
  };

  /** The user's answer; throws PendingInteractionError for an unknown request or invalid answer. */
  respond(sessionId: string, requestId: ShellAuthRequestId, payload: unknown): SubmittedShellAuthResponse {
    const entry = this.pending.get(sessionId)?.get(requestId);
    if (!entry) {
      throw new PendingInteractionError("request_not_found", "Pending shell authentication request not found", { statusCode: 404 });
    }
    const response = validateShellAuthResponse(entry.view, payload);
    const timestamp = new Date().toISOString();
    this.remove(sessionId, requestId);
    entry.bus.emitShellAuthResolved(requestId, response.action, timestamp);
    entry.settle(response);
    this.deps.onPendingChange(sessionId, "completed", timestamp);
    return { requestId, action: response.action, timestamp };
  }

  /** Cancels every prompt of a chat, for a run that ended or a chat that went away. */
  cancelSession(sessionId: string, reason: ShellAuthCancelReason = "session_ended"): void {
    for (const requestId of [...this.pending.get(sessionId)?.keys() ?? []]) {
      this.cancel(sessionId, requestId, reason);
    }
  }

  private cancel(sessionId: string, requestId: ShellAuthRequestId, reason: ShellAuthCancelReason): void {
    const entry = this.pending.get(sessionId)?.get(requestId);
    if (!entry) return;
    const timestamp = new Date().toISOString();
    this.remove(sessionId, requestId);
    entry.bus.emitShellAuthCanceled(requestId, { reason, timestamp });
    entry.settle(CANCEL);
    this.deps.onPendingChange(sessionId, "completed", timestamp);
  }

  private remove(sessionId: string, requestId: ShellAuthRequestId): void {
    const forSession = this.pending.get(sessionId);
    forSession?.delete(requestId);
    if (forSession?.size === 0) this.pending.delete(sessionId);
  }
}
