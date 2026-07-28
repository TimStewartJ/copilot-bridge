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

describe("launcher restart state builders", () => {
  it("builds waiting and restarting states from pickup info, session count, and heartbeat", () => {
    expect(buildWaitingState(fullInfo, 3, NOW)).toEqual({
      ...fullInfo, phase: "waiting-for-sessions", waitingSessions: 3, launcherHeartbeatAt: NOW, releaseFailure: null,
    });
    expect(buildWaitingState(emptyInfo, 0, NOW)).toEqual({
      ...emptyInfo, phase: "waiting-for-sessions", waitingSessions: 0, launcherHeartbeatAt: NOW, releaseFailure: null,
    });
    // Restarting always zeroes the session count; the second-wait variant preserves it.
    expect(buildRestartingState(fullInfo, NOW)).toEqual({
      ...fullInfo, phase: "restarting", waitingSessions: 0, launcherHeartbeatAt: NOW, releaseFailure: null,
    });
    expect(buildRestartingState(emptyInfo, NOW)).toEqual({
      ...emptyInfo, phase: "restarting", waitingSessions: 0, launcherHeartbeatAt: NOW, releaseFailure: null,
    });
    expect(buildRestartingWaitingState(fullInfo, 2, NOW)).toEqual({
      ...fullInfo, phase: "restarting", waitingSessions: 2, launcherHeartbeatAt: NOW, releaseFailure: null,
    });
    expect(buildRestartingWaitingState(fullInfo, 0, NOW)).toEqual({
      ...fullInfo, phase: "restarting", waitingSessions: 0, launcherHeartbeatAt: NOW, releaseFailure: null,
    });

    // Each heartbeat reflects the latest session count and timestamp.
    const later = buildWaitingState(fullInfo, 2, "2026-04-24T12:00:03.000Z");
    expect(later.waitingSessions).toBe(2);
    expect(later.launcherHeartbeatAt).toBe("2026-04-24T12:00:03.000Z");
  });
});
