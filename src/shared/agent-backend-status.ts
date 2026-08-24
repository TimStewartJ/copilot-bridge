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
  /** Sessions whose in-flight turn was failed by the most recent disconnect. */
  lastInterruptedSessionCount: number;
  /** Sessions the Bridge re-sent a continue prompt to after the most recent recovery. */
  lastAutoResumedSessionCount: number;
}
