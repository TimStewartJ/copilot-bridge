import type { RestartStatusPhase } from "../api";

export type RestartBannerPhase = "pending" | "reconnected" | null;

export interface RestartBannerState {
  phase: RestartBannerPhase;
  restartPhase: RestartStatusPhase;
  waitingSessions: number;
  canAcceptNewWork: boolean;
  shouldReload: boolean;
  reconnectedSincePending: boolean;
  pendingSnapshotSeen: boolean;
  pendingServerInstanceId: string | null;
}

interface RestartPendingFields {
  waitingSessions?: number;
  phase?: RestartStatusPhase;
  canAcceptNewWork?: boolean;
}

export type RestartBannerEvent =
  | ({ type: "server:restart-pending"; serverInstanceId?: string } & RestartPendingFields)
  | { type: "server:restart-cleared"; serverInstanceId?: string }
  | ({ type: "snapshot:restart-status"; pending: boolean; serverInstanceId?: string } & RestartPendingFields)
  | { type: "status:connected" };

function inferPendingRestartPhase(event: RestartPendingFields): RestartStatusPhase {
  return event.phase ?? ((event.waitingSessions ?? 0) > 0 ? "waiting-for-sessions" : "queued");
}

function canAcceptNewWork(event: RestartPendingFields, restartPhase: RestartStatusPhase): boolean {
  return event.canAcceptNewWork ?? restartPhase !== "restarting";
}

function clearedState(): RestartBannerState {
  return {
    phase: null,
    restartPhase: "idle",
    waitingSessions: 0,
    canAcceptNewWork: true,
    shouldReload: false,
    reconnectedSincePending: false,
    pendingSnapshotSeen: false,
    pendingServerInstanceId: null,
  };
}

export function reduceRestartBannerState(
  prev: RestartBannerState,
  event: RestartBannerEvent,
): RestartBannerState {
  switch (event.type) {
    case "server:restart-pending": {
      const restartPhase = inferPendingRestartPhase(event);
      return {
        phase: "pending",
        restartPhase,
        waitingSessions: event.waitingSessions ?? 0,
        canAcceptNewWork: canAcceptNewWork(event, restartPhase),
        shouldReload: false,
        reconnectedSincePending: false,
        pendingSnapshotSeen: prev.pendingSnapshotSeen,
        pendingServerInstanceId: event.serverInstanceId ?? prev.pendingServerInstanceId,
      };
    }
    case "snapshot:restart-status":
      if (event.pending) {
        const restartPhase = inferPendingRestartPhase(event);
        return {
          phase: "pending",
          restartPhase,
          waitingSessions: event.waitingSessions ?? 0,
          canAcceptNewWork: canAcceptNewWork(event, restartPhase),
          shouldReload: false,
          reconnectedSincePending: prev.reconnectedSincePending,
          pendingSnapshotSeen: true,
          pendingServerInstanceId: event.serverInstanceId ?? prev.pendingServerInstanceId,
        };
      }
      if (prev.phase !== "pending") {
        return clearedState();
      }
      if (
        !prev.pendingSnapshotSeen ||
        !prev.pendingServerInstanceId ||
        !event.serverInstanceId ||
        prev.pendingServerInstanceId === event.serverInstanceId
      ) {
        return clearedState();
      }
      return {
        phase: "reconnected",
        restartPhase: "idle",
        waitingSessions: 0,
        canAcceptNewWork: true,
        shouldReload: true,
        reconnectedSincePending: false,
        pendingSnapshotSeen: false,
        pendingServerInstanceId: null,
      };
    case "status:connected":
      if (prev.phase !== "pending") return prev;
      if (prev.pendingSnapshotSeen) return prev;
      return {
        ...prev,
        reconnectedSincePending: true,
      };
    case "server:restart-cleared":
      if (prev.phase !== "pending") {
        return prev;
      }
      if (prev.pendingServerInstanceId && event.serverInstanceId) {
        if (prev.pendingServerInstanceId !== event.serverInstanceId) {
          return {
            phase: "reconnected",
            restartPhase: "idle",
            waitingSessions: 0,
            canAcceptNewWork: true,
            shouldReload: true,
            reconnectedSincePending: false,
            pendingSnapshotSeen: false,
            pendingServerInstanceId: null,
          };
        }
        return clearedState();
      }
      if (!prev.reconnectedSincePending || prev.pendingSnapshotSeen) {
        return clearedState();
      }
      return {
        phase: "reconnected",
        restartPhase: "idle",
        waitingSessions: 0,
        canAcceptNewWork: true,
        shouldReload: true,
        reconnectedSincePending: false,
        pendingSnapshotSeen: false,
        pendingServerInstanceId: null,
      };
  }
}
