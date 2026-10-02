// Shared (server + client) shape of the agent backend connection status that
// the Bridge reports in /api/health, /api/server/runtime-status, and over the
// status stream as `backend:status`.

export type AgentBackendLifecycleState =
  | "starting"
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "stopped";

export interface AgentBackendDisconnectSummary {
  at: string;
  reason: string;
  detail?: string;
}

/**
 * Why the backend was replaced, in plain words, to follow "the agent backend". Not every reason
 * is a disconnect: the Bridge restarts a runtime that reported no failure when a session will not release.
 */
export function describeAgentBackendLoss(reason: string): string {
  switch (reason) {
    case "cleanup-stalled": return "Bridge restarted it because a session did not release in time";
    case "connection-closed": return "its connection closed";
    case "connection-error": return "its connection failed";
    case "process-exit": return "its process exited";
    case "stdin-error": return "the pipe to it failed";
    case "rpc-timeout": return "it stopped answering";
    case "health-probe-failed": return "it failed a liveness check";
    default: return reason;
  }
}

/** The cause in words, then the reason code and detail, for a status line. */
export function formatAgentBackendLoss(loss: AgentBackendDisconnectSummary): string {
  const reason = loss.reason.trim();
  const detail = loss.detail?.trim();
  const code = detail ? `${reason} - ${detail}` : reason;
  const words = describeAgentBackendLoss(reason);
  return words === reason ? code : `${words} (${code})`;
}

export interface AgentBackendStatus {
  state: AgentBackendLifecycleState;
  /** Transport state reported by the SDK client, when the backend exposes one. */
  connection: "connected" | "connecting" | "disconnected" | "error" | "unknown" | null;
  pid: number | null;
  /** When the current backend instance finished starting. */
  createdAt: string | null;
  lastDisconnect: AgentBackendDisconnectSummary | null;
  disconnectCount: number;
  recoveryCount: number;
  lastRecoveryAt: string | null;
  lastRecoveryError: string | null;
  /**
   * When automatic recovery gave up and the Bridge needs a server restart, or
   * null while the backend is ready or still recovering on its own. A
   * supervising launcher restarts the server once this has persisted.
   */
  recoveryBlockedAt: string | null;
  /** Sessions whose in-flight turn was failed by the most recent disconnect. */
  lastInterruptedSessionCount: number;
  /** Sessions the Bridge re-sent a continue prompt to after the most recent recovery. */
  lastAutoResumedSessionCount: number;
}
