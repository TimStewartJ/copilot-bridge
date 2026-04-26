import { describe, expect, it } from "vitest";
import {
  buildRestartingState,
  buildRestartingWaitingState,
  buildWaitingState,
  type RestartPickupInfo,
} from "./launcher-restart-state-ops.js";

const NOW = "2026-04-24T12:00:00.000Z";

const fullInfo: RestartPickupInfo = {
  requestId: "req-abc123",
  requestedAt: "2026-04-24T11:59:00.000Z",
};

const emptyInfo: RestartPickupInfo = {
  requestId: null,
  requestedAt: null,
};

describe("buildWaitingState", () => {
  it("produces a waiting-for-sessions state preserving the pickup info", () => {
    expect(buildWaitingState(fullInfo, 3, NOW)).toEqual({
      requestId: "req-abc123",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T11:59:00.000Z",
      waitingSessions: 3,
      launcherHeartbeatAt: NOW,
      releaseFailure: null,
    });
  });

  it("handles null requestId / requestedAt (manual trigger)", () => {
    expect(buildWaitingState(emptyInfo, 0, NOW)).toEqual({
      requestId: null,
      phase: "waiting-for-sessions",
      requestedAt: null,
      waitingSessions: 0,
      launcherHeartbeatAt: NOW,
      releaseFailure: null,
    });
  });

  it("reflects the updated session count on each heartbeat", () => {
    const state1 = buildWaitingState(fullInfo, 1, NOW);
    const state2 = buildWaitingState(fullInfo, 2, "2026-04-24T12:00:03.000Z");

    expect(state1.waitingSessions).toBe(1);
    expect(state2.waitingSessions).toBe(2);
    expect(state2.launcherHeartbeatAt).toBe("2026-04-24T12:00:03.000Z");
  });
});

describe("buildRestartingState", () => {
  it("produces a restarting state with zero waitingSessions", () => {
    expect(buildRestartingState(fullInfo, NOW)).toEqual({
      requestId: "req-abc123",
      phase: "restarting",
      requestedAt: "2026-04-24T11:59:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: NOW,
      releaseFailure: null,
    });
  });

  it("handles null requestId / requestedAt (manual trigger)", () => {
    expect(buildRestartingState(emptyInfo, NOW)).toEqual({
      requestId: null,
      phase: "restarting",
      requestedAt: null,
      waitingSessions: 0,
      launcherHeartbeatAt: NOW,
      releaseFailure: null,
    });
  });
});

describe("buildRestartingWaitingState", () => {
  it("produces a restarting state with the active session count during second wait", () => {
    expect(buildRestartingWaitingState(fullInfo, 2, NOW)).toEqual({
      requestId: "req-abc123",
      phase: "restarting",
      requestedAt: "2026-04-24T11:59:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: NOW,
      releaseFailure: null,
    });
  });

  it("clears session count to zero when idle during second wait", () => {
    expect(buildRestartingWaitingState(fullInfo, 0, NOW)).toEqual({
      requestId: "req-abc123",
      phase: "restarting",
      requestedAt: "2026-04-24T11:59:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: NOW,
      releaseFailure: null,
    });
  });
});
