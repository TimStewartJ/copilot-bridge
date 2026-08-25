import type { AgentBackendStatus } from "../../shared/agent-backend-status.js";

export const BACKEND_RECOVERY_BANNER_MS = 60_000;

export type BackendStatusBannerVariant = "warning" | "error" | "success";

export interface BackendStatusBannerView {
  key: string;
  variant: BackendStatusBannerVariant;
  status: AgentBackendStatus;
}

export interface BackendStatusBannerState {
  banner: BackendStatusBannerView | null;
  dismissedKey: string | null;
  recoveryExpiresAt: number | null;
}

export type BackendStatusBannerEvent =
  | { type: "backend:status"; agentBackend: AgentBackendStatus; nowMs?: number }
  | { type: "dismiss" }
  | { type: "tick"; nowMs?: number };

export function createBackendStatusBannerState(): BackendStatusBannerState {
  return { banner: null, dismissedKey: null, recoveryExpiresAt: null };
}

export function reduceBackendStatusBannerState(
  prev: BackendStatusBannerState,
  event: BackendStatusBannerEvent,
): BackendStatusBannerState {
  switch (event.type) {
    case "backend:status":
      return stateFromBackendStatus(prev, event.agentBackend, event.nowMs ?? Date.now());
    case "dismiss":
      return {
        ...prev,
        banner: null,
        dismissedKey: prev.banner?.key ?? prev.dismissedKey,
      };
    case "tick": {
      const nowMs = event.nowMs ?? Date.now();
      if (prev.recoveryExpiresAt === null || nowMs < prev.recoveryExpiresAt) return prev;
      return { ...prev, banner: null, recoveryExpiresAt: null };
    }
  }
}

function stateFromBackendStatus(
  prev: BackendStatusBannerState,
  status: AgentBackendStatus,
  nowMs: number,
): BackendStatusBannerState {
  if (status.state === "disconnected" || status.state === "reconnecting") {
    const key = `backend:${status.state}:${status.lastDisconnect?.at ?? "unknown"}:${status.disconnectCount}`;
    return {
      banner: prev.dismissedKey === key ? null : {
        key,
        variant: status.state === "disconnected" ? "error" : "warning",
        status,
      },
      dismissedKey: prev.dismissedKey,
      recoveryExpiresAt: null,
    };
  }

  if (status.state === "ready" && status.lastRecoveryAt) {
    const recoveryAt = Date.parse(status.lastRecoveryAt);
    const recoveryExpiresAt = Number.isFinite(recoveryAt) ? recoveryAt + BACKEND_RECOVERY_BANNER_MS : null;
    const shouldShowRecovery = recoveryExpiresAt !== null && nowMs < recoveryExpiresAt;
    const key = `backend:recovered:${status.lastRecoveryAt}:${status.recoveryCount}`;
    return {
      banner: shouldShowRecovery && prev.dismissedKey !== key ? { key, variant: "success", status } : null,
      dismissedKey: prev.dismissedKey,
      recoveryExpiresAt: shouldShowRecovery ? recoveryExpiresAt : null,
    };
  }

  return { ...prev, banner: null, recoveryExpiresAt: null };
}
