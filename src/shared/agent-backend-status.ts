// Agent backend status shape for /api/health, runtime-status and the `backend:status` event.

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

/** Why the backend was replaced, worded to follow "the agent backend"; not always a disconnect. */
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
  /** Set when auto recovery gave up; a supervising launcher restarts once it persists. */
  recoveryBlockedAt: string | null;
  /** Sessions whose in-flight turn was failed by the most recent disconnect. */
  lastInterruptedSessionCount: number;
  /** Sessions the Bridge re-sent a continue prompt to after the most recent recovery. */
  lastAutoResumedSessionCount: number;
}
