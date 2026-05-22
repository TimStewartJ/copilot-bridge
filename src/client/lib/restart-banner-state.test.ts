import { describe, expect, it } from "vitest";
import { reduceRestartBannerState, type RestartBannerState } from "./restart-banner-state";

const idleState: RestartBannerState = {
  phase: null,
  restartPhase: "idle",
  waitingSessions: 0,
  canAcceptNewWork: true,
  shouldReload: false,
  reconnectedSincePending: false,
  pendingSnapshotSeen: false,
  pendingServerInstanceId: null,
};

function pendingState(overrides: Partial<RestartBannerState> = {}): RestartBannerState {
  return {
    phase: "pending",
    restartPhase: "waiting-for-sessions",
    waitingSessions: 1,
    canAcceptNewWork: true,
    shouldReload: false,
    reconnectedSincePending: false,
    pendingSnapshotSeen: false,
    pendingServerInstanceId: null,
    ...overrides,
  };
}

function reconnectedState(): RestartBannerState {
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

describe("restart banner state", () => {
  it("enters pending without queueing a reload", () => {
    expect(reduceRestartBannerState(idleState, {
      type: "server:restart-pending",
      phase: "waiting-for-sessions",
      waitingSessions: 2,
      canAcceptNewWork: true,
      serverInstanceId: "server-1",
    })).toEqual(pendingState({
      waitingSessions: 2,
      pendingServerInstanceId: "server-1",
    }));
  });

  it("tracks restart cutover separately from waiting sessions", () => {
    expect(reduceRestartBannerState(idleState, {
      type: "snapshot:restart-status",
      pending: true,
      phase: "restarting",
      waitingSessions: 2,
      canAcceptNewWork: false,
      serverInstanceId: "server-1",
    })).toEqual(pendingState({
      restartPhase: "restarting",
      waitingSessions: 2,
      canAcceptNewWork: false,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }));
  });

  it("infers old pending events that do not include phase fields", () => {
    expect(reduceRestartBannerState(idleState, {
      type: "server:restart-pending",
      waitingSessions: 2,
      serverInstanceId: "server-1",
    })).toEqual(pendingState({
      waitingSessions: 2,
      pendingServerInstanceId: "server-1",
    }));
  });

  it("does not clear a pending snapshot marker when an SSE pending event follows", () => {
    expect(reduceRestartBannerState(pendingState({
      waitingSessions: 2,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }), { type: "server:restart-pending", waitingSessions: 2 })).toEqual(pendingState({
      waitingSessions: 2,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }));
  });

  it("queues a reload when a pending restart reconnects and then clears", () => {
    expect(reduceRestartBannerState(pendingState({
      reconnectedSincePending: true,
      pendingServerInstanceId: "server-1",
    }), { type: "server:restart-cleared", serverInstanceId: "server-2" })).toEqual(reconnectedState());
  });

  it("queues a reload when a pending restart is cleared by a new server snapshot", () => {
    expect(reduceRestartBannerState(pendingState({
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }), { type: "snapshot:restart-status", pending: false, waitingSessions: 0, serverInstanceId: "server-2" })).toEqual(reconnectedState());
  });

  it("does not reload when a pending restart clears on the same server instance", () => {
    expect(reduceRestartBannerState(pendingState({
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }), { type: "snapshot:restart-status", pending: false, waitingSessions: 0, serverInstanceId: "server-1" })).toEqual(idleState);
  });

  it("does not reload for a cleared snapshot when pending was only seen from SSE", () => {
    expect(reduceRestartBannerState(pendingState(), {
      type: "snapshot:restart-status",
      pending: false,
      waitingSessions: 0,
    })).toEqual(idleState);
  });

  it("uses pending restart status snapshots without clearing reconnect state", () => {
    expect(reduceRestartBannerState(pendingState({
      restartPhase: "queued",
      waitingSessions: 0,
      reconnectedSincePending: true,
    }), {
      type: "snapshot:restart-status",
      pending: true,
      phase: "waiting-for-sessions",
      waitingSessions: 2,
      canAcceptNewWork: true,
      serverInstanceId: "server-1",
    })).toEqual(pendingState({
      waitingSessions: 2,
      reconnectedSincePending: true,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }));
  });

  it("does not treat an initial SSE connection as a restart after a pending snapshot", () => {
    const afterConnect = reduceRestartBannerState(pendingState({
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }), { type: "status:connected" });

    expect(afterConnect).toEqual(pendingState({
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }));
    expect(reduceRestartBannerState(afterConnect, {
      type: "server:restart-cleared",
      serverInstanceId: "server-1",
    })).toEqual(idleState);
  });

  it("reloads when an SSE clear arrives from a different server after a pending snapshot", () => {
    expect(reduceRestartBannerState(pendingState({
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }), { type: "server:restart-cleared", serverInstanceId: "server-2" })).toEqual(reconnectedState());
  });

  it("does not queue a reload for restart-cleared without a prior pending state", () => {
    expect(reduceRestartBannerState(idleState, { type: "server:restart-cleared" })).toEqual(idleState);
  });

  it("dismisses the banner without reloading when pending clears before any reconnect", () => {
    expect(reduceRestartBannerState(pendingState(), { type: "server:restart-cleared" })).toEqual(idleState);
  });

  it("marks a pending restart as reconnected only after a new status connection", () => {
    expect(reduceRestartBannerState(pendingState(), { type: "status:connected" })).toEqual(pendingState({
      reconnectedSincePending: true,
    }));
  });
});
