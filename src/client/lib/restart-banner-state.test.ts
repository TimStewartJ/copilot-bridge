import { describe, expect, it } from "vitest";
import { reduceRestartBannerState, type RestartBannerState } from "./restart-banner-state";

const idleState: RestartBannerState = {
  phase: null,
  waitingSessions: 0,
  shouldReload: false,
  reconnectedSincePending: false,
};

describe("restart banner state", () => {
  it("enters pending without queueing a reload", () => {
    expect(reduceRestartBannerState(idleState, { type: "server:restart-pending", waitingSessions: 2 })).toEqual({
      phase: "pending",
      waitingSessions: 2,
      shouldReload: false,
      reconnectedSincePending: false,
    });
  });

  it("queues a reload when a pending restart reconnects and then clears", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: true,
    }, { type: "server:restart-cleared" })).toEqual({
      phase: "reconnected",
      waitingSessions: 0,
      shouldReload: true,
      reconnectedSincePending: false,
    });
  });

  it("does not queue a reload for restart-cleared without a prior pending state", () => {
    expect(reduceRestartBannerState(idleState, { type: "server:restart-cleared" })).toEqual(idleState);
  });

  it("dismisses the banner without reloading when pending clears before any reconnect", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
    }, { type: "server:restart-cleared" })).toEqual(idleState);
  });

  it("marks a pending restart as reconnected only after a new status connection", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
    }, { type: "status:connected" })).toEqual({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: true,
    });
  });
});
