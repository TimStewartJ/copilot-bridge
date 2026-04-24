// Pure helpers for building restart-state transitions owned by the launcher.
// All functions accept an explicit `now` timestamp so they remain deterministic
// and fully testable without mocking Date.

import type { RestartState } from "./server/restart-state.js";

export interface RestartPickupInfo {
  /** Preserved from the queued restart state (set by the server). Null when triggered manually. */
  requestId: string | null;
  /** ISO timestamp when the restart was originally requested. Null when triggered manually. */
  requestedAt: string | null;
}

/**
 * Build the "waiting-for-sessions" state for the launcher's first loop iteration
 * and every subsequent heartbeat during the busy-wait.
 */
export function buildWaitingState(
  info: RestartPickupInfo,
  waitingSessions: number,
  now: string,
): RestartState {
  return {
    requestId: info.requestId,
    phase: "waiting-for-sessions",
    requestedAt: info.requestedAt,
    waitingSessions,
    launcherHeartbeatAt: now,
  };
}

/**
 * Build the "restarting" state, published once the launcher has committed to
 * restarting (i.e., before build / shutdown / swap begins).
 */
export function buildRestartingState(
  info: RestartPickupInfo,
  now: string,
): RestartState {
  return {
    requestId: info.requestId,
    phase: "restarting",
    requestedAt: info.requestedAt,
    waitingSessions: 0,
    launcherHeartbeatAt: now,
  };
}

/**
 * Build a "restarting" state that also carries a live waiting-session count,
 * used during the second busy-wait (after build, before server swap).
 */
export function buildRestartingWaitingState(
  info: RestartPickupInfo,
  waitingSessions: number,
  now: string,
): RestartState {
  return {
    requestId: info.requestId,
    phase: "restarting",
    requestedAt: info.requestedAt,
    waitingSessions,
    launcherHeartbeatAt: now,
  };
}
