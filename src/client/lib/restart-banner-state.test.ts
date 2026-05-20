import { describe, expect, it } from "vitest";
import { reduceRestartBannerState, type RestartBannerState } from "./restart-banner-state";

const idleState: RestartBannerState = {
  phase: null,
  waitingSessions: 0,
  shouldReload: false,
  reconnectedSincePending: false,
  pendingSnapshotSeen: false,
  pendingServerInstanceId: null,
};

describe("restart banner state", () => {
  it("enters pending without queueing a reload", () => {
    expect(reduceRestartBannerState(idleState, {
      type: "server:restart-pending",
      waitingSessions: 2,
      serverInstanceId: "server-1",
    })).toEqual({
      phase: "pending",
      waitingSessions: 2,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: "server-1",
    });
  });

  it("does not clear a pending snapshot marker when an SSE pending event follows", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 2,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }, { type: "server:restart-pending", waitingSessions: 2 })).toEqual({
      phase: "pending",
      waitingSessions: 2,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    });
  });

  it("queues a reload when a pending restart reconnects and then clears", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: true,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: "server-1",
    }, { type: "server:restart-cleared", serverInstanceId: "server-2" })).toEqual({
      phase: "reconnected",
      waitingSessions: 0,
      shouldReload: true,
      reconnectedSincePending: false,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: null,
    });
  });

  it("queues a reload when a pending restart is cleared by a new server snapshot", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }, { type: "snapshot:restart-status", pending: false, waitingSessions: 0, serverInstanceId: "server-2" })).toEqual({
      phase: "reconnected",
      waitingSessions: 0,
      shouldReload: true,
      reconnectedSincePending: false,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: null,
    });
  });

  it("does not reload when a pending restart clears on the same server instance", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }, { type: "snapshot:restart-status", pending: false, waitingSessions: 0, serverInstanceId: "server-1" })).toEqual(idleState);
  });

  it("does not reload for a cleared snapshot when pending was only seen from SSE", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: null,
    }, { type: "snapshot:restart-status", pending: false, waitingSessions: 0 })).toEqual(idleState);
  });

  it("uses pending restart status snapshots without clearing reconnect state", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 0,
      shouldReload: false,
      reconnectedSincePending: true,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: null,
    }, { type: "snapshot:restart-status", pending: true, waitingSessions: 2, serverInstanceId: "server-1" })).toEqual({
      phase: "pending",
      waitingSessions: 2,
      shouldReload: false,
      reconnectedSincePending: true,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    });
  });

  it("does not treat an initial SSE connection as a restart after a pending snapshot", () => {
    const afterConnect = reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }, { type: "status:connected" });

    expect(afterConnect).toEqual({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    });
    expect(reduceRestartBannerState(afterConnect, {
      type: "server:restart-cleared",
      serverInstanceId: "server-1",
    })).toEqual(idleState);
  });

  it("reloads when an SSE clear arrives from a different server after a pending snapshot", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: true,
      pendingServerInstanceId: "server-1",
    }, { type: "server:restart-cleared", serverInstanceId: "server-2" })).toEqual({
      phase: "reconnected",
      waitingSessions: 0,
      shouldReload: true,
      reconnectedSincePending: false,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: null,
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
      pendingSnapshotSeen: false,
      pendingServerInstanceId: null,
    }, { type: "server:restart-cleared" })).toEqual(idleState);
  });

  it("marks a pending restart as reconnected only after a new status connection", () => {
    expect(reduceRestartBannerState({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: false,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: null,
    }, { type: "status:connected" })).toEqual({
      phase: "pending",
      waitingSessions: 1,
      shouldReload: false,
      reconnectedSincePending: true,
      pendingSnapshotSeen: false,
      pendingServerInstanceId: null,
    });
  });
});
