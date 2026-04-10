export type RestartBannerPhase = "pending" | "reconnected" | null;

export interface RestartBannerState {
  phase: RestartBannerPhase;
  waitingSessions: number;
  shouldReload: boolean;
  reconnectedSincePending: boolean;
}

export type RestartBannerEvent =
  | { type: "server:restart-pending"; waitingSessions?: number }
  | { type: "server:restart-cleared" }
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
      };
    case "status:connected":
      if (prev.phase !== "pending") return prev;
      return {
        ...prev,
        reconnectedSincePending: true,
      };
    case "server:restart-cleared":
      if (prev.phase !== "pending") {
        return prev;
      }
      if (!prev.reconnectedSincePending) {
        return {
          phase: null,
          waitingSessions: 0,
          shouldReload: false,
          reconnectedSincePending: false,
        };
      }
      return {
        phase: "reconnected",
        waitingSessions: 0,
        shouldReload: true,
        reconnectedSincePending: false,
      };
  }
}
