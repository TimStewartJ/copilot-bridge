export type RestartBannerPhase = "pending" | "reconnected" | null;

export interface RestartBannerState {
  phase: RestartBannerPhase;
  waitingSessions: number;
  shouldReload: boolean;
  reconnectedSincePending: boolean;
  pendingSnapshotSeen: boolean;
  pendingServerInstanceId: string | null;
}

export type RestartBannerEvent =
  | { type: "server:restart-pending"; waitingSessions?: number; serverInstanceId?: string }
  | { type: "server:restart-cleared"; serverInstanceId?: string }
  | { type: "snapshot:restart-status"; pending: boolean; waitingSessions?: number; serverInstanceId?: string }
  | { type: "status:connected" };

export function reduceRestartBannerState(
  prev: RestartBannerState,
  event: RestartBannerEvent,
): RestartBannerState {
  switch (event.type) {
    case "server:restart-pending":
      return {
        phase: "pending",
        waitingSessions: event.waitingSessions ?? 0,
        shouldReload: false,
        reconnectedSincePending: false,
        pendingSnapshotSeen: prev.pendingSnapshotSeen,
        pendingServerInstanceId: event.serverInstanceId ?? prev.pendingServerInstanceId,
      };
    case "snapshot:restart-status":
      if (event.pending) {
        return {
          phase: "pending",
          waitingSessions: event.waitingSessions ?? 0,
          shouldReload: false,
          reconnectedSincePending: prev.reconnectedSincePending,
          pendingSnapshotSeen: true,
          pendingServerInstanceId: event.serverInstanceId ?? prev.pendingServerInstanceId,
        };
      }
      if (prev.phase !== "pending") {
        return {
          phase: null,
          waitingSessions: 0,
          shouldReload: false,
          reconnectedSincePending: false,
          pendingSnapshotSeen: false,
          pendingServerInstanceId: null,
        };
      }
      if (
        !prev.pendingSnapshotSeen ||
        !prev.pendingServerInstanceId ||
        !event.serverInstanceId ||
        prev.pendingServerInstanceId === event.serverInstanceId
      ) {
        return {
          phase: null,
          waitingSessions: 0,
          shouldReload: false,
          reconnectedSincePending: false,
          pendingSnapshotSeen: false,
          pendingServerInstanceId: null,
        };
      }
      return {
        phase: "reconnected",
        waitingSessions: 0,
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
            waitingSessions: 0,
            shouldReload: true,
            reconnectedSincePending: false,
            pendingSnapshotSeen: false,
            pendingServerInstanceId: null,
          };
        }
        return {
          phase: null,
          waitingSessions: 0,
          shouldReload: false,
          reconnectedSincePending: false,
          pendingSnapshotSeen: false,
          pendingServerInstanceId: null,
        };
      }
      if (!prev.reconnectedSincePending || prev.pendingSnapshotSeen) {
        return {
          phase: null,
          waitingSessions: 0,
          shouldReload: false,
          reconnectedSincePending: false,
          pendingSnapshotSeen: false,
          pendingServerInstanceId: null,
        };
      }
      return {
        phase: "reconnected",
        waitingSessions: 0,
        shouldReload: true,
        reconnectedSincePending: false,
        pendingSnapshotSeen: false,
        pendingServerInstanceId: null,
      };
  }
}
